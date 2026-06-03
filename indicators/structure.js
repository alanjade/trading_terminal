/**
 * indicators/structure.js
 * Market structure analysis:
 *   - Swing high / swing low detection
 *   - Break of Structure (BOS)
 *   - Change of Character (CHoCH)
 *   - Liquidity sweeps
 *   - Equal highs / lows
 *   - Previous day / session high-low
 *   - Displacement candle detection
 *   - Session weighting (London / NY open)
 */

// ── Swing Points ──────────────────────────────────────────────────────────────

export function detectSwingPoints(candles, leftBars = 3, rightBars = 3) {
  const swings = [];
  const n = candles.length;

  for (let i = leftBars; i < n - rightBars; i++) {
    const c = candles[i];

    let isHigh = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) { isHigh = false; break; }
    }
    if (isHigh) {
      swings.push({ idx: i, price: c.h, type: 'high', ts: c.t || 0 });
    }

    let isLow = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].l <= c.l) { isLow = false; break; }
    }
    if (isLow) {
      swings.push({ idx: i, price: c.l, type: 'low', ts: c.t || 0 });
    }
  }

  return swings;
}

// ── Break of Structure (BOS) & Change of Character (CHoCH) ───────────────────

export function detectStructureBreaks(candles, swings) {
  const events = [];
  if (swings.length < 2) return events;

  const sorted = [...swings].sort((a, b) => a.idx - b.idx);
  const highs = sorted.filter(s => s.type === 'high');
  const lows  = sorted.filter(s => s.type === 'low');

  if (highs.length < 2 || lows.length < 2) return events;

  for (let i = 1; i < highs.length; i++) {
    const prev = highs[i - 1];
    const curr = highs[i];
    if (curr.price > prev.price) {
      events.push({ type: 'BOS', dir: 'bull', price: prev.price, idx: curr.idx, ts: curr.ts });
    }
  }

  for (let i = 1; i < lows.length; i++) {
    const prev = lows[i - 1];
    const curr = lows[i];
    if (curr.price < prev.price) {
      events.push({ type: 'BOS', dir: 'bear', price: prev.price, idx: curr.idx, ts: curr.ts });
    }
  }

  if (highs.length >= 2 && lows.length >= 2) {
    const lastHigh = highs[highs.length - 1];
    const prevHigh = highs[highs.length - 2];
    const lastLow  = lows[lows.length - 1];
    const prevLow  = lows[lows.length - 2];

    const isUptrend   = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
    const isDowntrend = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

    if (isUptrend && candles.length > 0) {
      const lastClose = candles[candles.length - 1].c;
      if (lastClose < lastLow.price) {
        events.push({ type: 'CHoCH', dir: 'bear', price: lastLow.price, idx: candles.length - 1, ts: candles[candles.length - 1].t || 0 });
      }
    }
    if (isDowntrend && candles.length > 0) {
      const lastClose = candles[candles.length - 1].c;
      if (lastClose > lastHigh.price) {
        events.push({ type: 'CHoCH', dir: 'bull', price: lastHigh.price, idx: candles.length - 1, ts: candles[candles.length - 1].t || 0 });
      }
    }
  }

  const seen = new Set();
  return events.filter(e => {
    const key = `${e.type}-${e.dir}-${e.price.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Liquidity Sweeps ──────────────────────────────────────────────────────────

/**
 * Detects potential liquidity sweeps: price wicks through a recent swing high/low
 * but closes back inside, suggesting stop hunts.
 * Returns enriched sweep objects with sweep size (% of ATR) and recency score.
 */
export function detectLiquiditySweeps(candles, swings, tolerance = 0.002) {
  const sweeps = [];
  const recent = candles.slice(-20);
  if (!recent.length || !swings.length) return sweeps;

  // Estimate ATR for sweep magnitude scoring
  const atrWindow = candles.slice(-15);
  let atr = 0;
  for (let i = 1; i < atrWindow.length; i++) {
    const c = atrWindow[i], p = atrWindow[i-1];
    atr += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  atr = atrWindow.length > 1 ? atr / (atrWindow.length - 1) : 0;

  swings.forEach(swing => {
    recent.forEach((c, i) => {
      if (c.t && swing.ts && c.t <= swing.ts) return;
      const candleIdx = candles.length - recent.length + i;

      if (swing.type === 'high') {
        if (c.h > swing.price * (1 + tolerance) && c.c < swing.price) {
          const sweepSize = c.h - swing.price;
          const sweepPct  = atr > 0 ? sweepSize / atr : 0;
          sweeps.push({
            swingType:  'high',
            swingPrice: swing.price,
            wickHigh:   c.h,
            closePrice: c.c,
            idx:        candleIdx,
            sweepSize,
            sweepPct,
            recencyBars: recent.length - 1 - i,
            ts:         c.t || 0,
          });
        }
      } else {
        if (c.l < swing.price * (1 - tolerance) && c.c > swing.price) {
          const sweepSize = swing.price - c.l;
          const sweepPct  = atr > 0 ? sweepSize / atr : 0;
          sweeps.push({
            swingType:  'low',
            swingPrice: swing.price,
            wickLow:    c.l,
            closePrice: c.c,
            idx:        candleIdx,
            sweepSize,
            sweepPct,
            recencyBars: recent.length - 1 - i,
            ts:         c.t || 0,
          });
        }
      }
    });
  });

  // Sort by recency (most recent first)
  return sweeps.sort((a, b) => b.idx - a.idx);
}

// ── Equal Highs / Lows ────────────────────────────────────────────────────────

/**
 * Finds equal highs or equal lows (price within tolerance % of each other).
 * Returns enriched objects with liquidity pool strength (touch count).
 */
export function detectEqualLevels(swings, tolerance = 0.003) {
  const equals = [];
  const highs = swings.filter(s => s.type === 'high');
  const lows  = swings.filter(s => s.type === 'low');

  const findEquals = (points, type) => {
    const merged = [];
    const used   = new Set();

    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      const group = [points[i]];
      used.add(i);

      for (let j = i + 1; j < points.length; j++) {
        if (used.has(j)) continue;
        const diff = Math.abs(points[i].price - points[j].price) / points[i].price;
        if (diff < tolerance) {
          group.push(points[j]);
          used.add(j);
        }
      }

      if (group.length >= 2) {
        const avgPrice = group.reduce((a, p) => a + p.price, 0) / group.length;
        const lastIdx  = Math.max(...group.map(p => p.idx));
        merged.push({
          type,
          price:    avgPrice,
          count:    group.length,
          lastIdx,
          // Strength: more touches = higher liquidity pool
          strength: Math.min(5, group.length),
          label:    type === 'high' ? `EQH ×${group.length}` : `EQL ×${group.length}`,
        });
      }
    }
    return merged;
  };

  equals.push(...findEquals(highs, 'high'));
  equals.push(...findEquals(lows,  'low'));
  return equals;
}

// ── Displacement Candle Detection ─────────────────────────────────────────────

/**
 * Detects displacement candles — large, decisive moves that signal institutional
 * order flow. Criteria:
 *   - Body size >= atrThreshold × ATR
 *   - Close in top/bottom portion of range (strong close)
 *   - Volume >= volThreshold × avg volume (if vol available)
 *
 * Returns array of displacement events with direction and magnitude.
 */
export function detectDisplacementCandles(candles, options = {}) {
  const {
    atrThreshold = 1.5,  // body must be >= 1.5x ATR
    closeRatio   = 0.6,  // close must be in top 60% (bull) or bottom 40% (bear) of range
    volThreshold = 1.3,  // volume >= 1.3x avg (optional)
    lookback     = 30,   // bars to analyse
  } = options;

  const displacements = [];
  const slice = candles.slice(-lookback);
  if (slice.length < 10) return displacements;

  // Compute rolling ATR over the lookback window
  const atrs = [];
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i], p = slice[i-1];
    atrs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const avgAtr = atrs.length ? atrs.reduce((a, b) => a + b, 0) / atrs.length : 0;

  // Average volume
  const avgVol = slice.reduce((a, c) => a + c.v, 0) / slice.length;

  slice.forEach((c, i) => {
    if (i === 0) return;

    const body     = Math.abs(c.c - c.o);
    const range    = c.h - c.l || 0.0001;
    const isBull   = c.c > c.o;
    const isBear   = c.c < c.o;

    // Must be a decent-sized candle
    if (body < avgAtr * atrThreshold) return;

    // Strong close check
    const closePos = (c.c - c.l) / range; // 0 = at low, 1 = at high
    const strongBullClose = isBull && closePos >= closeRatio;
    const strongBearClose = isBear && closePos <= (1 - closeRatio);

    if (!strongBullClose && !strongBearClose) return;

    // Volume confirmation (soft — not required but boosts strength)
    const volMultiple = avgVol > 0 ? c.v / avgVol : 1;
    const volConfirmed = volMultiple >= volThreshold;

    const magnitude   = body / avgAtr; // how many ATRs the body is
    const dir         = isBull ? 'bull' : 'bear';
    const recencyBars = slice.length - 1 - i;
    const strength    = magnitude >= 3 ? 'extreme' : magnitude >= 2 ? 'strong' : 'moderate';

    displacements.push({
      idx:          candles.length - slice.length + i,
      ts:           c.t || 0,
      dir,
      openPrice:    c.o,
      closePrice:   c.c,
      high:         c.h,
      low:          c.l,
      body,
      magnitude,      // in ATR units — higher = more powerful
      recencyBars,
      strength,
      volConfirmed,
      volMultiple,
      // Fair Value Gap: the price gap left by the displacement
      // Bull: high of the candle before → low of the candle after (if gap exists)
      fvgHigh:      isBull ? c.h : null,
      fvgLow:       isBull ? null : c.l,
      label:        `${dir === 'bull' ? '⚡↑' : '⚡↓'} Disp ${magnitude.toFixed(1)}×ATR${volConfirmed ? ' 🔥' : ''}`,
    });
  });

  return displacements;
}

// ── Session Context ───────────────────────────────────────────────────────────

/**
 * Determines the current and recent trading session context.
 * Returns session name, open price, and whether we're in a high-probability window.
 *
 * Sessions (UTC):
 *   Tokyo:  00:00 – 09:00
 *   London: 07:00 – 16:00  (overlap with NY: 13:00-16:00 = highest volume)
 *   New York: 13:00 – 22:00
 */
export function getSessionContext(candles, nowMs = Date.now()) {
  const now   = new Date(nowMs);
  const utcH  = now.getUTCHours();
  const utcM  = now.getUTCMinutes();
  const utcMins = utcH * 60 + utcM;

  // Session windows in UTC minutes
  const SESSIONS = {
    tokyo:    { start: 0,    end: 540,  label: 'Tokyo',    color: '#a78bff' },
    london:   { start: 420,  end: 960,  label: 'London',   color: '#4da6ff' },
    ny:       { start: 780,  end: 1320, label: 'New York', color: '#00e5a0' },
    overlap:  { start: 780,  end: 960,  label: 'NY/London Overlap', color: '#ffb82e' },
  };

  // Active sessions
  const active = [];
  for (const [key, s] of Object.entries(SESSIONS)) {
    if (utcMins >= s.start && utcMins < s.end) active.push({ key, ...s });
  }

  // Session open detection (within 30 mins of open)
  const londonOpenMins  = 420;  // 07:00 UTC
  const nyOpenMins      = 780;  // 13:00 UTC
  const tokyoOpenMins   = 0;    // 00:00 UTC

  const minsFromLondon  = Math.abs(utcMins - londonOpenMins);
  const minsFromNY      = Math.abs(utcMins - nyOpenMins);
  const minsFromTokyo   = Math.min(utcMins, 1440 - utcMins); // wrap midnight

  const isNearLondonOpen = minsFromLondon <= 30;
  const isNearNYOpen     = minsFromNY     <= 30;
  const isNearTokyoOpen  = minsFromTokyo  <= 30;
  const isOverlap        = utcMins >= 780 && utcMins < 960;

  // Session open prices from candle data
  const sessionOpenPrices = {};
  if (candles.length) {
    const todayStr = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    candles.forEach(c => {
      if (!c.t) return;
      const d    = new Date(c.t);
      const dStr = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (dStr !== todayStr) return;
      const h = d.getUTCHours(), m = d.getUTCMinutes();
      const mins = h * 60 + m;
      if (mins >= 420 && mins < 435 && !sessionOpenPrices.london) sessionOpenPrices.london = c.o;
      if (mins >= 780 && mins < 795 && !sessionOpenPrices.ny)     sessionOpenPrices.ny = c.o;
      if (mins >= 0   && mins < 15  && !sessionOpenPrices.tokyo)  sessionOpenPrices.tokyo = c.o;
    });
  }

  // High-probability window label
  let sessionLabel = 'Off-Hours';
  let sessionColor = '#5a6180';
  let isHighProb   = false;

  if (isOverlap) {
    sessionLabel = 'NY/London Overlap ⭐';
    sessionColor = '#ffb82e';
    isHighProb   = true;
  } else if (active.find(s => s.key === 'ny')) {
    sessionLabel = 'New York Session';
    sessionColor = '#00e5a0';
    isHighProb   = true;
  } else if (active.find(s => s.key === 'london')) {
    sessionLabel = 'London Session';
    sessionColor = '#4da6ff';
    isHighProb   = true;
  } else if (active.find(s => s.key === 'tokyo')) {
    sessionLabel = 'Tokyo Session';
    sessionColor = '#a78bff';
    isHighProb   = false;
  }

  // Open alerts
  const openAlert = isNearLondonOpen ? { session: 'London', color: '#4da6ff', minsAway: minsFromLondon }
                  : isNearNYOpen     ? { session: 'New York', color: '#00e5a0', minsAway: minsFromNY }
                  : isNearTokyoOpen  ? { session: 'Tokyo', color: '#a78bff', minsAway: minsFromTokyo }
                  : null;

  return {
    sessionLabel,
    sessionColor,
    isHighProb,
    isOverlap,
    active,
    openAlert,          // null or { session, color, minsAway }
    sessionOpenPrices,  // { london?, ny?, tokyo? }
    utcHour: utcH,
    utcMins,
  };
}

// ── Previous Day / Session High-Low ──────────────────────────────────────────

export function getSessionLevels(candles) {
  if (!candles || candles.length === 0) return null;

  const now = new Date();
  const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()+1}-${now.getUTCDate()}`;

  const byDay = new Map();

  candles.forEach(c => {
    if (!c.t) return;
    const d = new Date(c.t);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(c);
  });

  const todayCandles = byDay.get(todayKey) || [];
  const prevKey = [...byDay.keys()]
    .filter(key => key !== todayKey)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;
  const prevCandles = prevKey ? byDay.get(prevKey) : [];

  const todayHigh = todayCandles.length ? Math.max(...todayCandles.map(c => c.h)) : null;
  const todayLow  = todayCandles.length ? Math.min(...todayCandles.map(c => c.l)) : null;
  const prevHigh  = prevCandles.length  ? Math.max(...prevCandles.map(c => c.h))  : null;
  const prevLow   = prevCandles.length  ? Math.min(...prevCandles.map(c => c.l))  : null;

  return { todayHigh, todayLow, prevHigh, prevLow, prevKey };
}

// ── Support / Resistance from Swing Clusters ──────────────────────────────────

export function buildSRZones(swings, tolerance = 0.005) {
  const zones = [];

  swings.forEach(s => {
    const existing = zones.find(z => Math.abs(z.price - s.price) / z.price < tolerance);
    if (existing) {
      existing.touches++;
      existing.price = (existing.price * (existing.touches - 1) + s.price) / existing.touches;
      existing.lastTs = Math.max(existing.lastTs, s.ts);
    } else {
      zones.push({ price: s.price, type: s.type, touches: 1, lastTs: s.ts });
    }
  });

  return zones.sort((a, b) => a.price - b.price);
}

/**
 * engine/signals.js
 * Entry quality scoring, suggestion computation, and confluence engine.
 *
 * Improvements:
 *  - volatility-adjusted scoring (atrPct gating)
 *  - higherTFConflict penalty wired in
 *  - compression/squeeze breakout detection
 *  - displacement candle bonus
 *  - session weighting (London/NY open premium)
 *  - liquidity sweep context
 */

import { getFibLevels, nearestFib, calcATR } from '../indicators/engine.js';
import { TF_MS } from '../utils/helpers.js';

// ── Volatility thresholds ─────────────────────────────────────────────────────
const ATR_PCT_SQUEEZE    = 0.3;   // below this = squeeze / compression
const ATR_PCT_NORMAL_LO  = 0.3;
const ATR_PCT_NORMAL_HI  = 3.0;
const ATR_PCT_EXTENDED   = 3.0;   // above this = overextended, reduce score

export function scoreEntryQuality({
  dir, rsi, e9, e20, e50, price, vwap, avwap,
  cvd, crossovers, tf, candles, regime,
  // New parameters — all optional for backward compatibility
  higherTFConflict = false,
  atrPct           = null,
  displacements    = [],
  liquiditySweeps  = [],
  sessionCtx       = null,
}) {
  let score = 0;
  const factors = [];

  // ── Volatility gate ───────────────────────────────────────────────────────
  // In a squeeze (very low ATR), signals are low-reliability — cap potential
  let volMultiplier = 1.0;
  if (atrPct !== null) {
    if (atrPct < ATR_PCT_SQUEEZE) {
      volMultiplier = 0.75;
      factors.push('Squeeze — low volatility, reduced conviction');
    } else if (atrPct > ATR_PCT_EXTENDED) {
      volMultiplier = 0.85;
      factors.push('High volatility — overextended range');
    }
  }

  // ── Higher TF Conflict — hard penalty applied first ──────────────────────
  if (higherTFConflict) {
    score -= 18;
    factors.push('Higher TF opposes signal ⚠');
  }

  // ── EMA Stack alignment (max 30) ─────────────────────────────────────────
  if (dir === 'long') {
    if (e9 > e20 && e20 > e50) { score += 30; factors.push('Full bullish stack'); }
    else if (e9 > e50)          { score += 15; factors.push('Price above EMA50'); }
  } else {
    if (e9 < e20 && e20 < e50) { score += 30; factors.push('Full bearish stack'); }
    else if (e9 < e50)          { score += 15; factors.push('Price below EMA50'); }
  }

  // ── RSI conditions (max 20) ───────────────────────────────────────────────
  if (dir === 'long') {
    if (rsi > 50 && rsi < 65)       { score += 20; factors.push('RSI momentum zone'); }
    else if (rsi >= 40 && rsi <= 50){ score += 12; factors.push('RSI midzone'); }
    else if (rsi < 35)               { score += 16; factors.push('RSI oversold bounce'); }
    else if (rsi >= 65)              { score -= 10; factors.push('RSI overbought'); }
  } else {
    if (rsi < 50 && rsi > 35)       { score += 20; factors.push('RSI bearish momentum'); }
    else if (rsi >= 50 && rsi <= 60){ score += 12; factors.push('RSI midzone'); }
    else if (rsi > 65)               { score += 16; factors.push('RSI overbought fade'); }
    else if (rsi <= 35)              { score -= 10; factors.push('RSI oversold'); }
  }

  // ── Price vs EMAs (max 15) ────────────────────────────────────────────────
  if (dir === 'long'  && price > e20) { score += 15; factors.push('Price > EMA20'); }
  if (dir === 'short' && price < e20) { score += 15; factors.push('Price < EMA20'); }

  // ── VWAP alignment (max 15) ───────────────────────────────────────────────
  if (vwap) {
    if (dir === 'long'  && price > vwap) { score += 15; factors.push('Price above VWAP'); }
    if (dir === 'short' && price < vwap) { score += 15; factors.push('Price below VWAP'); }
    if (dir === 'long'  && price < vwap) { score -=  8; factors.push('Below VWAP — weak long'); }
    if (dir === 'short' && price > vwap) { score -=  8; factors.push('Above VWAP — weak short'); }
  }

  // ── Anchored VWAP alignment (max 15) ─────────────────────────────────────
  if (avwap != null) {
    const distPct = Math.abs(price - avwap) / avwap * 100;

    if (dir === 'long') {
      if (price > avwap) {
        score += 10;
        factors.push('Price above session AVWAP');
        if (distPct < 0.3) { score += 5; factors.push('At AVWAP — institutional mean reversion zone'); }
      } else {
        score -= 5;
        factors.push('Below AVWAP — anchored resistance');
      }
    } else {
      if (price < avwap) {
        score += 10;
        factors.push('Price below session AVWAP');
        if (distPct < 0.3) { score += 5; factors.push('At AVWAP — institutional rejection zone'); }
      } else {
        score -= 5;
        factors.push('Above AVWAP — anchored support');
      }
    }
  }

  // ── CVD alignment (max 15) ────────────────────────────────────────────────
  if (cvd !== undefined && cvd !== null) {
    if (dir === 'long'  && cvd > 0) { score += 15; factors.push('CVD net buying'); }
    if (dir === 'short' && cvd < 0) { score += 15; factors.push('CVD net selling'); }
    if (dir === 'long'  && cvd < 0) { score -=  5; factors.push('CVD bearish divergence'); }
    if (dir === 'short' && cvd > 0) { score -=  5; factors.push('CVD bullish divergence'); }
  }

  // ── Recent crossover bonus (max 20) ──────────────────────────────────────
  if (crossovers && crossovers.length > 0) {
    const recent = crossovers[crossovers.length - 1];
    const age    = (Date.now() - recent.time) / 60_000;
    const cutoff = Math.max(30, (TF_MS[tf] || 300_000) / 60_000 * 3);
    if (recent.type === 'bull' && dir === 'long'  && age < cutoff) { score += 20; factors.push('Fresh bull cross'); }
    if (recent.type === 'bear' && dir === 'short' && age < cutoff) { score += 20; factors.push('Fresh bear cross'); }
  }

  // ── Fibonacci proximity (max 20) ─────────────────────────────────────────
  if (candles && candles.length >= 5) {
    const fibLevels = getFibLevels(candles.slice(-50));
    const nf        = nearestFib(price, fibLevels);
    if (nf) {
      const keyFibs = [0.382, 0.5, 0.618];
      const isKey   = keyFibs.includes(nf.r);
      if (nf.distPct < 1.0) {
        if (nf.r === 0.618) { score += 20; factors.push('At golden ratio 61.8%'); }
        else if (isKey && nf.r === 0.5)   { score += 15; factors.push('At 50% retracement'); }
        else if (isKey && nf.r === 0.382) { score += 12; factors.push('At 38.2% retracement'); }
        else if (nf.r === 0 || nf.r === 1){ score +=  5; factors.push('At fib extreme'); }
      } else if (nf.distPct < 2.5 && isKey) {
        score += 6; factors.push('Near fib ' + nf.label);
      }
      if (dir === 'long'  && nf.r <= 0.1 && nf.distPct < 2) { score -= 12; factors.push('Near fib top — extended'); }
      if (dir === 'short' && nf.r >= 0.9 && nf.distPct < 2) { score -= 12; factors.push('Near fib bottom — extended'); }
    }
  }

  // ── Regime bonus/penalty (max 15, min -15) ────────────────────────────────
  if (regime) {
    if (regime.type === 'trending') {
      if ((regime.dir === 'bull' && dir === 'long') || (regime.dir === 'bear' && dir === 'short')) {
        score += 15; factors.push('With-trend in trending regime');
      } else if (regime.dir !== 'neutral') {
        score -= 15; factors.push('Counter-trend in trending regime');
      }
    } else if (regime.type === 'choppy') {
      score -= 10; factors.push('Choppy regime — low reliability');
    } else if (regime.type === 'ranging') {
      score += 0; factors.push('Ranging regime');
    }
  }

  // ── Displacement candle bonus (max 15) ────────────────────────────────────
  // Recent displacement in signal direction = institutional momentum confirmation
  if (displacements && displacements.length > 0) {
    const signalDispDir = dir === 'long' ? 'bull' : 'bear';
    const recentDisp = displacements
      .filter(d => d.recencyBars !== undefined ? d.recencyBars <= 5 : true)
      .slice(0, 3);

    const alignedDisp = recentDisp.find(d => d.dir === signalDispDir);
    if (alignedDisp) {
      const bonus = Math.min(15, Math.round(alignedDisp.magnitude * 5));
      score += bonus;
      factors.push(`Displacement candle ${alignedDisp.magnitude.toFixed(1)}×ATR${alignedDisp.volConfirmed ? ' + vol' : ''}`);
    }

    const opposingDisp = recentDisp.find(d => d.dir !== signalDispDir);
    if (opposingDisp && !alignedDisp) {
      score -= 8;
      factors.push('Recent displacement against signal');
    }
  }

  // ── Liquidity sweep context (max 12) ─────────────────────────────────────
  // A sweep of lows followed by a bull signal = classic stop hunt + reversal
  if (liquiditySweeps && liquiditySweeps.length > 0) {
    const recentSweeps = liquiditySweeps.filter(s => s.recencyBars <= 8);
    const sweepOfLows  = recentSweeps.find(s => s.swingType === 'low');
    const sweepOfHighs = recentSweeps.find(s => s.swingType === 'high');

    if (dir === 'long'  && sweepOfLows) {
      score += 12;
      factors.push('Liquidity sweep of lows — stop hunt reversal setup');
    }
    if (dir === 'short' && sweepOfHighs) {
      score += 12;
      factors.push('Liquidity sweep of highs — stop hunt reversal setup');
    }
  }

  // ── Session weighting (max 10) ────────────────────────────────────────────
  if (sessionCtx) {
    if (sessionCtx.isOverlap) {
      score += 10;
      factors.push('NY/London overlap — highest liquidity window');
    } else if (sessionCtx.isHighProb) {
      score += 6;
      factors.push(`${sessionCtx.sessionLabel} — active session`);
    }

    // Session open bonus — first 30 mins of London/NY open are high-probability
    if (sessionCtx.openAlert) {
      const { session, minsAway } = sessionCtx.openAlert;
      if (minsAway <= 15) {
        score += 8;
        factors.push(`${session} open in ${minsAway}m — prime window`);
      } else if (minsAway <= 30) {
        score += 4;
        factors.push(`${session} open nearby`);
      }
    }
  }

  // ── Apply volatility multiplier to raw score additions ───────────────────
  // (We do this at the end on the positive portion only — don't amplify penalties)
  if (volMultiplier < 1.0) {
    const penalty = Math.round((1 - volMultiplier) * Math.max(0, score) * 0.25);
    score -= penalty;
  }

  score = Math.max(0, Math.min(100, score));

  let label, cls;
  if (score >= 75)      { label = '★ PRIME ENTRY'; cls = 'strong-' + dir; }
  else if (score >= 50) { label = '◆ GOOD SETUP';  cls = dir === 'long' ? 'strong-long' : 'strong-short'; }
  else if (score >= 30) { label = '◇ WEAK SETUP';  cls = 'weak'; }
  else                  { label = '○ WAIT';         cls = 'none'; }

  return { score, label, cls, factors };
}

export function computeSuggestion({ e9, e20, e50, livePrice, rsi, rrRatio, tf, candles, vwap, avwap, regime }) {
  if (!e9 || !e20 || !e50 || candles.length < 50 || !livePrice) return null;

  const bullish   = e9 > e20 && e20 > e50;
  const bearish   = e9 < e20 && e20 < e50;
  const aboveVwap = vwap ? livePrice > vwap : null;

  const atr = calcATR(candles, 14) || livePrice * 0.005;

  const candleMs    = TF_MS[tf] || 300_000;
  const lookback24h = Math.max(5, Math.min(candles.length, Math.round(86_400_000 / candleMs)));
  const recent      = candles.slice(-lookback24h);

  const localN      = Math.min(5, candles.length);
  const localCandles= candles.slice(-localN);
  const localLow    = Math.min(...localCandles.map(c => c.l));
  const localHigh   = Math.max(...localCandles.map(c => c.h));

  const fibLevels = getFibLevels(candles.slice(-50));
  const nfib = nearestFib(livePrice, fibLevels);
  let fibNote = '';
  if (nfib && nfib.distPct < 2.0 && [0.236, 0.382, 0.5, 0.618].includes(nfib.r)) {
    fibNote = ` Price at ${nfib.label} Fib retracement (${nfib.price.toFixed(4)}) — key pullback zone.`;
  }

  const vwapNote = (aboveVwap !== null)
    ? (aboveVwap ? ' Price above VWAP — confirms bias.' : ' ⚠ Price below VWAP — weaker setup.')
    : '';

  let avwapNote = '';
  if (avwap != null) {
    const aboveAvwap = livePrice > avwap;
    const avwapFmt   = avwap.toFixed(avwap >= 1000 ? 2 : avwap >= 1 ? 4 : 6);
    avwapNote = aboveAvwap
      ? ` Price above session AVWAP (${avwapFmt}) — anchored mean supports longs.`
      : ` ⚠ Price below session AVWAP (${avwapFmt}) — selling pressure from anchored mean.`;
  }

  let dir, entry, stop, target, reason;

  if (bullish && rsi < 65) {
    dir   = 'long';
    entry = livePrice;
    const stopCandidates = [e20, localLow];
    if (avwap != null && livePrice > avwap) stopCandidates.push(avwap);
    stop   = Math.min(...stopCandidates) * 0.9995;
    target = entry + (entry - stop) * rrRatio;
    reason = `Bullish EMA stack (9>${e9.toFixed(4)} > 20>${e20.toFixed(4)} > 50>${e50.toFixed(4)}). RSI ${Math.round(rsi)} — momentum intact.${vwapNote}${avwapNote}${fibNote} SL below EMA20 / 5-candle low${avwap != null && livePrice > avwap ? ' / AVWAP' : ''}.`;

  } else if (bearish && rsi > 35) {
    dir   = 'short';
    entry = livePrice;
    const stopCandidates = [e20, localHigh];
    if (avwap != null && livePrice < avwap) stopCandidates.push(avwap);
    stop   = Math.max(...stopCandidates) * 1.0005;
    target = entry - (stop - entry) * rrRatio;
    reason = `Bearish EMA stack (9<${e9.toFixed(4)} < 20<${e20.toFixed(4)} < 50<${e50.toFixed(4)}). RSI ${Math.round(rsi)} — downside pressure.${vwapNote}${avwapNote}${fibNote} SL above EMA20 / 5-candle high${avwap != null && livePrice < avwap ? ' / AVWAP' : ''}.`;

  } else if (rsi < 35 && e9 > e50) {
    dir    = 'long';
    entry  = livePrice;
    stop   = localLow * 0.999;
    target = entry + (entry - stop) * rrRatio;
    reason = `RSI oversold at ${Math.round(rsi)} while price holds above EMA50. Mean-reversion bounce setup.${avwapNote} SL below 5-candle low.`;

  } else if (rsi > 65 && e9 < e50) {
    dir    = 'short';
    entry  = livePrice;
    stop   = localHigh * 1.001;
    target = entry - (stop - entry) * rrRatio;
    reason = `RSI overbought at ${Math.round(rsi)} with EMA9 below EMA50. Fade setup.${avwapNote} SL above 5-candle high.`;

  } else {
    const fallbackDir = e9 >= e50 ? 'long' : 'short';
    dir    = fallbackDir;
    entry  = livePrice;
    stop   = fallbackDir === 'long'
      ? Math.min(e20, e50) * 0.999
      : Math.max(e20, e50) * 1.001;
    target = fallbackDir === 'long'
      ? entry + (entry - stop) * rrRatio
      : entry - (stop - entry) * rrRatio;
    reason = `EMAs are tangled — low conviction. Waiting for EMA9/20 to separate cleanly. Using current price with a neutral-bias stop.${avwapNote}`;
  }

  return { dir, entry, stop, target, reason };
}

// ── Compression / Squeeze Breakout Detection ──────────────────────────────────

/**
 * Detects volatility compression (squeeze) and potential breakout direction.
 * Uses ATR ratio and price range relative to recent history.
 *
 * Returns:
 *  { inSqueeze, breakoutDir, strength, atrRatio, label }
 *  or null if insufficient data.
 */
export function detectSqueezeBreakout(candles, options = {}) {
  const {
    atrPeriod    = 14,
    lookback     = 20,
    squeezeRatio = 0.5,   // current ATR < squeezeRatio * max ATR over lookback
    breakoutRatio= 1.5,   // current candle body > breakoutRatio * ATR
  } = options;

  if (!candles || candles.length < lookback + atrPeriod) return null;

  // Compute ATR values over the lookback window
  const atrs = [];
  for (let i = Math.max(1, candles.length - lookback - atrPeriod); i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (p) atrs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  if (atrs.length < atrPeriod) return null;

  // Current ATR (last period bars)
  const recentAtrs = atrs.slice(-atrPeriod);
  const currentAtr = recentAtrs.reduce((a, b) => a + b, 0) / recentAtrs.length;

  // Historical max ATR over lookback
  const maxAtr = Math.max(...atrs);
  const minAtr = Math.min(...atrs);

  // ATR ratio (compression indicator)
  const atrRatio = maxAtr > 0 ? currentAtr / maxAtr : 1;

  const inSqueeze = atrRatio < squeezeRatio;

  if (!inSqueeze) return { inSqueeze: false, atrRatio, label: null };

  // Check last candle for breakout signal
  const last  = candles[candles.length - 1];
  const prev  = candles[candles.length - 2];
  const body  = Math.abs(last.c - last.o);
  const range = last.h - last.l;

  const isBullBreakout = last.c > last.o && body > currentAtr * breakoutRatio && last.c > prev.h;
  const isBearBreakout = last.c < last.o && body > currentAtr * breakoutRatio && last.c < prev.l;

  let breakoutDir = null;
  let label = `⟨⟩ Squeeze (ATR at ${Math.round(atrRatio * 100)}% of range)`;

  if (isBullBreakout) {
    breakoutDir = 'bull';
    label = `⟨↑⟩ Squeeze Breakout LONG — ATR expanding`;
  } else if (isBearBreakout) {
    breakoutDir = 'bear';
    label = `⟨↓⟩ Squeeze Breakout SHORT — ATR expanding`;
  }

  // Strength: how compressed the squeeze is
  const strength = Math.round((1 - atrRatio) * 100);

  return {
    inSqueeze:   true,
    breakoutDir,
    strength,
    atrRatio,
    currentAtr,
    maxAtr,
    minAtr,
    label,
  };
}

export function computeEntryZones({ e9, e20, livePrice, suggestion, atr }) {
  if (!e9 || !e20 || !livePrice) return null;

  const dir    = suggestion?.dir || 'long';
  const isLong = dir === 'long';
  const fallbackAtr = atr || livePrice * 0.005;

  let z1, z2, z3;

  if (isLong) {
    const candidates = [e9, (e9 + e20) / 2, e20].filter(v => v < livePrice).sort((a, b) => b - a);
    z1 = candidates[0] ?? livePrice - fallbackAtr * 0.5;
    z2 = candidates[1] ?? livePrice - fallbackAtr * 1.0;
    z3 = candidates[2] ?? livePrice - fallbackAtr * 1.5;
    if (z2 >= z1) z2 = z1 - fallbackAtr * 0.5;
    if (z3 >= z2) z3 = z2 - fallbackAtr * 0.5;
  } else {
    const candidates = [e9, (e9 + e20) / 2, e20].filter(v => v > livePrice).sort((a, b) => a - b);
    z1 = candidates[0] ?? livePrice + fallbackAtr * 0.5;
    z2 = candidates[1] ?? livePrice + fallbackAtr * 1.0;
    z3 = candidates[2] ?? livePrice + fallbackAtr * 1.5;
    if (z2 <= z1) z2 = z1 + fallbackAtr * 0.5;
    if (z3 <= z2) z3 = z2 + fallbackAtr * 0.5;
  }

  const stop = isLong ? z3 * 0.999 : z3 * 1.001;

  return { aggressive: z1, balanced: z2, conservative: z3, dir, stop };
}

export function calcAtrPositionSize({ capital, riskPct, entry, atr, atrMultiple = 2 }) {
  if (!capital || !riskPct || !entry || !atr) return null;

  const riskUSD       = capital * (riskPct / 100);
  const stopDistAbs   = atr * atrMultiple;
  const stopDistPct   = (stopDistAbs / entry) * 100;
  const tokens        = stopDistAbs > 0 ? riskUSD / stopDistAbs : 0;
  const positionValue = tokens * entry;

  return { riskUSD, stopDistPct, stopDistAbs, tokens, positionValue, atrMultiple };
}

export function computePartialTPs({ entry, stop, dir }) {
  if (!entry || !stop || entry === stop) return null;
  const risk   = Math.abs(entry - stop);
  const isLong = dir === 'long';
  return [1, 2, 3].map(n => {
    const tp  = isLong ? entry + risk * n : entry - risk * n;
    const pct = Math.abs((tp - entry) / entry * 100);
    return { n, tp, pct, label: `TP${n} · 1:${n}` };
  });
}

/**
 * indicators/engine.js
 * Pure indicator math — no DOM, no state mutations.
 * All functions are stateless (take inputs, return outputs).
 * Stateful versions (streaming) accept+return state objects.
 */

// ── EMA ───────────────────────────────────────────────────────────────────────

/** One-step EMA update */
export const updEMA = (prev, v, k) => prev === null ? v : v * k + prev * (1 - k);

/** EMA multiplier */
export const emaK = period => 2 / (period + 1);

/**
 * Full EMA array from closes array.
 * Returns array same length as closes.
 */
export function calcEMAArray(closes, period) {
  const k = emaK(period);
  let state = null;
  return closes.map(v => {
    state = state === null ? v : v * k + state * (1 - k);
    return state;
  });
}

// ── Wilder RSI (Wilder's Smoothed Moving Average) ─────────────────────────────

/**
 * Stateful RSI — takes previous state, returns { rsi, avgGain, avgLoss }.
 * Accumulates 14 seed bars before emitting a value.
 */
export function calcWilderRSI(close, prevClose, rsiState) {
  if (prevClose === null) return { rsi: null, ...rsiState };

  const ch   = close - prevClose;
  const gain = Math.max(0, ch);
  const loss = Math.max(0, -ch);

  if (rsiState.avgGain === null) {
    // Accumulate seed values
    const gains  = [...(rsiState._gains  || []), gain];
    const losses = [...(rsiState._losses || []), loss];
    if (gains.length === 14) {
      const ag = gains.reduce((a,b) => a+b, 0) / 14;
      const al = losses.reduce((a,b) => a+b, 0) / 14;
      const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      return { rsi, avgGain: ag, avgLoss: al, _gains: [], _losses: [] };
    }
    return { rsi: null, avgGain: null, avgLoss: null, _gains: gains, _losses: losses };
  }

  const ag = (rsiState.avgGain * 13 + gain) / 14;
  const al = (rsiState.avgLoss * 13 + loss) / 14;
  const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  return { rsi, avgGain: ag, avgLoss: al, _gains: [], _losses: [] };
}

/**
 * Full Wilder RSI array from closes.
 * Returns array same length as closes (nulls for first 14).
 */
export function calcRSIArray(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const result = Array(period).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i-1];
    gains  += Math.max(0, ch);
    losses += Math.max(0, -ch);
  }
  let ag = gains / period, al = losses / period;
  result.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i-1];
    ag = (ag * (period - 1) + Math.max(0, ch))  / period;
    al = (al * (period - 1) + Math.max(0, -ch)) / period;
    result.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return result;
}

// ── ATR (Average True Range) ──────────────────────────────────────────────────

/**
 * Returns the average ATR over the last `period` candles.
 */
export function calcATR(candles, period = 14) {
  if (!candles || candles.length < 2) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
  });
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

/**
 * Full ATR array — Wilder's smoothed ATR.
 */
export function calcATRArray(candles, period = 14) {
  if (candles.length < 2) return [];
  const result = [null]; // first candle has no ATR
  let atr = null;
  for (let i = 1; i < candles.length; i++) {
    const c    = candles[i];
    const prev = candles[i - 1];
    const tr   = Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
    if (i < period) {
      result.push(null);
    } else if (i === period) {
      // Seed: simple average of first `period` TRs
      const sum = candles.slice(1, period + 1).reduce((a, cc, j) => {
        const pp = candles[j];
        return a + Math.max(cc.h - cc.l, Math.abs(cc.h - pp.c), Math.abs(cc.l - pp.c));
      }, 0);
      atr = sum / period;
      result.push(atr);
    } else {
      atr = (atr * (period - 1) + tr) / period;
      result.push(atr);
    }
  }
  return result;
}

// ── MACD ──────────────────────────────────────────────────────────────────────

/**
 * Returns { macd, signal, histogram } arrays.
 */
export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMAArray(closes, fast);
  const emaSlow = calcEMAArray(closes, slow);
  const macd    = emaFast.map((v, i) => (emaSlow[i] !== null && v !== null) ? v - emaSlow[i] : null);
  const validMacd = macd.filter(v => v !== null);
  const signalLine = calcEMAArray(validMacd, signal);
  // Pad signal line to match macd length
  const signalPadded = Array(macd.length - signalLine.length).fill(null).concat(signalLine);
  const histogram = macd.map((v, i) => (v !== null && signalPadded[i] !== null) ? v - signalPadded[i] : null);
  return { macd, signal: signalPadded, histogram };
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────

export function calcBollingerBands(closes, period = 20, multiplier = 2) {
  const result = closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    const mean  = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std   = Math.sqrt(variance);
    return { mid: mean, upper: mean + multiplier * std, lower: mean - multiplier * std };
  });
  return result;
}

// ── VWAP (Session) ────────────────────────────────────────────────────────────

/**
 * Stateful VWAP + Welford bands update.
 * Returns updated state + { vwap, bands }.
 */
export function updVWAP(candle, state) {
  let { cumPV, cumV, m2, sessionKey } = state;

  // Session reset
  if (candle.t) {
    const d = new Date(candle.t);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
    if (key !== sessionKey) {
      cumPV = 0; cumV = 0; m2 = 0; sessionKey = key;
    }
  }

  const tp      = (candle.h + candle.l + candle.c) / 3;
  const oldVwap = cumV > 0 ? cumPV / cumV : tp;
  cumPV += tp * candle.v;
  cumV  += candle.v;
  const vwap    = cumV > 0 ? cumPV / cumV : tp;
  m2    += candle.v * (tp - oldVwap) * (tp - vwap);

  const variance = cumV > 0 ? Math.max(0, m2 / cumV) : 0;
  const sd       = Math.sqrt(variance);
  const bands    = { v1u: vwap + sd, v1l: vwap - sd, v2u: vwap + 2*sd, v2l: vwap - 2*sd };

  return { newState: { cumPV, cumV, m2, sessionKey }, vwap, bands };
}

/** Compute live (uncommitted candle) VWAP */
export function computeLiveVwap(currentCandle, vwapState, lastVwap, vwapSessionKey) {
  if (!currentCandle) return lastVwap;
  const { cumPV, cumV } = vwapState;
  const tp = (currentCandle.h + currentCandle.l + currentCandle.c) / 3;
  const liveCumV = cumV + Math.max(0, currentCandle.v || 0);
  if (!currentCandle.t) {
    return liveCumV > 0 ? (cumPV + tp * Math.max(0, currentCandle.v || 0)) / liveCumV : tp;
  }
  const d   = new Date(currentCandle.t);
  const key = `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
  if (key !== vwapSessionKey) return tp;
  if (liveCumV <= 0) return tp;
  return (cumPV + tp * Math.max(0, currentCandle.v || 0)) / liveCumV;
}

/** Compute live VWAP bands using Welford's running M2 */
export function computeLiveBands(currentCandle, vwapState, liveVwap) {
  if (!liveVwap || !currentCandle) return null;
  const { cumPV, cumV, m2 } = vwapState;
  const tp       = (currentCandle.h + currentCandle.l + currentCandle.c) / 3;
  const vol      = Math.max(0, currentCandle.v || 0);
  const oldVwap  = cumV > 0 ? cumPV / cumV : tp;
  const liveM2   = m2 + vol * (tp - oldVwap) * (tp - liveVwap);
  const liveCumV = cumV + vol;
  const variance = liveCumV > 0 ? Math.max(0, liveM2 / liveCumV) : 0;
  const sd       = Math.sqrt(variance);
  return { v1u: liveVwap + sd, v1l: liveVwap - sd, v2u: liveVwap + 2*sd, v2l: liveVwap - 2*sd };
}

// ── CVD (Cumulative Volume Delta) ─────────────────────────────────────────────

/** Heuristic CVD delta for one candle (when real trade stream unavailable) */
export function candleDelta(c) {
  const range = c.h - c.l || 0.0001;
  return c.v * (2 * c.c - c.h - c.l) / range;
}

/**
 * Stateful CVD update.
 * Returns { newRunning, newEmaRun, delta }.
 */
export function updCVD(candle, running, emaRun, CVD_EMA_K, resetMode, sessionKey) {
  let newRunning    = running;
  let newSessionKey = sessionKey;

  if (resetMode === 'daily' && candle.t) {
    const d  = new Date(candle.t);
    const dk = `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
    if (dk !== sessionKey) { newRunning = 0; newSessionKey = dk; }
  }

  const delta = candle._realDelta !== undefined && candle._realDelta !== null
    ? candle._realDelta
    : candleDelta(candle);

  newRunning += delta;
  const newEmaRun = emaRun === null ? newRunning : newRunning * CVD_EMA_K + emaRun * (1 - CVD_EMA_K);

  return { newRunning, newEmaRun, newSessionKey, delta };
}

// ── Volume Profile ────────────────────────────────────────────────────────────

export function calcVolumeProfile(candles, bins = 24) {
  if (!candles.length) return null;
  const pMin = Math.min(...candles.map(c => c.l));
  const pMax = Math.max(...candles.map(c => c.h));
  const step = (pMax - pMin) / bins || 0.001;
  const profile = Array(bins).fill(0);

  candles.forEach(c => {
    const bin = Math.min(bins - 1, Math.floor((c.c - pMin) / step));
    profile[bin] += c.v;
  });

  const maxVol  = Math.max(...profile) || 1;
  const pocBin  = profile.indexOf(maxVol);
  const poc     = pMin + step * (pocBin + 0.5);
  const totalVol= profile.reduce((a, b) => a + b, 0);

  // Value Area: bins summing to 70% of total volume
  const vaTarget = totalVol * 0.7;
  const sorted   = profile.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  let acc = 0;
  const vaBins = new Set();
  for (const { v, i } of sorted) {
    acc += v; vaBins.add(i);
    if (acc >= vaTarget) break;
  }
  const vaBinArr = [...vaBins].sort((a, b) => a - b);
  const vah = pMin + step * (Math.max(...vaBinArr) + 1);
  const val = pMin + step * Math.min(...vaBinArr);

  return { poc, vah, val, profile, pMin, pMax, step, bins };
}

// ── Fibonacci ─────────────────────────────────────────────────────────────────

const FIB_RATIOS = [
  { r: 0,     label: '0%'    },
  { r: 0.236, label: '23.6%' },
  { r: 0.382, label: '38.2%' },
  { r: 0.5,   label: '50%'   },
  { r: 0.618, label: '61.8%' },
  { r: 1,     label: '100%'  },
];

export function getFibLevels(candles) {
  if (!candles || candles.length < 5) return null;
  const hi = Math.max(...candles.map(c => c.h));
  const lo = Math.min(...candles.map(c => c.l));
  const range = hi - lo;
  if (range === 0) return null;
  return FIB_RATIOS.map(f => ({ ...f, price: hi - range * f.r }));
}

export function nearestFib(price, fibLevels) {
  if (!fibLevels) return null;
  let best = null, bestDist = Infinity;
  fibLevels.forEach(f => {
    const dist = Math.abs(price - f.price);
    if (dist < bestDist) { bestDist = dist; best = f; }
  });
  const range = fibLevels[0].price - fibLevels[fibLevels.length - 1].price;
  const distPct = range > 0 ? (bestDist / range) * 100 : 100;

  const tier = (best.r === 0.618 || best.r === 0.5 || best.r === 0.382)
    ? (best.r === 0.618 ? 'gold' : 'key')
    : 'minor';

  return { ...best, distPct, tier };
}

// ── Divergence ────────────────────────────────────────────────────────────────

export function detectRSIDivergence(candles, rsiVals) {
  const pairs = [];
  const total = Math.min(candles.length, rsiVals.length);
  for (let i = total - 1; i >= 0 && pairs.length < 30; i--) {
    if (rsiVals[i] !== null) pairs.unshift({ c: candles[i], r: rsiVals[i] });
  }
  const n = pairs.length;
  if (n < 12) return null;
  const h = Math.floor(n / 2);
  const early = pairs.slice(0, h), late = pairs.slice(h);
  const ePH = Math.max(...early.map(p => p.c.h)), lPH = Math.max(...late.map(p => p.c.h));
  const ePL = Math.min(...early.map(p => p.c.l)), lPL = Math.min(...late.map(p => p.c.l));
  const eRH = Math.max(...early.map(p => p.r)),   lRH = Math.max(...late.map(p => p.r));
  const eRL = Math.min(...early.map(p => p.r)),   lRL = Math.min(...late.map(p => p.r));
  if (lPH > ePH * 1.001 && lRH < eRH * 0.999) return 'bear';
  if (lPL < ePL * 0.999 && lRL > eRL * 1.001) return 'bull';
  return null;
}

export function detectCVDDivergence(candles, cvdVals) {
  const n = Math.min(candles.length, 30);
  if (n < 12) return null;
  const h  = Math.floor(n / 2);
  const eC = candles.slice(-n, -h), lC = candles.slice(-h);
  const eD = cvdVals.slice(-n, -h),  lD = cvdVals.slice(-h);
  if (!eD.length || !lD.length) return null;
  const ePH = Math.max(...eC.map(c => c.h)), lPH = Math.max(...lC.map(c => c.h));
  const ePL = Math.min(...eC.map(c => c.l)), lPL = Math.min(...lC.map(c => c.l));
  const eDH = Math.max(...eD), lDH = Math.max(...lD);
  const eDL = Math.min(...eD), lDL = Math.min(...lD);
  if (lPH > ePH * 1.001 && lDH < eDH * 0.999) return 'bear';
  if (lPL < ePL * 0.999 && lDL > eDL * 1.001) return 'bull';
  return null;
}

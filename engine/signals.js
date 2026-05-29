/**
 * engine/signals.js
 * Entry quality scoring, suggestion computation, and confluence engine.
 * Extracted from the monolith and enhanced with regime + structure context.
 */

import { getFibLevels, nearestFib, calcATR } from '../indicators/engine.js';
import { TF_MS } from '../utils/helpers.js';

// ── Entry Quality Scorer ──────────────────────────────────────────────────────

/**
 * Scores a potential entry 0–100 based on multiple confluence factors.
 *
 * @param {object} params
 * @param {string}  params.dir          - 'long' | 'short'
 * @param {number}  params.rsi
 * @param {number}  params.e9
 * @param {number}  params.e20
 * @param {number}  params.e50
 * @param {number}  params.price        - current live price
 * @param {number}  params.vwap         - rolling session VWAP
 * @param {number|null} params.avwap    - anchored VWAP (null when no anchor set)
 * @param {number}  params.cvd
 * @param {Array}   params.crossovers
 * @param {string}  params.tf
 * @param {Array}   params.candles
 * @param {object}  params.regime
 * @returns {{ score: number, label: string, cls: string, factors: string[] }}
 */
export function scoreEntryQuality({
  dir, rsi, e9, e20, e50, price, vwap, avwap,
  cvd, crossovers, tf, candles, regime
}) {
  let score = 0;
  const factors = [];

  // 1. EMA Stack alignment (max 30)
  if (dir === 'long') {
    if (e9 > e20 && e20 > e50) { score += 30; factors.push('Full bullish stack'); }
    else if (e9 > e50)          { score += 15; factors.push('Price above EMA50'); }
  } else {
    if (e9 < e20 && e20 < e50) { score += 30; factors.push('Full bearish stack'); }
    else if (e9 < e50)          { score += 15; factors.push('Price below EMA50'); }
  }

  // 2. RSI conditions (max 20)
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

  // 3. Price vs EMAs (max 15)
  if (dir === 'long'  && price > e20) { score += 15; factors.push('Price > EMA20'); }
  if (dir === 'short' && price < e20) { score += 15; factors.push('Price < EMA20'); }

  // 4. VWAP alignment (max 15)
  if (vwap) {
    if (dir === 'long'  && price > vwap) { score += 15; factors.push('Price above VWAP'); }
    if (dir === 'short' && price < vwap) { score += 15; factors.push('Price below VWAP'); }
    if (dir === 'long'  && price < vwap) { score -=  8; factors.push('Below VWAP — weak long'); }
    if (dir === 'short' && price > vwap) { score -=  8; factors.push('Above VWAP — weak short'); }
  }

  if (avwap != null) {
    const distPct = Math.abs(price - avwap) / avwap * 100;

    if (dir === 'long') {
      if (price > avwap) {
        score += 10;
        factors.push('Price above session AVWAP');
      } else {
        score -= 5;
        factors.push('Below AVWAP — anchored resistance');
      }
      // Bonus: price pulling back tightly to AVWAP = high-quality bounce zone
      if (distPct < 0.3 && price >= avwap) {
        score += 5;
        factors.push('At AVWAP — institutional mean reversion zone');
      }
    } else {
      if (price < avwap) {
        score += 10;
        factors.push('Price below session AVWAP');
      } else {
        score -= 5;
        factors.push('Above AVWAP — anchored support');
      }
      // Bonus: price rejecting at AVWAP from below
      if (distPct < 0.3 && price <= avwap) {
        score += 5;
        factors.push('At AVWAP — institutional rejection zone');
      }
    }
  }

  // 5. CVD alignment (max 15)
  if (cvd !== undefined && cvd !== null) {
    if (dir === 'long'  && cvd > 0) { score += 15; factors.push('CVD net buying'); }
    if (dir === 'short' && cvd < 0) { score += 15; factors.push('CVD net selling'); }
    if (dir === 'long'  && cvd < 0) { score -=  5; factors.push('CVD bearish divergence'); }
    if (dir === 'short' && cvd > 0) { score -=  5; factors.push('CVD bullish divergence'); }
  }

  // 6. Recent crossover bonus (max 20)
  if (crossovers && crossovers.length > 0) {
    const recent = crossovers[crossovers.length - 1];
    const age    = (Date.now() - recent.time) / 60_000;
    const cutoff = Math.max(30, (TF_MS[tf] || 300_000) / 60_000 * 3);
    if (recent.type === 'bull' && dir === 'long'  && age < cutoff) { score += 20; factors.push('Fresh bull cross'); }
    if (recent.type === 'bear' && dir === 'short' && age < cutoff) { score += 20; factors.push('Fresh bear cross'); }
  }

  // 7. Fibonacci proximity (max 20)
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

  // 8. Regime bonus/penalty (max 15, min -15)
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

  score = Math.max(0, Math.min(100, score));

  let label, cls;
  if (score >= 75)      { label = '★ PRIME ENTRY'; cls = 'strong-' + dir; }
  else if (score >= 50) { label = '◆ GOOD SETUP';  cls = dir === 'long' ? 'strong-long' : 'strong-short'; }
  else if (score >= 30) { label = '◇ WEAK SETUP';  cls = 'weak'; }
  else                  { label = '○ WAIT';         cls = 'none'; }

  return { score, label, cls, factors };
}

// ── Suggestion Engine ─────────────────────────────────────────────────────────

/**
 * Computes framework entry suggestion from current indicators.
 *
 * @param {object} params
 * @param {number|null} params.avwap - anchored VWAP value (null when not set)
 * @returns {{ dir, entry, stop, target, reason }}
 */
export function computeSuggestion({ e9, e20, e50, livePrice, rsi, rrRatio, tf, candles, vwap, avwap, regime }) {
  if (!e9 || !e20 || !e50 || candles.length < 50 || !livePrice) return null;

  const bullish   = e9 > e20 && e20 > e50;
  const bearish   = e9 < e20 && e20 < e50;
  const aboveVwap = vwap ? livePrice > vwap : null;

  // ATR-based stop cushion
  const atr = calcATR(candles, 14) || livePrice * 0.005;

  // Time-based lookback (~24h worth of candles, floored at 5)
  const candleMs    = TF_MS[tf] || 300_000;
  const lookback24h = Math.max(5, Math.min(candles.length, Math.round(86_400_000 / candleMs)));
  const recent      = candles.slice(-lookback24h);

  // Local 5-candle structure
  const localN      = Math.min(5, candles.length);
  const localCandles= candles.slice(-localN);
  const localLow    = Math.min(...localCandles.map(c => c.l));
  const localHigh   = Math.max(...localCandles.map(c => c.h));

  // Fib note
  const fibLevels = getFibLevels(candles.slice(-50));
  const nfib = nearestFib(livePrice, fibLevels);
  let fibNote = '';
  if (nfib && nfib.distPct < 2.0 && [0.236, 0.382, 0.5, 0.618].includes(nfib.r)) {
    fibNote = ` Price at ${nfib.label} Fib retracement (${nfib.price.toFixed(4)}) — key pullback zone.`;
  }

  // VWAP note
  const vwapNote = (aboveVwap !== null)
    ? (aboveVwap ? ' Price above VWAP — confirms bias.' : ' ⚠ Price below VWAP — weaker setup.')
    : '';

  // AVWAP note — only present when an anchor is active
  let avwapNote = '';
  if (avwap != null) {
    const aboveAvwap = livePrice > avwap;
    const avwapFmt   = avwap.toFixed(avwap >= 1000 ? 2 : avwap >= 1 ? 4 : 6);
    if (aboveAvwap) {
      avwapNote = ` Price above session AVWAP (${avwapFmt}) — anchored mean supports longs.`;
    } else {
      avwapNote = ` ⚠ Price below session AVWAP (${avwapFmt}) — selling pressure from anchored mean.`;
    }
  }

  let dir, entry, stop, target, reason;

  if (bullish && rsi < 65) {
    dir   = 'long';
    entry = livePrice;

    // When price is above AVWAP on a confirmed long, use AVWAP as an additional
    // stop candidate — it often acts as the most meaningful dynamic support.
    const stopCandidates = [e20, localLow];
    if (avwap != null && livePrice > avwap) stopCandidates.push(avwap);
    stop   = Math.min(...stopCandidates) * 0.9995;

    target = entry + (entry - stop) * rrRatio;
    reason = `Bullish EMA stack (9>${e9.toFixed(4)} > 20>${e20.toFixed(4)} > 50>${e50.toFixed(4)}). RSI ${Math.round(rsi)} — momentum intact.${vwapNote}${avwapNote}${fibNote} SL below EMA20 / 5-candle low${avwap != null && livePrice > avwap ? ' / AVWAP' : ''}.`;

  } else if (bearish && rsi > 35) {
    dir   = 'short';
    entry = livePrice;

    // Mirror: when price is below AVWAP on a short, AVWAP becomes an additional
    // resistance reference for stop placement.
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
    dir    = 'long';
    entry  = e9;
    stop   = e50 * 0.999;
    target = entry + (entry - stop) * rrRatio;
    reason = `EMAs are tangled — low conviction. Waiting for EMA9/20 to separate cleanly. Tentative levels shown near EMA9.${avwapNote}`;
  }

  return { dir, entry, stop, target, reason };
}

// ── Entry Zones ───────────────────────────────────────────────────────────────

/**
 * Computes the three smart entry zones (aggressive/balanced/conservative)
 * based on EMAs and ATR spacing.
 */
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

// ── ATR Position Sizing ───────────────────────────────────────────────────────

/**
 * Calculates ATR-based position size from risk parameters.
 * @param {object} params
 * @returns {PositionSize}
 */
export function calcAtrPositionSize({ capital, riskPct, entry, atr, atrMultiple = 2 }) {
  if (!capital || !riskPct || !entry || !atr) return null;

  const riskUSD       = capital * (riskPct / 100);
  const stopDistAbs   = atr * atrMultiple;
  const stopDistPct   = (stopDistAbs / entry) * 100;
  const tokens        = stopDistAbs > 0 ? riskUSD / stopDistAbs : 0;
  const positionValue = tokens * entry;

  return { riskUSD, stopDistPct, stopDistAbs, tokens, positionValue, atrMultiple };
}

// ── Partial TPs ───────────────────────────────────────────────────────────────

/**
 * Computes TP1 (1R), TP2 (2R), TP3 (3R) prices and percentages.
 */
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
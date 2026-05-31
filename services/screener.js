import { calcEMAArray, calcRSIArray, calcATR } from '../indicators/engine.js';
import { fmtSym } from '../utils/helpers.js';

export const SCR_CURATED_TIERS = {
  BTCUSDT:'T1', ETHUSDT:'T1', SOLUSDT:'T1', BNBUSDT:'T1', XRPUSDT:'T1',
  DOGEUSDT:'T1', ADAUSDT:'T1', TRXUSDT:'T1', TONUSDT:'T1', LINKUSDT:'T1',
  AVAXUSDT:'T2', SUIUSDT:'T2', APTUSDT:'T2', NEARUSDT:'T2', ARBUSDT:'T2',
  OPUSDT:'T2', POLUSDT:'T2', RENDERUSDT:'T2', SEIUSDT:'T2', HYPEUSDT:'T2',
  INJUSDT:'T2', TIAUSDT:'T2', KASUSDT:'T2', ICPUSDT:'T2', HBARUSDT:'T2',
  VETUSDT:'T2', FILUSDT:'T2', ATOMUSDT:'T2', ALGOUSDT:'T2', XLMUSDT:'T2',
  FETUSDT:'AI', TAOUSDT:'AI', AKTUSDT:'AI', OCEANUSDT:'AI', AGIXUSDT:'AI',
  AIOZUSDT:'AI', WLDUSDT:'AI', ARKMUSDT:'AI', PHAUSDT:'AI', NMRUSDT:'AI',
  PEPEUSDT:'MEME', SHIBUSDT:'MEME', BONKUSDT:'MEME', FLOKIUSDT:'MEME',
  WIFUSDT:'MEME', BRETTUSDT:'MEME', POPCATUSDT:'MEME', MOGUSDT:'MEME',
  TURBOUSDT:'MEME', BOMEUSDT:'MEME',
  UNIUSDT:'DeFi', AAVEUSDT:'DeFi', MKRUSDT:'DeFi', CRVUSDT:'DeFi',
  LDOUSDT:'DeFi', PENDLEUSDT:'DeFi', ENAUSDT:'DeFi', JUPUSDT:'DeFi',
  RAYUSDT:'DeFi', SUSHIUSDT:'DeFi',
  IMXUSDT:'Game', GALAUSDT:'Game', SANDUSDT:'Game', MANAUSDT:'Game',
  AXSUSDT:'Game', BEAMUSDT:'Game', RONUSDT:'Game', ENJUSDT:'Game',
  ILVUSDT:'Game', PIXELUSDT:'Game',
  DOTUSDT:'Infra', FTMUSDT:'Infra', MNTUSDT:'Infra', ZKUSDT:'Infra',
  STRKUSDT:'Infra', RUNEUSDT:'Infra', QNTUSDT:'Infra', EOSUSDT:'Infra',
  XTZUSDT:'Infra', KAVAUSDT:'Infra',
  OKBUSDT:'CEX', CROUSDT:'CEX', BGBUSDT:'CEX', KCSUSDT:'CEX', HTUSDT:'CEX',
  ORDIUSDT:'Scalp', SATSUSDT:'Scalp', PYTHUSDT:'Scalp', WUSDT:'Scalp',
  DYMUSDT:'Scalp', ZETAUSDT:'Scalp', AEVOUSDT:'Scalp', ETHFIUSDT:'Scalp',
  BLURUSDT:'Scalp', PORTALUSDT:'Scalp',
  JASMYUSDT:'Watch', THETAUSDT:'Watch', NEOUSDT:'Watch', CHZUSDT:'Watch',
  COMPUSDT:'Watch',
};

export const SCR_DEFAULT_COINS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'AVAXUSDT','LINKUSDT','SUIUSDT','APTUSDT','TONUSDT',
  'DOGEUSDT','PEPEUSDT','BONKUSDT','WIFUSDT',
  'ARBUSDT','OPUSDT','POLUSDT',
  'UNIUSDT','AAVEUSDT',
  'FETUSDT','WLDUSDT','RENDERUSDT',
];

const FIB_LEVELS = [
  { r: 0,     label: '0%',    tier: 'ext',   strength: 1 },
  { r: 0.236, label: '23.6%', tier: 'minor', strength: 2 },
  { r: 0.382, label: '38.2%', tier: 'key',   strength: 3 },
  { r: 0.5,   label: '50%',   tier: 'key',   strength: 4 },
  { r: 0.618, label: '61.8%', tier: 'gold',  strength: 5 },
  { r: 0.786, label: '78.6%', tier: 'key',   strength: 3 },
  { r: 1,     label: '100%',  tier: 'ext',   strength: 1 },
];

const TF_MINS = { '1m':1, '3m':3, '5m':5, '15m':15, '30m':30, '1h':60, '4h':240, '1d':1440 };

// Higher timeframes carry more weight in MTF scoring
const TF_WEIGHT = { '1m':1, '3m':1, '5m':1, '15m':2, '30m':2, '1h':3, '4h':5, '1d':8 };

// ─── RSI divergence detector (lightweight, screener-local) ───────────────────
function detectRSIDivBearish(candles, rsiVals) {
  // Bearish: price makes higher high but RSI makes lower high
  const n = Math.min(candles.length, rsiVals.length, 30);
  if (n < 10) return false;
  const prices = candles.slice(-n).map(c => c.h);
  const rsis   = rsiVals.slice(-n);
  const ph1i   = prices.lastIndexOf(Math.max(...prices.slice(0, Math.floor(n / 2))));
  const ph2i   = Math.floor(n / 2) + prices.slice(Math.floor(n / 2)).indexOf(Math.max(...prices.slice(Math.floor(n / 2))));
  if (ph2i <= ph1i) return false;
  return prices[ph2i] > prices[ph1i] && rsis[ph2i] < rsis[ph1i];
}

function detectRSIDivBullish(candles, rsiVals) {
  // Bullish: price makes lower low but RSI makes higher low
  const n = Math.min(candles.length, rsiVals.length, 30);
  if (n < 10) return false;
  const prices = candles.slice(-n).map(c => c.l);
  const rsis   = rsiVals.slice(-n);
  const pl1i   = prices.indexOf(Math.min(...prices.slice(0, Math.floor(n / 2))));
  const pl2i   = Math.floor(n / 2) + prices.slice(Math.floor(n / 2)).indexOf(Math.min(...prices.slice(Math.floor(n / 2))));
  if (pl2i <= pl1i) return false;
  return prices[pl2i] < prices[pl1i] && rsis[pl2i] > rsis[pl1i];
}

// ─── Momentum acceleration: is rate-of-change speeding up or slowing? ────────
function calcMomentumAccel(candles, period = 5) {
  if (candles.length < period * 2 + 1) return 0;
  const roc = (a, b) => b > 0 ? (a - b) / b * 100 : 0;
  const recent = roc(candles[candles.length - 1].c, candles[candles.length - 1 - period].c);
  const prev   = roc(candles[candles.length - 1 - period].c, candles[candles.length - 1 - period * 2].c);
  return recent - prev; // positive = accelerating, negative = decelerating
}

export function analyseSymbol(sym, candles, primaryTf, tfData, activeTFs, fetchedAt, source) {
  if (!candles || candles.length < 15) return null;

  const k9 = 2 / 10, k20 = 2 / 21, k50 = 2 / 51;
  let e9 = null, e20 = null, e50 = null;
  let avgGain = null, avgLoss = null, prevC = null;
  let rsi = null;
  const rsiWindow = [];
  const rsiSeries = []; // track full RSI series for divergence
  let prevE9 = null, prevE20 = null;
  let lastCrossIdx = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    e9  = e9  === null ? c.c : c.c * k9  + e9  * (1 - k9);
    e20 = e20 === null ? c.c : c.c * k20 + e20 * (1 - k20);
    e50 = e50 === null ? c.c : c.c * k50 + e50 * (1 - k50);

    if (prevE9 !== null && prevE20 !== null) {
      if ((prevE9 <= prevE20 && e9 > e20) || (prevE9 >= prevE20 && e9 < e20)) {
        lastCrossIdx = i;
      }
    }
    prevE9 = e9; prevE20 = e20;

    if (prevC !== null) {
      const ch   = c.c - prevC;
      const gain = Math.max(0, ch);
      const loss = Math.max(0, -ch);
      if (avgGain === null) {
        rsiWindow.push({ gain, loss });
        if (rsiWindow.length === 14) {
          avgGain = rsiWindow.reduce((a, b) => a + b.gain, 0) / 14;
          avgLoss = rsiWindow.reduce((a, b) => a + b.loss, 0) / 14;
          const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
          rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
          rsiSeries.push(rsi);
        }
      } else {
        avgGain = (avgGain * 13 + gain) / 14;
        avgLoss = (avgLoss * 13 + loss) / 14;
        const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
        rsiSeries.push(rsi);
      }
    }
    prevC = c.c;
  }

  const price = candles[candles.length - 1].c;

  const candlesPer24h = Math.round(1440 / (TF_MINS[primaryTf] || 15));
  const open24 = candles[Math.max(0, candles.length - candlesPer24h)].o;
  const chgPct = open24 ? ((price - open24) / open24 * 100) : 0;

  const crossLookback = Math.max(3, Math.round(30 / (TF_MINS[primaryTf] || 15)));
  const recentCross = lastCrossIdx >= 0 && (candles.length - 1 - lastCrossIdx) <= crossLookback;

  const bullStack = e9 > e20 && e20 > e50;
  const bearStack = e9 < e20 && e20 < e50;

  let signal      = 'tang';
  let signalClass = 'tang';
  let signalLabel = '⚠ MIXED';
  if (bullStack)      { signal = 'bull'; signalClass = 'bull'; signalLabel = '▲ LONG';  }
  else if (bearStack) { signal = 'bear'; signalClass = 'bear'; signalLabel = '▼ SHORT'; }

  const stackLabel = bullStack ? '9>20>50 🟢' : bearStack ? '9<20<50 🔴' : '⚠ Tangled';

  // ── Trend age (candles since last cross) ─────────────────────────────────
  const trendAge = lastCrossIdx >= 0
    ? (candles.length - 1 - lastCrossIdx)
    : (bullStack || bearStack ? candles.length : 0);

  // ── Momentum acceleration ─────────────────────────────────────────────────
  const momentumAccel = calcMomentumAccel(candles);
  const accelAligned  = (signal === 'bull' && momentumAccel > 0) ||
                        (signal === 'bear' && momentumAccel < 0);
  const accelOpposed  = (signal === 'bull' && momentumAccel < -0.5) ||
                        (signal === 'bear' && momentumAccel >  0.5);

  // ── RSI divergence ────────────────────────────────────────────────────────
  const hasBullDiv = rsiSeries.length >= 10 && detectRSIDivBullish(candles, rsiSeries);
  const hasBearDiv = rsiSeries.length >= 10 && detectRSIDivBearish(candles, rsiSeries);
  // divergence aligned with signal = confirmation; opposed = warning
  const divAligned  = (signal === 'bull' && hasBullDiv) || (signal === 'bear' && hasBearDiv);
  const divOpposed  = (signal === 'bull' && hasBearDiv) || (signal === 'bear' && hasBullDiv);

  // ── Volume direction check ────────────────────────────────────────────────
  // Estimate buy/sell pressure from candle body direction on the spike candle
  const lastCandle   = candles[candles.length - 1];
  const volWindow    = candles.slice(-21, -1);
  const avgVol       = volWindow.length ? volWindow.reduce((a, c) => a + c.v, 0) / volWindow.length : 0;
  const curVol       = lastCandle.v;
  const volRatio     = avgVol > 0 ? curVol / avgVol : 1;
  const volSpike     = volRatio >= 2.0;
  const volHot       = volRatio >= 1.5;
  const hasFakeVol   = candles.some(c => c._fakeVol);
  // Candle body direction on the volume spike candle
  const volBullish   = lastCandle.c >= lastCandle.o; // green candle = buy pressure
  const volAligned   = (signal === 'bull' && volBullish) || (signal === 'bear' && !volBullish);
  const volOpposed   = (signal === 'bull' && !volBullish) || (signal === 'bear' && volBullish);

  // ── Score ─────────────────────────────────────────────────────────────────
  let score = 0;

  // EMA stack
  if (bullStack || bearStack) score += 30;

  // RSI zone
  if (rsi !== null) {
    if      (signal === 'bull' && rsi > 50 && rsi < 65)  score += 20;
    else if (signal === 'bull' && rsi >= 40 && rsi < 50)  score += 12;
    else if (signal === 'bear' && rsi < 50 && rsi > 35)   score += 20;
    else if (signal === 'bear' && rsi >= 50 && rsi <= 60) score += 12;

    // Price above/below EMA20
    if (signal === 'bull' && price > e20) score += 15;
    if (signal === 'bear' && price < e20) score += 15;

    // Extreme RSI + recent cross
    if (rsi < 30 && signal === 'bull' && recentCross) score += 15;
    if (rsi > 70 && signal === 'bear' && recentCross) score += 15;
  }

  // Recent cross
  if (recentCross) score += 15;

  // Trend age — fresh crosses score higher, very old trends score lower
  if (trendAge <= 3)                      score += 12;
  else if (trendAge <= 8)                 score += 6;
  else if (trendAge > 40)                 score  = Math.max(0, score - 8);

  // Momentum acceleration
  if (accelAligned)  score += 8;
  if (accelOpposed)  score  = Math.max(0, score - 6);

  // RSI divergence
  if (divAligned)    score += 12;
  if (divOpposed)    score  = Math.max(0, score - 10);

  score = Math.min(100, score);

  // ── Fib proximity ─────────────────────────────────────────────────────────
  const swingWindow = candles.slice(-50);
  const swingHi = Math.max(...swingWindow.map(c => c.h));
  const swingLo = Math.min(...swingWindow.map(c => c.l));
  const fibRange = swingHi - swingLo;

  let fibProximity = null;
  if (fibRange > 0) {
    let nearest = null, nearestDist = Infinity;
    FIB_LEVELS.forEach(f => {
      const fibPrice = swingHi - fibRange * f.r;
      const dist = Math.abs(price - fibPrice);
      const distPct = (dist / fibRange) * 100;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = { ...f, fibPrice, distPct, distPctOfPrice: (dist / price) * 100 };
      }
    });

    if (nearest && nearest.distPctOfPrice < 3.0) {
      const lookN     = Math.min(5, candles.length - 1);
      const priceNAgo = lookN > 0 ? candles[candles.length - 1 - lookN].c : price;
      const pctMove   = priceNAgo > 0 ? (price - priceNAgo) / priceNAgo * 100 : 0;
      const isRising  = pctMove >  0.1;
      const isFalling = pctMove < -0.1;
      const fibAbove  = nearest.fibPrice > price;

      let dir, dirLabel;
      if      (isRising  && fibAbove)  { dir = 'resistance'; dirLabel = '↑ Res';  }
      else if (isFalling && !fibAbove) { dir = 'support';    dirLabel = '↓ Supp'; }
      else if (isRising  && !fibAbove) { dir = 'support';    dirLabel = '↓ Supp'; }
      else if (isFalling && fibAbove)  { dir = 'resistance'; dirLabel = '↑ Res';  }
      else                              { dir = 'neutral';    dirLabel = '— Flat'; }

      const qualifies = nearest.tier !== 'ext' || nearest.distPctOfPrice < 1.0;
      if (qualifies) {
        fibProximity = {
          label:          nearest.label,
          r:              nearest.r,
          tier:           nearest.tier,
          strength:       nearest.strength,
          fibPrice:       nearest.fibPrice,
          distPct:        nearest.distPctOfPrice,
          distPctOfRange: nearest.distPct,
          dir,
          dirLabel,
        };
      }
    }
  }

  if (fibProximity) {
    const { tier, dir, distPct } = fibProximity;
    const proximity = distPct < 0.5 ? 1.0 : distPct < 1.5 ? 0.7 : 0.4;
    let fibBonus = 0;
    if      (tier === 'gold')  fibBonus = 20;
    else if (tier === 'key')   fibBonus = 14;
    else if (tier === 'minor') fibBonus = 7;
    const misaligned = (signal === 'bull' && dir === 'resistance') ||
                       (signal === 'bear' && dir === 'support');
    fibBonus = Math.round(fibBonus * proximity * (misaligned ? 0.5 : 1.0));
    score = Math.min(100, score + fibBonus);
  }

  // Volume — direction-aware
  if (volSpike) {
    if (volAligned)       score = Math.min(100, score + 10);
    else if (volOpposed)  score = Math.max(0,   score - 6);
  } else if (volHot && volAligned) {
    score = Math.min(100, score + 4);
  }

  // EMA20 distance
  const e20dist = e20 > 0 ? ((price - e20) / e20 * 100) : 0;
  if (Math.abs(e20dist) <= 1.0 && (bullStack || bearStack))
    score = Math.min(100, score + 8);
  else if (Math.abs(e20dist) > 5.0)
    score = Math.max(0, score - 10);

  // H/L position vs signal direction
  const cPer24  = Math.round(1440 / (TF_MINS[primaryTf] || 15));
  const last24  = candles.slice(-Math.min(cPer24, candles.length));
  const hi24    = Math.max(...last24.map(c => c.h));
  const lo24    = Math.min(...last24.map(c => c.l));
  const hlRange = hi24 - lo24;
  const hlPos   = hlRange > 0 ? ((price - lo24) / hlRange * 100) : 50;
  const nearHigh = hlPos >= 80;
  const nearLow  = hlPos <= 20;

  // Reward confluence: bull pulling back to low, bear rallying to high
  if (signal === 'bull' && nearLow)  score = Math.min(100, score + 10);
  if (signal === 'bear' && nearHigh) score = Math.min(100, score + 10);
  // Penalise chasing: bull extended to high, bear extended to low
  if (signal === 'bull' && nearHigh) score = Math.max(0, score - 8);
  if (signal === 'bear' && nearLow)  score = Math.max(0, score - 8);

  const atr = calcATR(candles, 14);

  // ── MTF — weighted by timeframe significance ──────────────────────────────
  const available = activeTFs.filter(t => tfData[t] && tfData[t].signal !== 'none');

  let weightedBull = 0, weightedBear = 0, totalWeight = 0;
  let higherTFConflict = false;

  // Define "higher" as anything with more minutes than the primary TF
  const primaryMins = TF_MINS[primaryTf] || 15;

  available.forEach(t => {
    const w   = TF_WEIGHT[t] || 1;
    const sig = tfData[t].signal;
    if (sig === 'bull') weightedBull += w;
    if (sig === 'bear') weightedBear += w;
    totalWeight += w;

    // Check if a higher TF contradicts the primary signal
    if ((TF_MINS[t] || 0) > primaryMins) {
      if ((signal === 'bull' && sig === 'bear') ||
          (signal === 'bear' && sig === 'bull')) {
        higherTFConflict = true;
      }
    }
  });

  const dominated     = Math.max(weightedBull, weightedBear);
  const mtfDir        = weightedBull > weightedBear ? 'bull' : weightedBear > weightedBull ? 'bear' : 'mixed';
  const mtfScore      = totalWeight > 0 ? Math.round(dominated / totalWeight * 100) : 0;
  const bulls         = available.filter(t => tfData[t].signal === 'bull').length;
  const bears         = available.filter(t => tfData[t].signal === 'bear').length;
  const mtfFull       = dominated === totalWeight && available.length > 1;
  const mtfMost       = !mtfFull && mtfScore >= 75;
  const mtfBreakdown  = activeTFs.map(t => ({
    tf:     t,
    signal: tfData[t] ? tfData[t].signal : 'none',
    weight: TF_WEIGHT[t] || 1,
  }));

  // Penalise higher-TF conflict in score
  if (higherTFConflict) score = Math.max(0, score - 12);

  score = Math.min(100, Math.max(0, score));

  return {
    sym, price, chgPct, primaryTf,
    signal, signalClass, signalLabel, stackLabel,
    e9, e20, e50, rsi, score,
    bullStack, bearStack,
    recentCross, fibProximity, hasFakeVol,
    volRatio, volSpike, volHot, volAligned, volOpposed, avgVol, curVol,
    e20dist, hlPos, nearHigh, nearLow, hi24, lo24,
    trendAge, atr,
    momentumAccel, accelAligned, accelOpposed,
    hasBullDiv, hasBearDiv, divAligned, divOpposed,
    higherTFConflict,
    mtfDir, mtfScore, mtfFull, mtfMost, mtfBreakdown,
    bullCount: bulls, bearCount: bears,
    availTFs: available.length, totalTFs: activeTFs.length,
    fetchedAt, source,
  };
}

export function calcTFSnapshot(candles, tf) {
  if (!candles || candles.length < 15) return null;

  const k9 = 2 / 10, k20 = 2 / 21, k50 = 2 / 51;
  let e9 = null, e20 = null, e50 = null;
  let avgGain = null, avgLoss = null, prevC = null;
  let rsi = null;
  const rsiWindow = [];
  let prevE9 = null, prevE20 = null, lastCrossIdx = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    e9  = e9  === null ? c.c : c.c * k9  + e9  * (1 - k9);
    e20 = e20 === null ? c.c : c.c * k20 + e20 * (1 - k20);
    e50 = e50 === null ? c.c : c.c * k50 + e50 * (1 - k50);

    if (prevE9 !== null && prevE20 !== null) {
      if ((prevE9 <= prevE20 && e9 > e20) || (prevE9 >= prevE20 && e9 < e20))
        lastCrossIdx = i;
    }
    prevE9 = e9; prevE20 = e20;

    if (prevC !== null) {
      const ch = c.c - prevC;
      const gain = Math.max(0, ch), loss = Math.max(0, -ch);
      if (avgGain === null) {
        rsiWindow.push({ gain, loss });
        if (rsiWindow.length === 14) {
          avgGain = rsiWindow.reduce((a, b) => a + b.gain, 0) / 14;
          avgLoss = rsiWindow.reduce((a, b) => a + b.loss, 0) / 14;
          rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
      } else {
        avgGain = (avgGain * 13 + gain) / 14;
        avgLoss = (avgLoss * 13 + loss) / 14;
        rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    prevC = c.c;
  }

  const bullStack = e9 > e20 && e20 > e50;
  const bearStack = e9 < e20 && e20 < e50;

  let signal = 'tang', signalClass = 'tang', signalLabel = '⚠ MIXED';
  if (bullStack)      { signal = 'bull'; signalClass = 'bull'; signalLabel = '▲ LONG';  }
  else if (bearStack) { signal = 'bear'; signalClass = 'bear'; signalLabel = '▼ SHORT'; }

  return { signal, signalClass, signalLabel, e9, e20, e50, rsi, bullStack, bearStack };
}

export function applyScreenerFilters(results, filter) {
  if (filter === 'all') return results;
  return results.filter(r => {
    switch (filter) {
      case 'bull':      return r.signal === 'bull';
      case 'bear':      return r.signal === 'bear';
      case 'cross':     return r.recentCross;
      case 'ob':        return r.rsi !== null && r.rsi >= 70;
      case 'os':        return r.rsi !== null && r.rsi <= 30;
      case 'fib':       return r.fibProximity !== null;
      case 'fib618':    return r.fibProximity?.r === 0.618;
      case 'fib50':     return r.fibProximity?.r === 0.5;
      case 'fib382':    return r.fibProximity?.r === 0.382;
      case 'fib_sup':   return r.fibProximity?.dir === 'support';
      case 'fib_res':   return r.fibProximity?.dir === 'resistance';
      case 'mtf_full':  return r.mtfFull;
      case 'mtf_most':  return r.mtfFull || r.mtfMost;
      case 'vol_spike': return r.volSpike;
      case 'vol_align': return r.volSpike && r.volAligned;
      case 'near_ema':  return Math.abs(r.e20dist || 0) <= 1.5;
      case 'fresh':     return r.trendAge <= 5;
      case 'div_bull':  return r.hasBullDiv;
      case 'div_bear':  return r.hasBearDiv;
      case 'accel':     return r.accelAligned;
      case 'no_htf_conflict': return !r.higherTFConflict;
      default:          return true;
    }
  });
}

export function sortScreenerResults(results, key, asc) {
  return [...results].sort((a, b) => {
    let av, bv;
    switch (key) {
      case 'sym':      av = a.sym;    bv = b.sym;    return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      case 'signal':   av = a.signal; bv = b.signal; return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      case 'stack':    av = a.bullStack ? 1 : a.bearStack ? -1 : 0;
                       bv = b.bullStack ? 1 : b.bearStack ? -1 : 0; break;
      case 'price':    av = a.price;               bv = b.price;               break;
      case 'chg':      av = a.chgPct;              bv = b.chgPct;              break;
      case 'rsi':      av = a.rsi      ?? -Infinity; bv = b.rsi      ?? -Infinity; break;
      case 'score':    av = a.score;               bv = b.score;               break;
      case 'mtf':      av = a.mtfScore ?? 0;        bv = b.mtfScore ?? 0;        break;
      case 'vol':      av = a.volRatio ?? 0;        bv = b.volRatio ?? 0;        break;
      case 'dist':     av = Math.abs(a.e20dist ?? 0); bv = Math.abs(b.e20dist ?? 0); break;
      case 'hlpos':    av = a.hlPos    ?? 50;       bv = b.hlPos    ?? 50;       break;
      case 'age':      av = a.trendAge ?? 0;        bv = b.trendAge ?? 0;        break;
      case 'fib':      av = a.fibProximity ? a.fibProximity.distPct  : 999;
                       bv = b.fibProximity ? b.fibProximity.distPct  : 999; break;
      case 'fibstr':   av = a.fibProximity ? a.fibProximity.strength : 0;
                       bv = b.fibProximity ? b.fibProximity.strength : 0; break;
      case 'accel':    av = a.momentumAccel ?? 0;  bv = b.momentumAccel ?? 0;  break;
      case 'fetchage': av = a.fetchedAt ?? 0; bv = b.fetchedAt ?? 0; break;
      default:         av = a[key] ?? -Infinity; bv = b[key] ?? -Infinity;
    }
    if (av === null || av === undefined) av = -Infinity;
    if (bv === null || bv === undefined) bv = -Infinity;
    return asc ? av - bv : bv - av;
  });
}

export function detectSectorRotation(results) {
  const sectors = {};

  results.forEach(r => {
    const tier = SCR_CURATED_TIERS[r.sym] || 'Other';
    if (!sectors[tier]) sectors[tier] = { bull: 0, bear: 0, total: 0 };
    sectors[tier].total++;
    if (r.signal === 'bull') sectors[tier].bull++;
    if (r.signal === 'bear') sectors[tier].bear++;
  });

  return Object.entries(sectors).map(([name, s]) => ({
    name,
    bullPct: s.total > 0 ? Math.round(s.bull / s.total * 100) : 0,
    bearPct: s.total > 0 ? Math.round(s.bear / s.total * 100) : 0,
    total:   s.total,
    bias:    s.bull > s.bear ? 'bull' : s.bear > s.bull ? 'bear' : 'neutral',
  })).sort((a, b) => b.bullPct - a.bullPct);
}
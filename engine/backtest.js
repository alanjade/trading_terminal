/**
 * engine/backtest.js
 * Historical backtesting engine.
 *
 * Architecture:
 *   BacktestEngine   — iterates candles bar-by-bar, manages open positions
 *   StrategyRunner   — evaluates entry/exit rules per bar
 *   MetricsCalc      — computes win rate, profit factor, expectancy, drawdown, Sharpe
 *   WalkForward      — splits data into in-sample/out-of-sample windows
 *
 */

import { calcEMAArray, calcRSIArray, calcATR, calcATRArray, getFibLevels, nearestFib } from '../indicators/engine.js';
import { detectRegime }    from '../indicators/regime.js';
import { detectSwingPoints, detectStructureBreaks } from '../indicators/structure.js';
import { TF_MS } from '../utils/helpers.js';

// ── Strategy stop/entry buffer constants ──────────────────────────────────────
const STOP_BUFFER_PCT  = 0.0005;  // 0.05% beyond swing extreme for stop placement
const EMA_TOUCH_BAND   = 0.002;   // 0.2% band for "price touched EMA" detection
const VOL_BREAKOUT_MIN = 1.5;     // minimum volume multiplier vs avg for breakout confirmation

// ── Warm-up bar minimum ───────────────────────────────────────────────────────
// EMA-50 needs 50 bars, RSI-14 needs 14 bars, ATR-14 needs 14 bars.
// 60 bars covers all indicators with a small buffer.
const DEFAULT_WARMUP_BARS = 60;

const DEFAULT_MAX_BAR_DURATION = 50;

const BARS_PER_YEAR = {
  '1m':  365 * 24 * 60,
  '3m':  365 * 24 * 20,
  '5m':  365 * 24 * 12,
  '15m': 365 * 24 * 4,
  '30m': 365 * 24 * 2,
  '1h':  365 * 24,
  '4h':  365 * 6,
  '1d':  365,
};

// ── Strategy Definitions ──────────────────────────────────────────────────────

export const STRATEGIES = {
  COMPOSITE: {
    id:    'composite',
    label: '⭐ App Signal (Combined)',
    desc:  'Mirrors the live suggestion engine exactly — EMA stack + RSI + VWAP + local structure + Fib. Backtest what the app actually signals.',
  },
  EMA_PULLBACK: {
    id:    'ema_pullback',
    label: 'EMA Pullback',
    desc:  'Enter on pullback to EMA9/20 in direction of EMA50 trend. ATR stop.',
  },
  EMA_CROSS: {
    id:    'ema_cross',
    label: 'EMA Crossover',
    desc:  'Enter on EMA9/20 crossover with RSI confirmation. ATR stop.',
  },
  RSI_MEAN_REVERT: {
    id:    'rsi_mean_revert',
    label: 'RSI Mean Reversion',
    desc:  'Enter on RSI <30 (long) or >70 (short) with EMA50 trend filter.',
  },
  BREAKOUT: {
    id:    'breakout',
    label: 'Structure Breakout',
    desc:  'Enter on break of recent swing high/low with volume confirmation.',
  },
  VWAP_BOUNCE: {
    id:    'vwap_bounce',
    label: 'VWAP Bounce',
    desc:  'Enter on price touch of VWAP with EMA trend confirmation.',
  },
};

// ── Trade State ───────────────────────────────────────────────────────────────

class Trade {
  constructor({ entryIdx, entryPrice, dir, stopPrice, targetPrice, tpPrices, size, atr }) {
    this.entryIdx    = entryIdx;
    this.entryPrice  = entryPrice;
    this.dir         = dir;
    this.stopPrice   = stopPrice;
    this.targetPrice = targetPrice;
    this.tpPrices    = tpPrices || [];
    this.size        = size;
    this.atr         = atr;
    this.exitIdx     = null;
    this.exitPrice   = null;
    this.exitReason  = null;
    this.pnl         = null;
    this.rr          = null;
    this.mae         = 0;
    this.mfe         = 0;
    this.barDuration = 0;
    this._trailStop  = null;
    this._tpHit      = 0;
    this._scaled     = false;
  }

  get isOpen() { return this.exitIdx === null; }
  get isLong()  { return this.dir === 'long'; }

  updateExcursions(candle) {
    const { h, l } = candle;
    if (this.isLong) {
      const adverse   = this.entryPrice - l;
      const favorable = h - this.entryPrice;
      if (adverse   > this.mae) this.mae = adverse;
      if (favorable > this.mfe) this.mfe = favorable;
    } else {
      const adverse   = h - this.entryPrice;
      const favorable = this.entryPrice - l;
      if (adverse   > this.mae) this.mae = adverse;
      if (favorable > this.mfe) this.mfe = favorable;
    }
    this.barDuration++;
  }

  close(exitIdx, exitPrice, reason, feeRate = 0) {
    this.exitIdx    = exitIdx;
    this.exitPrice  = exitPrice;
    this.exitReason = reason;

    const priceDiff = this.isLong
      ? exitPrice - this.entryPrice
      : this.entryPrice - exitPrice;

    const grossPnl = (priceDiff / this.entryPrice) * this.size / (this._leverage || 1);
    const fees     = (this.size / (this._leverage || 1)) * feeRate * 2;
    this.pnl       = grossPnl - fees;

    const risk = Math.abs(this.entryPrice - this.stopPrice);
    this.rr = risk > 0 ? priceDiff / risk : null;
  }
}

// ── Main Backtest Engine ──────────────────────────────────────────────────────

export class BacktestEngine {
  constructor(config) {
    this.candles        = config.candles      || [];
    this.strategy       = config.strategy     || STRATEGIES.COMPOSITE;
    this.capital        = config.capital      ?? 1000;
    this.riskPct        = config.riskPct      ?? 1;
    this.leverage       = config.leverage     ?? 10;
    this.feeRate        = config.feeRate      ?? 0.0002;
    this.rrRatio        = config.rrRatio      ?? 2;
    this.atrMultiple    = config.atrMultiple  ?? 2;
    this.trailStop      = config.trailStop    ?? false;
    this.partialTPs     = config.partialTPs   ?? true;
    this.maxOpenTrades  = config.maxOpenTrades ?? 1;
    this.warmupBars     = config.warmupBars   ?? DEFAULT_WARMUP_BARS;
    this.maxBarDuration = config.maxBarDuration ?? DEFAULT_MAX_BAR_DURATION;
    this.tf             = config.tf           || '5m';
    this.onProgress     = config.onProgress   ?? null;

    this._closes = null;
    this._e9s    = null;
    this._e20s   = null;
    this._e50s   = null;
    this._rsi    = null;
    this._atrs   = null;
    this._vwap   = null;
  }

  // ── Pre-compute indicators ──────────────────────────────────────────────

  _precompute() {
    this._closes = this.candles.map(c => c.c);
    this._e9s    = calcEMAArray(this._closes, 9);
    this._e20s   = calcEMAArray(this._closes, 20);
    this._e50s   = calcEMAArray(this._closes, 50);
    this._rsi    = calcRSIArray(this._closes, 14);
    this._atrs   = calcATRArray(this.candles, 14);
    this._vwap   = this._calcVWAPArray(this.candles);
  }

  _calcVWAPArray(candles) {
    let cumPV = 0, cumV = 0, sessionKey = '';
    return candles.map(c => {
      if (c.t) {
        const d   = new Date(c.t);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
        if (key !== sessionKey) { cumPV = 0; cumV = 0; sessionKey = key; }
      }
      const tp = (c.h + c.l + c.c) / 3;
      // Guard against zero-volume bars (gaps, illiquid markets).
      if (c.v > 0) { cumPV += tp * c.v; cumV += c.v; }
      return cumV > 0 ? cumPV / cumV : c.c;
    });
  }

  // ── Run ─────────────────────────────────────────────────────────────────

  run() {
    if (this.candles.length < this.warmupBars + 10) {
      return { trades: [], metrics: null, equity: [], error: 'Not enough candles' };
    }

    this._precompute();

    const trades      = [];
    let openTrades    = [];
    let equity        = this.capital;
    const equityCurve = [{ idx: 0, value: equity }];

    for (let i = this.warmupBars; i < this.candles.length; i++) {
      const c = this.candles[i];

      // ── Update open trades ──────────────────────────────────────────
      for (const trade of [...openTrades]) {
        trade.updateExcursions(c);

        // FIX (#6): force-close trades that have exceeded maxBarDuration.
        if (trade.barDuration >= this.maxBarDuration) {
          trade.close(i, c.c, 'timeout', this.feeRate);
          openTrades = openTrades.filter(t => t !== trade);
          trades.push(trade);
          equity += trade.pnl;
          equityCurve.push({ idx: i, value: equity });
          continue;
        }

        if (this.trailStop && trade._tpHit >= 1) {
          const atr      = this._atrs[i] || trade.atr;
          const newTrail = trade.isLong
            ? c.c - atr * this.atrMultiple
            : c.c + atr * this.atrMultiple;
          if (trade._trailStop === null) {
            trade._trailStop = newTrail;
          } else {
            if (trade.isLong  && newTrail > trade._trailStop) trade._trailStop = newTrail;
            if (!trade.isLong && newTrail < trade._trailStop) trade._trailStop = newTrail;
          }
        }

        const stopToUse = trade._trailStop ?? trade.stopPrice;

        if (this.partialTPs && trade._tpHit < trade.tpPrices.length) {
          const nextTP = trade.tpPrices[trade._tpHit];
          const tpHit  = trade.isLong ? c.h >= nextTP : c.l <= nextTP;
          if (tpHit) {
            trade._tpHit++;
            if (trade._tpHit === 1) {
              if (trade.isLong  && trade.stopPrice < trade.entryPrice) trade.stopPrice = trade.entryPrice;
              if (!trade.isLong && trade.stopPrice > trade.entryPrice) trade.stopPrice = trade.entryPrice;
            }
          }
        }

        const slHit = trade.isLong ? c.l <= stopToUse  : c.h >= stopToUse;
        const tpHit = trade.isLong ? c.h >= trade.targetPrice : c.l <= trade.targetPrice;

        if (slHit && tpHit) {
          const o = c.o ?? c.c; // use open if available, fall back to close
          const tpFirst = trade.isLong ? o >= trade.targetPrice : o <= trade.targetPrice;
          if (tpFirst) {
            trade.close(i, trade.targetPrice, 'tp', this.feeRate);
          } else {
            trade.close(i, stopToUse, 'sl', this.feeRate);
          }
          openTrades = openTrades.filter(t => t !== trade);
          trades.push(trade);
          equity += trade.pnl;
          equityCurve.push({ idx: i, value: equity });
          continue;
        }

        if (slHit) {
          trade.close(i, stopToUse, 'sl', this.feeRate);
          openTrades = openTrades.filter(t => t !== trade);
          trades.push(trade);
          equity += trade.pnl;
          equityCurve.push({ idx: i, value: equity });
          continue;
        }

        if (tpHit) {
          trade.close(i, trade.targetPrice, 'tp', this.feeRate);
          openTrades = openTrades.filter(t => t !== trade);
          trades.push(trade);
          equity += trade.pnl;
          equityCurve.push({ idx: i, value: equity });
        }
      }

      // ── Check for new entries ───────────────────────────────────────
      if (openTrades.length < this.maxOpenTrades) {
        const signal = this._evalStrategy(i);
        if (signal) {
          const atr = this._atrs[i];
          if (!atr) continue;

          const { dir, entry, stop } = signal;
          const stopDist = Math.abs(entry - stop);
          if (stopDist <= 0) continue;

          const riskUSD = equity * (this.riskPct / 100);
          const tokens  = (riskUSD * this.leverage) / stopDist;
          const size    = tokens * entry;

          const tp1 = dir === 'long' ? entry + stopDist                : entry - stopDist;
          const tp2 = dir === 'long' ? entry + stopDist * 2            : entry - stopDist * 2;
          const tp3 = dir === 'long' ? entry + stopDist * this.rrRatio : entry - stopDist * this.rrRatio;

          const trade = new Trade({
            entryIdx:    i,
            entryPrice:  entry,
            dir,
            stopPrice:   stop,
            targetPrice: tp3,
            tpPrices:    [tp1, tp2],
            size,
            atr,
          });
          // Store leverage on the trade so close() can scale P&L correctly.
          trade._leverage = this.leverage;

          openTrades.push(trade);
        }
      }

      if (this.onProgress && i % 100 === 0) {
        this.onProgress(Math.round((i / this.candles.length) * 100));
      }
    }

    for (const trade of openTrades) {
      const lastIdx = this.candles.length - 1;
      const markPrice = this.candles[lastIdx].c;
      trade.close(lastIdx, markPrice, 'eod', this.feeRate);
      trades.push(trade);
      equity += trade.pnl;
    }
    equityCurve.push({ idx: this.candles.length - 1, value: equity });

    const metrics = calcMetrics(trades, this.capital, equityCurve, this.tf);
    return { trades, metrics, equityCurve, initialCapital: this.capital };
  }

  // ── Strategy Router ─────────────────────────────────────────────────────

  _evalStrategy(i) {
    switch (this.strategy.id) {
      case 'composite':       return this._composite(i);
      case 'ema_pullback':    return this._emaPullback(i);
      case 'ema_cross':       return this._emaCross(i);
      case 'rsi_mean_revert': return this._rsiMeanRevert(i);
      case 'breakout':        return this._breakout(i);
      case 'vwap_bounce':     return this._vwapBounce(i);
      default:                return null;
    }
  }

  // ── ⭐ Composite — exact port of computeSuggestion ───────────────────────

  _composite(i) {
    if (i < Math.max(this.warmupBars, 50)) return null;

    const e9  = this._e9s[i];
    const e20 = this._e20s[i];
    const e50 = this._e50s[i];
    const rsi = this._rsi[i];
    const atr = this._atrs[i];
    const vwap= this._vwap[i];
    const c   = this.candles[i];

    if (!e9 || !e20 || !e50 || !atr || rsi === null) return null;

    const bullish   = e9 > e20 && e20 > e50;
    const bearish   = e9 < e20 && e20 < e50;
    const aboveVwap = vwap ? c.c > vwap : null;

    const localStart   = Math.max(0, i - 4);
    const localCandles = this.candles.slice(localStart, i + 1);
    const localLow     = Math.min(...localCandles.map(x => x.l));
    const localHigh    = Math.max(...localCandles.map(x => x.h));

    let dir, entry, stop;

    if (bullish && rsi < 65) {
      dir   = 'long';
      entry = c.c;
      stop  = Math.min(e20, localLow) * (1 - STOP_BUFFER_PCT);

    } else if (bearish && rsi > 35) {
      dir   = 'short';
      entry = c.c;
      stop  = Math.max(e20, localHigh) * (1 + STOP_BUFFER_PCT);

    } else if (rsi < 35 && e9 > e50) {
      dir   = 'long';
      entry = c.c;
      stop  = localLow * (1 - STOP_BUFFER_PCT);

    } else if (rsi > 65 && e9 < e50) {
      dir   = 'short';
      entry = c.c;
      stop  = localHigh * (1 + STOP_BUFFER_PCT);

    } else {
      return null;
    }

    if (dir === 'long'  && entry <= stop) return null;
    if (dir === 'short' && entry >= stop) return null;

    const stopDist = Math.abs(entry - stop);
    if (stopDist <= 0) return null;

    // ── VWAP soft filter ────────────────────────────────────────────────
    if (aboveVwap !== null && atr > 0) {
      const vwapDist = Math.abs(c.c - vwap);
      if (dir === 'long'  && !aboveVwap && vwapDist > atr) return null;
      if (dir === 'short' &&  aboveVwap && vwapDist > atr) return null;
    }

    return { dir, entry, stop };
  }

  // ── EMA Pullback ────────────────────────────────────────────────────────

  _emaPullback(i) {
    if (i < 3) return null;
    const e9  = this._e9s[i],  e20 = this._e20s[i], e50 = this._e50s[i];
    const rsi = this._rsi[i];
    const c   = this.candles[i];
    const pc  = this.candles[i - 1];
    const atr = this._atrs[i];
    if (!e9 || !e20 || !e50 || !atr || rsi === null) return null;

    if (e9 > e20 && e20 > e50 && rsi > 40 && rsi < 65) {
      const touchedEMA9 = pc.l <= e9 * (1 + EMA_TOUCH_BAND) && c.c > e9;
      if (touchedEMA9) {
        const entry = c.c;
        const stop  = Math.min(e20, c.l) - atr * 0.5;
        return { dir: 'long', entry, stop };
      }
    }
    if (e9 < e20 && e20 < e50 && rsi < 60 && rsi > 35) {
      const touchedEMA9 = pc.h >= e9 * (1 - EMA_TOUCH_BAND) && c.c < e9;
      if (touchedEMA9) {
        const entry = c.c;
        const stop  = Math.max(e20, c.h) + atr * 0.5;
        return { dir: 'short', entry, stop };
      }
    }
    return null;
  }

  // ── EMA Crossover ───────────────────────────────────────────────────────

  _emaCross(i) {
    if (i < 2) return null;
    const e9  = this._e9s[i],  e20  = this._e20s[i], e50 = this._e50s[i];
    const pe9 = this._e9s[i-1], pe20 = this._e20s[i-1];
    const rsi = this._rsi[i];
    const c   = this.candles[i];
    const atr = this._atrs[i];
    if (!e9 || !e20 || !e50 || !pe9 || !pe20 || !atr || rsi === null) return null;

    const bullCross = pe9 <= pe20 && e9 > e20;
    const bearCross = pe9 >= pe20 && e9 < e20;

    if (bullCross && e9 > e50 && rsi < 70) return { dir: 'long',  entry: c.c, stop: c.c - atr * this.atrMultiple };
    if (bearCross && e9 < e50 && rsi > 30) return { dir: 'short', entry: c.c, stop: c.c + atr * this.atrMultiple };
    return null;
  }

  // ── RSI Mean Reversion ──────────────────────────────────────────────────

  _rsiMeanRevert(i) {
    if (i < 2) return null;
    const e50  = this._e50s[i];
    const rsi  = this._rsi[i];
    const prsi = this._rsi[i - 1];
    const c    = this.candles[i];
    const atr  = this._atrs[i];
    if (!e50 || rsi === null || prsi === null || !atr) return null;

    if (prsi < 30 && rsi > prsi && c.c > e50) return { dir: 'long',  entry: c.c, stop: c.l - atr * 0.5 };
    if (prsi > 70 && rsi < prsi && c.c < e50) return { dir: 'short', entry: c.c, stop: c.h + atr * 0.5 };
    return null;
  }

  // ── Structure Breakout ──────────────────────────────────────────────────

  _breakout(i) {
    if (i < 20) return null;
    const lookback = 20;
    const lookbackCandles = this.candles.slice(i - lookback, i);
    const hi  = Math.max(...lookbackCandles.map(c => c.h));
    const lo  = Math.min(...lookbackCandles.map(c => c.l));
    const c   = this.candles[i];
    const pc  = this.candles[i - 1];
    const e50 = this._e50s[i];
    const atr = this._atrs[i];
    const rsi = this._rsi[i];
    if (!e50 || !atr || rsi === null) return null;

    const volAvg = lookbackCandles.reduce((a, x) => a + x.v, 0) / lookback;
    if (pc.c < hi && c.c > hi && c.c > e50 && c.v > volAvg * VOL_BREAKOUT_MIN && rsi < 80) return { dir: 'long',  entry: c.c, stop: hi - atr * 0.5 };
    if (pc.c > lo && c.c < lo && c.c < e50 && c.v > volAvg * VOL_BREAKOUT_MIN && rsi > 20) return { dir: 'short', entry: c.c, stop: lo + atr * 0.5 };
    return null;
  }

  // ── VWAP Bounce ─────────────────────────────────────────────────────────

  _vwapBounce(i) {
    if (i < 2) return null;
    const vwap = this._vwap[i];
    const e20  = this._e20s[i];
    const e50  = this._e50s[i];
    const c    = this.candles[i];
    const pc   = this.candles[i - 1];
    const atr  = this._atrs[i];
    const rsi  = this._rsi[i];
    if (!vwap || !e20 || !e50 || !atr || rsi === null) return null;

    const bullBounce = pc.l <= vwap * (1 + STOP_BUFFER_PCT * 2) && c.c > vwap && e20 > e50 && rsi < 65;
    const bearBounce = pc.h >= vwap * (1 - STOP_BUFFER_PCT * 2) && c.c < vwap && e20 < e50 && rsi > 35;

    if (bullBounce) return { dir: 'long',  entry: c.c, stop: c.l - atr * 0.5 };
    if (bearBounce) return { dir: 'short', entry: c.c, stop: c.h + atr * 0.5 };
    return null;
  }
}

// ── Metrics Calculator ────────────────────────────────────────────────────────
export function calcMetrics(trades, initialCapital, equityCurve, tf = '5m') {
  if (!trades.length) return null;

  const closed  = trades.filter(t => t.pnl !== null);
  const wins    = closed.filter(t => t.pnl > 0);
  const losses  = closed.filter(t => t.pnl <= 0);
  const total   = closed.length;

  const winRate = total > 0 ? wins.length / total : 0;

  const grossWin  = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const netPnl    = grossWin - grossLoss;

  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;

  const avgWin  = wins.length   > 0 ? grossWin  / wins.length   : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  const rrVals = closed.filter(t => t.rr != null).map(t => t.rr);
  const avgRR  = rrVals.length > 0 ? rrVals.reduce((a, b) => a + b, 0) / rrVals.length : null;

  const { maxDrawdown, maxDrawdownPct, drawdownCurve } = calcDrawdown(equityCurve);
  const sharpe = calcSharpe(equityCurve, tf);

  let maxConsecWins = 0, maxConsecLoss = 0, cw = 0, cl = 0;
  closed.forEach(t => {
    if (t.pnl > 0) { cw++; cl = 0; maxConsecWins = Math.max(maxConsecWins, cw); }
    else           { cl++; cw = 0; maxConsecLoss = Math.max(maxConsecLoss, cl); }
  });

  const avgBars = closed.length > 0
    ? closed.reduce((a, t) => a + t.barDuration, 0) / closed.length
    : 0;

  const avgMAE = closed.length > 0 ? closed.reduce((a, t) => a + t.mae, 0) / closed.length : 0;
  const avgMFE = closed.length > 0 ? closed.reduce((a, t) => a + t.mfe, 0) / closed.length : 0;

  const byReason = {};
  closed.forEach(t => {
    if (!byReason[t.exitReason]) byReason[t.exitReason] = { count: 0, pnl: 0 };
    byReason[t.exitReason].count++;
    byReason[t.exitReason].pnl += t.pnl;
  });

  const riskOfRuin = estimateRiskOfRuin(winRate, avgWin, avgLoss, total);

  return {
    total,
    wins:    wins.length,
    losses:  losses.length,
    winRate: Math.round(winRate * 100),
    winRateRaw: winRate,

    grossWin, grossLoss, netPnl,
    profitFactor,
    expectancy,
    avgRR,
    avgWin, avgLoss,

    maxDrawdown, maxDrawdownPct,
    sharpe,

    maxConsecWins, maxConsecLoss,
    avgBars, avgMAE, avgMFE,
    byReason,
    riskOfRuin,

    finalEquity: equityCurve[equityCurve.length - 1]?.value ?? initialCapital,
    totalReturn: ((equityCurve[equityCurve.length - 1]?.value ?? initialCapital) - initialCapital) / initialCapital * 100,

    drawdownCurve,
  };
}

function calcDrawdown(equityCurve) {
  let peak = -Infinity;
  let maxDD = 0, maxDDPct = 0;
  const curve = equityCurve.map(({ idx, value }) => {
    if (value > peak) peak = value;
    const dd    = peak - value;
    const ddPct = peak > 0 ? dd / peak * 100 : 0;
    if (dd > maxDD)       maxDD    = dd;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
    return { idx, value, drawdown: dd, drawdownPct: ddPct };
  });
  return { maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, drawdownCurve: curve };
}

function calcSharpe(equityCurve, tf = '5m') {
  if (equityCurve.length < 2) return null;
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i-1].value;
    const curr = equityCurve[i].value;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  if (returns.length < 2) return null;
  const mean     = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const std      = Math.sqrt(variance);
  if (std === 0) return null;
  const barsPerYear = BARS_PER_YEAR[tf] ?? BARS_PER_YEAR['1d'];
  return (mean / std) * Math.sqrt(barsPerYear);
}

function estimateRiskOfRuin(winRate, avgWin, avgLoss, totalTrades) {
  if (avgLoss <= 0 || avgWin <= 0 || winRate <= 0) return null;
  const lossRate = 1 - winRate;
  const payoff   = avgWin / avgLoss;
  const edge     = winRate * payoff - lossRate;
  if (edge <= 0) return 1; // negative expectancy: ruin is certain
  const ratio = lossRate / (winRate * payoff);
  if (ratio >= 1) return 1;
  // Use 100-trade horizon as the ruin target (practical planning window).
  const horizon = Math.max(totalTrades, 100);
  return Math.min(1, Math.pow(ratio, horizon / 100));
}

// ── Walk-Forward Analysis ─────────────────────────────────────────────────────

export function runWalkForward(candles, engineConfig, wfOptions = {}) {
  const numWindows  = wfOptions.windows     || 4;
  const inSamplePct = wfOptions.inSamplePct || 0.7;
  const warmupBars  = engineConfig.warmupBars ?? DEFAULT_WARMUP_BARS;

  const totalBars  = candles.length;
  const windowSize = Math.floor(totalBars / numWindows);
  const minWindow  = warmupBars + 10;

  if (windowSize < minWindow) {
    console.warn(`[WalkForward] Window size (${windowSize}) is below minimum (${minWindow}). Results may be unreliable.`);
  }

  const results = [];

  const { onProgress: _ignored, ...safeConfig } = engineConfig;

  for (let w = 0; w < numWindows; w++) {
    const start = w * windowSize;
    const end   = Math.min(start + windowSize, totalBars);
    const split = start + Math.floor((end - start) * inSamplePct);

    const inSample  = candles.slice(start, split);
    const outSample = candles.slice(split, end);

    const isResult  = new BacktestEngine({ ...safeConfig, candles: inSample  }).run();
    const oosResult = new BacktestEngine({ ...safeConfig, candles: outSample }).run();

    results.push({
      window:      w + 1,
      inSample:    { bars: inSample.length,  metrics: isResult.metrics  },
      outSample:   { bars: outSample.length, metrics: oosResult.metrics },
      degradation: isResult.metrics && oosResult.metrics
        ? (isResult.metrics.winRate - oosResult.metrics.winRate)
        : null,
    });
  }

  const oosTrades    = results.flatMap(r => r.outSample?.metrics ? [r.outSample.metrics] : []);
  const aggregateOOS = {
    avgWinRate:  oosTrades.length > 0 ? oosTrades.reduce((a, m) => a + m.winRate, 0) / oosTrades.length : 0,
    avgNetPnl:   oosTrades.length > 0 ? oosTrades.reduce((a, m) => a + m.netPnl, 0) / oosTrades.length : 0,
    avgDrawdown: oosTrades.length > 0 ? oosTrades.reduce((a, m) => a + m.maxDrawdownPct, 0) / oosTrades.length : 0,
    consistency: results.filter(r => r.outSample?.metrics?.winRate >= 40).length / numWindows,
  };

  return { windows: results, aggregateOOS };
}

// ── Batch Strategy Comparison ─────────────────────────────────────────────────

export async function compareStrategies(candles, baseConfig = {}) {
  const results = [];

  const { onProgress: _ignored, candles: _ignoredCandles, ...safeConfig } = baseConfig;

  for (const strategy of Object.values(STRATEGIES)) {
    const engine = new BacktestEngine({ ...safeConfig, candles, strategy });
    const result = engine.run();
    results.push({
      strategy: strategy.label,
      id:       strategy.id,
      metrics:  result.metrics,
      trades:   result.trades.length,
    });
    await new Promise(r => setTimeout(r, 0));
  }

  return results.sort((a, b) => {
    if (!a.metrics) return 1;
    if (!b.metrics) return -1;
    return (b.metrics.netPnl || 0) - (a.metrics.netPnl || 0);
  });
}
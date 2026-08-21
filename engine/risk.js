/**
 * engine/risk.js
 * Futures & risk calculations:
 *   - Position sizing (risk-based + ATR-based)
 *   - Liquidation price (Binance, Bybit, OKX models)
 *   - Fee modeling (maker/taker/funding)
 *   - Break-even price
 *   - Daily goal tracker math
 *   - Dynamic leverage suggestions
 */

export const FEE_RATES = {
  maker: 0.0002,  // 0.02% — Binance/Bybit maker
  taker: 0.0005,  // 0.05% — Binance/Bybit taker
};

// ── Maintenance Margin Tiers ───────────────────────────────────────────────────
// Tiered by position notional (USDT). These mirror the publicly-published
// tier tables exchanges use for major linear-USDT pairs (BTC/ETH-class).
// Altcoins and lower-liquidity pairs often have steeper/fewer tiers — treat
// this as a realistic major-pair approximation, not an exact per-symbol feed.
// mmRate = maintenance margin rate; mmAmt = maintenance amount deduction (USDT)
// used by the exchange's exact formula: MM = notional*mmRate - mmAmt.
// Source: representative of Binance/Bybit/OKX public tier schedules (subject
// to periodic exchange updates — re-verify against the exchange API for
// production use).
export const MM_TIERS = {
  binance: [
    { max: 50_000,      mmRate: 0.004,  mmAmt: 0 },
    { max: 250_000,     mmRate: 0.005,  mmAmt: 50 },
    { max: 1_000_000,   mmRate: 0.010,  mmAmt: 1_300 },
    { max: 5_000_000,   mmRate: 0.025,  mmAmt: 16_300 },
    { max: 20_000_000,  mmRate: 0.050,  mmAmt: 141_300 },
    { max: Infinity,    mmRate: 0.100,  mmAmt: 1_141_300 },
  ],
  bybit: [
    { max: 50_000,      mmRate: 0.005,  mmAmt: 0 },
    { max: 200_000,     mmRate: 0.006,  mmAmt: 50 },
    { max: 500_000,     mmRate: 0.010,  mmAmt: 850 },
    { max: 1_000_000,   mmRate: 0.020,  mmAmt: 5_850 },
    { max: 5_000_000,   mmRate: 0.040,  mmAmt: 25_850 },
    { max: Infinity,    mmRate: 0.080,  mmAmt: 225_850 },
  ],
  okx: [
    { max: 50_000,      mmRate: 0.004,  mmAmt: 0 },
    { max: 250_000,     mmRate: 0.005,  mmAmt: 50 },
    { max: 1_000_000,   mmRate: 0.010,  mmAmt: 1_300 },
    { max: 5_000_000,   mmRate: 0.025,  mmAmt: 16_300 },
    { max: Infinity,    mmRate: 0.050,  mmAmt: 141_300 },
  ],
};

function lookupMMTier(exchange, notional, customTiers = null) {
  const tiers = customTiers?.length ? customTiers : (MM_TIERS[exchange] || MM_TIERS.binance);
  return tiers.find(t => notional <= t.max) || tiers[tiers.length - 1];
}

// ── Liquidation Prices ────────────────────────────────────────────────────────

/**
 * Isolated-margin liquidation price using real tiered maintenance margin.
 * Formula (isolated, linear USDT contract):
 *   Long:  Liq = Entry × (1 − 1/Leverage) + (mmRate × Entry − mmAmt/Qty)
 *   Short: Liq = Entry × (1 + 1/Leverage) − (mmRate × Entry − mmAmt/Qty)
 * where Qty = positionNotional / Entry.
 * `exchange` selects the tier table ('binance' | 'bybit' | 'okx'); defaults
 * to binance's schedule if unrecognized.
 */
export function calcLiqPrice(entry, leverage, dir, margin = null, exchange = 'binance', customTiers = null) {
  if (!entry || !leverage || leverage < 1) return null;
  const isLong = dir === 'long';

  // If margin isn't supplied we can't know notional/tier — fall back to the
  // lowest (tightest) tier as a conservative estimate.
  const notional = margin ? margin * leverage : 0;
  const tier = lookupMMTier(exchange, notional || 0, customTiers);
  const qty  = notional > 0 ? notional / entry : 0;
  const mmPerUnit = qty > 0 ? tier.mmRate * entry - tier.mmAmt / qty : tier.mmRate * entry;

  return isLong
    ? entry * (1 - 1 / leverage) + mmPerUnit
    : entry * (1 + 1 / leverage) - mmPerUnit;
}

/**
 * Bybit USDT perpetual liquidation using the tiered MM schedule.
 * `margin` is the isolated margin allocated to the position (USDT).
 */
export function calcLiqPriceBybit(entry, margin, leverage, dir, mmRateOverride = null) {
  if (!entry || !margin || !leverage) return null;
  const notional = margin * leverage;
  const tier = mmRateOverride != null
    ? { mmRate: mmRateOverride, mmAmt: 0 }
    : lookupMMTier('bybit', notional);
  const qty = notional / entry;
  const mmPerUnit = tier.mmRate * entry - tier.mmAmt / qty;
  const isLong = dir === 'long';
  return isLong
    ? entry * (1 - 1 / leverage) + mmPerUnit
    : entry * (1 + 1 / leverage) - mmPerUnit;
}

// ── Core Futures Math ─────────────────────────────────────────────────────────

/**
 * Main futures P&L calculator.
 * Returns a complete futures metrics object.
 */
export function calcFuturesMetrics({
  capital, margin, leverage, entry, stop, dir, rrRatio, feeType, exchange = 'binance', customTiers = null
}) {
  const isLong    = dir === 'long';
  const feeRate   = FEE_RATES[feeType] || FEE_RATES.maker;
  const posSize   = margin * leverage;

  // Liquidation — uses live per-symbol tiers when available (customTiers),
  // else the static major-pair approximation for the position's notional.
  const liqPrice    = calcLiqPrice(entry, leverage, dir, margin, exchange, customTiers) || 0;
  const liqDistPct  = entry > 0 ? Math.abs(liqPrice - entry) / entry * 100 : 0;

  // P&L if entry + stop are set
  let profitUSD = 0, lossUSD = 0;
  if (entry > 0 && stop > 0) {
    const stopDistPct = Math.abs(entry - stop) / entry * 100;
    lossUSD           = posSize * (stopDistPct / 100);
    profitUSD         = lossUSD * rrRatio;
  }

  // Fees (open + close)
  const feeOpen  = posSize * feeRate;
  const feeClose = posSize * feeRate;
  const feeTot   = feeOpen + feeClose;

  const profitNet = profitUSD - feeTot;
  const lossNet   = -(lossUSD + feeTot);
  const roiWin    = capital > 0 ? (profitNet / capital * 100) : 0;
  const roiLoss   = capital > 0 ? (lossNet   / capital * 100) : 0;
  const riskPct   = capital > 0 ? Math.abs(lossNet) / capital * 100 : 0;

  // Break-even price
  let bePrice = 0;
  if (entry > 0 && posSize > 0) {
    const tokens = posSize / entry;
    const beMove = tokens > 0 ? feeTot / tokens : 0;
    bePrice = isLong ? entry + beMove : entry - beMove;
  }

  // Liquidation gauge: previously divided liqDistPct by a "max safe distance"
  // that was computed with the exact same flat factor as liqPrice itself,
  // which made this always read ~100% regardless of actual risk — a dead
  // metric. Now it's simply the real liq distance (%), capped at 100, which
  // directly reflects how far price can move before liquidation.
  const liqGaugePct = Math.max(0, Math.min(100, liqDistPct));

  return {
    posSize, liqPrice, liqDistPct, liqGaugePct,
    profitUSD, profitNet, lossUSD, lossNet,
    feeOpen, feeClose, feeTot,
    roiWin, roiLoss, riskPct, bePrice,
  };
}

// ── Risk-Based Position Sizing ─────────────────────────────────────────────────

/**
 * Given a risk % of capital and stop distance, computes:
 *   - maximum position size ($ notional)
 *   - token count
 *   - recommended margin
 */
export function calcRiskBasedSize({ capital, riskPct, entry, stop, leverage }) {
  if (!capital || !riskPct || !entry || !stop || !leverage) return null;

  const riskUSD    = capital * (riskPct / 100);
  const stopDist   = Math.abs(entry - stop);
  if (stopDist === 0) return null;

  const tokens      = riskUSD / stopDist;
  const positionVal = tokens * entry;
  const margin      = positionVal / leverage;

  return { riskUSD, tokens, positionVal, margin, stopDist };
}

// ── ATR Stop Placement ────────────────────────────────────────────────────────

/**
 * Suggests a stop loss price based on ATR multiple.
 */
export function calcATRStop(entry, atr, dir, multiple = 2) {
  if (!entry || !atr) return null;
  return dir === 'long' ? entry - atr * multiple : entry + atr * multiple;
}

/** Trailing stop at ATR × multiple from current price */
export function calcATRTrailStop(currentPrice, atr, dir, multiple = 2) {
  if (!currentPrice || !atr) return null;
  return dir === 'long' ? currentPrice - atr * multiple : currentPrice + atr * multiple;
}

// ── Daily Goal Tracker ────────────────────────────────────────────────────────

/**
 * Calculates how many winning trades are needed to hit a daily goal.
 */
export function calcDailyGoal({ capital, goalPct, margin, leverage, entry, stop, rrRatio, feeType }) {
  const feeRate   = FEE_RATES[feeType] || FEE_RATES.maker;
  const posSize   = margin * leverage;
  const feeTot    = posSize * feeRate * 2;
  const goalUSD   = capital * goalPct / 100;

  if (!entry || !stop) {
    return { goalUSD, perTrade: 0, tradesNeeded: null, summary: 'Set entry and stop loss to see trade breakdown.' };
  }

  const stopDistPct = Math.abs(entry - stop) / entry * 100;
  const grossLoss   = posSize * stopDistPct / 100;
  const grossProfit = grossLoss * rrRatio;
  const perTrade    = grossProfit - feeTot;
  const lossNet     = -(grossLoss + feeTot);

  if (perTrade <= 0) {
    return { goalUSD, perTrade, tradesNeeded: Infinity, summary: `⚠ Fees ($${feeTot.toFixed(3)}) exceed gross profit. Widen TP or reduce fees.` };
  }

  const tradesNeeded = Math.ceil(goalUSD / perTrade);

  const rates = [0.30, 0.40, 0.50, 0.60];
  const tableRows = rates.map(wr => {
    const roundTrips = Math.ceil(tradesNeeded / wr);
    const losses     = roundTrips - tradesNeeded;
    return `${Math.round(wr * 100)}% WR: ${roundTrips} trades (${tradesNeeded}W/${losses}L)`;
  }).join(' · ');

  const summary = `At ${leverage}× with $${margin} margin, each winner nets ~$${perTrade.toFixed(2)} after fees. `
    + `Need ${tradesNeeded} winners to hit $${goalUSD.toFixed(2)}. `
    + `${tableRows}. ⚠ Arithmetic only — not a prediction.`;

  return { goalUSD, perTrade, tradesNeeded, lossNet, summary };
}

// ── Dynamic Leverage Suggestion ───────────────────────────────────────────────

/**
 * Suggests a safe maximum leverage given account size, risk tolerance and ATR.
 */
export function suggestLeverage({ entry, atr, riskPctPerTrade = 1 }) {
  if (!entry || !atr) return 10;
  // Stop distance as % of price (1× ATR)
  const stopPct = (atr / entry) * 100;
  if (stopPct === 0) return 10;
  // Max leverage such that 1 ATR stop = riskPctPerTrade% of margin
  // Simple: leverage = riskPctPerTrade / stopPct × some safety factor
  const suggested = Math.floor((riskPctPerTrade / stopPct) * 50);
  return Math.max(1, Math.min(suggested, 20)); // cap at 20× for safety
}

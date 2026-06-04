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

// ── Liquidation Prices ────────────────────────────────────────────────────────

/**
 * Simplified isolated-margin liquidation price.
 * Approximation valid for Binance/Bybit/OKX linear contracts.
 * Liq price ≈ entry × (1 − 1/leverage × maintenanceMarginRate × 0.9)
 *
 * Full formula requires maintenance margin tier tables per exchange.
 * We use 0.9 factor as a conservative safety estimate.
 */
export function calcLiqPrice(entry, leverage, dir) {
  if (!entry || !leverage || leverage < 1) return null;
  const isLong = dir === 'long';
  return isLong
    ? entry * (1 - (1 / leverage) * 0.9)
    : entry * (1 + (1 / leverage) * 0.9);
}

/**
 * Bybit USDT perpetual liquidation (more accurate — includes maintenance margin).
 * maintenanceMarginRate defaults to 0.5% (lowest tier, <5000 USDT position).
 */
export function calcLiqPriceBybit(entry, margin, leverage, dir, mmRate = 0.005) {
  if (!entry || !margin || !leverage) return null;
  const positionSize = margin * leverage;
  const isLong = dir === 'long';
  // Liq = entry - (margin - fees - maintenanceMargin) / (qty)
  // Simplified: Liq ≈ entry × (1 − (1 − mmRate) / leverage)
  return isLong
    ? entry * (1 - (1 - mmRate) / leverage)
    : entry * (1 + (1 - mmRate) / leverage);
}

// ── Core Futures Math ─────────────────────────────────────────────────────────

/**
 * Main futures P&L calculator.
 * Returns a complete futures metrics object.
 */
export function calcFuturesMetrics({
  capital, margin, leverage, entry, stop, dir, rrRatio, feeType
}) {
  const isLong    = dir === 'long';
  const feeRate   = FEE_RATES[feeType] || FEE_RATES.maker;
  const posSize   = margin * leverage;

  // Liquidation
  const liqPrice    = calcLiqPrice(entry, leverage, dir) || 0;
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

  // Liquidation gauge %
  const maxSafeDist = (1 / leverage) * 100 * 0.9;
  const liqGaugePct = Math.min(100, liqDistPct / (maxSafeDist || 1) * 100);

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

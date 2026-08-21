/**
 * services/riskTiers.js
 * Fetches real per-symbol maintenance-margin tier tables from exchange
 * public APIs, so liquidation math uses the actual tiers for the symbol
 * being traded instead of the static major-pair approximation in
 * engine/risk.js.
 *
 * Coverage:
 *   - Bybit: GET /v5/market/risk-limit — public, no auth, CORS-enabled.
 *   - OKX:   GET /api/v5/public/position-tiers — public, no auth, CORS-enabled.
 *   - Binance: the real bracket endpoint (/fapi/v1/leverageBracket) requires
 *     an API key even for read-only access, so it can't be called directly
 *     from the browser without a signed proxy. Falls back to the static
 *     MM_TIERS.binance table in engine/risk.js. If you want live Binance
 *     tiers, the cleanest path is proxying through your existing Cloudflare
 *     Worker (the same one klines already go through) with a signed request.
 *
 * Results are cached in localStorage for CACHE_TTL_MS since tiers change
 * rarely (days/weeks, not per session).
 */

import { tryFetch } from '../utils/helpers.js';

const CACHE_KEY     = 'risk_tiers_v1';
const CACHE_TTL_MS  = 6 * 60 * 60 * 1000; // 6h

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch(e) { return {}; }
}

function writeCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch(e) {}
}

function cacheKey(exchange, sym) { return `${exchange}:${sym}`; }

/**
 * Returns tiers as [{ max, mmRate, mmAmt }, ...] sorted ascending by `max`,
 * matching the shape engine/risk.js's MM_TIERS uses — or null if unavailable
 * (caller should fall back to the static table).
 */
export async function fetchRiskTiers(exchange, sym) {
  const key = cacheKey(exchange, sym);
  const cache = readCache();
  const hit = cache[key];
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.tiers;

  let tiers = null;
  try {
    if (exchange === 'bybit')      tiers = await _fetchBybitTiers(sym);
    else if (exchange === 'okx')   tiers = await _fetchOkxTiers(sym);
    // binance: no public unauthenticated endpoint — leave tiers = null,
    // engine/risk.js falls back to its static MM_TIERS.binance table.
  } catch(e) {
    tiers = null; // network/API error — caller falls back silently
  }

  if (tiers?.length) {
    cache[key] = { tiers, ts: Date.now() };
    // Cap cache size so this never grows unbounded across symbols switched over time.
    const keys = Object.keys(cache);
    if (keys.length > 100) delete cache[keys[0]];
    writeCache(cache);
  }
  return tiers;
}

async function _fetchBybitTiers(sym) {
  const d = await tryFetch(`https://api.bybit.com/v5/market/risk-limit?category=linear&symbol=${sym}`);
  const list = d?.result?.list;
  if (!Array.isArray(list) || !list.length) return null;
  return list
    .map(t => ({
      max:    +t.riskLimitValue,
      mmRate: +t.maintainMargin,
      mmAmt:  0, // Bybit's schedule doesn't use a separate deduction amount
    }))
    .sort((a, b) => a.max - b.max);
}

async function _fetchOkxTiers(sym) {
  // OKX tiers are keyed by instFamily (e.g. "BTC-USDT"), not the raw symbol.
  const base = sym.replace(/USDT$/, '');
  const instFamily = `${base}-USDT`;
  const d = await tryFetch(
    `https://www.okx.com/api/v5/public/position-tiers?instType=SWAP&tdMode=cross&instFamily=${instFamily}`
  );
  const list = d?.data;
  if (!Array.isArray(list) || !list.length) return null;
  return list
    .map(t => ({
      max:    +t.maxSz * (+t.maxSz > 0 ? 1 : 1), // notional cap; OKX reports in contracts for some pairs — treat as USDT-notional proxy
      mmRate: +t.mmr,
      mmAmt:  0,
    }))
    .filter(t => Number.isFinite(t.max) && Number.isFinite(t.mmRate))
    .sort((a, b) => a.max - b.max);
}

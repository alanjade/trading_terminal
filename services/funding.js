/**
 * services/funding.js
 * Fetches current perpetual funding rate + next funding time from exchange
 * public APIs (all three support this without auth). Used to surface funding
 * cost/edge in the futures panel, which calcFuturesMetrics previously ignored
 * entirely (it only modeled open/close trading fees).
 *
 * Funding is charged every 8h (typical) at a rate set by the exchange based
 * on perp-vs-spot premium. Positive rate = longs pay shorts, negative = shorts
 * pay longs.
 */

import { tryFetch } from '../utils/helpers.js';

const CACHE_KEY    = 'funding_rate_v1';
const CACHE_TTL_MS = 2 * 60 * 1000; // 2min — funding rate itself updates slowly but countdown needs to stay fresh-ish

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch(e) { return {}; }
}
function writeCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch(e) {}
}

/**
 * Returns { rate, nextFundingTime } where rate is a decimal (e.g. 0.0001 = 0.01%)
 * and nextFundingTime is a ms epoch timestamp, or null if unavailable.
 */
export async function fetchFundingRate(exchange, sym) {
  const key = `${exchange}:${sym}`;
  const cache = readCache();
  const hit = cache[key];
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.data;

  let data = null;
  try {
    if (exchange === 'bybit')      data = await _fetchBybit(sym);
    else if (exchange === 'binance') data = await _fetchBinance(sym);
    else if (exchange === 'okx')   data = await _fetchOkx(sym);
  } catch(e) { data = null; }

  if (data) {
    cache[key] = { data, ts: Date.now() };
    const keys = Object.keys(cache);
    if (keys.length > 100) delete cache[keys[0]];
    writeCache(cache);
  }
  return data;
}

async function _fetchBybit(sym) {
  const d = await tryFetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`);
  const t = d?.result?.list?.[0];
  if (!t) return null;
  return {
    rate: +t.fundingRate,
    nextFundingTime: +t.nextFundingTime,
  };
}

async function _fetchBinance(sym) {
  const d = await tryFetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`);
  if (!d?.lastFundingRate && d?.lastFundingRate !== '0') return null;
  return {
    rate: +d.lastFundingRate,
    nextFundingTime: +d.nextFundingTime,
  };
}

async function _fetchOkx(sym) {
  const base = sym.replace(/USDT$/, '');
  const instId = `${base}-USDT-SWAP`;
  const d = await tryFetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`);
  const t = d?.data?.[0];
  if (!t) return null;
  return {
    rate: +t.fundingRate,
    nextFundingTime: +t.nextFundingTime,
  };
}

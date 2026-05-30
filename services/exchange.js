/**
 * services/exchange.js
 * Exchange abstraction layer: WebSocket feeds, REST kline fetching,
 * trade stream, reconnection logic.
 */

import { BY_TF, BY_TF_WS, OKX_TF_REST, OKX_TF_WS, tryFetch, TF_MS } from '../utils/helpers.js';
import { state } from '../state/store.js';

// ── Exchange Definitions ──────────────────────────────────────────────────────

export const EXCHANGES = {
  bybit: {
    name: 'Bybit',
    wsUrl:      'wss://stream.bybit.com/v5/public/spot',
    tradeWsUrl: 'wss://stream.bybit.com/v5/public/spot',
    wsSub:  (sym, tf) => ({ op:'subscribe', args:[`kline.${BY_TF_WS[tf]||'5'}.${sym}`] }),
    tradeSub: sym => ({ op:'subscribe', args:[`publicTrade.${sym}`] }),
    wsPing: ()  => ({ op:'ping' }),
    wsKlineConfirm: msg => msg?.data?.[0]?.confirm,
    wsKlineToCandle: k  => ({ t:+k.start, o:+k.open, h:+k.high, l:+k.low, c:+k.close, v:+k.volume }),
    wsTradeToTick:   t  => ({ price:+t.p, qty:+t.v, side: t.S==='Buy'?'buy':'sell', ts:+t.T }),
    klineUrl: (sym, tf) => `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${BY_TF[tf]||'5'}&limit=500`,
    parseKlines: d => (d?.result?.list||[]).slice().reverse().map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})),
    parseWsKlines: msg => msg?.data || [],
  },

  binance: {
    name: 'Binance',
    wsUrl:      'wss://stream.binance.com:9443/stream',
    tradeWsUrl: 'wss://stream.binance.com:9443/stream',
    wsSub: (sym, tf) => ({
      method:'SUBSCRIBE',
      params:[`${sym.toLowerCase()}@kline_${tf}`],
      id:1
    }),
    tradeSub: sym => ({ method:'SUBSCRIBE', params:[`${sym.toLowerCase()}@aggTrade`], id:2 }),
    wsPing: () => ({ method:'LIST_SUBSCRIPTIONS', id:99 }),
    wsKlineConfirm: msg => msg?.data?.k?.x || msg?.k?.x,
    wsKlineToCandle: k => { const kd=k.k||k; return {t:+kd.t,o:+kd.o,h:+kd.h,l:+kd.l,c:+kd.c,v:+kd.v}; },
    wsTradeToTick:   t => { const d=t.data||t; return {price:+d.p,qty:+d.q,side:d.m?'sell':'buy',ts:+d.T}; },
    klineUrl: (sym, tf) => `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=500`,
    parseKlines: d => (Array.isArray(d)?d:[]).map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})),
    parseWsKlines: msg => {
      const k = msg?.data?.k || msg?.k;
      return k ? [k] : [];
    },
  },

  okx: {
    name: 'OKX',
    wsUrl:      'wss://ws.okx.com:8443/ws/v5/public',
    tradeWsUrl: 'wss://ws.okx.com:8443/ws/v5/public',
    wsSub: (sym, tf) => {
      const instId = sym.replace('USDT','-USDT');
      return { op:'subscribe', args:[{ channel:`candle${OKX_TF_WS[tf]||'5m'}`, instId }] };
    },
    tradeSub: sym => {
      const instId = sym.replace('USDT','-USDT');
      return { op:'subscribe', args:[{ channel:'trades', instId }] };
    },
    wsPing: () => 'ping',
    wsKlineConfirm: msg => msg?.data?.[0]?.[8]==='1',
    wsKlineToCandle: k  => ({ t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5] }),
    wsTradeToTick:   t  => ({ price:+t.px,qty:+t.sz,side:t.side==='buy'?'buy':'sell',ts:+t.ts }),
    klineUrl: (sym, tf) => {
      const instId = sym.replace('USDT','-USDT');
      return `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${OKX_TF_REST[tf]||'5m'}&limit=500`;
    },
    parseKlines: d => (d?.data||[]).slice().reverse().map(k=>({t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})),
    parseWsKlines: msg => msg?.data || [],
  },
};

// ── REST Kline Fetching ───────────────────────────────────────────────────────

/**
 * Fetches klines for the given exchange, symbol, and timeframe.
 * Returns array of Candle objects, or null on failure.
 */
export async function fetchKlines(exchName, sym, tf) {
  const exch = EXCHANGES[exchName];
  if (!exch) return null;
  try {
    const data = await tryFetch(exch.klineUrl(sym, tf));
    return exch.parseKlines(data);
  } catch(e) {
    console.warn(`[exchange] fetchKlines ${exchName} failed:`, e.message);
    return null;
  }
}

/**
 * Tries all exchanges in order for a given symbol/tf.
 * Returns { candles, source } or null.
 */
export async function fetchKlinesFallback(sym, tf) {
  const order = ['binance', 'bybit', 'okx'];
  for (const name of order) {
    const candles = await fetchKlines(name, sym, tf);
    if (candles && candles.length >= 10) {
      return { candles, source: name };
    }
  }
  return null;
}

// ── WebSocket Manager ─────────────────────────────────────────────────────────

export class KlineWebSocket {
  constructor({ exchName, sym, tf, onCandle, onStatus }) {
    this.exchName  = exchName;
    this.sym       = sym;
    this.tf        = tf;
    this.onCandle  = onCandle;
    this.onStatus  = onStatus;
    this.ws        = null;
    this.pingTimer = null;
    this.reconnTimer = null;
    this.staleTimer  = null;
    this.lastMsgTime = 0;
    this._closed   = false;
  }

  connect() {
    this._closed = false;
    const exch = EXCHANGES[this.exchName];
    if (!exch) return;

    try { this.ws = new WebSocket(exch.wsUrl); }
    catch(e) { this._scheduleReconnect(); return; }

    this.ws.onopen = () => {
      this.onStatus?.('connected', `${exch.name} · ${this.sym} · ${this.tf}`);
      this.lastMsgTime = Date.now();
      this.ws.send(JSON.stringify(exch.wsSub(this.sym, this.tf)));

      // Ping keepalive
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          const ping = exch.wsPing();
          if (ping) this.ws.send(typeof ping === 'string' ? ping : JSON.stringify(ping));
        }
      }, 20_000);

      // Stale detection
      this.staleTimer = setInterval(() => {
        if (Date.now() - this.lastMsgTime > 10_000) {
          this.onStatus?.('warn', 'Feed stale — reconnecting…');
          this.reconnect();
        }
      }, 5_000);
    };

    this.ws.onmessage = (evt) => {
      this.lastMsgTime = Date.now();
      let msg;
      try { msg = JSON.parse(evt.data); } catch(e) { return; }

      const raw = exch.parseWsKlines(msg);
      raw.forEach(k => {
        const candle    = exch.wsKlineToCandle(k);
        const confirmed = exch.wsKlineConfirm(msg);
        this.onCandle?.(candle, confirmed);
      });
    };

    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      this._clearTimers();
      if (!this._closed) this._scheduleReconnect();
    };
  }

  reconnect() {
    this.close();
    this._closed = false;
    this.connect();
  }

  close() {
    this._closed = true;
    this._clearTimers();
    if (this.ws) { try { this.ws.close(); } catch(e) {} this.ws = null; }
  }

  _clearTimers() {
    clearInterval(this.pingTimer);  this.pingTimer  = null;
    clearInterval(this.staleTimer); this.staleTimer = null;
    clearTimeout(this.reconnTimer); this.reconnTimer = null;
  }

  _scheduleReconnect() {
    this._clearTimers();
    this.reconnTimer = setTimeout(() => this.connect(), 5_000);
  }
}

// ── Trade Stream ──────────────────────────────────────────────────────────────

export class TradeStream {
  constructor({ exchName, sym, onTick }) {
    this.exchName = exchName;
    this.sym      = sym;
    this.onTick   = onTick;
    this.ws       = null;
    this.pingTimer  = null;
    this.reconnTimer= null;
    this.rateTimer  = null;
    this.count1s    = 0;
    this._closed    = false;
  }

  connect() {
    this._closed = false;
    const exch = EXCHANGES[this.exchName];
    if (!exch?.tradeWsUrl) return;

    try { this.ws = new WebSocket(exch.tradeWsUrl); }
    catch(e) { return; }

    this.ws.onopen = () => {
      const sub = exch.tradeSub(this.sym);
      if (sub) this.ws.send(JSON.stringify(sub));

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          const ping = exch.wsPing();
          if (ping) this.ws.send(typeof ping === 'string' ? ping : JSON.stringify(ping));
        }
      }, 20_000);
    };

    this.ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch(e) { return; }
      if (!msg || typeof msg !== 'object') return;

      let ticks = [];
      if (this.exchName === 'bybit' && msg.topic?.startsWith('publicTrade') && Array.isArray(msg.data)) {
        ticks = msg.data.map(exch.wsTradeToTick);
      } else if (this.exchName === 'binance') {
        const d = msg.data || msg;
        if (d?.e === 'aggTrade') ticks = [exch.wsTradeToTick(d)];
      } else if (this.exchName === 'okx' && msg.arg?.channel === 'trades' && Array.isArray(msg.data)) {
        ticks = msg.data.map(exch.wsTradeToTick).filter(Boolean);
      }

      this.count1s += ticks.length;
      ticks.forEach(t => t?.price && this.onTick?.(t));
    };

    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      this._clearTimers();
      if (!this._closed) this.reconnTimer = setTimeout(() => this.connect(), 6_000);
    };
  }

  close() {
    this._closed = true;
    this._clearTimers();
    if (this.ws) { try { this.ws.close(); } catch(e) {} this.ws = null; }
  }

  _clearTimers() {
    clearInterval(this.pingTimer);  this.pingTimer   = null;
    clearTimeout(this.reconnTimer); this.reconnTimer = null;
  }
}

// ── Multi-Symbol Screener Fetch ───────────────────────────────────────────────

const RATE_LIMIT_DELAY_MS = 180; // ~5 req/s per exchange

/**
 * Fetches klines for multiple symbols across timeframes with rate limiting.
 * Calls onProgress({ done, total, sym }) for each completed symbol.
 *
 * @param {string[]}  symbols
 * @param {string[]}  tfs       - timeframes to fetch per symbol
 * @param {string}    exchName
 * @param {function}  onProgress
 * @returns {Map<string, Record<string, Candle[]>>}  symbol → tf → candles
 */
export async function batchFetchScreener(symbols, tfs, exchName, onProgress) {
  const exch    = EXCHANGES[exchName];
  if (!exch) return new Map();

  const results = new Map();
  let done = 0;

  for (const sym of symbols) {
    const tfMap = {};
    for (const tf of tfs) {
      try {
        const data    = await tryFetch(exch.klineUrl(sym, tf), 6_000);
        const candles = exch.parseKlines(data);
        if (candles?.length >= 10) tfMap[tf] = candles;
      } catch(e) {
        // Skip silently; screener handles missing data
      }
      await sleep(RATE_LIMIT_DELAY_MS);
    }
    results.set(sym, tfMap);
    done++;
    onProgress?.({ done, total: symbols.length, sym });
  }

  return results;
}

const sleep = ms => new Promise(res => setTimeout(res, ms));

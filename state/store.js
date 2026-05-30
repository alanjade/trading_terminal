/**
 * state/store.js
 * Single source of truth for all app state.
 * Replaces the dozens of scattered `let` vars in the monolith.
 * Exported as a plain JS object so it works without a build step.
 */

export const state = {
  // ── Active symbol / timeframe / exchange ──────────────────────────────────
  sym:            'BTCUSDT',
  tf:             '5m',
  exchange:       'bybit',

  // ── Candle data ──────────────────────────────────────────────────────────
  candles:        [],   // committed closed candles
  currentCandle:  null, // live forming candle

  // ── Indicator arrays (parallel to candles[]) ─────────────────────────────
  e9s:     [],
  e20s:    [],
  e50s:    [],
  rsiVals: [],

  // ── Running EMA values (latest) ──────────────────────────────────────────
  e9:  null,
  e20: null,
  e50: null,

  // ── Wilder RMA state ─────────────────────────────────────────────────────
  rmaAvgGain: null,
  rmaAvgLoss: null,
  prevClose:  null,

  // ── VWAP state ───────────────────────────────────────────────────────────
  vwapVals:       [],
  vwapBandVals:   [],
  vwapCumPV:      0,
  vwapCumV:       0,
  vwapM2:         0,
  vwapSessionKey: '',

  // ── CVD state ────────────────────────────────────────────────────────────
  cvdVals:       [],
  cvdRunning:    0,
  cvdEmaVals:    [],
  cvdEmaRun:     null,
  cvdSessionKey: '',
  cvdResetMode:  'continuous', // 'continuous' | 'daily'
  CVD_EMA_K:     2 / (5 + 1),

  // ── Live price ───────────────────────────────────────────────────────────
  livePrice:     0,
  prevLivePrice: 0,
  openPrice:     0,

  // ── Crossovers ───────────────────────────────────────────────────────────
  crossovers: [],

  // ── Signal / suggestion ──────────────────────────────────────────────────
  suggestion: { entry: 0, stop: 0, target: 0, dir: 'long' },

  // ── Market regime ────────────────────────────────────────────────────────
  regime: null, // MarketRegime | null

  // ── Structure detection ──────────────────────────────────────────────────
  swingPoints:      [],
  structureEvents:  [],

  // ── Entry zones ──────────────────────────────────────────────────────────
  entryZones: { aggressive: 0, balanced: 0, conservative: 0, dir: 'long', stop: 0 },

  // ── Chart UI ─────────────────────────────────────────────────────────────
  hoverIdx:       -1,
  currentDir:     'long',
  rrRatio:        2,
  overlayFib:     true,
  overlayVP:      true,
  overlayDiv:     true,
  showVwapBands:  true,
  showCvdEma:     true,

  // ── Anchored VWAP ────────────────────────────────────────────────────────
  anchorIdx:  null,
  avwapVals:  [],
  avwapCumPV:  0,    
  avwapCumV:   0,    

  // ── Worker VP result ─────────────────────────────────────────────────────
  workerVP: null,

  // ── Trade stream ─────────────────────────────────────────────────────────
  tradeStreamDelta: 0,
  tradeBuyVol:      0,
  tradeSellVol:     0,
  tradeCount1s:     0,
  tradeRate:        0,
  tradeCandle:      null,
  tradeCandleStart: 0,
  tradeTickBuf:     [],

  // ── Replay ───────────────────────────────────────────────────────────────
  replayData:   [],
  replayIdx:    0,
  replayActive: false,

  // ── Futures calculator ───────────────────────────────────────────────────
  leverage: 10,
  feeType:  'maker',

  // ── Screener ─────────────────────────────────────────────────────────────
  scrRunning:  false,
  scrResults:  [],
  scrFilter:   'all',
  scrSortKey:  'score',
  scrSortAsc:  false,
  scrTFs:      new Set(['5m','15m','1h','4h']),
  scrExchange: 'binance',
  scrListMode: 'default',
  scrCoinList: [],
  scrAutoOn:   false,

  // ── Watchlist ─────────────────────────────────────────────────────────────
  watchlist: [],

  // ── Alerts ───────────────────────────────────────────────────────────────
  alerts:   [],
  alertDir: 'above',

  // ── P&L tracker ─────────────────────────────────────────────────────────
  pnlTrades:  [],
  tradeCount: 0,

  // ── Trade Journal ────────────────────────────────────────────────────────
  journalTrades: [],

  // ── MTF data ─────────────────────────────────────────────────────────────
  mtfData: {},

  // ── Theme ────────────────────────────────────────────────────────────────
  isDark: true,

  // ── Misc timers (refs stored here to allow cleanup) ──────────────────────
  timers: {
    pollTimer:     null,
    wsReconnTimer: null,
    wsPingTimer:   null,
    wsStaleTimer:  null,
    tradeWsTimer:  null,
    tradeRateTimer:null,
    scrAutoTimer:  null,
    replayTimer:   null,
  },

  lastCandleTime: 0,
  activeApiIdx:   0,
};

/**
 * Resets candle-derived state when switching symbol/timeframe.
 * Keeps user preferences (leverage, watchlist, etc.) intact.
 */
export function resetCandleState() {
  state.candles      = [];
  state.currentCandle= null;
  state.e9s = []; state.e20s = []; state.e50s = []; state.rsiVals = [];
  state.e9 = null; state.e20 = null; state.e50 = null;
  state.rmaAvgGain = null; state.rmaAvgLoss = null; state.prevClose = null;
  state.crossovers  = [];
  state.vwapVals = []; state.vwapBandVals = [];
  state.vwapCumPV = 0; state.vwapCumV = 0; state.vwapM2 = 0; state.vwapSessionKey = '';
  state.cvdVals = []; state.cvdRunning = 0; state.cvdEmaVals = [];
  state.cvdEmaRun = null; state.cvdSessionKey = '';
  state.liveTradesDelta = 0; state.tradeBuyVol = 0; state.tradeSellVol = 0;
  state.tradeStreamDelta = 0; state.tradeCandle = null; state.tradeCandleStart = 0;
  state.tradeTickBuf = [];
  state.anchorIdx = null; state.avwapVals = [];
  state.workerVP = null;
  state.suggestion = { entry: 0, stop: 0, target: 0, dir: 'long' };
  state.regime = null;
  state.swingPoints = []; state.structureEvents = [];
  state.hoverIdx = -1;
  state.anchorIdx  = null;
  state.avwapVals  = [];
  state.avwapCumPV = 0;   
  state.avwapCumV  = 0;   
  state.workerVP   = null;
}

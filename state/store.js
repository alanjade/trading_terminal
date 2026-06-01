/**
 * state/store.js
 * Single source of truth for all app state.
 */

export const state = {
  sym:            'BTCUSDT',
  tf:             '5m',
  exchange:       'bybit',

  candles:        [],
  currentCandle:  null,

  e9s:     [],
  e20s:    [],
  e50s:    [],
  rsiVals: [],

  e9:  null,
  e20: null,
  e50: null,

  rmaAvgGain:  null,
  rmaAvgLoss:  null,
  _rsiGains:   [],
  _rsiLosses:  [],
  prevClose:   null,

  vwapVals:       [],
  vwapBandVals:   [],
  vwapCumPV:      0,
  vwapCumV:       0,
  vwapM2:         0,
  vwapSessionKey: '',

  cvdVals:       [],
  cvdRunning:    0,
  cvdEmaVals:    [],
  cvdEmaRun:     null,
  cvdSessionKey: '',
  cvdResetMode:  'continuous',
  CVD_EMA_K:     2 / (5 + 1),

  livePrice:     0,
  prevLivePrice: 0,
  openPrice:     0,

  crossovers: [],

  suggestion: { entry: 0, stop: 0, target: 0, dir: 'long' },

  regime: null,

  swingPoints:      [],
  structureEvents:  [],

  entryZones: { aggressive: 0, balanced: 0, conservative: 0, dir: 'long', stop: 0 },

  hoverIdx:       -1,
  currentDir:     'long',
  rrRatio:        2,
  overlayFib:     true,
  overlayVP:      true,
  overlayDiv:     true,
  showVwapBands:  true,
  showCvdEma:     true,

  anchorIdx:   null,
  avwapVals:   [],
  avwapCumPV:  0,
  avwapCumV:   0,

  workerVP: null,

  tradeStreamDelta: 0,
  tradeBuyVol:      0,
  tradeSellVol:     0,
  tradeCount1s:     0,
  tradeRate:        0,
  tradeCandle:      null,
  tradeCandleStart: 0,
  tradeTickBuf:     [],

  replayData:   [],
  replayIdx:    0,
  replayActive: false,

  leverage: 10,
  feeType:  'maker',

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

  watchlist: [],

  alerts:   [],
  alertDir: 'above',

  pnlTrades:  [],
  tradeCount: 0,

  journalTrades: [],

  mtfData: {},

  isDark: true,

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

  sessionLevels: null,
};

export function resetCandleState() {
  state.candles      = [];
  state.currentCandle= null;
  state.e9s = []; state.e20s = []; state.e50s = []; state.rsiVals = [];
  state.e9 = null; state.e20 = null; state.e50 = null;
  state.rmaAvgGain = null; state.rmaAvgLoss = null;
  state._rsiGains = []; state._rsiLosses = [];
  state.prevClose = null;
  state.crossovers  = [];
  state.vwapVals = []; state.vwapBandVals = [];
  state.vwapCumPV = 0; state.vwapCumV = 0; state.vwapM2 = 0; state.vwapSessionKey = '';
  state.cvdVals = []; state.cvdRunning = 0; state.cvdEmaVals = [];
  state.cvdEmaRun = null; state.cvdSessionKey = '';
  state.tradeStreamDelta = 0; state.tradeBuyVol = 0; state.tradeSellVol = 0;
  state.tradeCandle = null; state.tradeCandleStart = 0;
  state.tradeTickBuf = [];
  state.anchorIdx = null; state.avwapVals = [];
  state.avwapCumPV = 0; state.avwapCumV = 0;
  state.workerVP = null;
  state.suggestion = { entry: 0, stop: 0, target: 0, dir: 'long' };
  state.regime = null;
  state.swingPoints = []; state.structureEvents = [];
  state.hoverIdx = -1;
  state.sessionLevels = null;
}
import { state, resetCandleState } from './state/store.js';
import { loadSettings, saveSettings, loadWatchlist, saveWatchlist, loadCollapsed, saveCollapsed } from './state/persistence.js';
import { fmt, fmtSym, fmtK, TF_MS } from './utils/helpers.js';
import { updEMA, emaK, calcWilderRSI, updVWAP, computeLiveVwap, computeLiveBands, updCVD, calcATR, detectRSIDivergence, getFibLevels } from './indicators/engine.js';
import { detectRegime, calcTrendAge, calcMomentumAcceleration } from './indicators/regime.js';
import { detectSwingPoints, detectStructureBreaks, getSessionLevels,
  detectLiquiditySweeps, detectEqualLevels,
  detectDisplacementCandles, getSessionContext
} from './indicators/structure.js';
import {  computeSuggestion, scoreEntryQuality, computeEntryZones,
  computePartialTPs, calcAtrPositionSize, detectSqueezeBreakout
} from './engine/signals.js';
import { calcFuturesMetrics, calcRiskBasedSize, calcATRStop, calcATRTrailStop, calcDailyGoal, suggestLeverage } from './engine/risk.js';
import { initRenderer, scheduleRender, cancelPendingRender, RenderPriority } from './engine/renderer.js';
import { KlineWebSocket, TradeStream, fetchKlines, fetchKlinesFallback, batchFetchScreener } from './services/exchange.js';
import { initSearch, initScreenerFilter, getScreenerTextFilter } from './components/search.js';
import { analyseSymbol, calcTFSnapshot, applyScreenerFilters, sortScreenerResults, detectSectorRotation, SCR_DEFAULT_COINS, SCR_CURATED_TIERS } from './services/screener.js';
import { initJournal, openJournalEntry, saveJournalEntry, renderJournalList, renderJournalStats, exportJournal, deleteJournalTrade, editJournalTrade } from './components/journal.js';
import { LWCChart } from './charts/lwc.js';
import { backtesterHTML, btRun, btCompare, btExport, initBacktester } from './components/backtester.js';
import * as dom from './ui/dom.js';
import { initTooltips, setTip } from './ui/tooltip.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const CANDLE_WINDOW        = 500;  // rolling candle buffer; must be > EMA-50 warm-up + analysis lookback
const REPLAY_MIN_INTERVAL  = 50;   // ms floor for replay tick interval
const REPLAY_BASE_INTERVAL = 400;  // ms at speed=1; divided by speed value
const SCR_AUTO_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between auto-scans
const MTF_TOP_N_FROM_SCR   = 20;   // coins imported from screener into MTF panel

let _lwcChart = null;

const SCR_COINS_DEFAULT = SCR_DEFAULT_COINS;
const SCR_COINS_CURATED = Object.values(SCR_CURATED_TIERS).flat()
  .filter((v, i, a) => a.indexOf(v) === i);

const TF_ORDER = ['1m','3m','5m','15m','30m','1h','4h','1d'];

let scrListMode  = 'default';
let scrCoinList  = [...SCR_COINS_DEFAULT];
let scrExchange  = 'bybit';
let scrTFs       = ['5m','15m','1h','4h'];
let scrFilter    = 'all';
let scrSortKey   = 'score';
let scrSortAsc   = false;
let scrRunning   = false;
let scrResults   = [];
let scrAutoTimer = null;

// ── MTF Confluence state ──────────────────────────────────────────────────────
let mtfCoins   = [];
let mtfTFs     = ['5m','15m','30m','1h','4h'];
let mtfResults = [];
let mtfFilter  = 'all';
let mtfRunning = false;

let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

let _lastBTResult = null;

Object.assign(window, {
  state,
  fmt, fmtSym, fmtK,
  saveJournalEntry, renderJournalList, deleteJournalTrade, editJournalTrade, exportJournal,
  toggleCard, loadCoinFromScreener, switchExchange, switchTF, switchSym,
  addAlert, deleteAlert, toggleAlertDir, wlAdd, wlRemove,
  logTrade, clearPnL, exportPnL,
  toggleOverlay, toggleTheme, setRRRatio, setDirection,
  runScreener, toggleScrAuto,
  scrSetFilter, scrSort,
  scrSetListMode, scrFetchTopCoins, scrAddCustomCoin, scrResetCoins,
  setScrTF,
  anchorToSessionOpen, clearAnchor, replayLoad, replayToggle, replayStep, replayReset,
  openJournalEntry,
  btRun, btCompare, btExport,
  runMTFScan, mtfAddCoin, mtfClearCoins, mtfLoadFromScreener, mtfLoadWatchlist, mtfScanCurrent,
  toggleMTFTf, mtfSetFilter,
  computeAndRender,
  renderScreenerTable,
  clearScreenerFilter: () => {
    const el = document.getElementById('scr-text-filter');
    if (el) { el.value = ''; el.dispatchEvent(new Event('input')); }
  },
});

const FIB_CONFIGS = [
  { r: 0,     label: '0%',    col: 'rgba(255,255,255,0.15)' },
  { r: 0.236, label: '23.6%', col: 'rgba(255,184,46,0.5)'  },
  { r: 0.382, label: '38.2%', col: 'rgba(0,229,160,0.6)'   },
  { r: 0.5,   label: '50%',   col: 'rgba(77,166,255,0.6)'  },
  { r: 0.618, label: '61.8%', col: 'rgba(167,139,255,0.7)' },
  { r: 1,     label: '100%',  col: 'rgba(255,255,255,0.15)' },
];

let klineWs         = null;
let tradeStream     = null;
let indicatorWorker = null;
let workerPending   = false;
let workerQueue     = null;
let _anchorMode     = null;
let _initSymSeq     = 0;

const SYM_RE = /^[A-Z0-9]{1,20}$/;

function sanitizeSym(raw) {
  const cleaned = raw.trim().toUpperCase()
    .replace(/\//g, '')
    .replace(/-USDT-SWAP$/, '')   // OKX perpetual format
    .replace(/-USDT$/, '');       // dash-separated pairs
  const base = cleaned.endsWith('USDT') ? cleaned : cleaned + 'USDT';
  if (!SYM_RE.test(base)) return null;
  return base;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function init() {
  dom.init();
  initTooltips();

  const saved    = loadSettings();
  state.sym      = saved?.sym      || 'BTCUSDT';
  state.tf       = saved?.tf       || '5m';
  state.exchange = saved?.exchange || 'bybit';
  state.watchlist = loadWatchlist();

  _ensureAvwapState();

  const initLev = +(dom.el['lev-slider']?.value ?? 10);
  state.leverage = initLev;
  if (dom.el['lev-manual'])  dom.el['lev-manual'].value        = initLev;
  if (dom.el['lev-display']) dom.el['lev-display'].textContent = initLev + '×';
  if (dom.el['lev-slider'])  dom.el['lev-slider'].style.setProperty('--lev-pct', ((initLev - 1) / 99 * 100) + '%');

  const collapsed = loadCollapsed();
  Object.entries(collapsed).forEach(([id, isCollapsed]) => {
    const el = document.getElementById(id);
    if (el && isCollapsed) el.classList.add('collapsed');
  });

  initJournal();
  initIndicatorWorker();

  _lwcChart = new LWCChart('lwc-container', { theme: state.isDark ? 'dark' : 'light' });

  initRenderer({
    onFull:    computeAndRender,
    onPartial: computePartial,
    onLive:    renderLive,
  });

  initSym(state.sym, state.tf);

  document.addEventListener('bt:result', e => {
    _lastBTResult = e.detail;
    scheduleRender(RenderPriority.PARTIAL);
  });

  document.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', () => _lwcChart?._resize());

  renderWatchlist();
  renderAlerts();
  renderPnL();

  _scrUpdateCoinCount();

  const btSlot = dom.el['bt-placeholder'];
  if (btSlot) btSlot.outerHTML = backtesterHTML();
  initBacktester();
  initSearch();

  // const searchInp = document.getElementById('sym-search');

  // if (searchInp) {
  //   searchInp.addEventListener('keydown', e => {
  //     if (e.key !== 'Enter') return;
  //     const sym = sanitizeSym(searchInp.value);
  //     if (!sym) { showToast('Invalid symbol'); return; }
  //     searchInp.value = '';
  //     searchInp.blur();
  //     initSym(sym, state.tf);
  //     document.querySelector('.chart-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  //   });
  // }
  requestAnimationFrame(() => initScreenerFilter());
  dom.resolveLazy();
}

function _ensureAvwapState() {
  if (!Array.isArray(state.avwapVals))         state.avwapVals  = [];
  if (typeof state.avwapCumPV !== 'number')    state.avwapCumPV = 0;
  if (typeof state.avwapCumV  !== 'number')    state.avwapCumV  = 0;
  if (state.anchorIdx === undefined)           state.anchorIdx  = null;
}

export async function initSym(sym, tf) {
  const seq = ++_initSymSeq;
  state.sym = sym;
  state.tf  = tf;
  resetCandleState();

  _ensureAvwapState();
  state.avwapVals  = [];
  state.avwapCumPV = 0;
  state.avwapCumV  = 0;
  state.anchorIdx  = null;
  _writeAvwapLabel();

  cancelPendingRender();
  klineWs?.close();     klineWs = null;
  tradeStream?.close(); tradeStream = null;

  document.querySelectorAll('#sym-group .pill-btn').forEach(b => {
    b.classList.remove('active', 'sym-active');
    const m = b.getAttribute('onclick')?.match(/'([A-Z]+)'/);
    if (m?.[1] === sym) b.classList.add('active', 'sym-active');
  });
  document.querySelectorAll('#tf-group .pill-btn').forEach(b => {
    b.classList.remove('active');
    if (b.dataset.tf === tf) b.classList.add('active');
  });

  document.title = `${fmtSym(sym)} · ${tf} — TradingTerminal`;
  setConnStatus('warn', `Loading ${fmtSym(sym)}…`);

  const candles = await fetchKlines(state.exchange, sym, tf);
  if (seq !== _initSymSeq) return;

  const res = candles?.length ? { candles, source: state.exchange } : null;
  if (res?.candles?.length) {
    res.candles.forEach(c => addCandleToState(c));
    state.openPrice = res.candles[0]?.c || 0;
    setConnStatus('ok', `${res.source} · ${fmtSym(sym)} · ${tf}`);
  } else {
    setConnStatus('err', `Failed to load ${fmtSym(sym)}`);
    return;
  }

  state.livePrice = state.candles[state.candles.length - 1]?.c || 0;
  updatePriceDisplay();

  if (_anchorMode === 'session') {
    _applySessionAnchor(true);
  }

  computeAndRender();
  dispatchToWorker([...state.candles]);

  klineWs = new KlineWebSocket({
    exchName: state.exchange, sym, tf,
    onCandle: (candle, confirmed) => {
      if (seq !== _initSymSeq) return;
      if (confirmed) {
        const realDelta = state.currentCandle?.t === candle.t ? state.currentCandle._realDelta : undefined;
        addCandleToState(realDelta != null ? { ...candle, _realDelta: realDelta } : candle);
        state.currentCandle = null;
        scheduleRender(RenderPriority.PARTIAL);
        dispatchToWorker([...state.candles]);
      } else {
        const priorDelta = state.currentCandle?.t === candle.t ? state.currentCandle._realDelta : undefined;
        state.currentCandle = priorDelta != null ? { ...candle, _realDelta: priorDelta } : candle;
        state.livePrice     = candle.c;
        checkAlerts(candle.c);
        scheduleRender(RenderPriority.LIVE);
      }
    },
    onStatus: setConnStatus,
  });
  klineWs.connect();

  tradeStream = new TradeStream({
    exchName: state.exchange, sym,
    onTick: tick => {
      if (seq !== _initSymSeq) return;
      processTradeTick(tick);
    },
  });
  tradeStream.connect();

  saveSettings();
}

function addCandleToState(c) {
  if (state.candles.length > 0 && c.t) {
    const last = state.candles[state.candles.length - 1].t;
    if (last && c.t < last) return;
  }

  const prevE9 = state.e9, prevE20 = state.e20;
  state.e9  = updEMA(state.e9,  c.c, emaK(9));
  state.e20 = updEMA(state.e20, c.c, emaK(20));
  state.e50 = updEMA(state.e50, c.c, emaK(50));
  state.e9s.push(state.e9);
  state.e20s.push(state.e20);
  state.e50s.push(state.e50);

  const rsiRes = calcWilderRSI(c.c, state.prevClose, {
    avgGain:  state.rmaAvgGain,
    avgLoss:  state.rmaAvgLoss,
    _gains:   state._rsiGains  || [],
    _losses:  state._rsiLosses || [],
  });
  state.rmaAvgGain  = rsiRes.avgGain;
  state.rmaAvgLoss  = rsiRes.avgLoss;
  state._rsiGains   = rsiRes._gains;
  state._rsiLosses  = rsiRes._losses;
  state.rsiVals.push(rsiRes.rsi);
  state.prevClose   = c.c;

  const vwapRes = updVWAP(c, {
    cumPV:      state.vwapCumPV,
    cumV:       state.vwapCumV,
    m2:         state.vwapM2,
    sessionKey: state.vwapSessionKey,
  });
  state.vwapCumPV      = vwapRes.newState.cumPV;
  state.vwapCumV       = vwapRes.newState.cumV;
  state.vwapM2         = vwapRes.newState.m2;
  state.vwapSessionKey = vwapRes.newState.sessionKey;
  state.vwapVals.push(vwapRes.vwap);
  state.vwapBandVals.push(vwapRes.bands);

  const cvdRes = updCVD(c, state.cvdRunning, state.cvdEmaRun, state.CVD_EMA_K, state.cvdResetMode, state.cvdSessionKey);
  state.cvdRunning    = cvdRes.newRunning;
  state.cvdEmaRun     = cvdRes.newEmaRun;
  state.cvdSessionKey = cvdRes.newSessionKey;
  state.cvdVals.push(state.cvdRunning);
  state.cvdEmaVals.push(state.cvdEmaRun);

  if (prevE9 !== null && prevE20 !== null) {
    const bullCross = prevE9 <= prevE20 && state.e9 > state.e20;
    const bearCross = prevE9 >= prevE20 && state.e9 < state.e20;
    if (bullCross || bearCross) {
      state.crossovers.push({ type: bullCross ? 'bull' : 'bear', price: c.c, idx: state.candles.length, time: c.t || Date.now() });
      if (state.crossovers.length > 8) state.crossovers.shift();
      playCrossSound(bullCross ? 'bull' : 'bear');
    }
  }

  state.candles.push(c);

  if (state.anchorIdx !== null) {
    _appendAvwapBar(c);
  }

  if (state.candles.length > CANDLE_WINDOW) {
    state.candles.shift();
    state.e9s.shift();   state.e20s.shift();  state.e50s.shift();
    state.rsiVals.shift();
    state.vwapVals.shift(); state.vwapBandVals.shift();
    state.cvdVals.shift();  state.cvdEmaVals.shift();

    if (state.anchorIdx !== null) {
      state.anchorIdx--;
      if (state.anchorIdx < 0) {
        if (_anchorMode === 'session') {
          state.anchorIdx  = 0;
          state.avwapVals  = [];
          state.avwapCumPV = 0;
          state.avwapCumV  = 0;
          recomputeAvwap();
        } else {
          state.anchorIdx  = null;
          state.avwapVals  = [];
          state.avwapCumPV = 0;
          state.avwapCumV  = 0;
          _anchorMode      = null;
          _writeAvwapLabel();
          showToast('AVWAP anchor evicted (window full) — re-anchor with A', 'warn');
        }
      } else {
        state.avwapVals.shift();
      }
    }

    state.crossovers = state.crossovers
      .map(x => ({ ...x, idx: x.idx - 1 }))
      .filter(x => x.idx >= 0);
  }
}

function _appendAvwapBar(c) {
  const tp  = (c.h + c.l + c.c) / 3;
  const vol = (c.v > 0) ? c.v : 0;
  state.avwapCumPV += tp * vol;
  state.avwapCumV  += vol;
  const v = state.avwapCumV > 0 ? state.avwapCumPV / state.avwapCumV : c.c;
  if (v != null && !isNaN(v)) state.avwapVals.push(v);
}

function _getLatestAvwap() {
  if (!Array.isArray(state.avwapVals) || state.avwapVals.length === 0) return null;
  const v = state.avwapVals[state.avwapVals.length - 1];
  return (v != null && !isNaN(v)) ? v : null;
}

function _getLatestVwap() {
  const lastVwap = state.vwapVals[state.vwapVals.length - 1] ?? null;
  if (!state.currentCandle) return lastVwap;
  return computeLiveVwap(
    state.currentCandle,
    { cumPV: state.vwapCumPV, cumV: state.vwapCumV },
    lastVwap,
    state.vwapSessionKey,
  );
}

function _getLatestCvd() {
  const lastCvd = state.cvdVals[state.cvdVals.length - 1] ?? null;
  if (!state.currentCandle || state.currentCandle._realDelta == null) return lastCvd;
  return state.cvdRunning + state.currentCandle._realDelta;
}

function _offsetIndexed(items, offset) {
  return items.map(item => ({ ...item, idx: item.idx + offset }));
}

function computeAndRender() {
  const all    = [...state.candles, state.currentCandle].filter(Boolean);
  const atr    = calcATR(all, 14);
  const atrPct = state.livePrice > 0 ? (atr / state.livePrice) * 100 : 0;
 
  state.regime = detectRegime(all, state.e20s, state.livePrice);
 
  if (all.length >= 10) {
    const structureWindow = all.slice(-60);
    const structureOffset = all.length - structureWindow.length;
    const localSwings     = detectSwingPoints(structureWindow, 3, 3);

    state.swingPoints     = _offsetIndexed(localSwings, structureOffset);
    state.structureEvents = _offsetIndexed(detectStructureBreaks(structureWindow, localSwings), structureOffset);
    state.liquiditySweeps = _offsetIndexed(detectLiquiditySweeps(structureWindow, localSwings), structureOffset);
    state.equalLevels     = detectEqualLevels(state.swingPoints);
    state.displacements   = detectDisplacementCandles(all, { lookback: 20 });
    state.squeezeState    = detectSqueezeBreakout(all);
  }
 
  state.sessionCtx    = getSessionContext(all);
  state.sessionLevels = getSessionLevels(all);
 
  dom.batch(() => {
    _computeSignalsAndUI(all, atr, atrPct);
    updateRegimeUI(state.regime);
    updateStructureUI(state.swingPoints, state.structureEvents);
    updateSessionUI(state.sessionCtx);
    updateSqueezeUI(state.squeezeState);
  });
 
  drawAll();
}

function computePartial() {
  const all    = [...state.candles, state.currentCandle].filter(Boolean);
  const atr    = calcATR(all, 14);
  const atrPct = state.livePrice > 0 ? (atr / state.livePrice) * 100 : 0;
  dom.batch(() => _computeSignalsAndUI(all, atr, atrPct));
  drawAll();
}

function renderLive() {
  updatePriceDisplay();
  drawLive();
}

function _computeSignalsAndUI(all, atr, atrPct = 0) {
  const latestRSI   = state.rsiVals[state.rsiVals.length - 1];
  const latestVwap  = _getLatestVwap();
  const latestAvwap = _getLatestAvwap();

  const capital  = +(dom.el['inp-capital']?.value)  || 100;
  const margin   = +(dom.el['inp-margin']?.value)   || 20;
  const entryRaw = dom.el['inp-entry']?.value;
  const stopRaw  = dom.el['inp-stop']?.value;
  const leverage = state.leverage || 10;

  const sug = computeSuggestion({
    e9: state.e9, e20: state.e20, e50: state.e50,
    livePrice: state.livePrice, rsi: latestRSI, rrRatio: state.rrRatio,
    tf: state.tf, candles: all, vwap: latestVwap,
    avwap: latestAvwap,
    regime: state.regime,
  });
  if (sug) state.suggestion = sug;

  const cvdLast = _getLatestCvd();
  const quality = scoreEntryQuality({
    dir: state.currentDir, rsi: latestRSI, e9: state.e9, e20: state.e20, e50: state.e50,
    price: state.livePrice, vwap: latestVwap,
    avwap: latestAvwap,
    cvd: cvdLast,
    crossovers: state.crossovers, tf: state.tf, candles: all, regime: state.regime,
    // New: pass through all extra context
    atrPct,
    displacements:   state.displacements   || [],
    liquiditySweeps: state.liquiditySweeps || [],
    sessionCtx:      state.sessionCtx      || null,
    // higherTFConflict is set to false here; wire from screener if available
    higherTFConflict: state.currentSymHTFConflict || false,
  });

  const zones = computeEntryZones({ e9: state.e9, e20: state.e20, livePrice: state.livePrice, suggestion: sug, atr });
  if (zones) state.entryZones = zones;

  const tps       = computePartialTPs({ entry: sug?.entry, stop: sug?.stop, dir: sug?.dir });
  const trailStop = calcATRTrailStop(state.livePrice, atr, state.currentDir, 2);
  const atrSize   = atr ? calcAtrPositionSize({ capital, riskPct: 1, entry: state.livePrice, atr, atrMultiple: 2 }) : null;

  const entry = (entryRaw !== '' && +entryRaw) ? +entryRaw : (sug?.entry || state.livePrice);
  const stop  = (stopRaw  !== '' && +stopRaw)  ? +stopRaw  : (sug?.stop  || 0);

  const futMetrics = calcFuturesMetrics({
    capital, margin, leverage, entry, stop,
    dir: state.currentDir, rrRatio: state.rrRatio, feeType: state.feeType,
  });

  updateSuggestionUI(sug, quality, tps, trailStop, atrSize, _lastBTResult);
  updateFuturesUI(futMetrics, leverage, entry);
  updateEntryZonesUI(zones);
  updateLegendLabels(latestVwap, cvdLast);
  _writeAvwapLabel();
}

function drawAll() {
  if (!_lwcChart) return;
  _lwcChart.setData(state.candles, {
    e9s:        state.e9s,
    e20s:       state.e20s,
    e50s:       state.e50s,
    vwapVals:   state.vwapVals,
    avwapVals:  state.avwapVals,
    rsiVals:    state.rsiVals,
    cvdVals:    state.cvdVals,
    cvdEmaVals: state.cvdEmaVals,
  });
  if (state.suggestion?.entry) _lwcChart.setSuggestion(state.suggestion);
  if (state.sessionLevels)     _lwcChart.setSessionLevels(state.sessionLevels);
  _lwcChart.setStructureEvents(state.candles, state.structureEvents || []);
}

function drawLive() {
  if (!_lwcChart || !state.currentCandle) return;

  const c = { ...state.currentCandle };
  c._liveVwap = _getLatestVwap();
  c._liveBands = computeLiveBands(c, {
    cumPV: state.vwapCumPV,
    cumV:  state.vwapCumV,
    m2:    state.vwapM2,
  }, c._liveVwap);
  c._liveRsi  = state.rsiVals[state.rsiVals.length - 1];
  c._liveCvd  = _getLatestCvd();

  if (state.anchorIdx !== null && state.avwapCumV > 0) {
    const tp    = (c.h + c.l + c.c) / 3;
    const vol   = c.v > 0 ? c.v : 0;
    const liveV = state.avwapCumV + vol;
    c._liveAvwap = liveV > 0 ? (state.avwapCumPV + tp * vol) / liveV : null;
  }

  _lwcChart.updateLiveCandle(c);
  _writeAvwapLabel();
}

function initIndicatorWorker() {
  try {
    indicatorWorker = new Worker(new URL('./workers/indicator.worker.js', import.meta.url));
    indicatorWorker.onmessage = e => {
      workerPending = false;
      if (e.data.type === 'result') onWorkerResult(e.data);
      if (workerQueue) { const q = workerQueue; workerQueue = null; dispatchToWorker(q); }
    };
    indicatorWorker.onerror = () => { indicatorWorker = null; };
  } catch(e) { indicatorWorker = null; }
}

function dispatchToWorker(candles) {
  if (!indicatorWorker) return;
  if (workerPending) { workerQueue = candles; return; }
  workerPending = true;
  indicatorWorker.postMessage({ type: 'calc_all', candles, params: { vpBins: 24 } });
}

function onWorkerResult(data) {
  if (data.vp) {
    state.workerVP = data.vp;
    dom.batch(() => updateVPLabels(data.vp));
  }
  if (data.regime) state.regime = { ...state.regime, ...data.regime };
  scheduleRender(RenderPriority.PARTIAL);
}

function processTradeTick({ price, qty, side }) {
  const signedQty = side === 'buy' ? qty : -qty;
  if (side === 'buy') { state.tradeStreamDelta += qty; state.tradeBuyVol  += qty; }
  else                { state.tradeStreamDelta -= qty; state.tradeSellVol += qty; }
  if (state.currentCandle) state.currentCandle._realDelta = (state.currentCandle._realDelta || 0) + signedQty;
  state.tradeTickBuf.push({ price, side, ts: Date.now() });
  if (state.tradeTickBuf.length > 50) state.tradeTickBuf.shift();
  updateDeltaTicker();
}

function updatePriceDisplay() {
  const priceEl  = dom.el['live-price'];
  const changeEl = dom.el['live-change'];
  if (!priceEl) return;

  const formatted = fmt(state.livePrice);
  const prev      = state.prevLivePrice;

  if (priceEl.textContent !== formatted) {
    priceEl.textContent = formatted;
    if (prev) dom.flashPrice(priceEl, state.livePrice >= prev ? 'up' : 'down');
  }
  state.prevLivePrice = state.livePrice;

  if (changeEl && state.openPrice > 0) {
    const chg = (state.livePrice - state.openPrice) / state.openPrice * 100;
    const txt = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    if (changeEl.textContent !== txt) {
      changeEl.textContent = txt;
      changeEl.style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
    }
  }
}

function setConnStatus(type, msg) {
  const el = dom.el['conn-status'];
  if (!el) return;
  el.textContent = msg;
  el.className   = 'conn-status ' + type;
}

function updateVPLabels(vp) {
  dom.setText(dom.el['vp-poc-val'], fmt(vp.poc));
  dom.setText(dom.el['vp-vah-val'], fmt(vp.vah));
  dom.setText(dom.el['vp-val-val'], fmt(vp.val));
  setTip(dom.el['vp-poc-val'], 'vp.poc');
  setTip(dom.el['vp-vah-val'], 'vp.vah');
  setTip(dom.el['vp-val-val'], 'vp.val');
}

function updateEntryZonesUI(zones) {
  if (!zones) return;
  dom.setText(dom.el['zone-agg'], fmt(zones.aggressive));
  dom.setText(dom.el['zone-bal'], fmt(zones.balanced));
  dom.setText(dom.el['zone-con'], fmt(zones.conservative));
  setTip(dom.el['zone-agg'], 'zone.aggressive');
  setTip(dom.el['zone-bal'], 'zone.balanced');
  setTip(dom.el['zone-con'], 'zone.conservative');
}

function updateRegimeUI(regime) {
  const el = dom.el['regime-display'];
  if (!el || !regime) return;
  const tipKey = `regime.${regime.type}.${regime.dir ?? ''}`.replace(/\.$/, '');
  setTip(el, tipKey);
  const typeMap = {
    trending: regime.dir === 'bull' ? 'regime-trending-bull' : 'regime-trending-bear',
    ranging:  'regime-ranging',
    choppy:   'regime-choppy',
  };
  const cls = 'regime-badge ' + (typeMap[regime.type] || '');
  if (el.className !== cls)            el.className   = cls;
  if (el.textContent !== regime.label) el.textContent = regime.label;
  dom.setText(dom.el['regime-advice'], regime.advice || '');
  dom.setText(dom.el['regime-adx'],    regime.adx?.toFixed(1) ?? '—');
  dom.setText(dom.el['regime-er'],     regime.er?.toFixed(2)  ?? '—');
  setTip(dom.el['regime-adx'], 'regime.adx');
  setTip(dom.el['regime-er'],  'regime.er');
}

function updateStructureUI(swings, events) {
  const el = dom.el['structure-events'];
  if (!el) return;
  const recent = (events || []).slice(-5).reverse();
  const html = recent.length
    ? recent.map(ev => {
        const tipKey = `struct.${ev.type.toLowerCase()}.${ev.dir}`;
        const cls = `struct-${ev.type.toLowerCase()}-${ev.dir}`;
        return `<span class="signal-badge ${cls}" data-tip="${tipKey}" style="font-size:8px;padding:1px 7px">${ev.type} ${ev.dir === 'bull' ? '↑' : '↓'}</span>`;
      }).join('')
    : '<span style="color:var(--text3);font-size:9px;font-family:var(--mono)">No recent structure breaks</span>';
  if (el.innerHTML !== html) el.innerHTML = html;
 
  // Liquidity sweeps display
  const sweepEl = dom.lazy('liquidity-sweeps');
  if (sweepEl) {
    const sweeps = (state.liquiditySweeps || []).slice(0, 4);
    if (sweeps.length) {
      sweepEl.style.display = '';
      sweepEl.innerHTML = sweeps.map(s => {
        const tipKey = s.swingType === 'low' ? 'sweep.low' : 'sweep.high';
        const col   = s.swingType === 'low' ? 'var(--green)' : 'var(--red)';
        const arrow = s.swingType === 'low' ? '↓' : '↑';
        const fire  = s.sweepPct >= 0.5 ? ' 🔥' : '';
        const age   = s.recencyBars != null ? ` ${s.recencyBars}b` : '';
        return `<span class="signal-badge" data-tip="${tipKey}" style="font-size:8px;padding:1px 7px;color:${col};border-color:${col}40">
          ${arrow}Sweep${fire}${age}
        </span>`;
      }).join('');
    } else {
      sweepEl.innerHTML = '<span style="color:var(--text3);font-size:9px;font-family:var(--mono)">None detected</span>';
    }
  }
 
  // Equal levels display
  const eqEl = dom.lazy('equal-levels');
  if (eqEl) {
    const equals = (state.equalLevels || []).filter(l => l.count >= 2).slice(0, 4);
    if (equals.length) {
      eqEl.style.display = '';
      eqEl.innerHTML = equals.map(l => {
        const tipKey = l.type === 'high' ? 'equal.highs' : 'equal.lows';
        const col = l.type === 'high' ? 'rgba(255,61,90,0.9)' : 'rgba(0,229,160,0.9)';
        return `<span data-tip="${tipKey}" style="font-family:var(--mono);font-size:8px;color:${col};
          background:var(--bg3);border-radius:4px;padding:2px 6px;margin:1px">
          ${l.label} <span style="color:var(--text3)">${fmt(l.price)}</span>
        </span>`;
      }).join('');
    } else {
      eqEl.innerHTML = '<span style="color:var(--text3);font-size:9px;font-family:var(--mono)">None detected</span>';
    }
  }
}

function updateSessionUI(ctx) {
  const el = dom.lazy('session-context');
  if (!el || !ctx) return;
  dom.setText(el, ctx.sessionLabel);
  dom.setStyle(el, 'color', ctx.sessionColor);
  const labelLower = (ctx.sessionLabel || '').toLowerCase();
  const tipKey = labelLower.includes('london') && labelLower.includes('ny') ? 'session.overlap'
               : labelLower.includes('london') ? 'session.london'
               : labelLower.includes('new york') || labelLower.includes('ny') ? 'session.ny'
               : labelLower.includes('asia') ? 'session.asia'
               : 'session.dead';
  setTip(el, tipKey);
 
  const alertEl = dom.lazy('session-open-alert');
  if (alertEl) {
    if (ctx.openAlert && ctx.openAlert.minsAway <= 30) {
      alertEl.style.display = '';
      alertEl.textContent   = `⏰ ${ctx.openAlert.session} open in ${ctx.openAlert.minsAway}m`;
      alertEl.style.color   = ctx.openAlert.color;
    } else {
      alertEl.style.display = 'none';
    }
  }
}
 
function updateSqueezeUI(sq) {
  const el = dom.lazy('squeeze-indicator');
  if (!el) return;
  if (sq?.inSqueeze) {
    el.style.display = '';
    dom.setText(el, sq.label);
    dom.setStyle(el, 'color',
      sq.breakoutDir === 'bull' ? 'var(--green)' :
      sq.breakoutDir === 'bear' ? 'var(--red)'   : 'var(--amber)');
      setTip(el, sq.breakoutDir === 'bull' ? 'squeeze.bull'
          : sq.breakoutDir === 'bear' ? 'squeeze.bear'
          :                             'squeeze.active');
  } else {
    el.style.display = 'none';
  }
}

function updateSuggestionUI(sug, quality, tps, trailStop, atrSize, btResult) {
  if (!sug) return;
  const scoreKey = quality?.score >= 75 ? 'quality.prime'
                : quality?.score >= 50 ? 'quality.good'
                : quality?.score >= 25 ? 'quality.weak'
                :                        'quality.skip';
  setTip(dom.el['entry-quality-label'], scoreKey);

  dom.setText(dom.el['sug-entry'],  fmt(sug.entry));
  dom.setText(dom.el['sug-stop'],   fmt(sug.stop));
  dom.setText(dom.el['sug-target'], fmt(sug.target));
  dom.setText(dom.el['sug-reason'], sug.reason || '');

  const dirTxt   = sug.dir === 'long' ? '▲ LONG' : '▼ SHORT';
  const dirColor = sug.dir === 'long' ? 'var(--green)' : 'var(--red)';
  dom.setText(dom.el['sug-dir'], dirTxt);
  dom.setStyle(dom.el['sug-dir'], 'color', dirColor);

  if (quality) {
    dom.setText(dom.el['entry-quality-score'], quality.score);
    dom.setText(dom.el['entry-quality-label'], quality.label);
    const labelColor = quality.score >= 75 ? 'var(--green)' : quality.score >= 50 ? 'var(--amber)' : 'var(--red)';
    dom.setStyle(dom.el['entry-quality-label'], 'color', labelColor);
    dom.setText(dom.el['entry-quality-factors'], quality.factors.slice(0, 3).join(' · '));
  }

  if (tps) {
    for (const tp of tps) {
      dom.setText(dom.el[`tp${tp.n}-price`], fmt(tp.tp));
      dom.setText(dom.el[`tp${tp.n}-pct`],   '+' + tp.pct.toFixed(2) + '%');
    }
  }

  dom.setText(dom.el['atr-trail-val'], trailStop ? fmt(trailStop) : '—');

  // Squeeze / breakout indicator
  const sqEl = dom.lazy('squeeze-state');
  if (sqEl) {
    const sq = state.squeezeState;
    if (sq?.inSqueeze) {
      sqEl.style.display = '';
      sqEl.textContent   = sq.label;
      sqEl.style.color   = sq.breakoutDir === 'bull' ? 'var(--green)'
                         : sq.breakoutDir === 'bear' ? 'var(--red)'
                         : 'var(--amber)';
    } else {
      sqEl.style.display = 'none';
    }
  }
 
  // Displacement candles info
  const dispEl = dom.lazy('displacement-info');
  if (dispEl) {
    const recent = (state.displacements || []).filter(d => {
      const barsAgo = (state.candles.length - 1) - d.idx;
      return barsAgo <= 5;
    }).slice(0, 2);
 
    if (recent.length) {
      dispEl.style.display = '';
      dispEl.innerHTML = recent.map(d => {
        const tipKey = `displacement.${d.strength || 'moderate'}`; // needs d.strength from detectDisplacementCandles
        return `<span data-tip="${tipKey}" style="color:${d.dir === 'bull' ? 'var(--green)' : 'var(--red)'};
          font-family:var(--mono);font-size:9px;background:var(--bg3);
          border-radius:4px;padding:1px 6px;margin-right:4px">
          ${d.label}
        </span>`
    }).join('');
    } else {
      dispEl.style.display = 'none';
    }
  }

  if (atrSize) {
    dom.setText(dom.el['atr-size-tokens'], atrSize.tokens.toFixed(4));
    dom.setText(dom.el['atr-size-value'],  '$' + atrSize.positionValue.toFixed(2));
    dom.setText(dom.el['atr-size-risk'],   '$' + atrSize.riskUSD.toFixed(2));
    dom.setText(dom.el['atr-stop-dist'],   atrSize.stopDistPct.toFixed(2) + '%');
    setTip(dom.el['atr-trail-val'],   'atr.trail');
    setTip(dom.el['atr-size-tokens'], 'atr.size');
  }

  const btEl = dom.el['bt-context'];
  if (btEl) {
    const m   = btResult?.metrics;
    const sym = btResult?.sym;
    const tf  = btResult?.tf;
    const matches = m && sym === state.sym && tf === state.tf;
    btEl.style.display = matches ? 'grid' : 'none';
    if (matches) {
      dom.setText(dom.el['bt-ctx-wr'],  m.winRate + '%');
      dom.setText(dom.el['bt-ctx-exp'], (m.expectancy >= 0 ? '+' : '') + '$' + m.expectancy.toFixed(2));
      dom.setText(dom.el['bt-ctx-pf'],  m.profitFactor != null ? m.profitFactor.toFixed(2) : '—');
      dom.setText(dom.el['bt-ctx-dd'],  m.maxDrawdownPct.toFixed(1) + '%');
      dom.setText(dom.el['bt-ctx-trades'], m.total);

      const wrEl = dom.el['bt-ctx-wr'];
      if (wrEl) wrEl.style.color = m.winRate >= 55 ? 'var(--green)' : m.winRate >= 45 ? 'var(--amber)' : 'var(--red)';

      const expEl = dom.el['bt-ctx-exp'];
      if (expEl) expEl.style.color = m.expectancy >= 0 ? 'var(--green)' : 'var(--red)';

      const ddEl = dom.el['bt-ctx-dd'];
      if (ddEl) ddEl.style.color = m.maxDrawdownPct < 10 ? 'var(--green)' : m.maxDrawdownPct < 20 ? 'var(--amber)' : 'var(--red)';
    }
  }
}

function updateFuturesUI(metrics, leverage, entry) {
  if (!metrics) return;

  dom.setText(dom.el['fv-pos-size'],  '$' + metrics.posSize.toFixed(2));
  dom.setText(dom.el['fv-liq-price'], fmt(metrics.liqPrice));
  dom.setText(dom.el['fv-liq-dist'],  metrics.liqDistPct.toFixed(1) + '%');
  dom.setText(dom.el['fv-profit'],    '$' + metrics.profitNet.toFixed(2));
  dom.setText(dom.el['fv-loss'],      '$' + Math.abs(metrics.lossNet).toFixed(2));
  dom.setText(dom.el['fv-roi-win'],   metrics.roiWin.toFixed(2) + '%');
  dom.setText(dom.el['fv-roi-loss'],  metrics.roiLoss.toFixed(2) + '%');
  dom.setText(dom.el['fv-be-price'],  fmt(metrics.bePrice));
  dom.setText(dom.el['fee-open'],     '$' + metrics.feeOpen.toFixed(3));
  dom.setText(dom.el['fee-close'],    '$' + metrics.feeClose.toFixed(3));
  dom.setText(dom.el['fee-tot'],      '$' + metrics.feeTot.toFixed(3));

  const liqBar = dom.el['liq-bar'];
  if (liqBar) {
    const pct = metrics.liqGaugePct + '%';
    const bg  = metrics.liqDistPct < 10
      ? 'var(--red)' : metrics.liqDistPct < 20 ? 'var(--amber)' : 'var(--green)';
    dom.setStyle(liqBar, 'width',      pct);
    dom.setStyle(liqBar, 'background', bg);
  }

  const warn = dom.el['risk-warn'];
  if (warn) {
    const isHigh = metrics.riskPct > 3;
    const isMed  = metrics.riskPct > 2 && !isHigh;
    dom.show(warn, isHigh || isMed);
    if (isHigh || isMed) {
      warn.className   = 'risk-warn ' + (isHigh ? 'high' : 'med');
      warn.textContent = `⚠ Risk is ${metrics.riskPct.toFixed(1)}% of capital — ${isHigh ? 'consider reducing leverage or size' : 'acceptable but elevated'}.`;
    }
  }
}

function updateLegendLabels(vwap, cvd) {
  dom.setText(dom.el['leg-e9'],   state.e9  ? fmt(state.e9)  : '—');
  dom.setText(dom.el['leg-e20'],  state.e20 ? fmt(state.e20) : '—');
  dom.setText(dom.el['leg-e50'],  state.e50 ? fmt(state.e50) : '—');
  setTip(dom.el['leg-e9'],   'ema.9');
  setTip(dom.el['leg-e20'],  'ema.20');
  setTip(dom.el['leg-e50'],  'ema.50');
  setTip(dom.el['leg-vwap'], 'vwap');
  setTip(dom.el['leg-vwap2'],'vwap');
  setTip(dom.el['leg-cvd'],  'cvd');

  const vwapStr = vwap ? fmt(vwap) : '—';
  dom.setText(dom.el['leg-vwap'],  vwapStr);
  dom.setText(dom.el['leg-vwap2'], vwapStr);

  if (cvd !== undefined) {
    dom.setText(dom.el['leg-cvd'], (cvd >= 0 ? '+' : '') + fmtK(cvd));
  }
}

function updateDeltaTicker() {
  const net = state.tradeBuyVol - state.tradeSellVol;
  const tot = state.tradeBuyVol + state.tradeSellVol || 1;
  const pct = Math.round(state.tradeBuyVol / tot * 100);

  dom.setText(dom.el['delta-buy'],  fmtK(state.tradeBuyVol));
  dom.setText(dom.el['delta-sell'], fmtK(state.tradeSellVol));
  setTip(dom.el['delta-buy'],  'delta.buy');
  setTip(dom.el['delta-sell'], 'delta.sell');
  setTip(dom.el['delta-net'],  'delta.net');

  const netEl = dom.el['delta-net'];
  if (netEl) {
    dom.setText(netEl, (net >= 0 ? '+' : '') + fmtK(net));
    dom.setStyle(netEl, 'color', net >= 0 ? 'var(--green)' : 'var(--red)');
  }

  const bar = dom.el['delta-ratio-bar'];
  if (bar) {
    dom.setStyle(bar, 'width',      pct + '%');
    dom.setStyle(bar, 'background', net >= 0 ? 'var(--green)' : 'var(--red)');
  }
}

function switchSym(sym) { initSym(sym, state.tf); }
function switchTF(tf)   { initSym(state.sym, tf); }

function switchExchange(name, btn) {
  state.exchange = name;
  scrExchange    = name;
  document.querySelectorAll('#exch-group .pill-btn').forEach(b => b.classList.remove('active', 'sym-active'));
  btn.classList.add('active', 'sym-active');
  initSym(state.sym, state.tf);
}

function setDirection(dir) { state.currentDir = dir; scheduleRender(RenderPriority.FULL); }
function setRRRatio(v)     { state.rrRatio = +v || 2; scheduleRender(RenderPriority.FULL); }

function toggleOverlay(key, btn) {
  if (key === 'fib') state.overlayFib = !state.overlayFib;
  if (key === 'vp')  state.overlayVP  = !state.overlayVP;
  if (key === 'div') state.overlayDiv = !state.overlayDiv;
  btn?.classList.toggle('active');
  scheduleRender(RenderPriority.FULL);
}

function toggleTheme() {
  state.isDark = !state.isDark;
  document.body.classList.toggle('light', !state.isDark);
  _lwcChart?.setTheme(state.isDark ? 'dark' : 'light');
  const btn = document.querySelector('.theme-btn');
  if (btn) btn.textContent = state.isDark ? '🌙' : '☀️';
}

function toggleCard(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('collapsed');
  saveCollapsed(id, el.classList.contains('collapsed'));
}

function loadCoinFromScreener(sym) {
  initSym(sym, state.tf);
  document.querySelector('.chart-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function addAlert() {
  const price = +(dom.el['alrt-price']?.value);
  if (!price) return;
  state.alerts.push({ id: Date.now(), sym: state.sym, price, dir: state.alertDir, triggered: false });
  if (dom.el['alrt-price']) dom.el['alrt-price'].value = '';
  renderAlerts();
  if (Notification?.permission === 'default') Notification.requestPermission();
}

function deleteAlert(id) { state.alerts = state.alerts.filter(a => a.id !== id); renderAlerts(); }

function toggleAlertDir() {
  state.alertDir = state.alertDir === 'above' ? 'below' : 'above';
  const btn = dom.el['alrt-dir-btn'];
  if (btn) btn.textContent = state.alertDir === 'above' ? 'Above ▲' : 'Below ▼';
}

function checkAlerts(price) {
  let fired = false;
  state.alerts.forEach(a => {
    if (a.triggered || a.sym !== state.sym) return;
    const hit = (a.dir === 'above' && price >= a.price) || (a.dir === 'below' && price <= a.price);
    if (hit) {
      a.triggered = true; fired = true;
      const msg = `🔔 ${a.sym}: ${a.dir === 'above' ? 'Crossed above' : 'Dropped below'} ${fmt(a.price)}`;
      showToast(msg); playBeep(880);
      if (Notification?.permission === 'granted') new Notification('TradeAssist', { body: msg });
    }
  });
  if (fired) renderAlerts();
}

function renderAlerts() {
  const el = dom.el['alert-list'];
  if (!el) return;
  if (!state.alerts.length) { el.innerHTML = '<div class="alert-empty">No alerts set</div>'; return; }
  el.innerHTML = state.alerts.map(a => `
    <div class="alert-item${a.triggered ? ' triggered' : ''}">
      <div class="alert-item-info">
        <span class="alert-sym">${escHtml(fmtSym(a.sym))}</span>
        <span class="alert-cond">${a.dir === 'above' ? 'Above' : 'Below'}</span>
        <span class="alert-price-val">${fmt(a.price)}</span>
        ${a.triggered ? '<span class="alert-status">✓ TRIGGERED</span>' : ''}
      </div>
      <button class="alert-del" onclick="deleteAlert(${a.id})">×</button>
    </div>`).join('');
}

function wlAdd() {
  const raw = dom.el['wl-inp']?.value || '';
  const sym = sanitizeSym(raw);
  if (!sym) { showToast('Invalid symbol — use letters and numbers only'); return; }
  if (!state.watchlist.includes(sym)) { state.watchlist.push(sym); saveWatchlist(state.watchlist); renderWatchlist(); }
  if (dom.el['wl-inp']) dom.el['wl-inp'].value = '';
}

function wlRemove(s) {
  state.watchlist = state.watchlist.filter(x => x !== s);
  saveWatchlist(state.watchlist); renderWatchlist();
}

function renderWatchlist() {
  const el = dom.el['wl-list'];
  if (!el) return;
  if (!state.watchlist.length) { el.innerHTML = '<span class="wl-empty">No coins added</span>'; return; }
  el.innerHTML = state.watchlist.map(s => `
    <div class="wl-chip" onclick="loadCoinFromScreener('${escHtml(s)}')">
      <span>${escHtml(fmtSym(s))}</span>
      <button class="wl-chip-del" onclick="event.stopPropagation();wlRemove('${escHtml(s)}')">×</button>
    </div>`).join('');
}

function logTrade(result) {
  state.tradeCount++;
  const profitEl = dom.el['fv-profit'];
  const lossEl   = dom.el['fv-loss'];
  const profit   = result === 'win'
    ? +(profitEl?.textContent?.replace(/[$,]/g, '')) || 0
    : -(+(lossEl?.textContent?.replace(/[$,]/g, '')) || 0);
  state.pnlTrades.push({
    n: state.tradeCount, time: new Date().toLocaleTimeString(),
    sym: state.sym, dir: state.currentDir === 'long' ? '▲ L' : '▼ S',
    result, pnl: profit,
  });
  renderPnL();
  showToast(result === 'win' ? `✓ Win: +$${Math.abs(profit).toFixed(2)}` : `✗ Loss: -$${Math.abs(profit).toFixed(2)}`);
}

function clearPnL() { state.pnlTrades = []; state.tradeCount = 0; renderPnL(); }

function renderPnL() {
  const wins   = state.pnlTrades.filter(t => t.result === 'win').length;
  const losses = state.pnlTrades.filter(t => t.result === 'loss').length;
  const net    = state.pnlTrades.reduce((a, t) => a + t.pnl, 0);
  const wr     = state.pnlTrades.length ? Math.round(wins / state.pnlTrades.length * 100) : 0;

  const netTxt = (net >= 0 ? '+' : '') + '$' + net.toFixed(2);
  dom.setText(dom.el['pnl-net'],    netTxt);
  dom.setText(dom.el['pnl-wins'],   wins);
  dom.setText(dom.el['pnl-losses'], losses);
  dom.setText(dom.el['pnl-wr'],     state.pnlTrades.length ? wr + '%' : '—');
  dom.setStyle(dom.el['pnl-net'], 'color', net >= 0 ? 'var(--green)' : 'var(--red)');

  const tbody = dom.el['pnl-tbody'];
  if (!tbody) return;
  if (!state.pnlTrades.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:12px;font-family:var(--mono);font-size:10px">No trades logged</td></tr>';
    return;
  }
  tbody.innerHTML = [...state.pnlTrades].reverse().map(t => `<tr>
    <td style="color:var(--text3)">${t.n}</td>
    <td style="color:var(--text3)">${t.time}</td>
    <td style="font-weight:700">${escHtml(t.sym.replace('USDT', ''))}</td>
    <td>${t.dir}</td>
    <td class="${t.result === 'win' ? 'pnl-win' : 'pnl-loss'}">${t.result === 'win' ? 'WIN' : 'LOSS'}</td>
    <td class="${t.pnl >= 0 ? 'pnl-win' : 'pnl-loss'}">${(t.pnl >= 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2)}</td>
  </tr>`).join('');
}

function exportPnL() {
  if (!state.pnlTrades.length) { showToast('No trades to export'); return; }
  const rows = ['#,Time,Symbol,Direction,Result,P&L'];
  state.pnlTrades.forEach(t => rows.push(`${t.n},${t.time},${t.sym},${t.dir},${t.result},${t.pnl.toFixed(2)}`));
  const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  const a   = Object.assign(document.createElement('a'), {
    href:     url,
    download: 'session_pnl_' + new Date().toISOString().slice(0, 10) + '.csv',
  });
  a.click();
  URL.revokeObjectURL(url);
}

function _scrUpdateCoinCount() {
  const el = document.getElementById('scr-coin-count');
  if (el) el.textContent = `${scrCoinList.length} coins`;
}

function scrSetFilter(filter, btn) {
  scrFilter = filter;
  document.querySelectorAll('.scr-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
  } else {
    document.querySelector(`.scr-filter-btn[onclick*="'${filter}'"]`)?.classList.add('active');
  }
  renderScreenerTable();
}

function scrSort(key) {
  if (scrSortKey === key) scrSortAsc = !scrSortAsc;
  else { scrSortKey = key; scrSortAsc = false; }
  const headers = ['sym','price','chg','signal','rsi','score','stack','mtf','vol','dist','hlpos','age'];
  const ths = document.querySelectorAll('#scr-table th');
  ths.forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
  const idx = headers.indexOf(key);
  if (idx >= 0 && ths[idx]) ths[idx].classList.add(scrSortAsc ? 'sort-asc' : 'sort-desc');
  renderScreenerTable();
}

function setScrTF(tf, btn) {
  const idx = scrTFs.indexOf(tf);
  if (idx >= 0) {
    if (scrTFs.length === 1) { showToast('Select at least one TF'); return; }
    scrTFs.splice(idx, 1);
  } else {
    scrTFs.push(tf);
    scrTFs.sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));
  }
  btn?.classList.toggle('active', scrTFs.includes(tf));
}

function scrSetListMode(mode, btn) {
  scrListMode = mode;
  scrCoinList = mode === 'curated' ? [...SCR_COINS_CURATED] : [...SCR_COINS_DEFAULT];
  _scrUpdateCoinCount();
  document.querySelectorAll('.scr-list-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const legend = document.getElementById('scr-tier-legend');
  if (legend) legend.style.display = mode === 'curated' ? 'flex' : 'none';
}

function scrAddCustomCoin() {
  const inp = document.getElementById('scr-coin-inp');
  if (!inp) return;
  const coin = sanitizeSym(inp.value);
  if (!coin) { showToast('Invalid symbol — letters and numbers only'); inp.value = ''; return; }
  if (scrCoinList.includes(coin)) { showToast(`${coin} already in list`); inp.value = ''; return; }
  scrCoinList.unshift(coin);
  _scrUpdateCoinCount();
  showToast(`✓ Added ${coin} (${scrCoinList.length} total)`);
  inp.value = '';
}

function scrResetCoins() {
  scrCoinList = scrListMode === 'curated' ? [...SCR_COINS_CURATED] : [...SCR_COINS_DEFAULT];
  _scrUpdateCoinCount();
  showToast(`Reset to ${scrCoinList.length} ${scrListMode === 'curated' ? 'curated' : 'default'} coins`);
}

async function scrFetchTopCoins(n, btn) {
  const fetchAll = (n == null);
  const origText = btn?.textContent || '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    let symbols = [];
    const blocked = /UP|DOWN|BULL|BEAR|3L|3S|5L|5S|2L|2S|USDC|BUSD|TUSD|USDP|DAI|UST|FRAX|GUSD/;

    if (scrExchange === 'bybit') {
      const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear', { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      let filtered = (d?.result?.list || [])
        .filter(t => t.symbol.endsWith('USDT') && !blocked.test(t.symbol))
        .sort((a, b) => +b.turnover24h - +a.turnover24h);
      if (!fetchAll) filtered = filtered.slice(0, n);
      symbols = filtered.map(t => t.symbol);

    } else if (scrExchange === 'okx') {
      const r = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP', { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      let filtered = (d?.data || [])
        .filter(t => t.instId.endsWith('-USDT-SWAP') && !blocked.test(t.instId))
        .sort((a, b) => +b.volCcy24h - +a.volCcy24h);
      if (!fetchAll) filtered = filtered.slice(0, n);
      symbols = filtered.map(t => t.instId.replace('-USDT-SWAP', '') + 'USDT');

    } else {
      let r = await fetch('https://api.binance.com/api/v3/ticker/24hr', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`Binance API returned ${r.status}. Try switching to Bybit or OKX.`);
      const d = await r.json();
      let filtered = d
        .filter(t => t.symbol.endsWith('USDT') && !blocked.test(t.symbol))
        .sort((a, b) => +b.quoteVolume - +a.quoteVolume);
      if (!fetchAll) filtered = filtered.slice(0, n);
      symbols = filtered.map(t => t.symbol);
    }

    if (!symbols.length) throw new Error('No symbols returned');
    const userAdded = scrCoinList.filter(s => !SCR_COINS_DEFAULT.includes(s) && !symbols.includes(s));
    scrCoinList = [...new Set([...symbols, ...userAdded])];
    _scrUpdateCoinCount();
    const label = fetchAll ? 'ALL' : 'top ' + symbols.length;
    showToast(`✓ Loaded ${label} coins from ${scrExchange} (${scrCoinList.length} total)`);

  } catch (e) {
    showToast(`❌ Failed to fetch from ${scrExchange}: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

async function runScreener() {
  if (scrRunning) return;
  scrRunning = true;

  const btn = dom.el['scr-run-btn'];
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
  dom.show(dom.el['scr-progress'], true);

  const coins     = scrCoinList.length ? scrCoinList : SCR_DEFAULT_COINS;
  const activeTFs = TF_ORDER.filter(t => scrTFs.includes(t));
  const exch      = scrExchange;

  const rawData = await batchFetchScreener(coins, activeTFs, exch, ({ done, total, sym }) => {
    const pct = Math.round(done / total * 100);
    dom.setStyle(dom.el['scr-progress-bar'], 'width', pct + '%');
    dom.setText(dom.el['scr-progress-lbl'], `${done}/${total} — ${sym}`);
  });

  scrResults = [];

  rawData.forEach((tfCandles, sym) => {
    const primaryTf = activeTFs.find(t => tfCandles[t]?.length >= 15);
    if (!primaryTf) return;

    const snapshotMap = {};
    activeTFs.forEach(tf => {
      const candles = tfCandles[tf];
      if (!candles?.length) return;
      const snap = calcTFSnapshot(candles, tf);
      if (snap) snapshotMap[tf] = snap;
    });

    const r = analyseSymbol(
      sym,
      tfCandles[primaryTf],
      primaryTf,
      snapshotMap,
      activeTFs,
      Date.now(),
      exch,
    );

    if (r) scrResults.push(r);
  });

  const currentResult = scrResults.find(r => r.sym === state.sym);
  state.currentSymHTFConflict = currentResult?.higherTFConflict ?? false;

  renderScreenerTable();
  scrRunning = false;
  if (btn) { btn.disabled = false; btn.textContent = '▶ Scan'; }
  dom.show(dom.el['scr-progress'], false);
  showToast(`Screener done: ${scrResults.length} symbols`);
}

function renderScreenerTable() {
  const tbody = dom.el['scr-tbody'];
  if (!tbody) return;

  const textQ = getScreenerTextFilter();
  let rows = applyScreenerFilters(scrResults, scrFilter).filter(r =>
    !textQ || r.sym.includes(textQ) || r.sym.replace('USDT','').includes(textQ)
  );
  rows = sortScreenerResults(rows, scrSortKey, scrSortAsc);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="14" class="scr-empty">No results — run a scan first</td></tr>';
    return;
  }

  const thead = document.querySelector('#scr-table thead tr');
  if (thead && !thead.dataset.hintsApplied) {
    const hints = [
      ['sym',    'Symbol — click to trade'],
      ['price',  'Last traded price'],
      ['chg',    '24-hour price change %'],
      ['signal', 'EMA 9/20/50 stack direction'],
      ['rsi',    'RSI-14 (>70 overbought, <30 oversold)'],
      ['score',  'Composite setup quality score (0–100)'],
      ['stack',  'EMA order: 9 vs 20 vs 50'],
      ['mtf',    'Weighted multi-timeframe confluence — higher TFs count more'],
      ['vol',    'Volume vs 20-bar avg · ✓ direction-aligned · ⚠ opposed'],
      ['dist',   '% distance of price from EMA20'],
      ['hlpos',  'Price in 24h range · ✓ = good entry side · ⚠ = extended'],
      ['age',    'Candles since last EMA9/20 cross'],
      ['fib',    'Nearest Fib level and direction'],
    ];
    const ths = thead.querySelectorAll('th');
    hints.forEach(([, tip], i) => {
      if (ths[i]) { ths[i].setAttribute('title', tip); ths[i].style.cursor = 'pointer'; }
    });
    thead.dataset.hintsApplied = '1';
  }

  const top5 = new Set([...rows].sort((a, b) => b.score - a.score).slice(0, 5).map(r => r.sym));

  tbody.innerHTML = rows.map(r => {
    const safeSym  = escHtml(r.sym);
    const safeDisp = escHtml(fmtSym(r.sym));

    const chgCls   = r.chgPct >= 0 ? 'pos' : 'neg';
    const isTop5   = top5.has(r.sym);
    const rowStyle = isTop5 ? 'background:rgba(0,229,160,0.04);border-left:2px solid rgba(0,229,160,0.5)' : '';

    const scoreCol = r.score >= 75 ? '#00e5a0' : r.score >= 50 ? '#4da6ff' : r.score >= 30 ? '#ffb82e' : '#3d4460';

    const stackCol = r.bullStack ? '#00e5a0' : r.bearStack ? '#ff3d5a' : '#ffb82e';
    const stackTxt = r.bullStack ? '9>20>50' : r.bearStack ? '9<20<50' : '⚠ MIX';

    const mtfStr = r.availTFs > 0 ? `${r.mtfScore}%` : '—';
    const mtfCol = r.higherTFConflict ? '#ff3d5a'
                 : r.mtfFull          ? '#00e5a0'
                 : r.mtfMost          ? '#ffb82e'
                 :                      'var(--text2)';
    const mtfTitle = r.higherTFConflict ? 'Higher TF contradicts signal' : '';

    const volCol  = r.volSpike && r.volAligned  ? '#00e5a0'
                  : r.volSpike && r.volOpposed  ? '#ff3d5a'
                  : r.volHot                    ? '#ffb82e'
                  :                               'var(--text2)';
    const volBg   = r.volSpike && r.volAligned  ? 'rgba(0,229,160,0.10)'
                  : r.volSpike && r.volOpposed  ? 'rgba(255,61,90,0.10)'
                  : r.volHot                    ? 'rgba(255,184,46,0.08)'
                  :                               'transparent';
    const volMark = r.volSpike && r.volAligned  ? '🔥✓'
                  : r.volSpike && r.volOpposed  ? '🔥⚠'
                  : r.volHot  && r.volAligned   ? '⚡✓'
                  : r.volHot                    ? '⚡'
                  :                               '';
    const volStr  = r.volRatio != null ? r.volRatio.toFixed(1) + 'x' : '—';

    const distAbs = r.e20dist != null ? Math.abs(r.e20dist) : null;
    const distCol = distAbs != null ? (distAbs <= 1 ? '#00e5a0' : distAbs > 5 ? '#ff3d5a' : 'var(--text2)') : 'var(--text2)';
    const distStr = distAbs != null ? (r.e20dist >= 0 ? '+' : '-') + distAbs.toFixed(1) + '%' : '—';

    const hlPos    = r.hlPos ?? 50;
    const hlBarCol = hlPos >= 80 ? '#ff3d5a' : hlPos <= 20 ? '#00e5a0' : '#4da6ff';
    const hlLabel  = hlPos >= 80 ? 'High' : hlPos <= 20 ? 'Low' : Math.round(hlPos) + '%';
    const hlMark   = (r.signal === 'bull' && r.nearLow)   ? ' ✓'
                   : (r.signal === 'bear' && r.nearHigh)  ? ' ✓'
                   : (r.signal === 'bull' && r.nearHigh)  ? ' ⚠'
                   : (r.signal === 'bear' && r.nearLow)   ? ' ⚠'
                   :                                         '';
    const hlMarkCol = hlMark === ' ✓' ? '#00e5a0' : hlMark === ' ⚠' ? '#ffb82e' : 'var(--text2)';

    const ageTxt = r.trendAge != null ? r.trendAge + 'c' : '—';
    const ageCol  = r.trendAge <= 3  ? '#00e5a0'
                  : r.trendAge <= 8  ? '#4da6ff'
                  : r.trendAge <= 40 ? 'var(--text3)'
                  :                    '#ff3d5a';

    let fibTxt = '—', fibCol = 'var(--text3)';
    if (r.fibProximity) {
      const { label, tier, dir, dirLabel } = r.fibProximity;
      fibTxt = `${label} ${dirLabel}`;
      fibCol = tier === 'gold' ? '#a78bff'
             : tier === 'key'  ? '#4da6ff'
             :                   'var(--text2)';
    }

    const badges = [];
    if (r.divAligned)        badges.push(`<span title="RSI divergence confirms signal" style="font-size:8px;color:#00e5a0">Div✓</span>`);
    if (r.divOpposed)        badges.push(`<span title="RSI divergence contradicts signal" style="font-size:8px;color:#ff3d5a">Div⚠</span>`);
    if (r.accelAligned)      badges.push(`<span title="Momentum accelerating" style="font-size:8px;color:#ffb82e">Accel</span>`);
    if (r.higherTFConflict)  badges.push(`<span title="Higher TF opposes signal" style="font-size:8px;color:#ff3d5a">HTF⚠</span>`);

    return `<tr style="${rowStyle}">
      <td>
          <span class="scr-sym" onclick="loadCoinFromScreener('${safeSym}')">${safeDisp}${isTop5 ? '⭐' : ''}</span>
          <div style="display:flex;gap:3px;margin-top:2px;flex-wrap:wrap">
            <span style="font-size:8px;color:var(--text3);font-family:var(--mono)">${r.primaryTf || '—'}</span>
            ${badges.join('')}
          </div>
      </td>
      <td class="scr-price">${fmt(r.price)}</td>
      <td class="scr-chg ${chgCls}">${(r.chgPct >= 0 ? '+' : '') + r.chgPct.toFixed(2) + '%'}</td>
      <td><span class="signal-badge signal-${r.signal}">${r.signalLabel}</span></td>
      <td class="scr-rsi">${r.rsi !== null ? Math.round(r.rsi) : '—'}</td>
      <td>
        <div class="score-bar">
          <div class="score-track">
            <div class="score-fill" style="width:${r.score}%;background:${scoreCol}"></div>
          </div>
          <span style="font-size:9px;color:${scoreCol};font-family:var(--mono);font-weight:700;min-width:24px">${r.score}</span>
        </div>
      </td>
      <td><span style="font-family:var(--mono);font-size:9px;font-weight:700;color:${stackCol}">${stackTxt}</span></td>
      <td title="${mtfTitle}"><span style="font-family:var(--mono);font-size:9px;font-weight:700;color:${mtfCol}">${mtfStr}${r.higherTFConflict ? ' ⚠' : ''}</span></td>
      <td title="Vol ratio: ${r.volRatio != null ? r.volRatio.toFixed(2) : '—'}x vs 20-bar avg | Cur: ${fmtK(r.curVol)} | Avg: ${fmtK(r.avgVol)}${r.volSpike ? ' | 🔥 Spike (≥2x)' : r.volHot ? ' | ⚡ Hot (≥1.5x)' : ''}${r.volAligned ? ' | ✓ Aligned with signal' : r.volOpposed ? ' | ⚠ Opposed to signal' : ''}"><span style="font-family:var(--mono);font-size:9px;font-weight:700;color:${volCol};background:${volBg};border-radius:6px;padding:1px 5px">${volStr}${volMark}</span></td>
      <td><span style="font-family:var(--mono);font-size:9px;color:${distCol}">${distStr}</span></td>
      <td title="24h High: ${fmt(r.hi24)} | Low: ${fmt(r.lo24)} | Position: ${Math.round(hlPos)}% from low${hlMark === ' ✓' ? ' — good entry side' : hlMark === ' ⚠' ? ' — extended, caution' : ''}">
        <div style="position:relative;width:36px;height:6px;background:var(--bg3);border-radius:2px;display:inline-block">
          <div style="position:absolute;left:0;top:0;height:100%;width:${hlPos}%;background:${hlBarCol};border-radius:2px"></div>
        </div>
        <span style="font-family:var(--mono);font-size:8px;color:${hlMarkCol};margin-left:3px">${hlLabel}${hlMark}</span>
      </td>
      <td><span style="font-family:var(--mono);font-size:9px;color:${ageCol}">${ageTxt}</span></td>
      <td><span style="font-family:var(--mono);font-size:9px;color:${fibCol}">${fibTxt}</span></td>
      <td><button class="scr-trade-btn" onclick="loadCoinFromScreener('${safeSym}')">Trade →</button></td>
    </tr>`;
  }).join('');
}

function toggleScrAuto() {
  if (scrAutoTimer) {
    clearTimeout(scrAutoTimer);
    scrAutoTimer = null;
    showToast('Auto-scan off');
  } else {
    const scheduleNext = async () => {
      await runScreener();
      if (scrAutoTimer !== null) {
        scrAutoTimer = setTimeout(scheduleNext, SCR_AUTO_INTERVAL_MS);
      }
    };
    scrAutoTimer = setTimeout(scheduleNext, 0); // kick off immediately
    showToast('Auto-scan: every 5 minutes');
  }
}

function _applySessionAnchor(silent = false) {
  if (!state.candles.length) { if (!silent) showToast('No candle data'); return; }

  const today = new Date();
  const dk    = `${today.getUTCFullYear()}-${today.getUTCMonth() + 1}-${today.getUTCDate()}`;
  let idx = state.candles.findIndex(c => {
    if (!c.t) return false;
    const d = new Date(c.t);
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}` === dk;
  });
  if (idx < 0) idx = 0;

  state.anchorIdx  = idx;
  state.avwapVals  = [];
  state.avwapCumPV = 0;
  state.avwapCumV  = 0;
  recomputeAvwap();
  _writeAvwapLabel();

  if (!silent) showToast('AVWAP anchored' + (idx === 0 ? ' (oldest in window)' : ' to session open'));
}

export function anchorToSessionOpen() { _anchorMode = 'session'; _applySessionAnchor(false); drawAll(); }

export function clearAnchor() {
  _anchorMode      = null;
  state.anchorIdx  = null;
  state.avwapVals  = [];
  state.avwapCumPV = 0;
  state.avwapCumV  = 0;
  _writeAvwapLabel();
  drawAll();
}

function _writeAvwapLabel() {
  const el = dom.el['avwap-val'];
  if (!el) return;
  const avwap = _getLatestAvwap();
  if (avwap != null) {
    dom.setText(el, fmt(avwap));
    dom.setStyle(el, 'color', (state.livePrice && state.livePrice >= avwap) ? 'var(--green)' : 'var(--red)');
  } else {
    dom.setText(el, '—');
    dom.setStyle(el, 'color', '');
  }
}

function recomputeAvwap() {
  if (state.anchorIdx === null) return;
  const slice = state.candles.slice(state.anchorIdx);
  let cumPV = 0, cumV = 0;
  state.avwapVals = slice.map(c => {
    const tp  = (c.h + c.l + c.c) / 3;
    const vol = (c.v > 0) ? c.v : 0;
    cumPV += tp * vol;
    cumV  += vol;
    return cumV > 0 ? cumPV / cumV : c.c;
  });
  state.avwapCumPV = cumPV;
  state.avwapCumV  = cumV;
}

async function replayLoad() {
  const btn = dom.el['replay-load-btn'];
  if (btn) { btn.textContent = '⏳ Loading…'; btn.disabled = true; }
  const res = await fetchKlinesFallback(state.sym, state.tf);
  if (!res?.candles?.length) {
    showToast('Failed to load replay data');
    if (btn) { btn.textContent = '⬇ Load'; btn.disabled = false; }
    return;
  }
  state.replayData   = res.candles;
  state.replayIdx    = 0;
  state.replayActive = false;
  clearTimeout(state.timers.replayTimer); state.timers.replayTimer = null;
  klineWs?.close(); tradeStream?.close();
  resetCandleState();
  _ensureAvwapState();
  setConnStatus('warn', `Replay · ${res.candles.length} candles · ${fmtSym(state.sym)}`);
  dom.el['replay-play-btn'].disabled = false;
  dom.setText(dom.el['replay-play-btn'], '▶ Play');
  dom.setText(dom.el['replay-progress-lbl'], `0 / ${res.candles.length}`);
  if (btn) { btn.textContent = '✓ Loaded'; btn.disabled = false; }
  showToast(`Replay ready: ${res.candles.length} candles`);
  drawAll();
}

function replayToggle() {
  if (!state.replayData.length) { showToast('Load history first'); return; }
  clearTimeout(state.timers.replayTimer);
  state.timers.replayTimer = null;
  state.replayActive = !state.replayActive;
  const btn = dom.el['replay-play-btn'];
  if (btn) { btn.textContent = state.replayActive ? '⏸ Pause' : '▶ Play'; btn.classList.toggle('active', state.replayActive); }
  if (state.replayActive) replayTick();
}

function replayTick() {
  if (!state.replayActive || state.replayIdx >= state.replayData.length) {
    state.replayActive = false;
    const btn = dom.el['replay-play-btn'];
    if (btn) { btn.textContent = '▶ Done'; btn.classList.remove('active'); }
    return;
  }
  replayStep();
  const speed = +(dom.el['replay-speed']?.value) || 2;
  clearTimeout(state.timers.replayTimer);
  state.timers.replayTimer = setTimeout(replayTick, Math.max(REPLAY_MIN_INTERVAL, REPLAY_BASE_INTERVAL / speed));
}

function replayStep() {
  if (state.replayIdx >= state.replayData.length) return;
  const c = state.replayData[state.replayIdx++];
  addCandleToState(c);
  state.livePrice = c.c;
  updatePriceDisplay();
  computeAndRender();
  dom.setText(dom.el['replay-progress-lbl'], `${state.replayIdx} / ${state.replayData.length}`);
  if (state.replayIdx % 10 === 0) dispatchToWorker([...state.candles]);
}

function replayReset() {
  state.replayActive = false;
  clearTimeout(state.timers.replayTimer); state.timers.replayTimer = null;
  state.replayIdx = 0;
  resetCandleState();
  _ensureAvwapState();
  const btn = dom.el['replay-play-btn'];
  if (btn) { btn.textContent = '▶ Play'; btn.classList.remove('active'); }
  dom.setText(dom.el['replay-progress-lbl'], `0 / ${state.replayData.length}`);
  drawAll();
  showToast('Replay reset');
}

function playBeep(freq) {
  try {
    const ctx  = _getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(); osc.stop(ctx.currentTime + 0.6);
  } catch(e) {}
}

function playCrossSound(type) { playBeep(type === 'bull' ? 660 : 440); }

export function showToast(msg, cls = '') {
  const t = dom.el['toast'];
  if (!t) return;
  t.textContent = msg; t.className = 'toast show ' + cls;
  clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.remove('show'), 3200);
}
window.showToast = showToast;

function handleKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toUpperCase();
  if (k === 'L') { state.currentDir = 'long';  scheduleRender(RenderPriority.FULL); showToast('Direction: LONG');  }
  if (k === 'S') { state.currentDir = 'short'; scheduleRender(RenderPriority.FULL); showToast('Direction: SHORT'); }
  if (k === 'R') runScreener();
  if (k === 'T') toggleTheme();
  if (k === 'V') { state.overlayVP = !state.overlayVP; scheduleRender(RenderPriority.FULL); }
  if (k === '[') { state.rrRatio = Math.max(1,  state.rrRatio - 0.5); setRRRatio(state.rrRatio); }
  if (k === ']') { state.rrRatio = Math.min(10, state.rrRatio + 0.5); setRRRatio(state.rrRatio); }
  if (k === 'A') anchorToSessionOpen();
  if (k === 'X') clearAnchor();
}

// ── MTF Confluence ────────────────────────────────────────────────────────────

function _mtfUpdateCoinCount() {
  const el = document.getElementById('mtf-coin-count');
  if (el) el.textContent = `${mtfCoins.length} coin${mtfCoins.length !== 1 ? 's' : ''}`;
}

function mtfAddCoin() {
  const inp = document.getElementById('mtf-coin-inp');
  if (!inp) return;
  const sym = sanitizeSym(inp.value);
  if (!sym) { showToast('Invalid symbol — letters and numbers only'); inp.value = ''; return; }
  if (mtfCoins.includes(sym)) { showToast(`${sym} already added`); inp.value = ''; return; }
  mtfCoins.push(sym);
  _mtfUpdateCoinCount();
  showToast(`✓ ${sym} added`);
  inp.value = '';
}

function mtfClearCoins() {
  mtfCoins   = [];
  mtfResults = [];
  _mtfUpdateCoinCount();
  renderMTFTable();
}

function mtfLoadFromScreener() {
  if (!scrResults.length) { showToast('Run screener first'); return; }
  const top = [...scrResults]
    .sort((a, b) => b.score - a.score)
    .slice(0, MTF_TOP_N_FROM_SCR)
    .map(r => r.sym);
  mtfCoins = [...new Set([...mtfCoins, ...top])];
  _mtfUpdateCoinCount();
  showToast(`✓ Loaded ${top.length} coins from screener`);
}

function mtfLoadWatchlist() {
  if (!state.watchlist.length) { showToast('Watchlist is empty'); return; }
  mtfCoins = [...new Set([...mtfCoins, ...state.watchlist])];
  _mtfUpdateCoinCount();
  showToast(`✓ Loaded ${state.watchlist.length} watchlist coins`);
}

function mtfScanCurrent() {
  const sym = state.sym;
  if (!sym) { showToast('No symbol loaded'); return; }
 
  // Add to front of list if not already present
  if (!mtfCoins.includes(sym)) {
    mtfCoins.unshift(sym);
    _mtfUpdateCoinCount();
  }
 
  // Expand + scroll to the card
  const card = document.getElementById('card-mtf');
  if (card?.classList.contains('collapsed')) {
    card.classList.remove('collapsed');
    saveCollapsed('card-mtf', false);
  }
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });
 
  showToast(`Scanning ${fmtSym(sym)} across ${mtfTFs.join(', ')}…`);
  runMTFScan();
}

function toggleMTFTf(tf, btn) {
  const idx = mtfTFs.indexOf(tf);
  if (idx >= 0) {
    if (mtfTFs.length === 1) { showToast('Need at least one TF'); return; }
    mtfTFs.splice(idx, 1);
  } else {
    mtfTFs.push(tf);
    mtfTFs.sort((a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b));
  }
  btn?.classList.toggle('active', mtfTFs.includes(tf));
}

function mtfSetFilter(f, btn) {
  mtfFilter = f;
  document.querySelectorAll('#card-mtf .scr-filter-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  renderMTFTable();
}

async function runMTFScan() {
  if (mtfRunning) return;
  if (!mtfCoins.length) { showToast('Add coins first'); return; }

  mtfRunning = true;
  const btn = document.getElementById('mtf-scan-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
  const prog    = document.getElementById('mtf-progress');
  const progBar = document.getElementById('mtf-progress-bar');
  const progLbl = document.getElementById('mtf-progress-lbl');
  if (prog) prog.style.display = 'block';

  const activeTFs = TF_ORDER.filter(t => mtfTFs.includes(t));
  const exch      = scrExchange;

  const cached    = new Map(scrResults.map(r => [r.sym, r]));
  const needFetch = mtfCoins.filter(s => !cached.has(s));
  const useCache  = mtfCoins.filter(s =>  cached.has(s));

  mtfResults = [];

  useCache.forEach(sym => {
    const r = cached.get(sym);
    mtfResults.push({
      sym,
      price:    r.price,
      signal:   r.signal,
      tfs:      r.mtfBreakdown || activeTFs.map(t => ({ tf: t, signal: 'none', weight: 1 })),
      score:    r.score,
      mtfScore: r.mtfScore,
      mtfFull:  r.mtfFull,
      conflict: r.higherTFConflict,
      fromCache: true,
    });
  });

  if (needFetch.length) {
    const rawData = await batchFetchScreener(needFetch, activeTFs, exch, ({ done, total, sym }) => {
      const pct = Math.round((useCache.length + done) / mtfCoins.length * 100);
      if (progBar) progBar.style.width = pct + '%';
      if (progLbl) progLbl.textContent = `${useCache.length + done}/${mtfCoins.length} — ${sym}`;
    });

    rawData.forEach((tfCandles, sym) => {
      const primaryTf = activeTFs.find(t => tfCandles[t]?.length >= 15);
      if (!primaryTf) return;

      const snapshotMap = {};
      activeTFs.forEach(tf => {
        const candles = tfCandles[tf];
        if (!candles?.length) return;
        const snap = calcTFSnapshot(candles, tf);
        if (snap) snapshotMap[tf] = snap;
      });

      const r = analyseSymbol(sym, tfCandles[primaryTf], primaryTf, snapshotMap, activeTFs, Date.now(), exch);
      if (!r) return;

      mtfResults.push({
        sym,
        price:    r.price,
        signal:   r.signal,
        tfs:      r.mtfBreakdown || activeTFs.map(t => ({ tf: t, signal: 'none', weight: 1 })),
        score:    r.score,
        mtfScore: r.mtfScore,
        mtfFull:  r.mtfFull,
        conflict: r.higherTFConflict,
        fromCache: false,
      });
    });
  }

  mtfResults.sort((a, b) => {
    if (a.mtfFull && !b.mtfFull) return -1;
    if (!a.mtfFull && b.mtfFull) return  1;
    return b.mtfScore - a.mtfScore;
  });

  renderMTFTable();
  mtfRunning = false;
  if (btn) { btn.disabled = false; btn.textContent = '▶ Scan'; }
  if (prog) prog.style.display = 'none';
  showToast(`MTF scan done — ${mtfResults.length} coins (${useCache.length} cached, ${needFetch.length} fetched)`);
}

function renderMTFTable() {
  const tbody    = document.getElementById('mtf-tbody');
  const theadRow = document.getElementById('mtf-thead-row');
  if (!tbody || !theadRow) return;

  const activeTFs = TF_ORDER.filter(t => mtfTFs.includes(t));

  theadRow.innerHTML = `
    <th>Symbol</th>
    <th>Price</th>
    <th>Overall</th>
    ${activeTFs.map(tf => `<th title="Weight: ${({'1m':1,'3m':1,'5m':1,'15m':2,'30m':2,'1h':3,'4h':5,'1d':8})[tf] || 1}×">${tf}</th>`).join('')}
    <th>Score</th>
    <th></th>
  `;

  let rows = mtfResults.filter(r => {
    const bullCount = r.tfs.filter(t => t.signal === 'bull').length;
    const bearCount = r.tfs.filter(t => t.signal === 'bear').length;
    const total     = r.tfs.filter(t => t.signal !== 'none').length;
    switch (mtfFilter) {
      case 'full_bull': return bullCount === total && total > 0;
      case 'full_bear': return bearCount === total && total > 0;
      case 'conflict':  return r.conflict;
      case 'clean':     return !r.conflict;
      default:          return true;
    }
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${activeTFs.length + 4}" class="scr-empty">${mtfResults.length ? 'No coins match filter' : 'No results — run a scan first'}</td></tr>`;
    return;
  }

  const SIG_COLOR = { bull: '#00e5a0', bear: '#ff3d5a', tang: '#ffb82e', none: 'var(--text3)' };
  const SIG_LABEL = { bull: '▲', bear: '▼', tang: '~', none: '—' };
  const SIG_BG    = { bull: 'rgba(0,229,160,0.12)', bear: 'rgba(255,61,90,0.12)', tang: 'rgba(255,184,46,0.08)', none: 'transparent' };

  tbody.innerHTML = rows.map(r => {
    const safeSym  = escHtml(r.sym);
    const safeDisp = escHtml(fmtSym(r.sym));

    const bullCount  = r.tfs.filter(t => t.signal === 'bull').length;
    const bearCount  = r.tfs.filter(t => t.signal === 'bear').length;
    const total      = r.tfs.filter(t => t.signal !== 'none').length;
    const allBull    = bullCount === total && total > 0;
    const allBear    = bearCount === total && total > 0;
    const overallCol = allBull ? '#00e5a0' : allBear ? '#ff3d5a' : r.conflict ? '#ff3d5a' : '#ffb82e';
    const overallTxt = allBull ? '▲ Full Bull' : allBear ? '▼ Full Bear' : r.conflict ? '⚠ Conflict' : `${bullCount}B ${bearCount}S`;
    const scoreCol   = r.score >= 75 ? '#00e5a0' : r.score >= 50 ? '#4da6ff' : r.score >= 30 ? '#ffb82e' : '#3d4460';
    const cacheTag   = r.fromCache ? `<span title="Using cached screener data" style="font-size:7px;color:var(--text3);font-family:var(--mono)">cached</span>` : '';

    const tfMap = Object.fromEntries(r.tfs.map(t => [t.tf, t.signal]));
    const tfCells = activeTFs.map(tf => {
      const sig = tfMap[tf] || 'none';
      return `<td style="text-align:center;background:${SIG_BG[sig]}">
        <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:${SIG_COLOR[sig]}"
              title="${tf}: ${sig}">${SIG_LABEL[sig]}</span>
      </td>`;
    }).join('');

    return `<tr>
      <td>
        <span class="scr-sym" onclick="loadCoinFromScreener('${safeSym}')">${safeDisp}</span>
        <div style="margin-top:2px">${cacheTag}</div>
      </td>
      <td class="scr-price" style="font-size:10px">${fmt(r.price)}</td>
      <td><span style="font-family:var(--mono);font-size:9px;font-weight:700;color:${overallCol}">${overallTxt}</span></td>
      ${tfCells}
      <td>
        <div class="score-bar">
          <div class="score-track">
            <div class="score-fill" style="width:${r.score}%;background:${scoreCol}"></div>
          </div>
          <span style="font-size:9px;color:${scoreCol};font-family:var(--mono);font-weight:700;min-width:24px">${r.score}</span>
        </div>
      </td>
      <td><button class="scr-trade-btn" onclick="loadCoinFromScreener('${safeSym}')">Trade →</button></td>
    </tr>`;
  }).join('');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

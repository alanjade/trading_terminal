import { state, resetCandleState } from './state/store.js';
import { loadSettings, saveSettings, loadWatchlist, saveWatchlist, loadCollapsed, saveCollapsed } from './state/persistence.js';
import { fmt, fmtSym, fmtK, TF_MS } from './utils/helpers.js';
import { updEMA, emaK, calcWilderRSI, updVWAP, computeLiveVwap, computeLiveBands, updCVD, calcATR, detectRSIDivergence, getFibLevels } from './indicators/engine.js';
import { detectRegime, calcTrendAge, calcMomentumAcceleration } from './indicators/regime.js';
import { detectSwingPoints, detectStructureBreaks, getSessionLevels } from './indicators/structure.js';
import { computeSuggestion, scoreEntryQuality, computeEntryZones, computePartialTPs, calcAtrPositionSize } from './engine/signals.js';
import { calcFuturesMetrics, calcRiskBasedSize, calcATRStop, calcATRTrailStop, calcDailyGoal, suggestLeverage } from './engine/risk.js';
import { initRenderer, scheduleRender, cancelPendingRender, RenderPriority } from './engine/renderer.js';
import { KlineWebSocket, TradeStream, fetchKlines, fetchKlinesFallback, batchFetchScreener } from './services/exchange.js';
import { analyseSymbol, calcTFSnapshot, applyScreenerFilters, sortScreenerResults, detectSectorRotation, SCR_DEFAULT_COINS, SCR_CURATED_TIERS } from './services/screener.js';
import { initJournal, openJournalEntry, saveJournalEntry, renderJournalList, renderJournalStats, exportJournal, deleteJournalTrade, editJournalTrade } from './components/journal.js';
import { LWCChart } from './charts/lwc.js';
import { backtesterHTML, btRun, btCompare, btExport, initBacktester } from './components/backtester.js';
import * as dom from './ui/dom.js';

let _lwcChart = null;

const SCR_COINS_DEFAULT = SCR_DEFAULT_COINS;
const SCR_COINS_CURATED = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','TRXUSDT','TONUSDT','LINKUSDT',
  'AVAXUSDT','SUIUSDT','APTUSDT','NEARUSDT','ARBUSDT','OPUSDT','POLUSDT','RENDERUSDT','SEIUSDT','HYPEUSDT',
  'INJUSDT','TIAUSDT','KASUSDT','ICPUSDT','HBARUSDT','VETUSDT','FILUSDT','ATOMUSDT','ALGOUSDT','XLMUSDT',
  'FETUSDT','TAOUSDT','AKTUSDT','OCEANUSDT','AGIXUSDT','AIOZUSDT','WLDUSDT','ARKMUSDT','PHAUSDT','NMRUSDT',
  'PEPEUSDT','SHIBUSDT','BONKUSDT','FLOKIUSDT','WIFUSDT','BRETTUSDT','POPCATUSDT','MOGUSDT','TURBOUSDT','BOMEUSDT',
  'UNIUSDT','AAVEUSDT','MKRUSDT','CRVUSDT','LDOUSDT','PENDLEUSDT','ENAUSDT','JUPUSDT','RAYUSDT','SUSHIUSDT',
  'IMXUSDT','GALAUSDT','SANDUSDT','MANAUSDT','AXSUSDT','BEAMUSDT','RONUSDT','ENJUSDT','ILVUSDT','PIXELUSDT',
  'DOTUSDT','FTMUSDT','MNTUSDT','ZKUSDT','STRKUSDT','RUNEUSDT','QNTUSDT','EOSUSDT','XTZUSDT','KAVAUSDT',
  'OKBUSDT','CROUSDT','BGBUSDT','KCSUSDT','HTUSDT',
  'ORDIUSDT','SATSUSDT','PYTHUSDT','WUSDT','DYMUSDT','ZETAUSDT','AEVOUSDT','ETHFIUSDT','BLURUSDT','PORTALUSDT',
  'JASMYUSDT','THETAUSDT','NEOUSDT','CHZUSDT','COMPUSDT',
].filter((v, i, a) => a.indexOf(v) === i);

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
  computeAndRender,
  renderScreenerTable,
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

export function init() {
  dom.init();

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

  document.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', () => _lwcChart?._resize());

  setupChartHover();
  renderWatchlist();
  renderAlerts();
  renderPnL();

  _scrUpdateCoinCount();

  const btSlot = dom.el['bt-placeholder'];
  if (btSlot) btSlot.outerHTML = backtesterHTML();
  initBacktester();
  dom.resolveLazy();
}

function _ensureAvwapState() {
  if (!Array.isArray(state.avwapVals))         state.avwapVals  = [];
  if (typeof state.avwapCumPV !== 'number')    state.avwapCumPV = 0;
  if (typeof state.avwapCumV  !== 'number')    state.avwapCumV  = 0;
  if (state.anchorIdx === undefined)           state.anchorIdx  = null;
}

export async function initSym(sym, tf) {
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

  const res = await fetchKlinesFallback(sym, tf);
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

  klineWs?.close();
  klineWs = new KlineWebSocket({
    exchName: state.exchange, sym, tf,
    onCandle: (candle, confirmed) => {
      if (confirmed) {
        addCandleToState(candle);
        state.currentCandle = null;
        scheduleRender(RenderPriority.PARTIAL);
        dispatchToWorker([...state.candles]);
      } else {
        state.currentCandle = candle;
        state.livePrice     = candle.c;
        checkAlerts(candle.c);
        scheduleRender(RenderPriority.LIVE);
      }
    },
    onStatus: setConnStatus,
  });
  klineWs.connect();

  tradeStream?.close();
  tradeStream = new TradeStream({
    exchName: state.exchange, sym,
    onTick: processTradeTick,
  });
  tradeStream.connect();

  saveSettings();
}

function addCandleToState(c) {
  if (state.candles.length > 0 && c.t) {
    const last = state.candles[state.candles.length - 1].t;
    if (last && c.t <= last) return;
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

  if (state.candles.length > 150) {
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

function computeAndRender() {
  const all = [...state.candles, state.currentCandle].filter(Boolean);
  const atr = calcATR(all, 14);

  state.regime = detectRegime(all, state.e20s, state.livePrice);

  if (all.length >= 10) {
    state.swingPoints     = detectSwingPoints(all.slice(-60), 3, 3);
    state.structureEvents = detectStructureBreaks(all.slice(-60), state.swingPoints);
  }

  state.sessionLevels = getSessionLevels(all);

  dom.batch(() => {
    _computeSignalsAndUI(all, atr);
    updateRegimeUI(state.regime);
    updateStructureUI(state.swingPoints, state.structureEvents);
  });

  drawAll();
}

function computePartial() {
  const all = [...state.candles, state.currentCandle].filter(Boolean);
  const atr = calcATR(all, 14);
  dom.batch(() => _computeSignalsAndUI(all, atr));
  drawAll();
}

function renderLive() {
  updatePriceDisplay();
  drawLive();
}

function _computeSignalsAndUI(all, atr) {
  const latestRSI   = state.rsiVals[state.rsiVals.length - 1];
  const latestVwap  = state.vwapVals[state.vwapVals.length - 1];
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

  const cvdLast = state.cvdVals[state.cvdVals.length - 1];
  const quality = scoreEntryQuality({
    dir: state.currentDir, rsi: latestRSI, e9: state.e9, e20: state.e20, e50: state.e50,
    price: state.livePrice, vwap: latestVwap,
    avwap: latestAvwap,
    cvd: cvdLast,
    crossovers: state.crossovers, tf: state.tf, candles: all, regime: state.regime,
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

  updateSuggestionUI(sug, quality, tps, trailStop, atrSize);
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
  if (state.structureEvents?.length) {
    _lwcChart.setStructureEvents(state.candles, state.structureEvents);
  }
}

function drawLive() {
  if (!_lwcChart || !state.currentCandle) return;

  const c = { ...state.currentCandle };
  c._liveVwap = state.vwapVals[state.vwapVals.length - 1];
  c._liveRsi  = state.rsiVals[state.rsiVals.length - 1];
  c._liveCvd  = state.cvdVals[state.cvdVals.length - 1];

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
    indicatorWorker = new Worker('./workers/indicator.worker.js');
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
  if (side === 'buy') { state.tradeStreamDelta += qty; state.tradeBuyVol  += qty; }
  else                { state.tradeStreamDelta -= qty; state.tradeSellVol += qty; }
  if (state.currentCandle) state.currentCandle._realDelta = state.tradeStreamDelta;
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
}

function updateEntryZonesUI(zones) {
  if (!zones) return;
  dom.setText(dom.el['zone-agg'], fmt(zones.aggressive));
  dom.setText(dom.el['zone-bal'], fmt(zones.balanced));
  dom.setText(dom.el['zone-con'], fmt(zones.conservative));
}

function updateRegimeUI(regime) {
  const el = dom.el['regime-display'];
  if (!el || !regime) return;
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
}

function updateStructureUI(swings, events) {
  const el = dom.el['structure-events'];
  if (!el) return;
  const recent = (events || []).slice(-5).reverse();
  const html = recent.length
    ? recent.map(ev => {
        const cls = `struct-${ev.type.toLowerCase()}-${ev.dir}`;
        return `<span class="signal-badge ${cls}" style="font-size:8px;padding:1px 7px">${ev.type} ${ev.dir === 'bull' ? '↑' : '↓'}</span>`;
      }).join('')
    : '<span style="color:var(--text3);font-size:9px;font-family:var(--mono)">No recent structure breaks</span>';
  if (el.innerHTML !== html) el.innerHTML = html;
}

function updateSuggestionUI(sug, quality, tps, trailStop, atrSize) {
  if (!sug) return;

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

  if (atrSize) {
    dom.setText(dom.el['atr-size-tokens'], atrSize.tokens.toFixed(4));
    dom.setText(dom.el['atr-size-value'],  '$' + atrSize.positionValue.toFixed(2));
    dom.setText(dom.el['atr-size-risk'],   '$' + atrSize.riskUSD.toFixed(2));
    dom.setText(dom.el['atr-stop-dist'],   atrSize.stopDistPct.toFixed(2) + '%');
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
        <span class="alert-sym">${fmtSym(a.sym)}</span>
        <span class="alert-cond">${a.dir === 'above' ? 'Above' : 'Below'}</span>
        <span class="alert-price-val">${fmt(a.price)}</span>
        ${a.triggered ? '<span class="alert-status">✓ TRIGGERED</span>' : ''}
      </div>
      <button class="alert-del" onclick="deleteAlert(${a.id})">×</button>
    </div>`).join('');
}

function wlAdd() {
  const v = dom.el['wl-inp']?.value.trim().toUpperCase().replace('/', '');
  if (!v) return;
  const sym = v.endsWith('USDT') ? v : v + 'USDT';
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
    <div class="wl-chip" onclick="loadCoinFromScreener('${s}')">
      <span>${fmtSym(s)}</span>
      <button class="wl-chip-del" onclick="event.stopPropagation();wlRemove('${s}')">×</button>
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
    <td style="font-weight:700">${t.sym.replace('USDT', '')}</td>
    <td>${t.dir}</td>
    <td class="${t.result === 'win' ? 'pnl-win' : 'pnl-loss'}">${t.result === 'win' ? 'WIN' : 'LOSS'}</td>
    <td class="${t.pnl >= 0 ? 'pnl-win' : 'pnl-loss'}">${(t.pnl >= 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2)}</td>
  </tr>`).join('');
}

function exportPnL() {
  if (!state.pnlTrades.length) { showToast('No trades to export'); return; }
  const rows = ['#,Time,Symbol,Direction,Result,P&L'];
  state.pnlTrades.forEach(t => rows.push(`${t.n},${t.time},${t.sym},${t.dir},${t.result},${t.pnl.toFixed(2)}`));
  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })),
    download: 'session_pnl_' + new Date().toISOString().slice(0, 10) + '.csv',
  });
  a.click();
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
  const raw = inp.value.trim().toUpperCase();
  if (!raw) return;
  const coin = raw.includes('USDT') ? raw : raw + 'USDT';
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
  const fetchAll = (n === null || n === undefined);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  const origText = fetchAll ? 'ALL' : `${n}`;
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
      const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('fapi ' + r.status);
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

  renderScreenerTable();
  scrRunning = false;
  if (btn) { btn.disabled = false; btn.textContent = '▶ Scan'; }
  dom.show(dom.el['scr-progress'], false);
  showToast(`Screener done: ${scrResults.length} symbols`);
}

function renderScreenerTable() {
  const tbody = dom.el['scr-tbody'];
  if (!tbody) return;

  let rows = applyScreenerFilters(scrResults, scrFilter);
  rows = sortScreenerResults(rows, scrSortKey, scrSortAsc);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="13" class="scr-empty">No results — run a scan first</td></tr>';
    return;
  }

  const thead = document.querySelector('#scr-table thead tr');
  if (thead && !thead.dataset.hintsApplied) {
    const hints = [
      ['sym',    'Symbol — click to trade'],
      ['price',  'Last traded price'],
      ['chg',    '24-hour price change %'],
      ['signal', 'EMA 9/20/50 stack direction'],
      ['rsi',    'RSI-14 momentum (>70 overbought, <30 oversold)'],
      ['score',  'Composite setup quality score (0–100)'],
      ['stack',  'EMA order: 9 vs 20 vs 50'],
      ['mtf',    'Multi-timeframe confluence — agreeing TFs / total TFs'],
      ['vol',    'Volume vs 20-bar average (🔥 ≥2x spike, ⚡ ≥1.5x hot)'],
      ['dist',   '% distance of price from EMA20'],
      ['hlpos',  'Price position within 24h high–low range'],
      ['age',    'Candles elapsed since last EMA9/20 crossover'],
    ];
    const ths = thead.querySelectorAll('th');
    hints.forEach(([key, tip], i) => {
      if (ths[i]) {
        ths[i].setAttribute('title', tip);
        ths[i].style.cursor = 'pointer';
      }
    });
    thead.dataset.hintsApplied = '1';
  }

  const top5 = new Set([...rows].sort((a, b) => b.score - a.score).slice(0, 5).map(r => r.sym));

  tbody.innerHTML = rows.map(r => {
    const chgCls   = r.chgPct >= 0 ? 'pos' : 'neg';
    const isTop5   = top5.has(r.sym);
    const rowStyle = isTop5 ? 'background:rgba(0,229,160,0.04);border-left:2px solid rgba(0,229,160,0.5)' : '';
    const scoreCol = r.score >= 75 ? '#00e5a0' : r.score >= 50 ? '#4da6ff' : r.score >= 30 ? '#ffb82e' : '#3d4460';
    const stackCol = r.bullStack ? '#00e5a0' : r.bearStack ? '#ff3d5a' : '#ffb82e';
    const stackTxt = r.bullStack ? '9>20>50' : r.bearStack ? '9<20<50' : '⚠ MIX';
    const volCol   = r.volSpike ? '#00e5a0' : r.volHot ? '#ffb82e' : 'var(--text2)';
    const volBg    = r.volSpike ? 'rgba(0,229,160,0.10)' : r.volHot ? 'rgba(255,184,46,0.08)' : 'transparent';
    const volIcon  = r.volSpike ? '🔥' : r.volHot ? '⚡' : '';
    const volStr   = r.volRatio != null ? r.volRatio.toFixed(1) + 'x' : '—';
    const distAbs  = r.e20dist != null ? Math.abs(r.e20dist) : null;
    const distCol  = distAbs != null ? (distAbs <= 1 ? '#00e5a0' : distAbs > 5 ? '#ff3d5a' : 'var(--text2)') : 'var(--text2)';
    const distStr  = distAbs != null ? (r.e20dist >= 0 ? '+' : '-') + distAbs.toFixed(1) + '%' : '—';
    const hlPos    = r.hlPos ?? 50;
    const hlBarCol = hlPos >= 80 ? '#ff3d5a' : hlPos <= 20 ? '#00e5a0' : '#4da6ff';
    const hlLabel  = hlPos >= 80 ? 'High' : hlPos <= 20 ? 'Low' : Math.round(hlPos) + '%';
    const mtfStr   = r.availTFs > 0 ? `${Math.max(r.bullCount, r.bearCount)}/${r.availTFs}` : '—';
    const mtfCol   = r.mtfFull ? '#00e5a0' : r.mtfMost ? '#ffb82e' : 'var(--text2)';
    const ageTxt   = r.trendAge != null ? r.trendAge + 'c' : '—';
    const ageCol   = r.trendAge <= 3 ? '#00e5a0' : r.trendAge <= 10 ? '#ffb82e' : 'var(--text3)';

    return `<tr style="${rowStyle}">
      <td><span class="scr-sym" onclick="loadCoinFromScreener('${r.sym}')">${fmtSym(r.sym)}${isTop5 ? '⭐' : ''}</span></td>
      <td class="scr-price">${fmt(r.price)}</td>
      <td class="scr-chg ${chgCls}">${(r.chgPct >= 0 ? '+' : '') + r.chgPct.toFixed(2) + '%'}</td>
      <td><span class="signal-badge signal-${r.signal}">${r.signalLabel}</span></td>
      <td class="scr-rsi">${r.rsi !== null ? Math.round(r.rsi) : '—'}</td>
      <td><div class="score-bar"><div class="score-track"><div class="score-fill" style="width:${r.score}%;background:${scoreCol}"></div></div><span style="font-size:9px;color:${scoreCol};font-family:var(--mono);font-weight:700;min-width:24px">${r.score}</span></div></td>
      <td><span style="font-family:var(--mono);font-size:9px;font-weight:700;color:${stackCol}">${stackTxt}</span></td>
      <td><span style="font-family:var(--mono);font-size:9px;font-weight:700;color:${mtfCol}">${mtfStr}</span></td>
      <td><span style="font-family:var(--mono);font-size:9px;font-weight:700;color:${volCol};background:${volBg};border-radius:6px;padding:1px 5px">${volStr}${volIcon}</span></td>
      <td><span style="font-family:var(--mono);font-size:9px;color:${distCol}">${distStr}</span></td>
      <td>
        <div style="position:relative;width:36px;height:6px;background:var(--bg3);border-radius:2px;display:inline-block">
          <div style="position:absolute;left:0;top:0;height:100%;width:${hlPos}%;background:${hlBarCol};border-radius:2px"></div>
        </div>
        <span style="font-family:var(--mono);font-size:8px;color:${hlBarCol};margin-left:3px">${hlLabel}</span>
      </td>
      <td><span style="font-family:var(--mono);font-size:9px;color:${ageCol}">${ageTxt}</span></td>
      <td><button class="scr-trade-btn" onclick="loadCoinFromScreener('${r.sym}')">Trade →</button></td>
    </tr>`;
  }).join('');
}

function toggleScrAuto() {
  if (scrAutoTimer) {
    clearInterval(scrAutoTimer);
    scrAutoTimer = null;
    showToast('Auto-scan off');
  } else {
    runScreener();
    scrAutoTimer = setInterval(runScreener, 5 * 60 * 1000);
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
  clearInterval(state.timers.replayTimer); state.timers.replayTimer = null;
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
  state.timers.replayTimer = setTimeout(replayTick, Math.max(50, 400 / speed));
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
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
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

function setupChartHover() {}

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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
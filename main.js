import { state, resetCandleState } from './state/store.js';
import { loadSettings, saveSettings, loadWatchlist, saveWatchlist, loadCollapsed, saveCollapsed } from './state/persistence.js';
import { fmt, fmtSym, fmtK, TF_MS } from './utils/helpers.js';
import { updEMA, emaK, calcWilderRSI, updVWAP, computeLiveVwap, computeLiveBands, updCVD, calcATR, detectRSIDivergence, getFibLevels } from './indicators/engine.js';
import { detectRegime, calcTrendAge, calcMomentumAcceleration } from './indicators/regime.js';
import { detectSwingPoints, detectStructureBreaks, getSessionLevels } from './indicators/structure.js';
import { computeSuggestion, scoreEntryQuality, computeEntryZones, computePartialTPs, calcAtrPositionSize } from './engine/signals.js';
import { calcFuturesMetrics, calcRiskBasedSize, calcATRStop, calcATRTrailStop, calcDailyGoal, suggestLeverage } from './engine/risk.js';
import { KlineWebSocket, TradeStream, fetchKlines, fetchKlinesFallback } from './services/exchange.js';
import { analyseSymbol, applyScreenerFilters, sortScreenerResults, detectSectorRotation, SCR_DEFAULT_COINS, SCR_CURATED_TIERS } from './services/screener.js';
import { initJournal, openJournalEntry, saveJournalEntry, renderJournalList, renderJournalStats, exportJournal, deleteJournalTrade, editJournalTrade } from './components/journal.js';
import { LWCChart } from './charts/lwc.js';
import { backtesterHTML, btRun, btCompare, btExport, initBacktester } from './components/backtester.js';

// ── Module-level chart reference ──────────────────────────────────────────────
let _lwcChart = null;

// ── Global exports (called from inline HTML onclick / oninput) ────────────────
Object.assign(window, {
  state,
  fmt, fmtSym, fmtK,
  saveJournalEntry, renderJournalList, deleteJournalTrade, editJournalTrade, exportJournal,
  toggleCard, loadCoinFromScreener, switchExchange, switchTF, switchSym,
  addAlert, deleteAlert, toggleAlertDir, wlAdd, wlRemove,
  logTrade, clearPnL, exportPnL,
  toggleOverlay, toggleTheme, setRRRatio, setDirection,
  runScreener, toggleScrAuto, setScrFilter, setScrTF,
  anchorToSessionOpen, clearAnchor, replayLoad, replayToggle, replayStep, replayReset,
  openJournalEntry,
  btRun, btCompare, btExport,
  computeAndRender,
  renderScreenerTable,
});

// ── Constants ─────────────────────────────────────────────────────────────────
const FIB_CONFIGS = [
  { r: 0,     label: '0%',    col: 'rgba(255,255,255,0.15)' },
  { r: 0.236, label: '23.6%', col: 'rgba(255,184,46,0.5)'  },
  { r: 0.382, label: '38.2%', col: 'rgba(0,229,160,0.6)'   },
  { r: 0.5,   label: '50%',   col: 'rgba(77,166,255,0.6)'  },
  { r: 0.618, label: '61.8%', col: 'rgba(167,139,255,0.7)' },
  { r: 1,     label: '100%',  col: 'rgba(255,255,255,0.15)' },
];

// ── WebSocket instances ───────────────────────────────────────────────────────
let klineWs         = null;
let tradeStream     = null;
let indicatorWorker = null;
let workerPending   = false;
let workerQueue     = null;

// ── AVWAP module-level anchor memory ─────────────────────────────────────────
let _anchorMode = null;   // null | 'session'

// ── Boot ──────────────────────────────────────────────────────────────────────
export function init() {
  // 1. Load persisted settings
  const saved    = loadSettings();
  state.sym      = saved?.sym      || 'BTCUSDT';
  state.tf       = saved?.tf       || '5m';
  state.exchange = saved?.exchange || 'bybit';
  state.watchlist = loadWatchlist();

  // 2. Use Object.defineProperty if the store uses getters, otherwise direct assign.
  _ensureAvwapState();

  // 2b. Seed leverage from DOM default so first computeAndRender() is never NaN.
  const levSlider  = document.getElementById('lev-slider');
  const levManual  = document.getElementById('lev-manual');
  const levDisplay = document.getElementById('lev-display');
  const initLev    = +(levSlider?.value ?? 10);
  state.leverage   = initLev;
  if (levManual)  levManual.value        = initLev;
  if (levDisplay) levDisplay.textContent = initLev + '×';
  if (levSlider)  levSlider.style.setProperty('--lev-pct', ((initLev - 1) / 99 * 100) + '%');

  // 3. Restore collapsed state
  const collapsed = loadCollapsed();
  Object.entries(collapsed).forEach(([id, isCollapsed]) => {
    const el = document.getElementById(id);
    if (el && isCollapsed) el.classList.add('collapsed');
  });

  // 4. Sub-system init
  initJournal();
  initIndicatorWorker();

  // 5. LWC chart — must exist before initSym() calls drawAll()
  _lwcChart = new LWCChart('lwc-container', { theme: state.isDark ? 'dark' : 'light' });

  // 6. Start data feeds
  initSym(state.sym, state.tf);

  // 7. Global event listeners
  document.addEventListener('keydown', handleKeyDown);
  window.addEventListener('resize', () => _lwcChart?._resize());

  // 8. UI
  setupChartHover();
  renderWatchlist();
  renderAlerts();
  renderPnL();

  // 9. Phase 9 — inject backtester card
  const btSlot = document.getElementById('bt-placeholder');
  if (btSlot) btSlot.outerHTML = backtesterHTML();
  initBacktester();
}

// Ensure all AVWAP fields exist on state, safe to call multiple times.
function _ensureAvwapState() {
  if (!Array.isArray(state.avwapVals)) state.avwapVals  = [];
  if (typeof state.avwapCumPV !== 'number') state.avwapCumPV = 0;
  if (typeof state.avwapCumV  !== 'number') state.avwapCumV  = 0;
  if (state.anchorIdx === undefined) state.anchorIdx = null;
}

// ── Symbol / TF init ──────────────────────────────────────────────────────────
export async function initSym(sym, tf) {
  state.sym = sym;
  state.tf  = tf;
  resetCandleState();

  _ensureAvwapState();

  state.avwapVals  = [];
  state.avwapCumPV = 0;
  state.avwapCumV  = 0;
  state.anchorIdx  = null;
  _writeAvwapLabel();   // show "—" immediately while loading

  // Highlight active pills
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

  // Fetch historical candles
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
    _applySessionAnchor(/* silent = */ true);
  }

  computeAndRender();
  dispatchToWorker([...state.candles]);

  // Live kline WebSocket
  klineWs?.close();
  klineWs = new KlineWebSocket({
    exchName: state.exchange, sym, tf,
    onCandle: (candle, confirmed) => {
      if (confirmed) {
        addCandleToState(candle);
        state.currentCandle = null;
        computeAndRender();
        dispatchToWorker([...state.candles]);
      } else {
        state.currentCandle = candle;
        state.livePrice     = candle.c;
        updatePriceDisplay();
        checkAlerts(candle.c);
        drawLive();
      }
    },
    onStatus: setConnStatus,
  });
  klineWs.connect();

  // Trade stream (for CVD delta)
  tradeStream?.close();
  tradeStream = new TradeStream({
    exchName: state.exchange, sym,
    onTick: processTradeTick,
  });
  tradeStream.connect();

  saveSettings();
}

// ── Candle state update ───────────────────────────────────────────────────────
function addCandleToState(c) {
  // Dedup by timestamp
  if (state.candles.length > 0 && c.t) {
    const last = state.candles[state.candles.length - 1].t;
    if (last && c.t <= last) return;
  }

  // EMA
  const prevE9 = state.e9, prevE20 = state.e20;
  state.e9  = updEMA(state.e9,  c.c, emaK(9));
  state.e20 = updEMA(state.e20, c.c, emaK(20));
  state.e50 = updEMA(state.e50, c.c, emaK(50));
  state.e9s.push(state.e9);
  state.e20s.push(state.e20);
  state.e50s.push(state.e50);

  // RSI
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

  // VWAP
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

  // CVD
  const cvdRes = updCVD(c, state.cvdRunning, state.cvdEmaRun, state.CVD_EMA_K, state.cvdResetMode, state.cvdSessionKey);
  state.cvdRunning    = cvdRes.newRunning;
  state.cvdEmaRun     = cvdRes.newEmaRun;
  state.cvdSessionKey = cvdRes.newSessionKey;
  state.cvdVals.push(state.cvdRunning);
  state.cvdEmaVals.push(state.cvdEmaRun);

  // EMA crossover detection
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

  // Trim ring-buffer to 150 bars
  if (state.candles.length > 150) {
    state.candles.shift();
    state.e9s.shift();   state.e20s.shift();  state.e50s.shift();
    state.rsiVals.shift();
    state.vwapVals.shift(); state.vwapBandVals.shift();
    state.cvdVals.shift();  state.cvdEmaVals.shift();

    if (state.anchorIdx !== null) {
      state.anchorIdx--;
      if (state.anchorIdx < 0) {
        // Anchor candle was evicted
        state.anchorIdx  = null;
        state.avwapVals  = [];
        state.avwapCumPV = 0;
        state.avwapCumV  = 0;
        _anchorMode      = null;   // clear module-level mode too
        _writeAvwapLabel();
        showToast('AVWAP anchor evicted (window full) — re-anchor with A', 'warn');
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
  const v = state.avwapCumV > 0
    ? state.avwapCumPV / state.avwapCumV
    : c.c;  // fallback to close, never push null/NaN
  if (v != null && !isNaN(v)) state.avwapVals.push(v);
}
// Safe single read-point for latest AVWAP value.
function _getLatestAvwap() {
  if (!Array.isArray(state.avwapVals) || state.avwapVals.length === 0) return null;
  const v = state.avwapVals[state.avwapVals.length - 1];
  console.log('[getLatest] v=', v, 'type=', typeof v, 'isNaN=', isNaN(v), 'null?', v == null);
  return (v != null && !isNaN(v)) ? v : null;
}

// ── compute + render (full refresh) ──────────────────────────────────────────
function computeAndRender() {
  const all = [...state.candles, state.currentCandle].filter(Boolean);
  const atr = calcATR(all, 14);

  // Market regime
  state.regime = detectRegime(all, state.e20s, state.livePrice);

  // Swing structure
  if (all.length >= 10) {
    state.swingPoints     = detectSwingPoints(all.slice(-60), 3, 3);
    state.structureEvents = detectStructureBreaks(all.slice(-60), state.swingPoints);
  }

  // Session levels
  state.sessionLevels = getSessionLevels(all);

  const latestRSI   = state.rsiVals[state.rsiVals.length - 1];
  const latestVwap  = state.vwapVals[state.vwapVals.length - 1];
  const latestAvwap = _getLatestAvwap();   // null when no anchor set

  // Trade suggestion
  const sug = computeSuggestion({
    e9: state.e9, e20: state.e20, e50: state.e50,
    livePrice: state.livePrice, rsi: latestRSI, rrRatio: state.rrRatio,
    tf: state.tf, candles: all, vwap: latestVwap,
    avwap: latestAvwap,
    regime: state.regime,
  });
  if (sug) state.suggestion = sug;

  // Entry quality
  const cvdLast = state.cvdVals[state.cvdVals.length - 1];
  const quality = scoreEntryQuality({
    dir: state.currentDir, rsi: latestRSI, e9: state.e9, e20: state.e20, e50: state.e50,
    price: state.livePrice, vwap: latestVwap,
    avwap: latestAvwap,
    cvd: cvdLast,
    crossovers: state.crossovers, tf: state.tf, candles: all, regime: state.regime,
  });

  // Entry zones
  const zones = computeEntryZones({ e9: state.e9, e20: state.e20, livePrice: state.livePrice, suggestion: sug, atr });
  if (zones) state.entryZones = zones;
  updateEntryZonesUI(zones);

  // Partial TPs + ATR trail
  const tps       = computePartialTPs({ entry: sug?.entry, stop: sug?.stop, dir: sug?.dir });
  const trailStop = calcATRTrailStop(state.livePrice, atr, state.currentDir, 2);

  // ATR position sizing
  const capital = +document.getElementById('inp-capital')?.value || 100;
  const atrSize = atr ? calcAtrPositionSize({ capital, riskPct: 1, entry: state.livePrice, atr, atrMultiple: 2 }) : null;

  // Futures metrics
  const leverage = state.leverage || 10;
  const margin   = +document.getElementById('inp-margin')?.value || 20;
  const entryRaw = document.getElementById('inp-entry')?.value;
  const stopRaw  = document.getElementById('inp-stop')?.value;
  const entry    = (entryRaw !== '' && +entryRaw) ? +entryRaw : (sug?.entry || state.livePrice);
  const stop     = (stopRaw  !== '' && +stopRaw)  ? +stopRaw  : (sug?.stop  || 0);

  const futMetrics = calcFuturesMetrics({
    capital, margin, leverage, entry, stop,
    dir: state.currentDir, rrRatio: state.rrRatio, feeType: state.feeType,
  });

  // Push to DOM
  updateSuggestionUI(sug, quality, tps, trailStop, atrSize);
  updateFuturesUI(futMetrics, leverage, entry);
  updateRegimeUI(state.regime);
  updateStructureUI(state.swingPoints, state.structureEvents);
  updateLegendLabels();
  _writeAvwapLabel(); 
  drawAll();
}

// ── Chart draw (full dataset) ─────────────────────────────────────────────────
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

// ── Live candle paint (unconfirmed tick) ──────────────────────────────────────
function drawLive() {
  if (!_lwcChart || !state.currentCandle) return;

  const c = { ...state.currentCandle };
  c._liveVwap = state.vwapVals[state.vwapVals.length - 1];
  c._liveRsi  = state.rsiVals[state.rsiVals.length - 1];
  c._liveCvd  = state.cvdVals[state.cvdVals.length - 1];

  // Live AVWAP for the forming bar (does not commit to avwapVals)
  if (state.anchorIdx !== null && state.avwapCumV > 0) {
    const tp    = (c.h + c.l + c.c) / 3;
    const vol   = c.v > 0 ? c.v : 0;
    const liveV = state.avwapCumV + vol;
    c._liveAvwap = liveV > 0 ? (state.avwapCumPV + tp * vol) / liveV : null;
  }

  _lwcChart.updateLiveCandle(c);

  // Refresh the AVWAP DOM label on every live tick — fixes "—" between confirmed bars.
  _writeAvwapLabel();
}

// ── Indicator web-worker ──────────────────────────────────────────────────────
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
  if (data.vp) { state.workerVP = data.vp; updateVPLabels(data.vp); }
  if (data.regime) state.regime = { ...state.regime, ...data.regime };
  drawAll();
}

// ── Trade tick (order-flow delta) ─────────────────────────────────────────────
function processTradeTick({ price, qty, side }) {
  if (side === 'buy') { state.tradeStreamDelta += qty; state.tradeBuyVol  += qty; }
  else                { state.tradeStreamDelta -= qty; state.tradeSellVol += qty; }
  if (state.currentCandle) state.currentCandle._realDelta = state.tradeStreamDelta;
  state.tradeTickBuf.push({ price, side, ts: Date.now() });
  if (state.tradeTickBuf.length > 50) state.tradeTickBuf.shift();
  updateDeltaTicker();
}

// ── DOM updaters ──────────────────────────────────────────────────────────────
function updatePriceDisplay() {
  const el = document.getElementById('live-price');
  if (!el) return;
  const prev = state.prevLivePrice;
  el.textContent = fmt(state.livePrice);
  if (prev) {
    el.classList.remove('flash-green', 'flash-red');
    void el.offsetWidth;
    el.classList.add(state.livePrice >= prev ? 'flash-green' : 'flash-red');
  }
  state.prevLivePrice = state.livePrice;

  const chg   = state.openPrice > 0 ? ((state.livePrice - state.openPrice) / state.openPrice * 100) : 0;
  const chgEl = document.getElementById('live-change');
  if (chgEl) {
    chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    chgEl.style.color = chg >= 0 ? 'var(--green)' : 'var(--red)';
  }
}

function setConnStatus(type, msg) {
  const el = document.getElementById('conn-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'conn-status ' + type;
}

function updateVPLabels(vp) {
  const g = id => document.getElementById(id);
  if (g('vp-poc-val')) g('vp-poc-val').textContent = fmt(vp.poc);
  if (g('vp-vah-val')) g('vp-vah-val').textContent = fmt(vp.vah);
  if (g('vp-val-val')) g('vp-val-val').textContent = fmt(vp.val);
}

function updateEntryZonesUI(zones) {
  if (!zones) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('zone-agg', fmt(zones.aggressive));
  set('zone-bal', fmt(zones.balanced));
  set('zone-con', fmt(zones.conservative));
}

function updateRegimeUI(regime) {
  const el = document.getElementById('regime-display');
  if (!el || !regime) return;
  const typeMap = {
    trending: regime.dir === 'bull' ? 'regime-trending-bull' : 'regime-trending-bear',
    ranging:  'regime-ranging',
    choppy:   'regime-choppy',
  };
  el.className   = 'regime-badge ' + (typeMap[regime.type] || '');
  el.textContent = regime.label;
  const advEl = document.getElementById('regime-advice'); if (advEl) advEl.textContent = regime.advice || '';
  const adxEl = document.getElementById('regime-adx');    if (adxEl) adxEl.textContent = regime.adx?.toFixed(1) ?? '—';
  const erEl  = document.getElementById('regime-er');     if (erEl)  erEl.textContent  = regime.er?.toFixed(2)  ?? '—';
}

function updateStructureUI(swings, events) {
  const el = document.getElementById('structure-events');
  if (!el) return;
  const recent = (events || []).slice(-5).reverse();
  if (!recent.length) {
    el.innerHTML = '<span style="color:var(--text3);font-size:9px;font-family:var(--mono)">No recent structure breaks</span>';
    return;
  }
  el.innerHTML = recent.map(ev => {
    const cls = `struct-${ev.type.toLowerCase()}-${ev.dir}`;
    return `<span class="signal-badge ${cls}" style="font-size:8px;padding:1px 7px">${ev.type} ${ev.dir === 'bull' ? '↑' : '↓'}</span>`;
  }).join('');
}

function updateSuggestionUI(sug, quality, tps, trailStop, atrSize) {
  if (!sug) return;
  const set      = (id, val)   => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const setColor = (id, color) => { const el = document.getElementById(id); if (el) el.style.color  = color; };

  set('sug-entry',  fmt(sug.entry));
  set('sug-stop',   fmt(sug.stop));
  set('sug-target', fmt(sug.target));
  set('sug-reason', sug.reason || '');
  set('sug-dir',    sug.dir === 'long' ? '▲ LONG' : '▼ SHORT');
  setColor('sug-dir', sug.dir === 'long' ? 'var(--green)' : 'var(--red)');

  if (quality) {
    set('entry-quality-score', quality.score);
    set('entry-quality-label', quality.label);
    const qEl = document.getElementById('entry-quality-label');
    if (qEl) qEl.style.color = quality.score >= 75 ? 'var(--green)' : quality.score >= 50 ? 'var(--amber)' : 'var(--red)';
    set('entry-quality-factors', quality.factors.slice(0, 3).join(' · '));
  }

  if (tps) {
    tps.forEach(tp => {
      set(`tp${tp.n}-price`, fmt(tp.tp));
      set(`tp${tp.n}-pct`,   '+' + tp.pct.toFixed(2) + '%');
    });
  }

  if (trailStop) set('atr-trail-val', fmt(trailStop));

  if (atrSize) {
    set('atr-size-tokens', atrSize.tokens.toFixed(4));
    set('atr-size-value',  '$' + atrSize.positionValue.toFixed(2));
    set('atr-size-risk',   '$' + atrSize.riskUSD.toFixed(2));
    set('atr-stop-dist',   atrSize.stopDistPct.toFixed(2) + '%');
  }
}

function updateFuturesUI(metrics, leverage, entry) {
  if (!metrics) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

  set('fv-pos-size',  '$' + metrics.posSize.toFixed(2));
  set('fv-liq-price', fmt(metrics.liqPrice));
  set('fv-liq-dist',  metrics.liqDistPct.toFixed(1) + '%');
  set('fv-profit',    '$' + metrics.profitNet.toFixed(2));
  set('fv-loss',      '$' + Math.abs(metrics.lossNet).toFixed(2));
  set('fv-roi-win',   metrics.roiWin.toFixed(2) + '%');
  set('fv-roi-loss',  metrics.roiLoss.toFixed(2) + '%');
  set('fv-be-price',  fmt(metrics.bePrice));
  set('fee-open',     '$' + metrics.feeOpen.toFixed(3));
  set('fee-close',    '$' + metrics.feeClose.toFixed(3));
  set('fee-tot',      '$' + metrics.feeTot.toFixed(3));

  const liqBar = document.getElementById('liq-bar');
  if (liqBar) {
    liqBar.style.width      = metrics.liqGaugePct + '%';
    liqBar.style.background = metrics.liqDistPct < 10
      ? 'var(--red)' : metrics.liqDistPct < 20 ? 'var(--amber)' : 'var(--green)';
  }

  const warn = document.getElementById('risk-warn');
  if (warn) {
    const isHigh = metrics.riskPct > 3;
    const isMed  = metrics.riskPct > 2 && !isHigh;
    warn.style.display = (isHigh || isMed) ? '' : 'none';
    warn.className     = 'risk-warn ' + (isHigh ? 'high' : 'med');
    if (isHigh || isMed) {
      warn.textContent = `⚠ Risk is ${metrics.riskPct.toFixed(1)}% of capital — ${isHigh ? 'consider reducing leverage or size' : 'acceptable but elevated'}.`;
    }
  }
}

function updateLegendLabels() {
  const set  = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const vwap = state.vwapVals[state.vwapVals.length - 1];
  const cvd  = state.cvdVals[state.cvdVals.length - 1];

  set('leg-e9',   state.e9  ? fmt(state.e9)  : '—');
  set('leg-e20',  state.e20 ? fmt(state.e20) : '—');
  set('leg-e50',  state.e50 ? fmt(state.e50) : '—');

  // FIX: write BOTH vwap elements — leg-vwap (card-structure) and leg-vwap2 (card-ema).
  // Previously leg-vwap2 was never written and always showed its initial "—".
  const vwapStr = vwap ? fmt(vwap) : '—';
  set('leg-vwap',  vwapStr);
  set('leg-vwap2', vwapStr);

  if (cvd !== undefined) set('leg-cvd', (cvd >= 0 ? '+' : '') + fmtK(cvd));

  _writeAvwapLabel();
}

function updateDeltaTicker() {
  const net = state.tradeBuyVol - state.tradeSellVol;
  const tot = state.tradeBuyVol + state.tradeSellVol || 1;
  const pct = Math.round(state.tradeBuyVol / tot * 100);
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('delta-buy',  fmtK(state.tradeBuyVol));
  set('delta-sell', fmtK(state.tradeSellVol));
  const netEl = document.getElementById('delta-net');
  if (netEl) { netEl.textContent = (net >= 0 ? '+' : '') + fmtK(net); netEl.style.color = net >= 0 ? 'var(--green)' : 'var(--red)'; }
  const bar = document.getElementById('delta-ratio-bar');
  if (bar) { bar.style.width = pct + '%'; bar.style.background = net >= 0 ? 'var(--green)' : 'var(--red)'; }
}

// ── UI actions ────────────────────────────────────────────────────────────────
function switchSym(sym) { initSym(sym, state.tf); }
function switchTF(tf)   { initSym(state.sym, tf); }

function switchExchange(name, btn) {
  state.exchange = name;
  document.querySelectorAll('#exch-group .pill-btn').forEach(b => b.classList.remove('active', 'sym-active'));
  btn.classList.add('active', 'sym-active');
  initSym(state.sym, state.tf);
}

function setDirection(dir) { state.currentDir = dir; computeAndRender(); }
function setRRRatio(v)     { state.rrRatio = +v || 2; computeAndRender(); }

function toggleOverlay(key, btn) {
  if (key === 'fib') state.overlayFib = !state.overlayFib;
  if (key === 'vp')  state.overlayVP  = !state.overlayVP;
  if (key === 'div') state.overlayDiv = !state.overlayDiv;
  btn?.classList.toggle('active');
  drawAll();
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

// ── Alerts ────────────────────────────────────────────────────────────────────
function addAlert() {
  const price = +document.getElementById('alrt-price')?.value;
  if (!price) return;
  state.alerts.push({ id: Date.now(), sym: state.sym, price, dir: state.alertDir, triggered: false });
  document.getElementById('alrt-price').value = '';
  renderAlerts();
  if (Notification?.permission === 'default') Notification.requestPermission();
}

function deleteAlert(id) { state.alerts = state.alerts.filter(a => a.id !== id); renderAlerts(); }

function toggleAlertDir() {
  state.alertDir = state.alertDir === 'above' ? 'below' : 'above';
  const btn = document.getElementById('alrt-dir-btn');
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
  const el = document.getElementById('alert-list');
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

// ── Watchlist ─────────────────────────────────────────────────────────────────
function wlAdd() {
  const v = document.getElementById('wl-inp')?.value.trim().toUpperCase().replace('/', '');
  if (!v) return;
  const sym = v.endsWith('USDT') ? v : v + 'USDT';
  if (!state.watchlist.includes(sym)) { state.watchlist.push(sym); saveWatchlist(state.watchlist); renderWatchlist(); }
  document.getElementById('wl-inp').value = '';
}

function wlRemove(s) {
  state.watchlist = state.watchlist.filter(x => x !== s);
  saveWatchlist(state.watchlist); renderWatchlist();
}

function renderWatchlist() {
  const el = document.getElementById('wl-list');
  if (!el) return;
  if (!state.watchlist.length) { el.innerHTML = '<span class="wl-empty">No coins added</span>'; return; }
  el.innerHTML = state.watchlist.map(s => `
    <div class="wl-chip" onclick="loadCoinFromScreener('${s}')">
      <span>${fmtSym(s)}</span>
      <button class="wl-chip-del" onclick="event.stopPropagation();wlRemove('${s}')">×</button>
    </div>`).join('');
}

// ── P&L tracker ───────────────────────────────────────────────────────────────
function logTrade(result) {
  state.tradeCount++;
  const profitEl = document.getElementById('fv-profit');
  const lossEl   = document.getElementById('fv-loss');
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
  const set    = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('pnl-net',    (net >= 0 ? '+' : '') + '$' + net.toFixed(2));
  set('pnl-wins',   wins);
  set('pnl-losses', losses);
  set('pnl-wr',     state.pnlTrades.length ? wr + '%' : '—');
  const netEl = document.getElementById('pnl-net');
  if (netEl) netEl.style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
  const tbody = document.getElementById('pnl-tbody');
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

// ── Screener ──────────────────────────────────────────────────────────────────
async function runScreener() {
  if (state.scrRunning) return;
  state.scrRunning = true;
  const btn = document.getElementById('scr-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
  showProgress(true);

  const coins = state.scrCoinList?.length ? state.scrCoinList : SCR_DEFAULT_COINS;
  const tfs   = [...state.scrTFs];
  const exch  = state.scrExchange;
  const { batchFetchScreener } = await import('./services/exchange.js');

  const rawData = await batchFetchScreener(coins, tfs, exch, ({ done, total, sym }) => {
    const pct = Math.round(done / total * 100);
    const bar = document.getElementById('scr-progress-bar');
    const lbl = document.getElementById('scr-progress-lbl');
    if (bar) bar.style.width = pct + '%';
    if (lbl) lbl.textContent = `${done}/${total} — ${sym}`;
  });

  state.scrResults = [];
  rawData.forEach((tfData, sym) => {
    const r = analyseSymbol(sym, tfData, tfs[0], Date.now(), exch);
    if (r) state.scrResults.push(r);
  });

  renderScreenerTable();
  state.scrRunning = false;
  if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }
  showProgress(false);
  showToast(`Screener done: ${state.scrResults.length} symbols`);
}

function renderScreenerTable() {
  const tbody = document.getElementById('scr-tbody');
  if (!tbody) return;
  let rows = applyScreenerFilters(state.scrResults, state.scrFilter);
  rows = sortScreenerResults(rows, state.scrSortKey, state.scrSortAsc);
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="scr-empty">No results</td></tr>'; return; }
  const top5 = new Set([...rows].sort((a, b) => b.score - a.score).slice(0, 5).map(r => r.sym));
  tbody.innerHTML = rows.map(r => {
    const chgCls   = r.chgPct >= 0 ? 'pos' : 'neg';
    const isTop5   = top5.has(r.sym);
    const rowStyle = isTop5 ? 'background:rgba(0,229,160,0.04);border-left:2px solid rgba(0,229,160,0.5)' : '';
    const scoreCol = r.score >= 75 ? '#00e5a0' : r.score >= 50 ? '#4da6ff' : r.score >= 30 ? '#ffb82e' : '#3d4460';
    return `<tr style="${rowStyle}">
      <td><span class="scr-sym" onclick="loadCoinFromScreener('${r.sym}')">${fmtSym(r.sym)}${isTop5 ? '⭐' : ''}</span></td>
      <td class="scr-price">${fmt(r.price)}</td>
      <td class="scr-chg ${chgCls}">${(r.chgPct >= 0 ? '+' : '') + r.chgPct.toFixed(2) + '%'}</td>
      <td><span class="signal-badge signal-${r.signal}">${r.signalLabel}</span></td>
      <td class="scr-rsi">${r.rsi !== null ? Math.round(r.rsi) : '—'}</td>
      <td><div class="score-bar"><div class="score-track"><div class="score-fill" style="width:${r.score}%;background:${scoreCol}"></div></div><span style="font-size:9px;color:${scoreCol};font-family:var(--mono);font-weight:700;min-width:24px">${r.score}</span></div></td>
      <td><button class="scr-trade-btn" onclick="loadCoinFromScreener('${r.sym}')">Trade →</button></td>
    </tr>`;
  }).join('');
}

function setScrFilter(filter) { state.scrFilter = filter; renderScreenerTable(); }

function setScrTF(tf, btn) {
  if (state.scrTFs.has(tf)) state.scrTFs.delete(tf); else state.scrTFs.add(tf);
  btn?.classList.toggle('active', state.scrTFs.has(tf));
}

let scrAutoTimer = null;
function toggleScrAuto() {
  state.scrAutoOn = !state.scrAutoOn;
  if (state.scrAutoOn) { runScreener(); scrAutoTimer = setInterval(runScreener, 60_000); }
  else { clearInterval(scrAutoTimer); scrAutoTimer = null; }
}

function showProgress(show) {
  const el = document.getElementById('scr-progress');
  if (el) el.style.display = show ? '' : 'none';
}

// ── Anchored VWAP ─────────────────────────────────────────────────────────────

/**
 * Finds the session-open candle index and sets the anchor.
 * Also sets _anchorMode so initSym() re-applies it after symbol/TF switches.
 * @param {boolean} silent - if true, suppresses the toast (used on auto re-apply)
 */
function _applySessionAnchor(silent = false) {
  if (!state.candles.length) {
    if (!silent) showToast('No candle data');
    return;
  }

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

  if (!silent) {
    showToast('AVWAP anchored' + (idx === 0 ? ' (oldest in window)' : ' to session open'));
  }
}

export function anchorToSessionOpen() {
  _anchorMode = 'session';
  _applySessionAnchor(false);
  drawAll();
}

export function clearAnchor() {
  _anchorMode      = null;
  state.anchorIdx  = null;
  state.avwapVals  = [];
  state.avwapCumPV = 0;
  state.avwapCumV  = 0;
  _writeAvwapLabel();
  drawAll();
}

/**
 * Writes the avwap-val DOM element.
 * Reads from _getLatestAvwap() — the single safe read-point.
 * Called from: anchorToSessionOpen, clearAnchor, updateLegendLabels, drawLive.
 */
function _writeAvwapLabel() {
  const el = document.getElementById('avwap-val');
  if (!el) return;
  const avwap = _getLatestAvwap();
  console.log('[AVWAP label] value:', avwap, 'livePrice:', state.livePrice); // TEMP
  if (avwap != null) {
    el.textContent = fmt(avwap);
    el.style.color = (state.livePrice && state.livePrice >= avwap) ? 'var(--green)' : 'var(--red)';
  } else {
    el.textContent = '\u2014';   // —
    el.style.color = '';
  }
}

/**
 * Rebuilds state.avwapVals from state.candles[anchorIdx..] in full.
 * Also resets and persists avwapCumPV/V so _appendAvwapBar stays O(1).
 */
function recomputeAvwap() {
  if (state.anchorIdx === null) return;
  const slice = state.candles.slice(state.anchorIdx);
  
  // TEMP DIAGNOSTIC — remove after fixing
  console.log('[AVWAP] anchorIdx:', state.anchorIdx, 
              'candles total:', state.candles.length,
              'slice length:', slice.length);
  if (slice.length > 0) {
    const c0 = slice[0];
    console.log('[AVWAP] first candle:', JSON.stringify(c0));
    console.log('[AVWAP] has volume?', c0.v, typeof c0.v);
  }

  let cumPV = 0, cumV = 0;
  state.avwapVals = slice.map(c => {
    const tp  = (c.h + c.l + c.c) / 3;
    const vol = (c.v > 0) ? c.v : 0;
    cumPV += tp * vol;
    cumV  += vol;
    return cumV > 0 ? cumPV / cumV : c.c;
  });
  
  // TEMP DIAGNOSTIC
  console.log('[AVWAP] avwapVals length:', state.avwapVals.length, 
              'last value:', state.avwapVals[state.avwapVals.length - 1]);
  
  state.avwapCumPV = cumPV;
  state.avwapCumV  = cumV;
}
// ── Replay ────────────────────────────────────────────────────────────────────
async function replayLoad() {
  const btn = document.getElementById('replay-load-btn');
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
  document.getElementById('replay-play-btn').disabled = false;
  document.getElementById('replay-play-btn').textContent = '▶ Play';
  document.getElementById('replay-progress-lbl').textContent = `0 / ${res.candles.length}`;
  if (btn) { btn.textContent = '✓ Loaded'; btn.disabled = false; }
  showToast(`Replay ready: ${res.candles.length} candles`);
  drawAll();
}

function replayToggle() {
  if (!state.replayData.length) { showToast('Load history first'); return; }
  state.replayActive = !state.replayActive;
  const btn = document.getElementById('replay-play-btn');
  if (btn) { btn.textContent = state.replayActive ? '⏸ Pause' : '▶ Play'; btn.classList.toggle('active', state.replayActive); }
  if (state.replayActive) replayTick();
}

function replayTick() {
  if (!state.replayActive || state.replayIdx >= state.replayData.length) {
    state.replayActive = false;
    const btn = document.getElementById('replay-play-btn');
    if (btn) { btn.textContent = '▶ Done'; btn.classList.remove('active'); }
    return;
  }
  replayStep();
  const speed = +document.getElementById('replay-speed')?.value || 2;
  state.timers.replayTimer = setTimeout(replayTick, Math.max(50, 400 / speed));
}

function replayStep() {
  if (state.replayIdx >= state.replayData.length) return;
  const c = state.replayData[state.replayIdx++];
  addCandleToState(c);
  state.livePrice = c.c;
  updatePriceDisplay();
  computeAndRender();
  document.getElementById('replay-progress-lbl').textContent = `${state.replayIdx} / ${state.replayData.length}`;
  if (state.replayIdx % 10 === 0) dispatchToWorker([...state.candles]);
}

function replayReset() {
  state.replayActive = false;
  clearTimeout(state.timers.replayTimer); state.timers.replayTimer = null;
  state.replayIdx = 0;
  resetCandleState();
  _ensureAvwapState();
  const btn = document.getElementById('replay-play-btn');
  if (btn) { btn.textContent = '▶ Play'; btn.classList.remove('active'); }
  document.getElementById('replay-progress-lbl').textContent = `0 / ${state.replayData.length}`;
  drawAll();
  showToast('Replay reset');
}

// ── Audio ─────────────────────────────────────────────────────────────────────
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

// ── Toast ─────────────────────────────────────────────────────────────────────
export function showToast(msg, cls = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg; t.className = 'toast show ' + cls;
  clearTimeout(t._tid); t._tid = setTimeout(() => t.classList.remove('show'), 3200);
}
window.showToast = showToast;

// ── Chart hover ───────────────────────────────────────────────────────────────
function setupChartHover() {
  // LWCChart manages hover internally via subscribeCrosshairMove.
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
function handleKeyDown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const k = e.key.toUpperCase();
  if (k === 'L') { state.currentDir = 'long';  computeAndRender(); showToast('Direction: LONG');  }
  if (k === 'S') { state.currentDir = 'short'; computeAndRender(); showToast('Direction: SHORT'); }
  if (k === 'R') runScreener();
  if (k === 'T') toggleTheme();
  if (k === 'V') { state.overlayVP = !state.overlayVP; drawAll(); }
  if (k === '[') { state.rrRatio = Math.max(1,  state.rrRatio - 0.5); setRRRatio(state.rrRatio); }
  if (k === ']') { state.rrRatio = Math.min(10, state.rrRatio + 0.5); setRRRatio(state.rrRatio); }
  if (k === 'A') anchorToSessionOpen();
  if (k === 'X') clearAnchor();
}

// ── Auto-start ────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
/**
 * components/backtester.js
 * Backtest UI — strategy selector, run controls, results dashboard.
 */

import { BacktestEngine, STRATEGIES, calcMetrics, runWalkForward, compareStrategies } from '../engine/backtest.js';
import { fetchKlinesFallback } from '../services/exchange.js';
import { fmt, fmtK } from '../utils/helpers.js';
import { state } from '../state/store.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_CANDLES_BACKTEST  = 80;   // minimum candles required to run a backtest
const MIN_CANDLES_WALKFWD   = 200;  // minimum candles required for walk-forward
const EQUITY_PADDING_FACTOR = 0.005; // 0.5% headroom above/below equity curve
const TRADE_LOG_MAX_ROWS    = 50;   // max trades shown in the log table
const WALKFWD_WINDOWS       = 4;

// ── State ─────────────────────────────────────────────────────────────────────

let _result    = null;
let _isRunning = false;

// ── HTML Template ─────────────────────────────────────────────────────────────

export function backtesterHTML() {
  return `
  <div id="card-backtest" class="card card--collapsible collapsed">
    <div class="card-header" onclick="toggleCard('card-backtest')">
      <span class="card-title">📊 Backtester</span>
      <div style="display:flex;gap:6px;align-items:center">
        <button id="bt-run-btn" class="btn btn--primary btn--icon" onclick="event.stopPropagation();btRun()">▶ Run</button>
        <button class="btn btn--icon" onclick="event.stopPropagation();btCompare()" title="Compare all strategies">⚡ Compare</button>
        <button class="btn btn--icon" onclick="event.stopPropagation();btExport()" title="Export trades CSV">⬇ CSV</button>
        <span class="card-chevron">▾</span>
      </div>
    </div>
    <div class="card-body">

      <!-- Config row -->
      <div class="bt-config-grid">

        <div class="bt-config-item">
          <label class="stat-lbl">Strategy</label>
          <select id="bt-strategy" class="input-field" style="font-size:11px">
            ${Object.values(STRATEGIES).map(s =>
              `<option value="${s.id}">${s.label}</option>`
            ).join('')}
          </select>
        </div>

        <div class="bt-config-item">
          <label class="stat-lbl">Symbol</label>
          <select id="bt-sym" class="input-field" style="font-size:11px">
            <option value="">Current</option>
            <option value="BTCUSDT">BTC</option>
            <option value="ETHUSDT">ETH</option>
            <option value="SOLUSDT">SOL</option>
          </select>
        </div>

        <div class="bt-config-item">
          <label class="stat-lbl">Timeframe</label>
          <select id="bt-tf" class="input-field" style="font-size:11px">
            <option value="">Current</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
          </select>
        </div>

        <div class="bt-config-item">
          <label class="stat-lbl">Capital $</label>
          <input id="bt-capital" class="input-field" type="number" value="1000" min="100" style="font-size:11px" />
        </div>

        <div class="bt-config-item">
          <label class="stat-lbl">Risk %</label>
          <input id="bt-risk" class="input-field" type="number" value="1" min="0.1" max="10" step="0.1" style="font-size:11px" />
        </div>

        <div class="bt-config-item">
          <label class="stat-lbl">R:R Ratio</label>
          <input id="bt-rr" class="input-field" type="number" value="2" min="1" max="10" step="0.5" style="font-size:11px" />
        </div>

        <div class="bt-config-item">
          <label class="stat-lbl">ATR Mult</label>
          <input id="bt-atr" class="input-field" type="number" value="2" min="0.5" max="5" step="0.5" style="font-size:11px" />
        </div>

        <div class="bt-config-item">
          <label class="stat-lbl">Leverage</label>
          <input id="bt-lev" class="input-field" type="number" value="10" min="1" max="100" style="font-size:11px" />
        </div>
      </div>

      <!-- Toggle options -->
      <div class="bt-toggles">
        <label class="bt-toggle">
          <input type="checkbox" id="bt-trail" />
          <span>Trailing stop</span>
        </label>
        <label class="bt-toggle">
          <input type="checkbox" id="bt-partials" checked />
          <span>Partial TPs</span>
        </label>
        <label class="bt-toggle">
          <input type="checkbox" id="bt-walkfwd" />
          <span>Walk-forward (${WALKFWD_WINDOWS} windows)</span>
        </label>
      </div>

      <!-- Progress -->
      <div id="bt-progress-wrap" style="display:none;margin-bottom:10px">
        <div class="progress-track">
          <div id="bt-progress-bar" class="progress-bar" style="width:0%"></div>
        </div>
        <div id="bt-progress-lbl" class="stat-lbl" style="margin-top:3px">Running…</div>
      </div>

      <!-- Strategy description -->
      <div id="bt-strat-desc" class="bt-strat-desc"></div>

      <!-- Results -->
      <div id="bt-results" style="display:none">

        <!-- Headline metrics -->
        <div class="bt-metrics-grid" id="bt-metrics-grid"></div>

        <!-- Charts row -->
        <div class="bt-charts-row">
          <div class="bt-chart-wrap">
            <div class="stat-lbl" style="margin-bottom:4px">Equity Curve</div>
            <canvas id="bt-equity-canvas" height="120" style="width:100%;display:block"></canvas>
          </div>
          <div class="bt-chart-wrap">
            <div class="stat-lbl" style="margin-bottom:4px">Drawdown</div>
            <canvas id="bt-dd-canvas" height="120" style="width:100%;display:block"></canvas>
          </div>
        </div>

        <!-- Walk-forward results (if enabled) -->
        <div id="bt-wf-section" style="display:none">
          <div class="struct-label" style="margin:10px 0 6px">Walk-Forward Windows</div>
          <div id="bt-wf-table"></div>
        </div>

        <!-- Trade log -->
        <div class="struct-label" style="margin:10px 0 6px">Trade Log</div>
        <div class="bt-trade-log-wrap">
          <table class="pnl-table">
            <thead>
              <tr>
                <th>#</th><th>Entry Bar</th><th>Dir</th><th>Entry</th>
                <th>Exit</th><th>Reason</th><th>RR</th><th>P&L</th><th>Bars</th>
              </tr>
            </thead>
            <tbody id="bt-trade-tbody"></tbody>
          </table>
        </div>

      </div>
    </div>
  </div>`;
}

// ── Run Backtest ──────────────────────────────────────────────────────────────

export async function btRun() {
  if (_isRunning) return;
  _isRunning = true;

  const btn = document.getElementById('bt-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running…'; }
  showProgress(true, 0);

  try {
    const symSel = document.getElementById('bt-sym')?.value;
    const tfSel  = document.getElementById('bt-tf')?.value;
    const sym    = symSel || state.sym;
    const tf     = tfSel  || state.tf;

    let candles;
    if (sym === state.sym && tf === state.tf) {
      candles = [...state.candles];
    } else {
      const res = await fetchKlinesFallback(sym, tf);
      candles = res?.candles || [];
    }

    if (candles.length < MIN_CANDLES_BACKTEST) {
      showToast('Not enough candle data for backtest');
      return;
    }

    const stratId  = document.getElementById('bt-strategy')?.value || 'ema_pullback';
    const strategy = Object.values(STRATEGIES).find(s => s.id === stratId) || STRATEGIES.EMA_PULLBACK;

    const config = {
      candles,
      strategy,
      capital:     +document.getElementById('bt-capital')?.value  || 1000,
      riskPct:     +document.getElementById('bt-risk')?.value     || 1,
      rrRatio:     +document.getElementById('bt-rr')?.value       || 2,
      atrMultiple: +document.getElementById('bt-atr')?.value      || 2,
      leverage:    +document.getElementById('bt-lev')?.value      || 10,
      trailStop:   document.getElementById('bt-trail')?.checked   || false,
      partialTPs:  document.getElementById('bt-partials')?.checked ?? true,
      onProgress:  pct => showProgress(true, pct),
    };

    // Run in yielded chunk to avoid blocking UI
    await new Promise(r => setTimeout(r, 10));
    const engine = new BacktestEngine(config);
    _result = engine.run();

    // Walk-forward
    const doWF = document.getElementById('bt-walkfwd')?.checked;
    let wfResult = null;
    if (doWF && candles.length > MIN_CANDLES_WALKFWD) {
      showProgress(true, 90);
      await new Promise(r => setTimeout(r, 10));
      wfResult = runWalkForward(candles, config);
    }

    renderResults(_result, wfResult);

    if (_result?.metrics) {
      document.dispatchEvent(new CustomEvent('bt:result', {
        detail: { metrics: _result.metrics, sym, tf },
      }));
    }

  } catch(err) {
    console.error('[Backtest]', err);
    showToast('Backtest error: ' + err.message);
  } finally {
    _isRunning = false;
    showProgress(false);
    if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }
  }
}

// ── Compare All Strategies ────────────────────────────────────────────────────

export async function btCompare() {
  if (_isRunning) return;
  _isRunning = true;
  showProgress(true, 0);

  try {
    const candles = [...state.candles];
    if (candles.length < MIN_CANDLES_BACKTEST) { showToast('Need more candle data'); return; }

    const config = {
      capital:    +document.getElementById('bt-capital')?.value || 1000,
      riskPct:    +document.getElementById('bt-risk')?.value    || 1,
      rrRatio:    +document.getElementById('bt-rr')?.value      || 2,
    };

    const results = await compareStrategies(candles, config);
    renderCompareTable(results);

  } catch(err) {
    console.error('[Backtest Compare]', err);
    showToast('Compare error: ' + err.message);
  } finally {
    _isRunning = false;
    showProgress(false);
  }
}

// ── Render Results ────────────────────────────────────────────────────────────

function renderResults(result, wfResult) {
  const { trades, metrics, equityCurve } = result;

  document.getElementById('bt-results').style.display = 'block';

  renderMetricsGrid(metrics);

  requestAnimationFrame(() => {
    drawEquityCurve(equityCurve, result.initialCapital);
    drawDrawdownCurve(metrics?.drawdownCurve);
  });

  if (wfResult) {
    document.getElementById('bt-wf-section').style.display = 'block';
    renderWFTable(wfResult);
  } else {
    document.getElementById('bt-wf-section').style.display = 'none';
  }

  renderTradeLog(trades);
}

function renderMetricsGrid(m) {
  const el = document.getElementById('bt-metrics-grid');
  if (!el || !m) return;

  const col = (v, lo, hi) => v >= hi ? '#00e5a0' : v >= lo ? '#ffb82e' : '#ff3d5a';

  const items = [
    { lbl: 'Total Trades',    val: m.total,                          color: 'var(--text)' },
    { lbl: 'Win Rate',        val: m.winRate + '%',                  color: col(m.winRate, 40, 55) },
    { lbl: 'Net P&L',         val: (m.netPnl>=0?'+':'')+'$'+m.netPnl.toFixed(2), color: m.netPnl >= 0 ? '#00e5a0' : '#ff3d5a' },
    { lbl: 'Profit Factor',   val: m.profitFactor?.toFixed(2) ?? '—', color: col(m.profitFactor||0, 1, 1.5) },
    { lbl: 'Expectancy',      val: (m.expectancy>=0?'+':'')+'$'+m.expectancy.toFixed(2), color: m.expectancy >= 0 ? '#00e5a0' : '#ff3d5a' },
    { lbl: 'Avg RR',          val: m.avgRR != null ? '1:'+m.avgRR.toFixed(2) : '—', color: col(m.avgRR||0, 1, 2) },
    { lbl: 'Max Drawdown',    val: m.maxDrawdownPct.toFixed(1)+'%',  color: col(100-m.maxDrawdownPct, 60, 85) },
    { lbl: 'Sharpe',          val: m.sharpe?.toFixed(2) ?? '—',      color: col(m.sharpe||0, 0.5, 1) },
    { lbl: 'Total Return',    val: m.totalReturn.toFixed(1)+'%',     color: m.totalReturn >= 0 ? '#00e5a0' : '#ff3d5a' },
    { lbl: 'Final Equity',    val: '$'+m.finalEquity.toFixed(0),     color: 'var(--text)' },
    { lbl: 'Max Streak W',    val: m.maxConsecWins,                  color: 'var(--text)' },
    { lbl: 'Max Streak L',    val: m.maxConsecLoss,                  color: m.maxConsecLoss >= 5 ? '#ff3d5a' : 'var(--text)' },
    { lbl: 'Avg Duration',    val: m.avgBars.toFixed(1)+' bars',     color: 'var(--text)' },
    { lbl: 'Risk of Ruin',    val: m.riskOfRuin != null ? (m.riskOfRuin*100).toFixed(1)+'%' : '—', color: col(100-(m.riskOfRuin||0)*100, 70, 90) },
  ];

  el.innerHTML = items.map(({ lbl, val, color }) => `
    <div class="stat-item">
      <div class="stat-lbl">${lbl}</div>
      <div class="stat-val" style="font-size:13px;color:${color}">${val}</div>
    </div>
  `).join('');
}

function renderTradeLog(trades) {
  const tbody = document.getElementById('bt-trade-tbody');
  if (!tbody) return;

  if (!trades.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="pnl-empty">No trades</td></tr>';
    return;
  }

  const total = trades.length;
  const shown = trades.slice(-TRADE_LOG_MAX_ROWS).reverse();

  tbody.innerHTML = shown.map((t, i) => {
    const cls = t.pnl > 0 ? 'pnl-win' : 'pnl-loss';
    const dir = t.dir === 'long'
      ? '<span style="color:#00e5a0">▲ L</span>'
      : '<span style="color:#ff3d5a">▼ S</span>';
    return `<tr>
      <td style="color:var(--text3)">${total - i}</td>
      <td style="color:var(--text3)">${t.entryIdx}</td>
      <td>${dir}</td>
      <td class="mono" style="font-size:10px">${fmt(t.entryPrice)}</td>
      <td class="mono" style="font-size:10px">${fmt(t.exitPrice)}</td>
      <td style="font-size:9px;color:var(--text2)">${t.exitReason?.toUpperCase()}</td>
      <td class="${cls}" style="font-size:10px">${t.rr != null ? t.rr.toFixed(2) : '—'}</td>
      <td class="${cls}" style="font-size:10px">${t.pnl != null ? (t.pnl>=0?'+':'')+'$'+Math.abs(t.pnl).toFixed(2) : '—'}</td>
      <td style="color:var(--text3);font-size:10px">${t.barDuration}</td>
    </tr>`;
  }).join('');
}

function renderCompareTable(results) {
  const el = document.getElementById('bt-results');
  if (!el) return;
  el.style.display = 'block';

  const mg = document.getElementById('bt-metrics-grid');
  if (mg) mg.innerHTML = `
    <div style="grid-column:1/-1">
      <div class="struct-label" style="margin-bottom:8px">Strategy Comparison</div>
      <table class="pnl-table" style="width:100%">
        <thead>
          <tr>
            <th>Strategy</th><th>Trades</th><th>Win%</th>
            <th>Net P&L</th><th>Prof. Factor</th><th>Drawdown</th><th>Sharpe</th>
          </tr>
        </thead>
        <tbody>
          ${results.map((r, i) => {
            const m    = r.metrics;
            const best = i === 0;
            return `<tr style="${best ? 'background:rgba(0,229,160,0.04)' : ''}">
              <td style="font-weight:700">${best ? '⭐ ' : ''}${r.strategy}</td>
              <td>${m?.total ?? '—'}</td>
              <td style="color:${(m?.winRate||0)>=50?'#00e5a0':'#ff3d5a'}">${m?.winRate ?? '—'}%</td>
              <td style="color:${(m?.netPnl||0)>=0?'#00e5a0':'#ff3d5a'}">${m ? (m.netPnl>=0?'+':'')+'$'+m.netPnl.toFixed(2) : '—'}</td>
              <td>${m?.profitFactor?.toFixed(2) ?? '—'}</td>
              <td style="color:${(m?.maxDrawdownPct||100)<20?'#00e5a0':'#ff3d5a'}">${m?.maxDrawdownPct?.toFixed(1) ?? '—'}%</td>
              <td>${m?.sharpe?.toFixed(2) ?? '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderWFTable(wfResult) {
  const el = document.getElementById('bt-wf-table');
  if (!el) return;

  const agg = wfResult.aggregateOOS;
  el.innerHTML = `
    <table class="pnl-table" style="width:100%;margin-bottom:8px">
      <thead>
        <tr><th>Window</th><th>IS Win%</th><th>OOS Win%</th><th>OOS P&L</th><th>Degradation</th></tr>
      </thead>
      <tbody>
        ${wfResult.windows.map(w => `
          <tr>
            <td>W${w.window}</td>
            <td>${w.inSample?.metrics?.winRate ?? '—'}%</td>
            <td style="color:${(w.outSample?.metrics?.winRate||0)>=40?'#00e5a0':'#ff3d5a'}">${w.outSample?.metrics?.winRate ?? '—'}%</td>
            <td style="color:${(w.outSample?.metrics?.netPnl||0)>=0?'#00e5a0':'#ff3d5a'}">${w.outSample?.metrics ? (w.outSample.metrics.netPnl>=0?'+':'')+'$'+w.outSample.metrics.netPnl.toFixed(2) : '—'}</td>
            <td style="color:${(w.degradation||0)<10?'#00e5a0':'#ffb82e'}">${w.degradation != null ? w.degradation.toFixed(1)+'pp' : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat-item"><div class="stat-lbl">Avg OOS Win%</div><div class="stat-val" style="font-size:13px">${agg.avgWinRate.toFixed(1)}%</div></div>
      <div class="stat-item"><div class="stat-lbl">Avg OOS P&L</div><div class="stat-val" style="font-size:13px;color:${agg.avgNetPnl>=0?'#00e5a0':'#ff3d5a'}">${agg.avgNetPnl>=0?'+':''}$${agg.avgNetPnl.toFixed(2)}</div></div>
      <div class="stat-item"><div class="stat-lbl">Avg Drawdown</div><div class="stat-val" style="font-size:13px">${agg.avgDrawdown.toFixed(1)}%</div></div>
      <div class="stat-item"><div class="stat-lbl">Consistency</div><div class="stat-val" style="font-size:13px;color:${agg.consistency>=0.75?'#00e5a0':'#ffb82e'}">${Math.round(agg.consistency*100)}%</div></div>
    </div>
  `;
}

// ── Canvas Charts ─────────────────────────────────────────────────────────────

function drawEquityCurve(curve, initial) {
  const canvas = document.getElementById('bt-equity-canvas');
  if (!canvas || !curve?.length) return;

  const w = canvas.parentElement.clientWidth || 400;
  const h = 120;
  const DPR = window.devicePixelRatio || 1;
  canvas.width  = w * DPR;
  canvas.height = h * DPR;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  ctx.clearRect(0, 0, w, h);

  const vals = curve.map(p => p.value);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);

  const range = rawMax - rawMin;
  const min = range === 0 ? rawMin - 1 : rawMin * (1 - EQUITY_PADDING_FACTOR);
  const max = range === 0 ? rawMax + 1 : rawMax * (1 + EQUITY_PADDING_FACTOR);
  const span = max - min;

  const padL = 6, padR = 40, padT = 8, padB = 6;
  const cW = w - padL - padR, cH = h - padT - padB;
  const n  = curve.length;

  const tx = i => padL + (i / (n - 1)) * cW;
  const ty = v => padT + cH - ((v - min) / span) * cH;

  const baseY = ty(initial);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(padL, baseY); ctx.lineTo(padL + cW, baseY); ctx.stroke();

  const gradient = ctx.createLinearGradient(0, padT, 0, padT + cH);
  gradient.addColorStop(0, 'rgba(0,229,160,0.2)');
  gradient.addColorStop(1, 'rgba(0,229,160,0)');

  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = tx(i), y = ty(p.value);
    if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
  });
  ctx.lineTo(tx(n - 1), padT + cH);
  ctx.lineTo(tx(0), padT + cH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = tx(i), y = ty(p.value);
    if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
  });
  ctx.strokeStyle = '#00e5a0';
  ctx.lineWidth = 1.5;
  ctx.lineJoin  = 'round';
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('$' + vals[vals.length - 1].toFixed(0), padL + cW + 3, ty(vals[vals.length - 1]) + 3);
  ctx.fillText('$' + rawMin.toFixed(0), padL + cW + 3, padT + cH);
}

function drawDrawdownCurve(curve) {
  const canvas = document.getElementById('bt-dd-canvas');
  if (!canvas || !curve?.length) return;

  const w = canvas.parentElement.clientWidth || 400;
  const h = 120;
  const DPR = window.devicePixelRatio || 1;
  canvas.width  = w * DPR;
  canvas.height = h * DPR;
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  ctx.clearRect(0, 0, w, h);

  const vals = curve.map(p => p.drawdownPct);
  const max  = Math.max(...vals, 1);

  const padL = 6, padR = 40, padT = 8, padB = 6;
  const cW = w - padL - padR, cH = h - padT - padB;
  const n  = curve.length;

  const tx = i => padL + (i / (n - 1)) * cW;
  const ty = v => padT + (v / max) * cH;

  const grad = ctx.createLinearGradient(0, padT, 0, padT + cH);
  grad.addColorStop(0, 'rgba(255,61,90,0.3)');
  grad.addColorStop(1, 'rgba(255,61,90,0)');

  ctx.beginPath();
  ctx.moveTo(tx(0), padT); // start at top-left of chart area (zero drawdown baseline)
  curve.forEach((p, i) => {
    ctx.lineTo(tx(i), ty(p.drawdownPct));
  });
  ctx.lineTo(tx(n - 1), padT); // return to top-right baseline
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = tx(i), y = ty(p.drawdownPct);
    if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
  });
  ctx.strokeStyle = '#ff3d5a';
  ctx.lineWidth = 1.5;
  ctx.lineJoin  = 'round';
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '9px JetBrains Mono, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(max.toFixed(1) + '%', padL + cW + 3, padT + 6);
  ctx.fillText('0%', padL + cW + 3, padT + cH);
}

// ── Export ────────────────────────────────────────────────────────────────────

export function btExport() {
  if (!_result?.trades?.length) { showToast('Run a backtest first'); return; }
  const cols = ['#','EntryBar','ExitBar','Dir','EntryPrice','ExitPrice','ExitReason','RR','PnL','Bars','MAE','MFE'];
  const rows = [cols.join(',')];
  _result.trades.forEach((t, i) => {
    rows.push([
      i+1, t.entryIdx, t.exitIdx, t.dir,
      t.entryPrice?.toFixed(4), t.exitPrice?.toFixed(4),
      t.exitReason, t.rr?.toFixed(3), t.pnl?.toFixed(2),
      t.barDuration, t.mae?.toFixed(4), t.mfe?.toFixed(4),
    ].join(','));
  });

  const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
  const a   = Object.assign(document.createElement('a'), {
    href:     url,
    download: `backtest_${Date.now()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(url);

  showToast('Exported ' + _result.trades.length + ' trades');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showProgress(show, pct = 0) {
  const wrap = document.getElementById('bt-progress-wrap');
  const bar  = document.getElementById('bt-progress-bar');
  const lbl  = document.getElementById('bt-progress-lbl');
  if (!wrap) return;
  wrap.style.display = show ? 'block' : 'none';
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = `Running… ${pct}%`;
}

function showToast(msg) {
  if (window.showToast) window.showToast(msg);
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const BT_CSS = `
.bt-config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}
.bt-config-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bt-toggles {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.bt-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text2);
  cursor: pointer;
}
.bt-toggle input[type=checkbox] {
  accent-color: var(--green);
}
.bt-strat-desc {
  font-size: 10px;
  color: var(--text3);
  font-style: italic;
  margin-bottom: 10px;
  min-height: 14px;
}
.bt-metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 6px;
  margin-bottom: 12px;
}
.bt-charts-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.bt-chart-wrap {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.bt-trade-log-wrap {
  max-height: 300px;
  overflow-y: auto;
}
`;

if (!document.getElementById('bt-styles')) {
  const style = document.createElement('style');
  style.id = 'bt-styles';
  style.textContent = BT_CSS;
  document.head.appendChild(style);
}

// ── Strategy description update on select change ──────────────────────────────

export function initBacktester() {
  const sel  = document.getElementById('bt-strategy');
  const desc = document.getElementById('bt-strat-desc');
  if (sel && desc) {
    const update = () => {
      const s = Object.values(STRATEGIES).find(x => x.id === sel.value);
      if (s && desc) desc.textContent = s.desc;
    };
    sel.addEventListener('change', update);
    update();
  }
}
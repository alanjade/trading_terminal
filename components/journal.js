/**
 * components/journal.js
 * Trade Journal: logging, tagging, performance analytics.
 * Enhanced with: emotional tags, setup types, mistake tracking, behavioral analysis.
 */

import { saveJournal, loadJournal, exportJournalCSV } from '../state/persistence.js';
import { fmt, relativeTime } from '../utils/helpers.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const EMOTIONS = [
  { id: 'confident', label: '😎 Confident', color: '#00e5a0' },
  { id: 'neutral',   label: '😐 Neutral',   color: '#6b7591' },
  { id: 'fomo',      label: '😰 FOMO',      color: '#ffb82e' },
  { id: 'fearful',   label: '😨 Fearful',   color: '#ff6b35' },
  { id: 'revenge',   label: '😡 Revenge',   color: '#ff3d5a' },
  { id: 'bored',     label: '😴 Bored',     color: '#a78bff' },
];

export const SETUPS = [
  { id: 'ema_pullback',  label: 'EMA Pullback' },
  { id: 'breakout',      label: 'Breakout'     },
  { id: 'reversal',      label: 'Reversal'     },
  { id: 'mean_revert',   label: 'Mean Revert'  },
  { id: 'momentum',      label: 'Momentum'     },
  { id: 'other',         label: 'Other'        },
];

export const MISTAKES = [
  { id: 'early_entry', label: '⚡ Early entry' },
  { id: 'late_entry',  label: '🐢 Late entry'  },
  { id: 'wide_stop',   label: '📏 Wide stop'   },
  { id: 'no_stop',     label: '🚫 No stop'     },
  { id: 'oversize',    label: '📈 Oversize'    },
  { id: 'revenge',     label: '😡 Revenge'     },
  { id: 'fomo',        label: '😰 FOMO entry'  },
  { id: 'none',        label: '✅ No mistake'  },
];

// ── Journal State ─────────────────────────────────────────────────────────────

let trades = [];
let editingId = null;

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function initJournal() {
  trades = loadJournal();
  renderJournalList();
  renderJournalStats();
}

// ── Log Trade ─────────────────────────────────────────────────────────────────

/**
 * Opens the journal entry form pre-filled with trade data from the calculator.
 */
export function openJournalEntry({ sym, dir, tf, entry, stop, target, regime, score }) {
  document.getElementById('jrn-sym').value   = sym  || '';
  document.getElementById('jrn-dir').value   = dir  || 'long';
  document.getElementById('jrn-tf').value    = tf   || '5m';
  document.getElementById('jrn-entry').value = entry  || '';
  document.getElementById('jrn-stop').value  = stop   || '';
  document.getElementById('jrn-target').value= target || '';

  if (regime) document.getElementById('jrn-regime').textContent = regime;
  if (score)  document.getElementById('jrn-score').textContent  = score;

  editingId = null;
  showPanel('jrn-form');
}

export function saveJournalEntry() {
  const sym     = document.getElementById('jrn-sym').value.trim().toUpperCase();
  const dir     = document.getElementById('jrn-dir').value;
  const tf      = document.getElementById('jrn-tf').value;
  const entry   = +document.getElementById('jrn-entry').value;
  const stop    = +document.getElementById('jrn-stop').value;
  const target  = +document.getElementById('jrn-target').value;
  const exit    = +document.getElementById('jrn-exit').value || undefined;
  const notes   = document.getElementById('jrn-notes').value.trim();
  const setup   = document.getElementById('jrn-setup').value;
  const emotion = document.getElementById('jrn-emotion').value;

  // Mistakes (multi-select)
  const mistakeEls = document.querySelectorAll('.jrn-mistake-btn.active');
  const mistakes   = [...mistakeEls].map(el => el.dataset.id);

  if (!sym || !entry || !stop) {
    showToast('Symbol, entry, and stop are required', 'warn');
    return;
  }

  // Auto-compute result if exit is set
  let result, pnl, rr;
  if (exit && entry && stop) {
    const risk = Math.abs(entry - stop);
    const profit = dir === 'long' ? exit - entry : entry - exit;
    pnl    = profit;
    rr     = risk > 0 ? profit / risk : null;
    result = profit > 0 ? 'win' : profit < -risk * 0.1 ? 'loss' : 'be';
  }

  const trade = {
    id:        editingId || Date.now(),
    timestamp: editingId ? trades.find(t => t.id === editingId)?.timestamp || Date.now() : Date.now(),
    sym, dir, tf, entry, stop, target,
    exit, result, pnl, rr,
    setup, emotion, mistakes, notes,
    regime: document.getElementById('jrn-regime')?.textContent,
    score:  +document.getElementById('jrn-score')?.textContent || undefined,
  };

  if (editingId) {
    trades = trades.map(t => t.id === editingId ? trade : t);
  } else {
    trades.push(trade);
  }

  saveJournal(trades);
  renderJournalList();
  renderJournalStats();
  hidePanel('jrn-form');
  editingId = null;
  showToast('Trade logged ✓');
}

export function deleteJournalTrade(id) {
  if (!confirm('Delete this journal entry?')) return;
  trades = trades.filter(t => t.id !== id);
  saveJournal(trades);
  renderJournalList();
  renderJournalStats();
}

export function editJournalTrade(id) {
  const t = trades.find(t => t.id === id);
  if (!t) return;
  editingId = id;
  document.getElementById('jrn-sym').value    = t.sym;
  document.getElementById('jrn-dir').value    = t.dir;
  document.getElementById('jrn-tf').value     = t.tf;
  document.getElementById('jrn-entry').value  = t.entry;
  document.getElementById('jrn-stop').value   = t.stop;
  document.getElementById('jrn-target').value = t.target;
  document.getElementById('jrn-exit').value   = t.exit || '';
  document.getElementById('jrn-notes').value  = t.notes || '';
  document.getElementById('jrn-setup').value  = t.setup || 'other';
  document.getElementById('jrn-emotion').value= t.emotion || 'neutral';

  // Restore mistakes
  document.querySelectorAll('.jrn-mistake-btn').forEach(btn => {
    btn.classList.toggle('active', (t.mistakes || []).includes(btn.dataset.id));
  });

  showPanel('jrn-form');
}

// ── Render List ───────────────────────────────────────────────────────────────

export function renderJournalList(filter = 'all') {
  const el = document.getElementById('jrn-list');
  if (!el) return;

  let list = [...trades].reverse();
  if (filter === 'win')  list = list.filter(t => t.result === 'win');
  if (filter === 'loss') list = list.filter(t => t.result === 'loss');

  if (!list.length) {
    el.innerHTML = `<div class="jrn-empty">No trades logged. Click + to add your first trade.</div>`;
    return;
  }

  el.innerHTML = list.map(t => {
    const emotion = EMOTIONS.find(e => e.id === t.emotion) || EMOTIONS[1];
    const resultCls = t.result === 'win' ? 'jrn-win' : t.result === 'loss' ? 'jrn-loss' : 'jrn-be';
    const resultLabel = t.result === 'win' ? 'WIN' : t.result === 'loss' ? 'LOSS' : t.result ? 'BE' : '—';
    const pnlStr  = t.pnl != null ? (t.pnl >= 0 ? '+' : '') + '$' + Math.abs(t.pnl).toFixed(2) : '—';
    const rrStr   = t.rr  != null ? '1:' + Math.abs(t.rr).toFixed(1) : '—';
    const dirIcon = t.dir === 'long' ? '▲' : '▼';
    const dirCol  = t.dir === 'long' ? 'var(--green)' : 'var(--red)';
    const setupLabel = SETUPS.find(s => s.id === t.setup)?.label || t.setup;
    const mistakeWarnings = (t.mistakes || []).filter(m => m !== 'none')
      .map(m => MISTAKES.find(x => x.id === m)?.label).join(', ');
    const symLabel = escHtml(String(t.sym || '').replace('USDT',''));
    const dirLabel = escHtml(String(t.dir || '').toUpperCase());
    const tfLabel = escHtml(t.tf || '');
    const setupText = escHtml(setupLabel || '');
    const mistakeText = escHtml(mistakeWarnings);
    const notesPreview = escHtml(String(t.notes || '').slice(0, 120));

    return `<div class="jrn-row" data-id="${t.id}">
      <div class="jrn-row-header">
        <span class="jrn-row-sym">${symLabel} <span style="color:${dirCol}">${dirIcon} ${dirLabel}</span></span>
        <span class="jrn-row-tf">${tfLabel}</span>
        <span class="jrn-row-time">${relativeTime(t.timestamp)}</span>
        <span class="jrn-row-result ${resultCls}">${resultLabel}</span>
        <span class="jrn-row-pnl ${resultCls}">${pnlStr}</span>
        <div class="jrn-row-actions">
          <button class="jrn-btn-sm" onclick="editJournalTrade(${t.id})">Edit</button>
          <button class="jrn-btn-sm jrn-btn-del" onclick="deleteJournalTrade(${t.id})">×</button>
        </div>
      </div>
      <div class="jrn-row-details">
        <span class="jrn-detail">Entry ${fmt(t.entry)}</span>
        <span class="jrn-detail">SL ${fmt(t.stop)}</span>
        <span class="jrn-detail">TP ${fmt(t.target)}</span>
        ${t.exit ? `<span class="jrn-detail">Exit ${fmt(t.exit)}</span>` : ''}
        <span class="jrn-detail">RR ${rrStr}</span>
        <span class="jrn-detail">
          <span style="color:${emotion.color}">${emotion.label}</span>
        </span>
        <span class="jrn-detail">${setupText}</span>
        ${t.score ? `<span class="jrn-detail">Score ${t.score}</span>` : ''}
      </div>
      ${mistakeWarnings ? `<div class="jrn-mistakes">⚠ ${mistakeText}</div>` : ''}
      ${t.notes ? `<div class="jrn-notes-preview">${notesPreview}${t.notes.length>120?'…':''}</div>` : ''}
    </div>`;
  }).join('');
}

// ── Performance Stats ──────────────────────────────────────────────────────────

export function renderJournalStats() {
  const el = document.getElementById('jrn-stats');
  if (!el) return;

  const stats = calcJournalStats(trades);
  if (!stats.total) {
    el.innerHTML = `<div class="jrn-stats-empty">Log trades to see performance analytics.</div>`;
    return;
  }

  const wrColor  = stats.wr >= 50 ? 'var(--green)' : 'var(--red)';
  const pnlColor = stats.netPnl >= 0 ? 'var(--green)' : 'var(--red)';

  // Behavioral warnings
  const warnings = [];
  if (stats.revengeCount > 0)    warnings.push(`🔴 ${stats.revengeCount} revenge trade${stats.revengeCount>1?'s':''}`);
  if (stats.fomoCount > 0)       warnings.push(`🟡 ${stats.fomoCount} FOMO trade${stats.fomoCount>1?'s':''}`);
  if (stats.noStopCount > 0)     warnings.push(`🔴 ${stats.noStopCount} trade${stats.noStopCount>1?'s':''} without a stop`);
  if (stats.oversizeCount > 0)   warnings.push(`🟡 ${stats.oversizeCount} oversize trade${stats.oversizeCount>1?'s':''}`);

  // Best/worst setups
  const setupRows = Object.entries(stats.bySetup)
    .sort((a, b) => (b[1].wins / (b[1].total||1)) - (a[1].wins / (a[1].total||1)))
    .slice(0, 4)
    .map(([setup, s]) => {
      const wr = s.total > 0 ? Math.round(s.wins / s.total * 100) : 0;
      const label = SETUPS.find(x => x.id === setup)?.label || setup;
      return `<div class="jrn-setup-row">
        <span>${label}</span>
        <span>${s.wins}W/${s.total - s.wins}L</span>
        <span style="color:${wr>=50?'var(--green)':'var(--red)'}">${wr}%</span>
      </div>`;
    }).join('');

  el.innerHTML = `
    <div class="jrn-stats-grid">
      <div class="jrn-stat-item">
        <div class="jrn-stat-lbl">Trades</div>
        <div class="jrn-stat-val">${stats.total}</div>
      </div>
      <div class="jrn-stat-item">
        <div class="jrn-stat-lbl">Win Rate</div>
        <div class="jrn-stat-val" style="color:${wrColor}">${stats.wr}%</div>
      </div>
      <div class="jrn-stat-item">
        <div class="jrn-stat-lbl">Net P&L</div>
        <div class="jrn-stat-val" style="color:${pnlColor}">${stats.netPnl>=0?'+':''}$${Math.abs(stats.netPnl).toFixed(2)}</div>
      </div>
      <div class="jrn-stat-item">
        <div class="jrn-stat-lbl">Avg RR</div>
        <div class="jrn-stat-val">${stats.avgRR !== null ? '1:' + stats.avgRR.toFixed(2) : '—'}</div>
      </div>
      <div class="jrn-stat-item">
        <div class="jrn-stat-lbl">Profit Factor</div>
        <div class="jrn-stat-val">${stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : '—'}</div>
      </div>
      <div class="jrn-stat-item">
        <div class="jrn-stat-lbl">Expectancy</div>
        <div class="jrn-stat-val">${stats.expectancy !== null ? (stats.expectancy>=0?'+':'')+stats.expectancy.toFixed(2) : '—'}</div>
      </div>
    </div>
    ${warnings.length ? `<div class="jrn-behavioral-warn">${warnings.join(' · ')}</div>` : ''}
    ${setupRows ? `<div class="jrn-setup-breakdown"><div class="jrn-setup-title">Setup Performance</div>${setupRows}</div>` : ''}
  `;
}

// ── Stats Calculator ──────────────────────────────────────────────────────────

export function calcJournalStats(trades) {
  const closed = trades.filter(t => t.result);
  const wins   = closed.filter(t => t.result === 'win');
  const losses = closed.filter(t => t.result === 'loss');
  const total  = closed.length;
  const wr     = total > 0 ? Math.round(wins.length / total * 100) : 0;

  const netPnl = closed.filter(t => t.pnl != null).reduce((a, t) => a + t.pnl, 0);

  const rrVals = closed.filter(t => t.rr != null).map(t => t.rr);
  const avgRR  = rrVals.length > 0 ? rrVals.reduce((a, b) => a + b, 0) / rrVals.length : null;

  const grossWin  = wins.filter(t => t.pnl != null).reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.filter(t => t.pnl != null).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;

  const avgWin  = wins.length  > 0 ? grossWin  / wins.length  : 0;
  const avgLoss = losses.length> 0 ? grossLoss / losses.length: 0;
  const expectancy = total > 0
    ? (wr / 100) * avgWin - (1 - wr / 100) * avgLoss
    : null;

  // Behavioral
  const revengeCount  = trades.filter(t => (t.mistakes||[]).includes('revenge')).length;
  const fomoCount     = trades.filter(t => (t.mistakes||[]).includes('fomo') || t.emotion === 'fomo').length;
  const noStopCount   = trades.filter(t => (t.mistakes||[]).includes('no_stop')).length;
  const oversizeCount = trades.filter(t => (t.mistakes||[]).includes('oversize')).length;

  // By setup
  const bySetup = {};
  SETUPS.forEach(s => { bySetup[s.id] = { wins: 0, total: 0 }; });
  closed.forEach(t => {
    if (!bySetup[t.setup]) bySetup[t.setup] = { wins: 0, total: 0 };
    bySetup[t.setup].total++;
    if (t.result === 'win') bySetup[t.setup].wins++;
  });

  return { total, wr, netPnl, avgRR, profitFactor, expectancy,
           revengeCount, fomoCount, noStopCount, oversizeCount, bySetup };
}

// ── Export ────────────────────────────────────────────────────────────────────

export function exportJournal() {
  if (!trades.length) { showToast('No trades to export'); return; }
  const csv  = exportJournalCSV(trades);
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'trade_journal_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}

// ── Behavioral Detection ──────────────────────────────────────────────────────

/**
 * Detects revenge trading: a losing trade immediately followed by another trade
 * with the same symbol within a short window.
 */
export function detectRevengeTrades(trades) {
  const alerts = [];
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gapMin = (curr.timestamp - prev.timestamp) / 60_000;
    if (prev.result === 'loss' && prev.sym === curr.sym && gapMin < 10) {
      alerts.push({ type: 'revenge', trade: curr, prev });
    }
  }
  return alerts;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showPanel(id) {
  document.getElementById(id)?.classList.add('show');
}
function hidePanel(id) {
  document.getElementById(id)?.classList.remove('show');
}
function showToast(msg) {
  // calls global showToast if available
  if (typeof window !== 'undefined' && window.showToast) window.showToast(msg);
}

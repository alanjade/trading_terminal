/**
 * state/persistence.js
 * Save and restore user settings from localStorage.
 */

import { state } from './store.js';

const SETTINGS_KEY  = 'settings_v2';
const COLLAPSED_KEY = 'collapsed';
const WATCHLIST_KEY = 'wl';
const JOURNAL_KEY   = 'journal_v1';
const LOCKED_SUG_KEY = 'locked_sug_v1';

// ── Settings ──────────────────────────────────────────────────────────────────

export function saveSettings() {
  try {
    const lev  = document.getElementById('lev-slider');
    const cap  = document.getElementById('inp-capital');
    const mar  = document.getElementById('inp-margin');
    const rrEl = document.getElementById('inp-rr');
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      sym:      state.sym,
      tf:       state.tf,
      exchange: state.exchange,
      leverage: lev  ? +lev.value  : state.leverage,
      capital:  cap  ? +cap.value  : 100,
      margin:   mar  ? +mar.value  : 20,
      rrRatio:  rrEl ? +rrEl.value : state.rrRatio,
      isDark:   state.isDark,
    }));
  } catch(e) {}
}

/** Returns { sym, tf, exchange } or null */
export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!s) return null;

    // Theme
    if (s.isDark === false) {
      state.isDark = false;
      document.body.classList.add('light');
      const tb = document.querySelector('.theme-btn');
      if (tb) tb.textContent = '☀️';
    }

    // Leverage
    const levSlider = document.getElementById('lev-slider');
    const levManual = document.getElementById('lev-manual');
    if (levSlider && s.leverage) levSlider.value = s.leverage;
    if (levManual && s.leverage) levManual.value = s.leverage;
    state.leverage = s.leverage || 10;

    // Capital / Margin
    const capEl = document.getElementById('inp-capital');
    const marEl = document.getElementById('inp-margin');
    if (capEl && s.capital) capEl.value = s.capital;
    if (marEl && s.margin)  marEl.value = s.margin;

    // RR ratio
    if (s.rrRatio) {
      state.rrRatio = s.rrRatio;
      const rrEl = document.getElementById('inp-rr');
      if (rrEl) rrEl.value = s.rrRatio;
    }

    return { sym: s.sym, tf: s.tf, exchange: s.exchange };
  } catch(e) { return null; }
}

// ── Collapsed card state ───────────────────────────────────────────────────────

export function saveCollapsed(id, collapsed) {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}');
    saved[id] = collapsed;
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(saved));
  } catch(e) {}
}

export function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}');
  } catch(e) { return {}; }
}

// ── Watchlist ──────────────────────────────────────────────────────────────────

export function saveWatchlist(list) {
  try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list)); } catch(e) {}
}

export function loadWatchlist() {
  try {
    return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '["BTCUSDT","ETHUSDT","SOLUSDT"]');
  } catch(e) { return ['BTCUSDT','ETHUSDT','SOLUSDT']; }
}

// ── Trade Journal ──────────────────────────────────────────────────────────────

export function saveJournal(trades) {
  try {
    // Keep last 500 trades to stay within localStorage limits
    const trimmed = trades.slice(-500);
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(trimmed));
  } catch(e) {}
}

export function loadJournal() {
  try {
    return JSON.parse(localStorage.getItem(JOURNAL_KEY) || '[]');
  } catch(e) { return []; }
}

export function exportJournalCSV(trades) {
  if (!trades.length) return null;
  const cols = ['id','timestamp','sym','dir','tf','entry','stop','target','exit','result',
                'pnl','rr','setup','emotion','mistakes','notes','score','regime'];
  const rows = [cols.join(',')];
  trades.forEach(t => rows.push([
    t.id, new Date(t.timestamp).toISOString(), t.sym, t.dir, t.tf,
    t.entry, t.stop, t.target, t.exit ?? '', t.result ?? '',
    t.pnl ?? '', t.rr ?? '', t.setup, t.emotion,
    (t.mistakes||[]).join('|'), `"${(t.notes||'').replace(/"/g,'""')}"`,
    t.score ?? '', t.regime ?? ''
  ].join(',')));
  return rows.join('\n');
}

// ── Locked Suggestion ────────────────────────────────────────────────────────
// Keyed by sym+tf so switching symbols and coming back restores the trade
// idea you were tracking, without leaking one symbol's locked entry onto
// another. `manual` flags a user-pinned suggestion (see main.js) so it's
// never silently auto-replaced.

export function saveLockedSuggestion(sym, tf, sug) {
  try {
    if (!sug) {
      const all = JSON.parse(localStorage.getItem(LOCKED_SUG_KEY) || '{}');
      delete all[`${sym}:${tf}`];
      localStorage.setItem(LOCKED_SUG_KEY, JSON.stringify(all));
      return;
    }
    const all = JSON.parse(localStorage.getItem(LOCKED_SUG_KEY) || '{}');
    all[`${sym}:${tf}`] = sug;
    // Cap stored entries so this never grows unbounded across symbols.
    const keys = Object.keys(all);
    if (keys.length > 50) delete all[keys[0]];
    localStorage.setItem(LOCKED_SUG_KEY, JSON.stringify(all));
  } catch(e) {}
}

export function loadLockedSuggestion(sym, tf) {
  try {
    const all = JSON.parse(localStorage.getItem(LOCKED_SUG_KEY) || '{}');
    return all[`${sym}:${tf}`] || null;
  } catch(e) { return null; }
}

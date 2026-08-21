/**
 * components/search.js
 * Global symbol search: quick-jump bar in topbar + screener inline filter.
 * No dependencies beyond state and helpers.
 */

import { SCR_DEFAULT_COINS, SCR_CURATED_TIERS } from '../services/screener.js';
import { fmtSym } from '../utils/helpers.js';

// ── All searchable symbols ────────────────────────────────────────────────────

const ALL_SYMBOLS = [
  ...new Set([
    ...SCR_DEFAULT_COINS,
    'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
    'AVAXUSDT','LINKUSDT','SUIUSDT','APTUSDT','TONUSDT',
    'NEARUSDT','INJUSDT','TIAUSDT','SEIUSDT','STXUSDT',
    'DOGEUSDT','SHIBUSDT','PEPEUSDT','BONKUSDT','WIFUSDT',
    'FLOKIUSDT','POPCATUSDT','MEMEUSDT',
    'ARBUSDT','OPUSDT','MATICUSDT',
    'UNIUSDT','AAVEUSDT','CRVUSDT','GMXUSDT',
    'FETUSDT','AGIXUSDT','WLDUSDT','RENDERUSDT',
    'FILUSDT','ARUSDT','HBARUSDT',
    'AXSUSDT','IMXUSDT','GALAUSDT',
    'LTCUSDT','ATOMUSDT','DOTUSDT','ADAUSDT',
    'TRXUSDT','XLMUSDT','VETUSDT','ICPUSDT',
    'LDOUSDT','MKRUSDT','COMPUSDT','SNXUSDT',
    'SANDUSDT','MANAUSDT','APEUSDT',
    'FTMUSDT','ONEUSDT','ZILUSDT',
    'JTOUSDT','PYTHUSDT','JITOUSDT','WUSDT',
    'ORDIUSDT','SATSUSDT','RUNESUSDT',
  ])
];

// ── State ─────────────────────────────────────────────────────────────────────

let _open      = false;
let _query     = '';
let _focusIdx  = -1;
let _results   = [];

// ── Init ──────────────────────────────────────────────────────────────────────

export function initSearch() {
  _injectStyles();
  _buildTopbarSearch();
  _bindGlobalShortcut();
}

// ── Topbar search bar ─────────────────────────────────────────────────────────

function _buildTopbarSearch() {
  const topbarCenter = document.querySelector('.topbar-center');
  if (!topbarCenter) return;

  const wrap = document.createElement('div');
  wrap.className = 'gs-wrap';
  wrap.innerHTML = `
    <div class="gs-input-row">
      <i class="ti ti-search gs-icon" aria-hidden="true"></i>
      <input
        id="gs-input"
        class="gs-input"
        type="text"
        placeholder="Search symbol… (Ctrl+K)"
        autocomplete="off"
        spellcheck="false"
      />
      <kbd class="gs-kbd" id="gs-kbd">Ctrl K</kbd>
    </div>
    <div id="gs-dropdown" class="gs-dropdown" role="listbox" aria-label="Symbol suggestions"></div>
  `;
  topbarCenter.appendChild(wrap);

  const input = wrap.querySelector('#gs-input');
  input.addEventListener('input', _onInput);
  input.addEventListener('keydown', _onKeydown);
  input.addEventListener('focus', () => { if (_query) _showDropdown(); });
  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) _hideDropdown();
  });
}

// ── Input handlers ────────────────────────────────────────────────────────────

function _onInput(e) {
  _query    = e.target.value.trim().toUpperCase().replace('/', '');
  _focusIdx = -1;
  if (!_query) { _hideDropdown(); return; }
  _results = _search(_query);
  _renderDropdown();
}

function _onKeydown(e) {
  if (!_open) {
    if (e.key === 'Escape') { e.target.blur(); return; }
    if (_query && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      _showDropdown(); return;
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _focusIdx = Math.min(_focusIdx + 1, _results.length - 1);
    _highlightItem();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _focusIdx = Math.max(_focusIdx - 1, 0);
    _highlightItem();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const sym = _focusIdx >= 0 ? _results[_focusIdx]?.sym : _results[0]?.sym;
    if (sym) _selectSym(sym);
  } else if (e.key === 'Escape') {
    _hideDropdown();
    e.target.blur();
  }
}

// ── Search logic ──────────────────────────────────────────────────────────────

function _search(q) {
  const base = q.endsWith('USDT') ? q : q + 'USDT';
  const results = [];

  for (const sym of ALL_SYMBOLS) {
    const ticker = sym.replace('USDT', '');
    if (sym === base || ticker === q) {
      // Exact match — put first
      results.unshift({ sym, ticker, tier: SCR_CURATED_TIERS[sym] || null, exact: true });
    } else if (sym.startsWith(base) || ticker.startsWith(q)) {
      results.push({ sym, ticker, tier: SCR_CURATED_TIERS[sym] || null, exact: false });
    }
  }

  // Secondary: contains match
  const seen = new Set(results.map(r => r.sym));
  for (const sym of ALL_SYMBOLS) {
    if (seen.has(sym)) continue;
    const ticker = sym.replace('USDT', '');
    if (ticker.includes(q)) {
      results.push({ sym, ticker, tier: SCR_CURATED_TIERS[sym] || null, exact: false });
    }
  }

  const trimmed = results.slice(0, 7);

  // Not every tradeable token is in the curated ALL_SYMBOLS list — this app
  // isn't limited to it, so if nothing curated matched exactly, offer a
  // free-form "use <TICKER>USDT" option that just hands the raw symbol
  // straight to the exchange. If it's not a real pair, the kline fetch will
  // fail with a normal error toast — same as typing a bad symbol anywhere else.
  const hasExact = trimmed.some(r => r.exact);
  if (!hasExact && q.length >= 2) {
    trimmed.push({ sym: base, ticker: q, tier: null, exact: false, freeform: true });
  }

  return trimmed;
}

// ── Dropdown rendering ────────────────────────────────────────────────────────

function _renderDropdown() {
  const dd = document.getElementById('gs-dropdown');
  if (!dd) return;

  if (!_results.length) {
    dd.innerHTML = `<div class="gs-empty">No results for "${_query}"</div>`;
    _showDropdown();
    return;
  }

  dd.innerHTML = _results.map((r, i) => {
    const active = i === _focusIdx ? ' gs-item--active' : '';

    if (r.freeform) {
      return `
        <div class="gs-item gs-item--freeform${active}" role="option" data-sym="${r.sym}" data-idx="${i}">
          <span class="gs-ticker">${r.ticker}</span>
          <span class="gs-pair">/USDT</span>
          <span class="gs-freeform-tag">not in curated list — try it anyway</span>
        </div>
      `;
    }

    const tierBadge = r.tier
      ? `<span class="gs-tier gs-tier--${r.tier.toLowerCase()}">${r.tier}</span>`
      : '';
    return `
      <div class="gs-item${active}" role="option" data-sym="${r.sym}" data-idx="${i}">
        <span class="gs-ticker">${r.ticker}</span>
        <span class="gs-pair">/USDT</span>
        ${tierBadge}
      </div>
    `;
  }).join('');

  dd.querySelectorAll('.gs-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      _selectSym(el.dataset.sym);
    });
    el.addEventListener('mouseenter', () => {
      _focusIdx = +el.dataset.idx;
      _highlightItem();
    });
  });

  _showDropdown();
}

function _highlightItem() {
  const dd = document.getElementById('gs-dropdown');
  if (!dd) return;
  dd.querySelectorAll('.gs-item').forEach((el, i) => {
    el.classList.toggle('gs-item--active', i === _focusIdx);
  });
}

function _showDropdown() {
  _open = true;
  const dd = document.getElementById('gs-dropdown');
  const kbd = document.getElementById('gs-kbd');
  if (dd) dd.classList.add('gs-dropdown--open');
  if (kbd) kbd.style.display = 'none';
}

function _hideDropdown() {
  _open = false;
  const dd = document.getElementById('gs-dropdown');
  const kbd = document.getElementById('gs-kbd');
  if (dd) dd.classList.remove('gs-dropdown--open');
  if (kbd) kbd.style.display = '';
}

function _selectSym(sym) {
  const input = document.getElementById('gs-input');
  if (input) input.value = '';
  _query    = '';
  _focusIdx = -1;
  _results  = [];
  _hideDropdown();

  // Delegate to main.js global
  if (window.loadCoinFromScreener) {
    window.loadCoinFromScreener(sym);
  }
}

// ── Ctrl+K global shortcut ────────────────────────────────────────────────────

function _bindGlobalShortcut() {
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const input = document.getElementById('gs-input');
      if (input) {
        input.focus();
        input.select();
      }
    }
  });
}

// ── Screener inline filter ────────────────────────────────────────────────────

/**
 * Injects a text filter row inside the screener card body.
 * Call after screener card HTML exists in DOM.
 */
export function initScreenerFilter() {
  const controls = document.querySelector('#card-screener .scr-controls');
  if (!controls || document.getElementById('scr-text-filter')) return;

  const row = document.createElement('div');
  row.style.cssText = 'width:100%;display:flex;align-items:center;gap:6px;margin-bottom:8px';
  row.innerHTML = `
    <div style="position:relative;flex:1">
      <i class="ti ti-search" aria-hidden="true"
        style="position:absolute;left:8px;top:50%;transform:translateY(-50%);
               font-size:13px;color:var(--text3);pointer-events:none"></i>
      <input
        id="scr-text-filter"
        class="input-field"
        type="text"
        placeholder="Filter results…"
        autocomplete="off"
        style="padding-left:28px;height:28px;font-size:10px"
      />
    </div>
    <button
      id="scr-filter-clear"
      class="btn btn--icon"
      title="Clear filter"
      style="display:none;padding:3px 7px"
      onclick="clearScreenerFilter()"
    >✕</button>
  `;

  controls.insertAdjacentElement('afterend', row);

  const input = document.getElementById('scr-text-filter');
  input.addEventListener('input', () => {
    const val = input.value.trim();
    const clearBtn = document.getElementById('scr-filter-clear');
    if (clearBtn) clearBtn.style.display = val ? '' : 'none';
    if (window.renderScreenerTable) window.renderScreenerTable();
  });
}

/** Returns the current screener text filter value (upper-cased). */
export function getScreenerTextFilter() {
  const el = document.getElementById('scr-text-filter');
  return el ? el.value.trim().toUpperCase() : '';
}

// ── Styles ────────────────────────────────────────────────────────────────────

function _injectStyles() {
  if (document.getElementById('gs-styles')) return;
  const s = document.createElement('style');
  s.id = 'gs-styles';
  s.textContent = `
.gs-wrap {
  position: relative;
  width: 200px;
}
.gs-input-row {
  display: flex;
  align-items: center;
  background: var(--bg3);
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  padding: 0 8px;
  gap: 6px;
  height: 30px;
  transition: border-color 0.15s;
}
.gs-input-row:focus-within {
  border-color: var(--accent);
}
.gs-icon {
  font-size: 13px;
  color: var(--text3);
  flex-shrink: 0;
}
.gs-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text);
  min-width: 0;
}
.gs-input::placeholder { color: var(--text3); }
.gs-kbd {
  font-family: var(--mono);
  font-size: 8px;
  color: var(--text3);
  background: var(--bg4);
  border: 1px solid var(--border2);
  border-radius: 3px;
  padding: 1px 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.gs-dropdown {
  display: none;
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  width: 220px;
  background: var(--bg2);
  border: 1px solid var(--border2);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  z-index: 500;
  overflow: hidden;
}
.gs-dropdown--open { display: block; }
.gs-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 10px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}
.gs-item:last-child { border-bottom: none; }
.gs-item:hover, .gs-item--active {
  background: var(--bg3);
}
.gs-item--freeform { opacity: 0.85; }
.gs-freeform-tag {
  margin-left: auto;
  font-size: 8px;
  color: var(--text3);
  font-style: italic;
  white-space: nowrap;
}
.gs-ticker { font-weight: 700; }
.gs-pair   { color: var(--text3); font-size: 9px; }
.gs-tier {
  margin-left: auto;
  font-size: 8px;
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.gs-tier--t1   { background: rgba(0,229,160,0.12); color: var(--green); border: 1px solid rgba(0,229,160,0.25); }
.gs-tier--t2   { background: rgba(77,166,255,0.1);  color: var(--blue);  border: 1px solid rgba(77,166,255,0.2); }
.gs-tier--meme { background: rgba(167,139,255,0.1); color: var(--purple); border: 1px solid rgba(167,139,255,0.2); }
.gs-tier--defi { background: rgba(255,184,46,0.1);  color: var(--amber); border: 1px solid rgba(255,184,46,0.2); }
.gs-tier--l2   { background: rgba(255,107,53,0.1);  color: var(--orange); border: 1px solid rgba(255,107,53,0.2); }
.gs-tier--ai   { background: rgba(0,229,160,0.08);  color: var(--green); border: 1px solid rgba(0,229,160,0.15); }
.gs-tier--infra,.gs-tier--game,.gs-tier--cex {
  background: rgba(255,255,255,0.05); color: var(--text2);
  border: 1px solid var(--border2);
}
.gs-empty {
  padding: 12px 10px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text3);
  text-align: center;
}
`;
  document.head.appendChild(s);
}
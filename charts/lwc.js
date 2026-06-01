/**
 * charts/lwc.js
 * LightweightCharts-based chart manager.
 */

const LW = () => window.LightweightCharts;

const DARK = {
  bg: '#0b0e17', bg2: '#111520',
  grid: 'rgba(255,255,255,0.04)', text: 'rgba(255,255,255,0.5)',
  border: 'rgba(255,255,255,0.08)',
  green: '#00e5a0', red: '#ff3d5a', amber: '#ffb82e',
  blue: '#4da6ff', purple: '#a78bff',
  ema9: '#ff6b35', ema20: '#4da6ff', ema50: '#a78bff',
  vwap: 'rgba(240,224,64,0.85)', avwap: 'rgba(167,139,255,0.85)',
};

const LIGHT = {
  bg: '#f0f2f8', bg2: '#ffffff',
  grid: 'rgba(0,0,0,0.05)', text: 'rgba(0,0,0,0.45)',
  border: 'rgba(0,0,0,0.10)',
  green: '#00a870', red: '#e0253a', amber: '#d4930a',
  blue: '#2070c8', purple: '#7050d0',
  ema9: '#d44010', ema20: '#2070c8', ema50: '#7050d0',
  vwap: 'rgba(140,110,0,0.85)', avwap: 'rgba(100,70,200,0.85)',
};

export const TOOL = {
  NONE: 'none', TRENDLINE: 'trendline',
  HRAY: 'hray', FIB: 'fib', RECT: 'rect', NOTE: 'note',
};

export class LWCChart {
  constructor(containerId, options = {}) {
    this.containerId  = containerId;
    this.theme        = options.theme || 'dark';
    this.onCrosshair  = options.onCrosshair || null;
    this._charts      = {};
    this._series      = {};
    this._drawings    = [];
    this._activeTool  = TOOL.NONE;
    this._drawingStart= null;
    this._tempLine    = null;
    this._pricelines  = {};
    this._markers     = [];
    this._init();
  }

  get C() { return this.theme === 'dark' ? DARK : LIGHT; }

  _init() {
    const container = document.getElementById(this.containerId);
    if (!container || !LW()) {
      console.warn('[LWCChart] container or LightweightCharts not found');
      return;
    }
    container.innerHTML = '';
    container.style.position = 'relative';

    this._priceEl = this._pane(container, 'lwc-price', 320);
    this._rsiEl   = this._pane(container, 'lwc-rsi',   70);
    this._volEl   = this._pane(container, 'lwc-vol',   44);
    this._cvdEl   = this._pane(container, 'lwc-cvd',   60);

    this._charts.price = this._createChart(this._priceEl, 320, true);
    this._charts.rsi   = this._createChart(this._rsiEl,   70,  false);
    this._charts.vol   = this._createChart(this._volEl,   44,  false);
    this._charts.cvd   = this._createChart(this._cvdEl,   60,  false);

    const C = this.C;
    this._series.candles = this._charts.price.addCandlestickSeries({
      upColor: C.green, downColor: C.red,
      borderUpColor: C.green, borderDownColor: C.red,
      wickUpColor: C.green, wickDownColor: C.red,
    });

    this._series.ema9  = this._addLine(this._charts.price, C.ema9,   1.5);
    this._series.ema20 = this._addLine(this._charts.price, C.ema20,  1.5);
    this._series.ema50 = this._addLine(this._charts.price, C.ema50,  1.5);
    this._series.vwap  = this._addLine(this._charts.price, C.vwap,   1.5);
    this._series.avwap = this._addLine(this._charts.price, C.avwap,  1.5, [4, 3]);

    this._series.rsi = this._charts.rsi.addLineSeries({
      color: C.purple, lineWidth: 1.5, priceScaleId: 'right',
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    });
    this._addRSIBands();

    this._series.vol = this._charts.vol.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceScaleId: 'right',
    });

    this._series.cvd = this._charts.cvd.addHistogramSeries({ priceScaleId: 'right' });
    this._series.cvdEma = this._addLine(this._charts.cvd, C.amber, 1.2);

    this._syncCrosshairs();
    this._buildToolbar(container);
    this._bindDrawingEvents();

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
  }

  _pane(parent, id, height) {
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = `width:100%;height:${height}px;position:relative;`;
    parent.appendChild(el);
    return el;
  }

  _createChart(el, height, hasTimeScale) {
    const C = this.C;
    return LW().createChart(el, {
      width:  el.parentElement?.clientWidth || 800,
      height,
      layout: {
        background: { type: 'solid', color: C.bg },
        textColor: C.text,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: C.grid, style: 1 },
        horzLines: { color: C.grid, style: 1 },
      },
      crosshair: {
        mode: LW().CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.15)', labelBackgroundColor: C.bg2 },
        horzLine: { color: 'rgba(255,255,255,0.15)', labelBackgroundColor: C.bg2 },
      },
      rightPriceScale: {
        borderColor: C.border, textColor: C.text,
        scaleMargins: { top: 0.08, bottom: 0.05 },
      },
      timeScale: {
        visible: hasTimeScale,
        borderColor: C.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: t => {
          const d = new Date(t * 1000);
          return `${d.getUTCHours().toString().padStart(2,'0')}:${d.getUTCMinutes().toString().padStart(2,'0')}`;
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
    });
  }

  _addLine(chart, color, lineWidth, lineDash) {
    const opts = { color, lineWidth, priceScaleId: 'right', lastValueVisible: false, priceLineVisible: false };
    if (lineDash) opts.lineDashPattern = lineDash;
    return chart.addLineSeries(opts);
  }

  _addRSIBands() {
    const C = this.C;
    [70, 50, 30].forEach(v => {
      const s = this._charts.rsi.addLineSeries({
        color: v === 50 ? 'rgba(255,255,255,0.12)' : v === 70 ? 'rgba(255,61,90,0.3)' : 'rgba(0,229,160,0.3)',
        lineWidth: 1,
        lineStyle: 2,
        priceScaleId: 'right',
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      s._rsiBand = v;
      if (!this._series.rsiBands) this._series.rsiBands = [];
      this._series.rsiBands.push(s);
    });
  }

  setData(candles, indicators = {}) {
    if (!candles?.length) return;
    const toTime = c => Math.floor(c.t / 1000);

    this._series.candles.setData(candles.map(c => ({
      time: toTime(c), open: c.o, high: c.h, low: c.l, close: c.c,
    })));

    this._setLineData(this._series.ema9,  candles, indicators.e9s);
    this._setLineData(this._series.ema20, candles, indicators.e20s);
    this._setLineData(this._series.ema50, candles, indicators.e50s);
    this._setLineData(this._series.vwap,  candles, indicators.vwapVals);
    this._setLineData(this._series.avwap, candles, indicators.avwapVals);
    this._setLineData(this._series.rsi,   candles, indicators.rsiVals);

    if (this._series.rsiBands) {
      this._series.rsiBands.forEach(s => {
        s.setData(candles.map(c => ({ time: toTime(c), value: s._rsiBand })));
      });
    }

    const C = this.C;
    this._series.vol.setData(candles.map(c => ({
      time: toTime(c), value: c.v,
      color: c.c >= c.o ? C.green + '80' : C.red + '80',
    })));

    this._setCVDData(candles, indicators.cvdVals, indicators.cvdEmaVals);
    this._charts.price.timeScale().fitContent();
  }

  _setLineData(series, candles, vals) {
    if (!vals?.length) return;
    const toTime = c => Math.floor(c.t / 1000);
    const offset = candles.length - vals.length;
    const data = [];
    vals.forEach((v, i) => {
      if (v !== null && v !== undefined) {
        data.push({ time: toTime(candles[i + offset]), value: v });
      }
    });
    series.setData(data);
  }

  _setCVDData(candles, cvdVals, cvdEmaVals) {
    if (!cvdVals?.length) return;
    const C = this.C;
    const toTime = c => Math.floor(c.t / 1000);
    const offset = candles.length - cvdVals.length;
    this._series.cvd.setData(cvdVals.map((v, i) => ({
      time:  toTime(candles[i + offset]),
      value: v,
      color: v >= 0 ? C.green + '88' : C.red + '88',
    })));
    if (cvdEmaVals?.length) {
      this._setLineData(this._series.cvdEma, candles, cvdEmaVals);
    }
  }

  updateLiveCandle(candle) {
    if (!candle) return;
    const t = Math.floor(candle.t / 1000);
    this._series.candles.update({ time: t, open: candle.o, high: candle.h, low: candle.l, close: candle.c });
    if (candle._liveVwap)           this._series.vwap.update({ time: t, value: candle._liveVwap });
    if (candle._liveAvwap != null)  this._series.avwap.update({ time: t, value: candle._liveAvwap });
    if (candle._liveRsi != null)    this._series.rsi.update({ time: t, value: candle._liveRsi });
    const C = this.C;
    if (candle._liveCvd != null) {
      this._series.cvd.update({ time: t, value: candle._liveCvd, color: candle._liveCvd >= 0 ? C.green + '88' : C.red + '88' });
    }
  }

  setSuggestion(sug) {
    if (!sug?.entry) return;
    this._removePriceLines(['entry','stop','target','tp1','tp2','tp3']);
    const C = this.C;
    const isLong = sug.dir === 'long';

    const add = (key, price, color, title, dash) => {
      if (!price) return;
      this._pricelines[key] = this._series.candles.createPriceLine({
        price, color, title,
        lineWidth: 1,
        lineStyle: dash ? LW().LineStyle.Dashed : LW().LineStyle.Solid,
        axisLabelVisible: true,
        axisLabelColor: color,
        axisLabelTextColor: '#fff',
      });
    };

    add('entry',  sug.entry,  C.blue,  'ENT',  false);
    add('stop',   sug.stop,   C.red,   'SL',   true);
    add('target', sug.target, C.green, 'TP',   true);

    if (sug.entry && sug.stop) {
      const risk = Math.abs(sug.entry - sug.stop);
      [1,2,3].forEach(n => {
        const tp = isLong ? sug.entry + risk * n : sug.entry - risk * n;
        add(`tp${n}`, tp, C.green + 'aa', `TP${n}`, true);
      });
    }
  }

  clearSuggestion() {
    this._removePriceLines(['entry','stop','target','tp1','tp2','tp3']);
  }

  setSessionLevels(levels) {
    this._removePriceLines(['pdh','pdl']);
    const C = this.C;
    if (levels?.prevHigh) this._pricelines.pdh = this._series.candles.createPriceLine({ price: levels.prevHigh, color: C.amber + 'aa', title: 'PDH', lineWidth: 1, lineStyle: LW().LineStyle.Dashed, axisLabelVisible: true });
    if (levels?.prevLow)  this._pricelines.pdl = this._series.candles.createPriceLine({ price: levels.prevLow,  color: C.amber + '77', title: 'PDL', lineWidth: 1, lineStyle: LW().LineStyle.Dashed, axisLabelVisible: true });
  }

  setStructureEvents(candles, events) {
    if (!events?.length || !candles?.length) return;
    const toTime = c => Math.floor(c.t / 1000);
    const C = this.C;
    const markers = events.slice(-8).map(ev => {
      const c = candles[ev.idx];
      if (!c) return null;
      return {
        time:     toTime(c),
        position: ev.dir === 'bull' ? 'belowBar' : 'aboveBar',
        color:    ev.dir === 'bull' ? C.green : C.red,
        shape:    ev.type === 'BOS' ? 'arrowUp' : 'circle',
        text:     ev.type + (ev.dir === 'bull' ? '↑' : '↓'),
        size:     1,
      };
    }).filter(Boolean);
    this._series.candles.setMarkers(markers);
    this._markers = markers;
  }

  setTheme(theme) {
    this.theme = theme;
    const C = this.C;
    const layout = { background: { type: 'solid', color: C.bg }, textColor: C.text };
    const grid   = { vertLines: { color: C.grid }, horzLines: { color: C.grid } };
    Object.values(this._charts).forEach(ch => ch.applyOptions({ layout, grid }));
    this._series.candles.applyOptions({ upColor: C.green, downColor: C.red, borderUpColor: C.green, borderDownColor: C.red, wickUpColor: C.green, wickDownColor: C.red });
    this._series.ema9.applyOptions({ color: C.ema9 });
    this._series.ema20.applyOptions({ color: C.ema20 });
    this._series.ema50.applyOptions({ color: C.ema50 });
    this._series.vwap.applyOptions({ color: C.vwap });
    this._series.avwap.applyOptions({ color: C.avwap });
    this._series.rsi.applyOptions({ color: C.purple });
    this._series.cvdEma.applyOptions({ color: C.amber });
  }

  setTool(tool) {
    this._activeTool = tool;
    this._drawingStart = null;
    const container = document.getElementById(this.containerId);
    if (container) container.style.cursor = tool === TOOL.NONE ? 'default' : 'crosshair';
    document.querySelectorAll('.lwc-tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
  }

  _buildToolbar(container) {
    const bar = document.createElement('div');
    bar.className = 'lwc-toolbar';
    bar.style.cssText = `
      position:absolute; top:6px; left:8px; z-index:10;
      display:flex; gap:4px; align-items:center;
      background:rgba(17,21,32,0.92); border:1px solid rgba(255,255,255,0.08);
      border-radius:6px; padding:3px 5px;
      font-family:'JetBrains Mono',monospace; font-size:10px;
    `;

    const tools = [
      { tool: TOOL.NONE,      label: '✕', title: 'Select (Esc)' },
      { tool: TOOL.TRENDLINE, label: '╱', title: 'Trendline (T)' },
      { tool: TOOL.HRAY,      label: '—', title: 'Horizontal Ray (H)' },
      { tool: TOOL.FIB,       label: '≋', title: 'Fib Retracement (F)' },
      { tool: TOOL.RECT,      label: '▭', title: 'Rectangle (R)' },
      { tool: TOOL.NOTE,      label: '✎', title: 'Note (N)' },
    ];

    tools.forEach(({ tool, label, title }) => {
      const btn = document.createElement('button');
      btn.className = 'lwc-tool-btn';
      btn.dataset.tool = tool;
      btn.title = title;
      btn.textContent = label;
      btn.style.cssText = `background:transparent; border:1px solid transparent; border-radius:4px; color:rgba(255,255,255,0.5); cursor:pointer; padding:3px 7px; font-family:inherit; font-size:11px; transition:all 0.15s;`;
      btn.addEventListener('mouseenter', () => { if (!btn.classList.contains('active')) btn.style.color = '#fff'; });
      btn.addEventListener('mouseleave', () => { if (!btn.classList.contains('active')) btn.style.color = 'rgba(255,255,255,0.5)'; });
      btn.addEventListener('click', () => this.setTool(tool));
      bar.appendChild(btn);
    });

    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:16px;background:rgba(255,255,255,0.1);margin:0 3px';
    bar.appendChild(sep);

    const clearBtn = document.createElement('button');
    clearBtn.title = 'Clear all drawings';
    clearBtn.textContent = '🗑';
    clearBtn.style.cssText = `background:transparent; border:1px solid transparent; border-radius:4px; color:rgba(255,61,90,0.6); cursor:pointer; padding:3px 7px; font-family:inherit; font-size:11px;`;
    clearBtn.addEventListener('click', () => this.clearDrawings());
    bar.appendChild(clearBtn);

    container.style.position = 'relative';
    container.insertBefore(bar, container.firstChild);

    const style = document.createElement('style');
    style.textContent = `.lwc-tool-btn.active { background:rgba(0,229,160,0.15)!important; border-color:rgba(0,229,160,0.3)!important; color:#00e5a0!important; }`;
    document.head.appendChild(style);
  }

  _bindDrawingEvents() {
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const k = e.key.toUpperCase();
      if (k === 'ESCAPE') this.setTool(TOOL.NONE);
      if (k === 'T') this.setTool(TOOL.TRENDLINE);
      if (k === 'H') this.setTool(TOOL.HRAY);
      if (k === 'F') this.setTool(TOOL.FIB);
      if (k === 'N') this.setTool(TOOL.NOTE);
    });

    if (!this._priceEl) return;

    this._priceEl.addEventListener('click', e => {
      if (this._activeTool === TOOL.NONE) return;
      const rect  = this._priceEl.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._handleDrawClick(point);
    });

    this._priceEl.addEventListener('mousemove', e => {
      if (this._activeTool === TOOL.NONE || !this._drawingStart) return;
      const rect  = this._priceEl.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this._updateTempDrawing(point);
    });
  }

  _handleDrawClick(point) {
    const price = this._priceToValue(point.y);
    const time  = this._xToTime(point.x);

    if (this._activeTool === TOOL.HRAY) {
      this._addHRay(price);
      return;
    }
    if (this._activeTool === TOOL.NOTE) {
      const text = prompt('Note:');
      if (text) this._addNote(time, price, text);
      return;
    }
    if (!this._drawingStart) {
      this._drawingStart = { price, time, x: point.x, y: point.y };
      return;
    }
    const start = this._drawingStart;
    this._drawingStart = null;
    this._clearTempDrawing();

    if (this._activeTool === TOOL.TRENDLINE) this._addTrendline(start, { price, time });
    if (this._activeTool === TOOL.FIB)       this._addFib(start.price, price);
    if (this._activeTool === TOOL.RECT)      this._addRect(start, { price, time });
  }

  _updateTempDrawing(point) {
    const price = this._priceToValue(point.y);
    if (this._tempLine) {
      try { this._series.candles.removePriceLine(this._tempLine); } catch(e) {}
    }
    this._tempLine = this._series.candles.createPriceLine({
      price, color: 'rgba(255,255,255,0.25)', title: '', lineWidth: 1,
      lineStyle: LW().LineStyle.Dashed, axisLabelVisible: false,
    });
  }

  _clearTempDrawing() {
    if (this._tempLine) {
      try { this._series.candles.removePriceLine(this._tempLine); } catch(e) {}
      this._tempLine = null;
    }
  }

  _addHRay(price) {
    const C = this.C;
    const line = this._series.candles.createPriceLine({
      price, color: C.amber + 'cc',
      title: `H ${price.toFixed(2)}`,
      lineWidth: 1, lineStyle: LW().LineStyle.Dashed,
      axisLabelVisible: true, draggable: true,
    });
    this._drawings.push({ type: TOOL.HRAY, line });
  }

  _addTrendline(start, end) {
    const C = this.C;
    const s = this._charts.price.addLineSeries({
      color: C.blue + 'cc', lineWidth: 1,
      lineStyle: LW().LineStyle.Solid,
      priceScaleId: 'right',
      lastValueVisible: false, priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    s.setData([
      { time: start.time, value: start.price },
      { time: end.time,   value: end.price   },
    ]);
    this._drawings.push({ type: TOOL.TRENDLINE, series: s, start, end });
  }

  _addFib(highPrice, lowPrice) {
    const C = this.C;
    const hi = Math.max(highPrice, lowPrice);
    const lo = Math.min(highPrice, lowPrice);
    const range = hi - lo;
    const levels = [
      { r: 0,     color: C.text },
      { r: 0.236, color: C.amber + 'cc' },
      { r: 0.382, color: C.green + 'cc' },
      { r: 0.5,   color: C.blue  + 'cc' },
      { r: 0.618, color: C.purple+ 'cc' },
      { r: 1,     color: C.text },
    ];
    const lines = levels.map(({ r, color }) => {
      const price = hi - range * r;
      return this._series.candles.createPriceLine({
        price, color, title: `${(r * 100).toFixed(1)}%`,
        lineWidth: 1, lineStyle: LW().LineStyle.Dashed,
        axisLabelVisible: true,
      });
    });
    this._drawings.push({ type: TOOL.FIB, lines });
  }

  _addRect(start, end) {
    const C = this.C;
    [start.price, end.price].forEach(price => {
      const line = this._series.candles.createPriceLine({
        price, color: C.blue + '66', title: '',
        lineWidth: 1, lineStyle: LW().LineStyle.Dotted, axisLabelVisible: false,
      });
      this._drawings.push({ type: TOOL.RECT, line });
    });
  }

  _addNote(time, price, text) {
    const C = this.C;
    this._series.candles.setMarkers([
      ...this._markers,
      { time, position: 'aboveBar', color: C.amber, shape: 'text', text, size: 1 },
    ]);
  }

  clearDrawings() {
    this._drawings.forEach(d => {
      try {
        if (d.line)   this._series.candles.removePriceLine(d.line);
        if (d.series) this._charts.price.removeSeries(d.series);
        if (d.lines)  d.lines.forEach(l => this._series.candles.removePriceLine(l));
      } catch(e) {}
    });
    this._drawings = [];
    this._series.candles.setMarkers(this._markers);
  }

  _removePriceLines(keys) {
    keys.forEach(k => {
      if (this._pricelines[k]) {
        try { this._series.candles.removePriceLine(this._pricelines[k]); } catch(e) {}
        delete this._pricelines[k];
      }
    });
  }

  _priceToValue(y) {
    return this._series.candles.coordinateToPrice(y) || 0;
  }

  _xToTime(x) {
    return this._charts.price.timeScale().coordinateToTime(x) || 0;
  }

  _syncCrosshairs() {
    const charts = [this._charts.price, this._charts.rsi, this._charts.vol, this._charts.cvd];

    charts.forEach((ch, i) => {
      ch.subscribeCrosshairMove(param => {
        if (!param.time) return;
        charts.forEach((other, j) => {
          if (i === j) return;
          try {
            const x = other.timeScale().timeToCoordinate(param.time);
            if (x !== null) {
              // Use setCrosshairPosition (correct API) with a dummy price
              other.setCrosshairPosition(NaN, param.time, other.series?.[0] || null);
            }
          } catch(e) {}
        });
        if (this.onCrosshair) this.onCrosshair(param);
      });
    });

    this._charts.price.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (!range) return;
      [this._charts.rsi, this._charts.vol, this._charts.cvd].forEach(ch => {
        try { ch.timeScale().setVisibleLogicalRange(range); } catch(e) {}
      });
    });
  }

  _resize() {
    const container = document.getElementById(this.containerId);
    if (!container) return;
    const w = container.clientWidth;
    Object.values(this._charts).forEach(ch => {
      try { ch.applyOptions({ width: w }); } catch(e) {}
    });
  }

  destroy() {
    this._ro?.disconnect();
    Object.values(this._charts).forEach(ch => { try { ch.remove(); } catch(e) {} });
    this._charts = {};
    this._series = {};
  }
}

export function initChartManager(containerId, options = {}) {
  if (window.LightweightCharts) return new LWCChart(containerId, options);
  console.warn('[ChartManager] LightweightCharts not loaded — falling back to canvas');
  return null;
}
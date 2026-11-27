const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SimCore = require('../sim-core.js');

// 從 index.html 載入實際的介面腳本，以最小 DOM 測試說明頁行為；store 為 localStorage 的初始內容
function loadUiHarness(store = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const match = html.match(/<script>\r?\n([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html should contain inline <script>');

  const elements = new Map();
  let activeElement = null;
  const docListeners = {};

  const makeClassList = () => {
    const set = new Set();
    return {
      add: (...cls) => cls.forEach((c) => set.add(c)),
      remove: (...cls) => cls.forEach((c) => set.delete(c)),
      toggle: (c, force) => {
        const next = force === undefined ? !set.has(c) : Boolean(force);
        if (next) set.add(c);
        else set.delete(c);
        return next;
      },
      contains: (c) => set.has(c),
    };
  };

  const noopProxy = new Proxy(() => {}, {
    get: () => noopProxy,
    set: () => true,
    apply: () => noopProxy,
  });

  const makeEl = (id, tagName = 'DIV') => {
    const el = {
      id,
      tagName,
      textContent: '',
      innerHTML: '',
      value: '',
      hidden: false,
      disabled: false,
      checked: true,
      isContentEditable: false,
      clientWidth: 800,
      clientHeight: 600,
      style: {},
      dataset: {},
      classList: makeClassList(),
      focus: () => { activeElement = el; },
      blur: () => { if (activeElement === el) activeElement = null; },
      addEventListener: () => {},
      getContext: () => noopProxy,
      setCustomValidity: () => {},
      reportValidity: () => true,
      checkValidity: () => true,
    };
    return el;
  };

  const tagForId = {
    qty: 'INPUT',
    'custom-speed': 'INPUT',
    'new-seed': 'INPUT',
    'new-price': 'INPUT',
    'new-cash': 'INPUT',
    'new-monthly': 'INPUT',
    'new-date': 'INPUT',
    'show-buyHold': 'INPUT',
    'show-dca': 'INPUT',
    'report-show-buyHold': 'INPUT',
    'report-show-dca': 'INPUT',
    play: 'BUTTON',
    buy: 'BUTTON',
    sell: 'BUTTON',
    lot: 'BUTTON',
    'all-in': 'BUTTON',
    'all-shares': 'BUTTON',
    'custom-speed-btn': 'BUTTON',
    'report-btn': 'BUTTON',
    'report-close': 'BUTTON',
  };

  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id, tagForId[id] || 'DIV'));
    return elements.get(id);
  };

  // 初始化關鍵元素的初始狀態（對齊 index.html 靜態 HTML）
  for (const id of ['notice', 'expired', 'restart-page', 'intro-page', 'latest', 'report', 'report-open', 'fill-toast']) {
    getEl(id).hidden = true;
  }
  getEl('play').textContent = '暫停';
  getEl('qty').value = '1000';
  getEl('custom-speed').value = '100';
  getEl('order').dataset.side = 'buy';

  const speedButtons = ['1', '5', '50'].map((s) => {
    const btn = makeEl(`speed-${s}`, 'BUTTON');
    btn.dataset.speed = s;
    if (s === '1') btn.classList.add('active');
    return btn;
  });

  const body = makeEl('body', 'BODY');
  activeElement = body;

  const sandbox = {
    SimCore,
    document: {
      body,
      get activeElement() { return activeElement; },
      getElementById: getEl,
      querySelector: (sel) => getEl(sel),
      querySelectorAll: (sel) => (sel === '[data-speed]' ? speedButtons : []),
      addEventListener: (type, fn) => {
        if (!docListeners[type]) docListeners[type] = [];
        docListeners[type].push(fn);
      },
    },
    window: {
      devicePixelRatio: 1,
      addEventListener: () => {},
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    requestAnimationFrame: () => 0,
    setTimeout: () => 1,
    clearTimeout: () => {},
    WheelEvent: { DOM_DELTA_LINE: 1 },
    Math,
    Number,
    Date,
    Set,
    Array,
    Object,
    JSON,
    Boolean,
    String,
  };
  sandbox.self = sandbox;

  vm.runInNewContext(match[1], sandbox, { filename: 'index.html' });

  const dispatchKey = (key, opts = {}) => {
    const event = {
      key,
      code: opts.code || (key === ' ' ? 'Space' : ''),
      target: opts.target || activeElement || body,
      ctrlKey: Boolean(opts.ctrlKey),
      metaKey: Boolean(opts.metaKey),
      altKey: Boolean(opts.altKey),
      isComposing: Boolean(opts.isComposing),
      repeat: Boolean(opts.repeat),
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const fn of docListeners.keydown || []) fn(event);
    return event;
  };

  return {
    el: (id) => getEl(id),
    speedBtn: (s) => speedButtons.find((b) => b.dataset.speed === String(s)),
    get activeElement() { return activeElement; },
    focus: (el) => { activeElement = el; },
    makeEl,
    body,
    dispatchKey,
  };
}

test('第一次進入（沒有存檔也沒看過說明）時自動開啟說明頁並暫停行情', () => {
  const ui = loadUiHarness();
  assert.equal(ui.el('intro-page').hidden, false);
  assert.equal(ui.el('play').textContent, '播放');
});

test('按「開始」關閉說明頁、記錄已看過並開始播放', () => {
  const store = {};
  const ui = loadUiHarness(store);
  ui.el('intro-start').onclick();
  assert.equal(ui.el('intro-page').hidden, true);
  assert.equal(store['stock-sim-intro-seen'], '1');
  assert.equal(ui.el('play').textContent, '暫停');
});

test('Esc 也能關閉說明頁並記錄已看過', () => {
  const store = {};
  const ui = loadUiHarness(store);
  ui.dispatchKey('Escape');
  assert.equal(ui.el('intro-page').hidden, true);
  assert.equal(store['stock-sim-intro-seen'], '1');
});

test('看過說明後再次進入不會自動開啟', () => {
  const ui = loadUiHarness({ 'stock-sim-intro-seen': '1' });
  assert.equal(ui.el('intro-page').hidden, true);
  assert.equal(ui.el('play').textContent, '暫停');
});

test('說明頁開啟時空白鍵、倍速與 B／S 快捷鍵不作用', () => {
  const ui = loadUiHarness();
  ui.dispatchKey(' ', { code: 'Space' });
  ui.dispatchKey('3');
  ui.dispatchKey('s');
  assert.equal(ui.el('play').textContent, '播放');
  assert.equal(ui.speedBtn(1).classList.contains('active'), true);
  assert.equal(ui.el('order').dataset.side, 'buy');
  assert.equal(ui.el('intro-page').hidden, false);
});

test('按「說明」可再次開啟；暫停中開啟的，關閉後維持暫停', () => {
  const ui = loadUiHarness({ 'stock-sim-intro-seen': '1' });
  ui.el('play').onclick();
  assert.equal(ui.el('play').textContent, '播放');
  ui.el('help-btn').onclick();
  assert.equal(ui.el('intro-page').hidden, false);
  ui.el('intro-start').onclick();
  assert.equal(ui.el('intro-page').hidden, true);
  assert.equal(ui.el('play').textContent, '播放');
});

test('說明頁內容涵蓋模擬真實波動、驗證策略與自動存檔', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const intro = html.match(/<div id="intro-page"[\s\S]*?<button id="intro-start">/);
  assert.ok(intro);
  assert.match(intro[0], /模擬真實市場的波動/);
  assert.match(intro[0], /驗證你的交易策略/);
  assert.match(intro[0], /自動存/);
  assert.match(intro[0], /隨時回來/);
});

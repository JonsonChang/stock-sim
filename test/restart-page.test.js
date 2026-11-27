const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SimCore = require('../sim-core.js');

// 從 index.html 載入實際的介面腳本，以最小 DOM 測試重新開局頁面行為
function loadUiHarness() {
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
    localStorage: { getItem: (k) => (k === 'stock-sim-intro-seen' ? '1' : null), setItem: () => {} }, // 已看過說明頁，避免說明頁暫停行情
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

test('按「重新開局」開啟全畫面頁面並自動暫停', () => {
  const ui = loadUiHarness();
  const page = ui.el('restart-page');
  assert.equal(page.hidden, true);
  assert.equal(ui.el('play').textContent, '暫停');

  ui.el('restart').onclick();
  assert.equal(page.hidden, false);
  assert.equal(ui.el('play').textContent, '播放');
});

test('按「取消」或 Esc 關閉重新開局頁面，關閉後維持暫停', () => {
  const ui = loadUiHarness();
  const page = ui.el('restart-page');

  ui.el('restart').onclick();
  ui.el('restart-cancel').onclick();
  assert.equal(page.hidden, true);
  assert.equal(ui.el('play').textContent, '播放');

  ui.el('restart').onclick();
  ui.dispatchKey('Escape');
  assert.equal(page.hidden, true);
  assert.equal(ui.el('play').textContent, '播放');
});

test('重新開局頁面開啟時空白鍵、倍速與 B／S 快捷鍵不作用', () => {
  const ui = loadUiHarness();
  ui.el('restart').onclick();

  ui.dispatchKey(' ', { code: 'Space' });
  ui.dispatchKey('3');
  ui.dispatchKey('s');
  assert.equal(ui.el('play').textContent, '播放');
  assert.equal(ui.speedBtn(1).classList.contains('active'), true);
  assert.equal(ui.el('order').dataset.side, 'buy');
  assert.equal(ui.el('restart-page').hidden, false);
});

test('每次開啟時起始日期預設為當天', () => {
  const ui = loadUiHarness();
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  ui.el('restart').onclick();
  assert.equal(ui.el('new-date').value, today);
  ui.el('new-date').value = '2001-02-03';
  ui.el('restart-cancel').onclick();
  ui.el('restart').onclick();
  assert.equal(ui.el('new-date').value, today);
});

function fillRestartForm(ui, fields) {
  const values = { 'new-seed': '42', 'new-price': '100', 'new-cash': '1000000', 'new-monthly': '10000', 'new-date': '2020-01-06', ...fields };
  for (const [id, v] of Object.entries(values)) ui.el(id).value = v;
}

test('驗證錯誤時顯示在頁面內且頁面維持開啟、不開新局', () => {
  const ui = loadUiHarness();
  const oldSeed = ui.el('seed').textContent;
  ui.el('restart').onclick();
  fillRestartForm(ui, { 'new-price': '0' });

  ui.el('restart-confirm').onclick();
  assert.equal(ui.el('restart-msg').textContent, '起始價須大於 0');
  assert.equal(ui.el('restart-page').hidden, false);
  assert.equal(ui.el('seed').textContent, oldSeed);
});

test('確認開局後關閉頁面並以新設定開局', () => {
  const ui = loadUiHarness();
  ui.el('restart').onclick();
  fillRestartForm(ui, { 'new-seed': '42' });

  ui.el('restart-confirm').onclick();
  assert.equal(ui.el('restart-page').hidden, true);
  assert.equal(String(ui.el('seed').textContent), '42');
  assert.equal(ui.el('restart-msg').textContent, '');
});

test('重新開局設定改為資訊列外的全畫面頁面，原本資訊列下方的設定列移除', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="restart-panel"/);

  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.doesNotMatch(header, /id="restart-page"/);
  assert.match(html, /<div id="restart-page" hidden role="dialog" aria-label="重新開局">/);

  const page = html.slice(html.indexOf('<div id="restart-page"'), html.indexOf('<div id="report"'));
  for (const id of ['new-seed', 'new-price', 'new-cash', 'new-monthly', 'new-date', 'restart-confirm', 'restart-cancel', 'restart-msg']) {
    assert.match(page, new RegExp(`id="${id}"`), `重新開局頁面應包含 #${id}`);
  }
});

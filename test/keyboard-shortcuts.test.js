const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SimCore = require('../sim-core.js');

// 從 index.html 載入實際的介面腳本，以最小 DOM 測試鍵盤快捷鍵行為
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
    'half-cash': 'BUTTON',
    'half-shares': 'BUTTON',
    'custom-speed-btn': 'BUTTON',
    'report-btn': 'BUTTON',
    'report-close': 'BUTTON',
  };

  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id, tagForId[id] || 'DIV'));
    return elements.get(id);
  };

  // 初始化關鍵元素的初始狀態（對齊 index.html 靜態 HTML）
  for (const id of ['notice', 'expired', 'restart-page', 'latest', 'report', 'report-open', 'fill-toast']) {
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
    localStorage: { getItem: () => null, setItem: () => {} },
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

test('空白鍵切換暫停／播放並呼叫 preventDefault 避免捲動與重複點擊按鈕', () => {
  const ui = loadUiHarness();
  const playBtn = ui.el('play');
  assert.equal(playBtn.textContent, '暫停');

  // 模擬焦點停在按鈕上，確認會呼叫 preventDefault() 擋掉原生按鈕空白鍵點擊
  ui.focus(playBtn);
  const e1 = ui.dispatchKey(' ', { code: 'Space' });
  assert.equal(e1.defaultPrevented, true);
  assert.equal(playBtn.textContent, '播放');

  // 長按 repeat 不應連續反覆切換
  const eRepeat = ui.dispatchKey(' ', { code: 'Space', repeat: true });
  assert.equal(eRepeat.defaultPrevented, true);
  assert.equal(playBtn.textContent, '播放');

  const e2 = ui.dispatchKey(' ', { code: 'Space' });
  assert.equal(e2.defaultPrevented, true);
  assert.equal(playBtn.textContent, '暫停');
});

test('1／2／3 切換 1x／5x／50x，按鈕 active 狀態同步', () => {
  const ui = loadUiHarness();
  assert.equal(ui.speedBtn(1).classList.contains('active'), true);

  ui.dispatchKey('2');
  assert.equal(ui.speedBtn(1).classList.contains('active'), false);
  assert.equal(ui.speedBtn(5).classList.contains('active'), true);
  assert.equal(ui.speedBtn(50).classList.contains('active'), false);
  assert.equal(ui.el('custom-speed-btn').classList.contains('active'), false);

  ui.dispatchKey('3');
  assert.equal(ui.speedBtn(5).classList.contains('active'), false);
  assert.equal(ui.speedBtn(50).classList.contains('active'), true);

  ui.dispatchKey('1');
  assert.equal(ui.speedBtn(1).classList.contains('active'), true);
  assert.equal(ui.speedBtn(50).classList.contains('active'), false);
});

test('B／S 切換買進／賣出並聚焦數量輸入框，不會直接送出市價單', () => {
  const ui = loadUiHarness();
  const order = ui.el('order');
  const qty = ui.el('qty');
  const toast = ui.el('fill-toast');

  const evS = ui.dispatchKey('s');
  assert.equal(evS.defaultPrevented, true);
  assert.equal(order.dataset.side, 'sell');
  assert.equal(ui.activeElement, qty);
  assert.equal(toast.hidden, true);
  assert.equal(ui.el('order-msg').textContent, '');

  // 失焦後按大寫 B 切回買進並再次聚焦
  ui.focus(ui.body);
  const evB = ui.dispatchKey('B');
  assert.equal(evB.defaultPrevented, true);
  assert.equal(order.dataset.side, 'buy');
  assert.equal(ui.activeElement, qty);
  assert.equal(toast.hidden, true);
});

test('數量輸入框中按 Enter 依目前選擇的買或賣送出市價單；其他輸入框按 Enter 不送出市價單', () => {
  const ui = loadUiHarness();
  const qty = ui.el('qty');
  const toast = ui.el('fill-toast');

  // 在自定倍速輸入框按 Enter 不應送出市價單
  ui.focus(ui.el('custom-speed'));
  ui.dispatchKey('Enter');
  assert.equal(toast.hidden, true);

  // 按 B 聚焦數量欄後按 Enter 送出買進市價單
  ui.focus(ui.body);
  ui.dispatchKey('b');
  assert.equal(ui.activeElement, qty);
  qty.value = '1000';
  const evBuy = ui.dispatchKey('Enter');
  assert.equal(evBuy.defaultPrevented, true);
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /^✓ 買進 1,000 股 @ /);

  // 失焦後按 S 切到賣出並聚焦數量欄，按 Enter 送出賣出市價單
  ui.focus(ui.body);
  ui.dispatchKey('S');
  qty.value = '400';
  const evSell = ui.dispatchKey('Enter');
  assert.equal(evSell.defaultPrevented, true);
  assert.match(toast.textContent, /^✓ 賣出 400 股 @ /);
});

test('焦點在任何輸入框時（#qty 的 Enter 除外）快捷鍵停用', () => {
  const ui = loadUiHarness();
  const playBtn = ui.el('play');
  const inputs = [
    ui.el('qty'),
    ui.el('custom-speed'),
    ui.el('new-seed'),
    ui.makeEl('note-area', 'TEXTAREA'),
    ui.makeEl('mode-select', 'SELECT'),
    Object.assign(ui.makeEl('editable', 'DIV'), { isContentEditable: true }),
  ];

  for (const input of inputs) {
    ui.focus(input);
    const eSpace = ui.dispatchKey(' ', { code: 'Space' });
    const e2 = ui.dispatchKey('2');
    const eS = ui.dispatchKey('s');
    assert.equal(eSpace.defaultPrevented, false);
    assert.equal(e2.defaultPrevented, false);
    assert.equal(eS.defaultPrevented, false);
    assert.equal(playBtn.textContent, '暫停');
    assert.equal(ui.speedBtn(1).classList.contains('active'), true);
    assert.equal(ui.el('order').dataset.side, 'buy');
  }
});

test('投資報告開啟時快捷鍵停用，Esc 行為不變；組合鍵與組字中不攔截', () => {
  const ui = loadUiHarness();
  const playBtn = ui.el('play');
  const report = ui.el('report');

  // 忽略 Ctrl / Meta / Alt 組合鍵與 IME 組字
  ui.dispatchKey('b', { ctrlKey: true });
  ui.dispatchKey('2', { metaKey: true });
  ui.dispatchKey('s', { altKey: true });
  ui.dispatchKey(' ', { code: 'Space', isComposing: true });
  assert.equal(playBtn.textContent, '暫停');
  assert.equal(ui.speedBtn(1).classList.contains('active'), true);
  assert.equal(ui.el('order').dataset.side, 'buy');

  // 開啟投資報告（會自動暫停）
  ui.el('report-btn').onclick();
  assert.equal(report.hidden, false);
  assert.equal(playBtn.textContent, '播放');

  // 報告開啟期間快捷鍵皆停用（包含 #qty 的 Enter）
  ui.dispatchKey(' ', { code: 'Space' });
  ui.dispatchKey('3');
  ui.dispatchKey('s');
  ui.focus(ui.el('qty'));
  ui.dispatchKey('Enter');
  assert.equal(playBtn.textContent, '播放');
  assert.equal(ui.speedBtn(1).classList.contains('active'), true);
  assert.equal(ui.el('order').dataset.side, 'buy');
  assert.equal(ui.el('fill-toast').hidden, true);

  // Esc 仍可關閉投資報告
  ui.dispatchKey('Escape');
  assert.equal(report.hidden, true);
});

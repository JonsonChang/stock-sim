const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SimCore = require('../sim-core.js');

// 從 index.html 載入實際的介面腳本，以最小 DOM 與假計時器測試市價單成交提示行為
function loadUiHarness() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const match = html.match(/<script>\r?\n([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html should contain inline <script>');

  const elements = new Map();
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
  const makeEl = (id) => ({
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    disabled: false,
    checked: true,
    clientWidth: 800,
    clientHeight: 600,
    style: {},
    dataset: {},
    classList: makeClassList(),
    addEventListener: () => {},
    getContext: () => noopProxy,
    setCustomValidity: () => {},
    reportValidity: () => true,
    checkValidity: () => true,
  });

  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  // 依 index.html 既有的 hidden 初始狀態初始化關鍵元素
  for (const id of ['notice', 'expired', 'restart-panel', 'latest', 'report', 'report-open', 'fill-toast']) {
    getEl(id).hidden = true;
  }
  getEl('qty').value = '1000';
  getEl('custom-speed').value = '100';

  const body = makeEl('body');
  const timers = new Map();
  let nextTimerId = 1;
  let nowMs = 0;

  const setTimeoutFake = (fn, delay) => {
    const id = nextTimerId++;
    timers.set(id, { fn, at: nowMs + (delay || 0) });
    return id;
  };
  const clearTimeoutFake = (id) => {
    timers.delete(id);
  };
  const advanceTime = (ms) => {
    nowMs += ms;
    while (true) {
      const due = Array.from(timers.entries())
        .filter(([, t]) => t.at <= nowMs)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, timer] = due[0];
      timers.delete(id);
      timer.fn();
    }
  };

  const sandbox = {
    SimCore,
    document: {
      body,
      getElementById: getEl,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {
      devicePixelRatio: 1,
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: () => 0,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
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

  return {
    el: (id) => elements.get(id),
    body,
    advanceTime,
  };
}

test('買進市價單成交後顯示紅色成交提示，約 2 秒後自動消失', () => {
  const ui = loadUiHarness();
  const toast = ui.el('fill-toast');
  assert.equal(toast.hidden, true);

  ui.el('qty').value = '1000';
  ui.el('buy').onclick();

  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /^✓ 買進 1,000 股 @ \d+\.\d{2}$/);
  assert.equal(toast.style.color, '#e03131');
  assert.equal(ui.el('order-msg').textContent, '');

  ui.advanceTime(1999);
  assert.equal(toast.hidden, false);

  ui.advanceTime(1);
  assert.equal(toast.hidden, true);
});

test('賣出市價單成交後顯示綠色成交提示並關閉手機市價單面板', () => {
  const ui = loadUiHarness();
  const toast = ui.el('fill-toast');

  ui.el('qty').value = '1000';
  ui.el('buy').onclick();
  ui.advanceTime(2000);
  assert.equal(toast.hidden, true);

  ui.el('m-sell').onclick();
  assert.equal(ui.body.classList.contains('sheet-open'), true);

  ui.el('qty').value = '500';
  ui.el('sell').onclick();

  assert.equal(ui.body.classList.contains('sheet-open'), false);
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /^✓ 賣出 500 股 @ \d+\.\d{2}$/);
  assert.equal(toast.style.color, '#2f9e44');
});

test('連續成交時，新提示取代舊提示並重新計時 2 秒', () => {
  const ui = loadUiHarness();
  const toast = ui.el('fill-toast');

  ui.el('qty').value = '1000';
  ui.el('buy').onclick();
  assert.match(toast.textContent, /^✓ 買進 1,000 股 @ /);

  ui.advanceTime(1500);
  assert.equal(toast.hidden, false);

  ui.el('qty').value = '400';
  ui.el('sell').onclick();
  assert.equal(toast.hidden, false);
  assert.match(toast.textContent, /^✓ 賣出 400 股 @ /);
  assert.equal(toast.style.color, '#2f9e44');

  // 原先買進的 2 秒到期時點（再過 500ms）不應提早消失
  ui.advanceTime(500);
  assert.equal(toast.hidden, false);

  // 新提示再過 1499ms 仍顯示，滿 2000ms 才消失
  ui.advanceTime(1499);
  assert.equal(toast.hidden, false);
  ui.advanceTime(1);
  assert.equal(toast.hidden, true);
});

test('市價單失敗時顯示既有錯誤訊息，不顯示成交提示並清除既有提示', () => {
  const ui = loadUiHarness();
  const toast = ui.el('fill-toast');

  ui.el('qty').value = '1000';
  ui.el('buy').onclick();
  assert.equal(toast.hidden, false);

  ui.el('qty').value = '1000000';
  ui.el('buy').onclick();

  assert.equal(ui.el('order-msg').textContent, '現金不足');
  assert.equal(toast.hidden, true);
});

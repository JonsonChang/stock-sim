const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SimCore = require('../sim-core.js');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 從 index.html 載入實際的介面腳本，以最小 DOM 測試「一半資金／一半持股」數量捷徑
function loadUiHarness() {
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
    offsetTop: 8,
    offsetHeight: 28,
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

  for (const id of ['notice', 'expired', 'restart-panel', 'latest', 'report', 'report-open', 'fill-toast']) {
    getEl(id).hidden = true;
  }
  getEl('qty').value = '1000';
  getEl('custom-speed').value = '100';

  const body = makeEl('body');
  let nextFrame = null;
  let nowMs = 0;

  const sandbox = {
    SimCore,
    document: {
      body,
      getElementById: getEl,
      querySelector: (sel) => getEl(sel),
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    window: {
      devicePixelRatio: 1,
      addEventListener: () => {},
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: (cb) => {
      nextFrame = cb;
      return 1;
    },
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

  const renderFrame = (dtMs = 0) => {
    nowMs += dtMs;
    const cb = nextFrame;
    assert.equal(typeof cb, 'function', '應有待執行的 requestAnimationFrame 回呼');
    nextFrame = null;
    cb(nowMs);
  };

  return {
    el: (id) => elements.get(id),
    renderFrame,
  };
}

// 用同一種子另開一局作為對照，取得畫面當下的價格與現金（暫停中、未推進 tick）
function referenceGame(ui) {
  return SimCore.createGame({ seed: Number(ui.el('seed').textContent) });
}

function buy(ui, shares) {
  ui.el('qty').value = String(shares);
  ui.el('buy').onclick();
  ui.renderFrame();
}

test('按「一半資金」填入一半現金可買的最大股數（含手續費），不直接下單', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  const ref = referenceGame(ui);
  const half = ref.account().cash / 2;

  ui.el('half-cash').onclick();
  const n = Number(ui.el('qty').value);

  assert.ok(n > 0);
  assert.ok(ref.quote('buy', n).total <= half);
  assert.ok(ref.quote('buy', n + 1).total > half);
  assert.match(ui.el('estimate').textContent, /^預估成交金額/);
  assert.equal(ui.el('pos-shares').textContent, '0');
});

test('按「一半持股」填入部位股數除以 2 無條件捨去，不直接下單', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  buy(ui, 7);

  ui.el('half-shares').onclick();

  assert.equal(ui.el('qty').value, 3);
  assert.equal(ui.el('pos-shares').textContent, '7');
});

test('部位不足 2 股時「一半持股」停用，部位增加後自動恢復', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  assert.equal(ui.el('half-shares').disabled, true);

  buy(ui, 1);
  assert.equal(ui.el('half-shares').disabled, true);

  buy(ui, 1);
  assert.equal(ui.el('half-shares').disabled, false);
});

test('一半現金買不起 1 股時「一半資金」停用，現金增加後自動恢復', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  assert.equal(ui.el('half-cash').disabled, false);

  const ref = referenceGame(ui);
  const max = ref.maxBuyShares();
  buy(ui, max);
  assert.equal(ui.el('half-cash').disabled, true);

  ui.el('qty').value = String(max);
  ui.el('sell').onclick();
  ui.renderFrame();
  assert.equal(ui.el('half-cash').disabled, false);
});

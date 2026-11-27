const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SimCore = require('../sim-core.js');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 從 index.html 載入實際的介面腳本，以最小 DOM 測試「ALL in／ALL out」直接送出市價單；saved 為預先放入 localStorage 的存檔
function loadUiHarness(saved = null) {
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
  const timers = [];
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
    localStorage: { getItem: () => saved, setItem: (k, v) => { saved = v; } },
    requestAnimationFrame: (cb) => {
      nextFrame = cb;
      return 1;
    },
    setTimeout: (cb) => { timers.push(cb); return 1; },
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
    saved: () => saved,
    runTimers: () => timers.splice(0).forEach((cb) => cb()),
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

test('按「ALL in」立即以現金能買的最大股數成交，現金不足以再買 1 股，並顯示成交提示與存檔', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  const ref = referenceGame(ui);
  const max = ref.maxBuyShares();

  ui.el('all-in').onclick();
  ui.renderFrame();

  assert.equal(ui.el('pos-shares').textContent, max.toLocaleString('zh-TW'));
  assert.equal(ui.el('fill-toast').hidden, false);
  assert.match(ui.el('fill-toast').textContent, /買進/);
  assert.equal(JSON.parse(ui.saved()).game.trades.length, 1);
  assert.equal(ui.el('all-in').disabled, true);
});

test('按「ALL out」立即賣出全部部位，部位歸零並顯示成交提示', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  buy(ui, 7);
  assert.equal(ui.el('all-out').disabled, false);

  ui.el('all-out').onclick();
  ui.renderFrame();

  assert.equal(ui.el('pos-shares').textContent, '0');
  assert.match(ui.el('fill-toast').textContent, /賣出 7 股/);
  assert.equal(ui.el('all-out').disabled, true);
});

test('ALL in／ALL out 送出市價單時不改動數量欄', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  ui.el('qty').value = '123';
  ui.el('all-in').onclick();
  ui.el('all-out').onclick();
  assert.equal(ui.el('qty').value, '123');
});

test('部位 0 股時「ALL out」停用，買進後自動恢復；現金買不起 1 股時「ALL in」停用，賣出後自動恢復', () => {
  const ui = loadUiHarness();
  ui.renderFrame();
  assert.equal(ui.el('all-out').disabled, true);
  assert.equal(ui.el('all-in').disabled, false);

  const max = referenceGame(ui).maxBuyShares();
  buy(ui, max);
  assert.equal(ui.el('all-in').disabled, true);
  assert.equal(ui.el('all-out').disabled, false);

  ui.el('qty').value = String(max);
  ui.el('sell').onclick();
  ui.renderFrame();
  assert.equal(ui.el('all-in').disabled, false);
});

test('已達模擬期限時「ALL in」「ALL out」皆停用', () => {
  const game = SimCore.createGame({ seed: 5, startDate: '2024-01-05' });
  let bought = false;
  while (!game.expired()) {
    game.tick();
    if (!bought && game.progress().tick === 100) bought = game.order({ side: 'buy', shares: 10 }).ok;
  }
  assert.ok(game.account().shares > 0 && game.maxBuyShares() > 0);
  const ui = loadUiHarness(JSON.stringify({ game: game.save(), ui: { showBenchmark: { buyHold: true, dca: true } } }));
  ui.renderFrame(); // 讀檔：requestAnimationFrame 內以 setTimeout 重算存檔
  ui.runTimers();
  ui.renderFrame();

  assert.equal(ui.el('all-in').disabled, true);
  assert.equal(ui.el('all-out').disabled, true);
});

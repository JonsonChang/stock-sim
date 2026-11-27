const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SimCore = require('../sim-core.js');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function extractBlock(source, openTagPattern, tagName) {
  const match = openTagPattern.exec(source);
  assert.ok(match, `找不到區塊：${openTagPattern}`);
  let depth = 0;
  const tagRe = new RegExp(`<(\\/?)${tagName}\\b[^>]*>`, 'g');
  tagRe.lastIndex = match.index;
  let m;
  while ((m = tagRe.exec(source)) !== null) {
    if (m[1] === '/') depth -= 1;
    else depth += 1;
    if (depth === 0) return source.slice(match.index, tagRe.lastIndex);
  }
  assert.fail(`區塊未正確閉合：<${tagName}>`);
}

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

  for (const id of ['notice', 'expired', 'restart-page', 'latest', 'report', 'report-open', 'fill-toast']) {
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

test('桌面與手機版資訊列皆顯示漲跌（緊接現價後）與我的報酬率，且不出現「總資產報酬」', () => {
  const header = extractBlock(html, /<header\b[^>]*>/, 'header');
  const marketGroup = extractBlock(header, /<div\b[^>]*data-header-group="market"[^>]*>/, 'div');
  const perfGroup = extractBlock(header, /<div\b[^>]*data-header-group="performance"[^>]*>/, 'div');
  const styleBlock = extractBlock(html, /<style\b[^>]*>/, 'style');

  // 漲跌緊接在現價後面，且不被 m-only 隱藏
  assert.match(
    marketGroup,
    /<span>現價\s*<b id="price"><\/b><\/span>\s*<span>漲跌\s*<b id="change"><\/b><\/span>/,
    '漲跌應緊接在現價後方且不應帶有 m-only 類別'
  );

  // 我的績效組在桌面與手機版都顯示「我的報酬率」
  assert.match(perfGroup, /^<div\b(?![^>]*\bm-only\b)[^>]*data-header-group="performance"/);
  assert.match(perfGroup, /<span>我的報酬率\s*<b id="ret-bar"><\/b><\/span>/);

  // 主畫面不應出現「總資產報酬」
  assert.doesNotMatch(html, /總資產報酬/);

  // 桌面版樣式不應隱藏 .m-only（或已移除殘留規則）或隱藏 performance 組
  const desktopStyle = styleBlock.split(/@media\s*\(max-width:\s*768px\)/)[0];
  assert.doesNotMatch(desktopStyle, /data-header-group="performance"[^}]*display:\s*none/);
  assert.doesNotMatch(desktopStyle, /\.m-only/);
});

test('資訊列漲跌依前一交易日收盤紅漲綠跌，且我的報酬率與績效分頁一致', () => {
  const ui = loadUiHarness();
  ui.renderFrame(0);

  // 先買進部位，讓後續價格變化產生報酬率變動
  ui.el('qty').value = '5000';
  ui.el('buy').onclick();
  ui.renderFrame(0);
  assert.equal(ui.el('ret-bar').textContent, ui.el('ret-user').textContent);

  // 切換至 50x 並推進幀數，直到觀察到上漲與下跌（相對前一交易日收盤）
  let sawUp = false;
  let sawDown = false;
  ui.el('qty').value = '0';
  for (let i = 0; i < 600 && (!sawUp || !sawDown); i += 1) {
    ui.renderFrame(100);
    const chgText = ui.el('change').textContent;
    const chgNum = Number.parseFloat(chgText);
    assert.ok(Number.isFinite(chgNum), `漲跌格式應為百分比數字，實際為 ${chgText}`);
    if (chgNum > 0) {
      assert.equal(ui.el('change').style.color, '#e03131');
      sawUp = true;
    } else if (chgNum < 0) {
      assert.equal(ui.el('change').style.color, '#2f9e44');
      sawDown = true;
    } else {
      assert.equal(ui.el('change').style.color, '');
    }
    assert.equal(ui.el('ret-bar').textContent, ui.el('ret-user').textContent);
  }

  assert.ok(sawUp && sawDown, '推進數百幀後應同時涵蓋紅漲與綠跌的漲跌顏色驗證');
});

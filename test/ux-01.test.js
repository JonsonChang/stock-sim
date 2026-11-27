const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

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

function assertAttrs(block, attr, values) {
  for (const v of values) {
    assert.match(block, new RegExp(`${attr}="${v}"`));
  }
}

test('上方資訊列依序分為「播放」「行情狀態」「我的績效」「局務」四組且不含圖表開關', () => {
  const header = extractBlock(html, /<header\b[^>]*>/, 'header');

  const groupMatches = [...header.matchAll(/data-header-group="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groupMatches, ['play', 'market', 'performance', 'session']);

  const playGroup = extractBlock(header, /<div\b[^>]*data-header-group="play"[^>]*>/, 'div');
  const marketGroup = extractBlock(header, /<div\b[^>]*data-header-group="market"[^>]*>/, 'div');
  const perfGroup = extractBlock(header, /<div\b[^>]*data-header-group="performance"[^>]*>/, 'div');
  const sessionGroup = extractBlock(header, /<div\b[^>]*data-header-group="session"[^>]*>/, 'div');

  assertAttrs(playGroup, 'id', ['play', 'custom-speed-btn', 'custom-speed']);
  assertAttrs(playGroup, 'data-speed', ['1', '5', '50']);
  assertAttrs(marketGroup, 'id', ['price', 'date', 'year', 'change']);
  assertAttrs(perfGroup, 'id', ['ret-bar']);

  const seedIdx = sessionGroup.indexOf('id="seed"');
  const reportIdx = sessionGroup.indexOf('id="report-btn"');
  const restartIdx = sessionGroup.indexOf('id="restart"');
  assert.ok(seedIdx !== -1 && reportIdx !== -1 && restartIdx !== -1, '局務組需包含種子、投資報告、重新開局');
  assert.ok(seedIdx < reportIdx && reportIdx < restartIdx, '局務組順序應為種子、投資報告、重新開局');

  for (const id of ['ma', 'kd', 'reveal']) {
    assert.doesNotMatch(header, new RegExp(`id="${id}"`), `資訊列不應再包含 #${id}`);
  }
});

test('均線、KD、揭曉開關位於圖表左上角並與 K 棒週期切換同列', () => {
  const chartWrap = extractBlock(html, /<div\b[^>]*id="chart-wrap"[^>]*>/, 'div');
  const toolbar = extractBlock(chartWrap, /<div\b[^>]*class="[^"]*\bchart-toolbar\b[^"]*"[^>]*>/, 'div');

  assertAttrs(toolbar, 'id', ['periods', 'ma', 'kd', 'reveal']);
  assertAttrs(toolbar, 'data-period', ['day', 'week', 'month']);
  assert.match(chartWrap, /id="latest"/);
});

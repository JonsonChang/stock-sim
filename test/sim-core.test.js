const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, TICKS_PER_DAY, HISTORY_DAYS } = require('../sim-core.js');

function advance(game, ticks) {
  for (let i = 0; i < ticks; i++) game.tick();
}

test('相同種子產生完全相同的行情', () => {
  const a = createGame({ seed: 12345 });
  const b = createGame({ seed: 12345 });
  advance(a, TICKS_PER_DAY * 3 + 100);
  advance(b, TICKS_PER_DAY * 3 + 100);
  assert.deepEqual(a.candles(), b.candles());
  assert.equal(a.price(), b.price());

  const c = createGame({ seed: 54321 });
  advance(c, TICKS_PER_DAY * 3 + 100);
  assert.notDeepEqual(a.candles(), c.candles());
});

test('每根 K 棒的高低包住開收，收盤價等於當日最後一個 tick 價', () => {
  const game = createGame({ seed: 7 });
  assert.equal(game.candles().length, HISTORY_DAYS);

  const lastTickPrices = [];
  for (let day = 0; day < 5; day++) {
    advance(game, TICKS_PER_DAY);
    lastTickPrices.push(game.price());
  }

  const candles = game.candles();
  assert.equal(candles.length, HISTORY_DAYS + 5);
  for (const c of candles) {
    assert.ok(c.high >= Math.max(c.open, c.close));
    assert.ok(c.low <= Math.min(c.open, c.close));
    assert.ok(c.low > 0);
  }
  assert.deepEqual(candles.slice(HISTORY_DAYS).map((c) => c.close), lastTickPrices);
});

test('盤中的當日 K 棒隨 tick 即時更新', () => {
  const game = createGame({ seed: 7 });
  advance(game, 10);
  const forming = game.candles().at(-1);
  assert.equal(game.candles().length, HISTORY_DAYS + 1);
  assert.equal(forming.close, game.price());
  advance(game, 1);
  assert.equal(game.candles().at(-1).close, game.price());
});

// 台股升降單位（依價格區間）
function tickSize(p) {
  if (p < 10) return 0.01;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
}

function onTickGrid(p) {
  const n = p / tickSize(p);
  return Math.abs(n - Math.round(n)) < 1e-6;
}

const LONG_DAYS = 5000;
let longRun = null;
function longGame() {
  if (!longRun) {
    const game = createGame({ seed: 20261126 });
    advance(game, LONG_DAYS * TICKS_PER_DAY);
    longRun = { game, candles: game.candles(), markers: game.dayMarkers() };
  }
  return longRun;
}

test('每個交易日相對前一交易日收盤的漲跌幅不超過 ±10%，所有價格都符合升降單位', () => {
  const { candles } = longGame();
  let prevClose = 100;
  for (const c of candles) {
    for (const p of [c.open, c.high, c.low, c.close]) {
      assert.ok(onTickGrid(p), `價格 ${p} 不符合升降單位`);
      assert.ok(p <= prevClose * 1.1 + 1e-9, `${p} 超過漲停（前收 ${prevClose}）`);
      assert.ok(p >= prevClose * 0.9 - 1e-9, `${p} 低於跌停（前收 ${prevClose}）`);
    }
    prevClose = c.close;
  }
});

function dailyReturns(candles) {
  const r = [];
  for (let i = 1; i < candles.length; i++) r.push(Math.log(candles[i].close / candles[i - 1].close));
  return r;
}

test('模擬核心提供每個交易日的市場狀態，三種狀態都會出現且會維持一段時間', () => {
  const { candles, markers } = longGame();
  assert.equal(markers.length, candles.length);
  assert.deepEqual(new Set(markers.map((m) => m.state)), new Set(['bull', 'bear', 'sideways']));

  let runs = 1;
  for (let i = 1; i < markers.length; i++) if (markers[i].state !== markers[i - 1].state) runs++;
  // 每個交易日維持原狀態的機率 0.98，平均一段約 50 個交易日
  const meanRun = markers.length / runs;
  assert.ok(meanRun > 30 && meanRun < 80, `平均狀態長度 ${meanRun}`);
});

test('跳躍每個交易日發生機率 1%～2%，跳躍日的漲跌明顯大於平常', () => {
  const { candles, markers } = longGame();
  const jumpRate = markers.filter((m) => m.jump).length / markers.length;
  assert.ok(jumpRate >= 0.01 && jumpRate <= 0.02, `跳躍頻率 ${jumpRate}`);

  const r = dailyReturns(candles);
  let jumpSum = 0, jumpN = 0, normalSum = 0, normalN = 0;
  r.forEach((x, i) => {
    if (markers[i + 1].jump) { jumpSum += Math.abs(x); jumpN++; }
    else { normalSum += Math.abs(x); normalN++; }
  });
  assert.ok(jumpSum / jumpN > 2.5 * (normalSum / normalN));
});

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

function autocorr(xs, lag) {
  const m = mean(xs);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    den += (xs[i] - m) ** 2;
    if (i >= lag) num += (xs[i] - m) * (xs[i - lag] - m);
  }
  return num / den;
}

function corr(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => {
    sxy += (x - mx) * (ys[i] - my);
    sxx += (x - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  });
  return sxy / Math.sqrt(sxx * syy);
}

test('日報酬有肥尾：峰度大於 3', () => {
  const r = dailyReturns(longGame().candles);
  const m = mean(r);
  const v = mean(r.map((x) => (x - m) ** 2));
  const kurtosis = mean(r.map((x) => (x - m) ** 4)) / v ** 2;
  assert.ok(kurtosis > 3, `峰度 ${kurtosis}`);
});

test('報酬方向無法從前一日預測：lag-1 自相關的絕對值小於 0.05', () => {
  const ac = autocorr(dailyReturns(longGame().candles), 1);
  assert.ok(Math.abs(ac) < 0.05, `lag-1 自相關 ${ac}`);
});

test('波動群聚：|報酬| 在 lag 1、5、20 的自相關都為正值', () => {
  const abs = dailyReturns(longGame().candles).map(Math.abs);
  for (const lag of [1, 5, 20]) {
    const ac = autocorr(abs, lag);
    assert.ok(ac > 0, `lag ${lag} 的 |報酬| 自相關 ${ac}`);
  }
});

test('長期日波動落在 1.5%～2.5%', () => {
  const r = dailyReturns(longGame().candles);
  const m = mean(r);
  const sd = Math.sqrt(mean(r.map((x) => (x - m) ** 2)));
  assert.ok(sd >= 0.015 && sd <= 0.025, `日波動 ${sd}`);
});

test('價格序列中同時出現上升段與下降段', () => {
  const closes = longGame().candles.map((c) => c.close);
  const span = 60;
  let up = false, down = false;
  for (let i = span; i < closes.length; i++) {
    const change = closes[i] / closes[i - span];
    if (change > 1.25) up = true;
    if (change < 0.8) down = true;
  }
  assert.ok(up, '沒有出現 60 個交易日漲超過 25% 的上升段');
  assert.ok(down, '沒有出現 60 個交易日跌超過 20% 的下降段');
});

test('成交量和價格波動大小正相關', () => {
  const { candles } = longGame();
  const absR = dailyReturns(candles).map(Math.abs);
  const volumes = candles.slice(1).map((c) => c.volume);
  const rho = corr(absR, volumes);
  assert.ok(rho > 0.3, `|報酬| 與成交量的相關係數 ${rho}`);
});

test('盤中波動呈 U 型：開盤與收盤附近的 tick 變動大於盤中', () => {
  const game = createGame({ seed: 99 });
  const sums = new Array(TICKS_PER_DAY).fill(0);
  advance(game, TICKS_PER_DAY); // 從下一個交易日的開盤開始量
  for (let day = 0; day < 300; day++) {
    let prev = game.price();
    for (let i = 0; i < TICKS_PER_DAY; i++) {
      game.tick();
      const p = game.price();
      sums[i] += Math.abs(Math.log(p / prev));
      prev = p;
    }
  }
  // 第 0 個 tick 是開盤跳空，不列入盤中比較
  const edge = mean([...sums.slice(1, 31), ...sums.slice(-30)]);
  const middle = mean(sums.slice(120, 150));
  assert.ok(edge > 1.3 * middle, `兩端 ${edge}、盤中 ${middle}`);
});

test('盤中的當日 K 棒也有市場狀態與跳躍標記', () => {
  const game = createGame({ seed: 7 });
  advance(game, 10);
  const markers = game.dayMarkers();
  assert.equal(markers.length, HISTORY_DAYS + 1);
  assert.ok(['bull', 'bear', 'sideways'].includes(markers.at(-1).state));
  assert.equal(typeof markers.at(-1).jump, 'boolean');
});

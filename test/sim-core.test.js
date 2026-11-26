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

test('買進收 0.1425% 手續費，最低 20 元，現金扣掉成交金額加手續費', () => {
  const game = createGame({ seed: 7 });
  const price = game.price();

  const small = game.order({ side: 'buy', shares: 1 });
  assert.equal(small.ok, true);
  assert.equal(small.trade.fee, 20);
  assert.equal(small.trade.tax, 0);
  assert.equal(game.account().cash, 1000000 - price - 20);

  const big = game.order({ side: 'buy', shares: 5000 });
  assert.equal(big.trade.fee, Math.floor(price * 5000 * 0.001425));
  assert.ok(big.trade.fee > 20);
  assert.equal(game.account().shares, 5001);
});

test('賣出另扣 0.3% 證交稅；一買一賣後現金與已實現損益正確', () => {
  const game = createGame({ seed: 7 });
  const buyPrice = game.price();
  const buy = game.order({ side: 'buy', shares: 2000 }).trade;
  const cost = buyPrice * 2000 + buy.fee;

  let account = game.account();
  assert.equal(account.avgCost, cost / 2000);
  assert.equal(account.realizedPnl, 0);

  advance(game, 50);
  const sellPrice = game.price();
  assert.notEqual(sellPrice, buyPrice);
  account = game.account();
  assert.equal(account.unrealizedPnl, sellPrice * 2000 - cost);
  assert.equal(account.totalAssets, account.cash + sellPrice * 2000);

  const sell = game.order({ side: 'sell', shares: 2000 }).trade;
  assert.equal(sell.fee, Math.max(20, Math.floor(sellPrice * 2000 * 0.001425)));
  assert.equal(sell.tax, Math.floor(sellPrice * 2000 * 0.003));

  account = game.account();
  const realized = sellPrice * 2000 - sell.fee - sell.tax - cost;
  assert.equal(account.shares, 0);
  assert.ok(Math.abs(account.realizedPnl - realized) < 1e-6);
  assert.ok(Math.abs(account.cash - (1000000 + realized)) < 1e-6);
  assert.equal(account.unrealizedPnl, 0);
  assert.equal(account.totalAssets, account.cash);
});

test('現金不足時拒絕買進，股數不足時拒絕賣出，帳務不變', () => {
  const game = createGame({ seed: 7, initialCash: 10000 });
  const before = game.account();

  assert.deepEqual(game.order({ side: 'sell', shares: 1 }), { ok: false, reason: 'insufficient-shares' });
  assert.deepEqual(game.order({ side: 'buy', shares: 1000 }), { ok: false, reason: 'insufficient-cash' });
  assert.deepEqual(game.account(), before);
  assert.equal(game.trades().length, 0);

  game.order({ side: 'buy', shares: 10 });
  assert.deepEqual(game.order({ side: 'sell', shares: 11 }), { ok: false, reason: 'insufficient-shares' });
  assert.equal(game.account().shares, 10);
});

test('股數不是正整數時拒絕，不能藉此放空或憑空增加現金', () => {
  const game = createGame({ seed: 7 });
  game.order({ side: 'buy', shares: 10 });
  const before = game.account();
  for (const shares of [-10, 0, 1.5, NaN]) {
    assert.deepEqual(game.order({ side: 'buy', shares }), { ok: false, reason: 'invalid-shares' });
    assert.deepEqual(game.order({ side: 'sell', shares }), { ok: false, reason: 'invalid-shares' });
  }
  assert.deepEqual(game.account(), before);
  assert.equal(game.trades().length, 1);
});

test('暫停時（不推進 tick）連續下單，都以最後一個 tick 價成交', () => {
  const game = createGame({ seed: 7 });
  advance(game, 123);
  const last = game.price();
  const a = game.order({ side: 'buy', shares: 100 }).trade;
  const b = game.order({ side: 'sell', shares: 40 }).trade;
  assert.equal(a.price, last);
  assert.equal(b.price, last);
  assert.equal(a.day, b.day);
});

test('全部資金買進後現金不為負，再多買 1 股就被拒絕', () => {
  const game = createGame({ seed: 7, initialCash: 50000 });
  const max = game.maxBuyShares();
  assert.ok(max > 0);
  assert.equal(game.order({ side: 'buy', shares: max }).ok, true);
  assert.ok(game.account().cash >= 0);
  assert.deepEqual(game.order({ side: 'buy', shares: 1 }), { ok: false, reason: 'insufficient-cash' });
});

test('零股可成交，交易紀錄記下交易日、買賣、股數、成交價、手續費、證交稅', () => {
  const game = createGame({ seed: 7 });
  const buyPrice = game.price();
  game.order({ side: 'buy', shares: 37 });
  advance(game, TICKS_PER_DAY);
  const sellPrice = game.price();
  game.order({ side: 'sell', shares: 12 });

  assert.equal(game.account().shares, 25);
  assert.deepEqual(game.trades(), [
    { day: HISTORY_DAYS - 1, side: 'buy', shares: 37, price: buyPrice, fee: 20, tax: 0 },
    { day: HISTORY_DAYS, side: 'sell', shares: 12, price: sellPrice, fee: 20, tax: Math.floor(sellPrice * 12 * 0.003) },
  ]);
});

test('在不同時間點下單或完全不下單，行情都完全相同', () => {
  const idle = createGame({ seed: 99 });
  const active = createGame({ seed: 99 });
  for (let i = 0; i < TICKS_PER_DAY * 4; i++) {
    if (i % 97 === 0) active.order({ side: 'buy', shares: 100 });
    if (i % 131 === 0) active.order({ side: 'sell', shares: 50 });
    idle.tick();
    active.tick();
  }
  assert.ok(active.trades().length > 0);
  assert.deepEqual(active.candles(), idle.candles());
  assert.equal(active.price(), idle.price());
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

// 依規格獨立計算：股數無條件捨去，成交金額加手續費（0.1425%，最低 20 元）不超過預算
function affordable(budget, price) {
  let n = Math.floor(budget / price);
  while (n > 0 && price * n + Math.max(20, Math.floor(price * n * 0.001425)) > budget) n--;
  return n;
}

test('買進持有：在第一個即時交易日開盤，用全部初始資金買進，股數與手續費正確，之後永不賣出', () => {
  const game = createGame({ seed: 7, initialCash: 1000000 });
  assert.deepEqual(game.benchmarks().buyHold.trades, []);

  advance(game, 1);
  const open = game.candles()[HISTORY_DAYS].open;
  const shares = affordable(1000000, open);
  const fee = Math.floor(open * shares * 0.001425);
  const buyHold = game.benchmarks().buyHold;
  assert.deepEqual(buyHold.trades, [{ day: HISTORY_DAYS, shares, price: open, fee }]);
  assert.equal(buyHold.shares, shares);
  assert.ok(Math.abs(buyHold.cash - (1000000 - open * shares - fee)) < 1e-6);
  assert.ok(buyHold.cash < open * 1.002); // 再多買 1 股就不夠

  advance(game, TICKS_PER_DAY * 30);
  assert.equal(game.benchmarks().buyHold.trades.length, 1);
  assert.equal(game.benchmarks().buyHold.shares, shares);
});

test('定期定額：在第 1、21、41… 個即時交易日開盤各投入初始資金的 1/12，投完 12 期就停止', () => {
  const game = createGame({ seed: 7, initialCash: 1200000 });
  advance(game, TICKS_PER_DAY * 300);
  const candles = game.candles();
  const dca = game.benchmarks().dca;

  const expectedDays = Array.from({ length: 12 }, (_, k) => HISTORY_DAYS + 20 * k);
  assert.deepEqual(dca.trades.map((t) => t.day), expectedDays);
  let spent = 0, shares = 0;
  for (const t of dca.trades) {
    const open = candles[t.day].open;
    assert.equal(t.price, open);
    assert.equal(t.shares, affordable(100000, open));
    assert.equal(t.fee, Math.max(20, Math.floor(open * t.shares * 0.001425)));
    spent += open * t.shares + t.fee;
    shares += t.shares;
  }
  assert.equal(dca.shares, shares);
  assert.ok(Math.abs(dca.cash - (1200000 - spent)) < 1e-6);
});

test('報酬率：使用者與兩個比較基準都以初始資金為分母，即時交易日開始前都是 0', () => {
  const game = createGame({ seed: 7, initialCash: 1200000 });
  assert.deepEqual(game.returns(), { user: 0, buyHold: 0, dca: 0 });

  advance(game, TICKS_PER_DAY * 25 + 40);
  game.order({ side: 'buy', shares: 3000 });
  advance(game, 30);
  const price = game.price();
  const { buyHold, dca } = game.benchmarks();
  const a = game.account();
  const r = game.returns();
  assert.ok(Math.abs(r.user - (a.cash + a.shares * price - 1200000) / 1200000) < 1e-12);
  assert.ok(Math.abs(r.buyHold - (buyHold.cash + buyHold.shares * price - 1200000) / 1200000) < 1e-12);
  assert.ok(Math.abs(r.dca - (dca.cash + dca.shares * price - 1200000) / 1200000) < 1e-12);
  assert.notEqual(r.user, 0);
});

test('資產曲線：從第一個即時交易日起每個交易日一筆，已收盤的用收盤值，最後一筆是當下即時值', () => {
  const game = createGame({ seed: 7, initialCash: 1000000 });
  assert.deepEqual(game.equityCurve(), []);

  advance(game, TICKS_PER_DAY + 50);
  const buy = game.order({ side: 'buy', shares: 2000 }).trade; // 第 2 個即時交易日盤中買進
  advance(game, TICKS_PER_DAY * 2 + 10);

  const candles = game.candles();
  const curve = game.equityCurve();
  assert.deepEqual(curve.map((p) => p.day), [HISTORY_DAYS, HISTORY_DAYS + 1, HISTORY_DAYS + 2, HISTORY_DAYS + 3]);

  const bh = game.benchmarks().buyHold;
  const cashAfterBuy = 1000000 - buy.price * 2000 - buy.fee;
  curve.slice(0, 3).forEach((p, i) => {
    const close = candles[p.day].close;
    const user = i === 0 ? 0 : (cashAfterBuy + 2000 * close - 1000000) / 1000000;
    assert.ok(Math.abs(p.user - user) < 1e-12);
    assert.ok(Math.abs(p.buyHold - (bh.cash + bh.shares * close - 1000000) / 1000000) < 1e-12);
  });
  assert.deepEqual(curve.at(-1), Object.assign({ day: HISTORY_DAYS + 3 }, game.returns()));

  // 暫停時下單，最右端立即反映
  game.order({ side: 'sell', shares: 2000 });
  assert.deepEqual(game.equityCurve().at(-1), Object.assign({ day: HISTORY_DAYS + 3 }, game.returns()));
});

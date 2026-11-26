const test = require('node:test');
const assert = require('node:assert/strict');
const { createGame, restoreGame, ENGINE_VERSION, TICKS_PER_DAY, HISTORY_DAYS } = require('../sim-core.js');

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
  // 維持原狀態的機率：多頭 0.991、空頭與盤整 0.97，平均一段約 59 個交易日
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

  const remainingCash = buyHold.cash;
  assert.equal(buyHold.investedCapital, 1000000);

  advance(game, TICKS_PER_DAY * 30);
  assert.equal(game.benchmarks().buyHold.trades.length, 1);
  assert.equal(game.benchmarks().buyHold.shares, shares);
  assert.equal(game.benchmarks().buyHold.cash, remainingCash);
  assert.equal(game.benchmarks().buyHold.investedCapital, 1000000);
});

test('定期定額：不包含初始資金，從第一個即時交易日與每個日曆月首個交易日開盤投入每月入金並滾存零頭', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 1200000, monthlyContribution: 10000 });
  assert.deepEqual(game.benchmarks().dca, { cash: 0, shares: 0, investedCapital: 0, trades: [] });

  advance(game, TICKS_PER_DAY * 80);
  const candles = game.candles();
  const dca = game.benchmarks().dca;

  const expectedDays = [];
  const expectedTrades = [];
  let pool = 0, expectedInvested = 0, expectedShares = 0;
  for (let d = HISTORY_DAYS; d < candles.length; d++) {
    if (d === HISTORY_DAYS || candles[d].date.slice(0, 7) !== candles[d - 1].date.slice(0, 7)) {
      expectedDays.push(d);
      pool += 10000;
      expectedInvested += 10000;
      const open = candles[d].open;
      const n = affordable(pool, open);
      if (n > 0) {
        const fee = Math.max(20, Math.floor(open * n * 0.001425));
        pool -= open * n + fee;
        expectedShares += n;
        expectedTrades.push({ day: d, shares: n, price: open, fee });
      }
    }
  }

  assert.ok(expectedDays.length >= 4); // 橫跨 1、2、3、4 月，包含起始月初買入與跨月買入
  assert.equal(dca.investedCapital, expectedInvested);
  assert.equal(dca.shares, expectedShares);
  assert.deepEqual(dca.trades, expectedTrades);
  assert.ok(Math.abs(dca.cash - pool) < 1e-6);
});

test('報酬率：使用者、買進持有與定期定額皆以各自的累計投入本金為分母，即時交易日開始前都是 0', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 1200000, monthlyContribution: 10000 });
  assert.deepEqual(game.returns(), { user: 0, buyHold: 0, dca: 0 });

  advance(game, TICKS_PER_DAY * 25 + 40);
  game.order({ side: 'buy', shares: 3000 });
  advance(game, 30);
  const price = game.price();
  const { buyHold, dca } = game.benchmarks();
  const a = game.account();
  const r = game.returns();
  assert.ok(a.investedCapital > 1200000); // 已跨過 2024-02-01 領取每月入金
  assert.equal(dca.investedCapital, 20000); // 1 月與 2 月各投入 10,000，不包含初始資金
  assert.ok(Math.abs(r.user - (a.cash + a.shares * price - a.investedCapital) / a.investedCapital) < 1e-12);
  assert.ok(Math.abs(r.buyHold - (buyHold.cash + buyHold.shares * price - buyHold.investedCapital) / buyHold.investedCapital) < 1e-12);
  assert.ok(Math.abs(r.dca - (dca.cash + dca.shares * price - dca.investedCapital) / dca.investedCapital) < 1e-12);
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

// 讀回的局所有可觀察狀態都要和原本的局相同
function observableState(game) {
  return {
    seed: game.seed,
    candles: game.candles(),
    progress: game.progress(),
    price: game.price(),
    account: game.account(),
    trades: game.trades(),
    benchmarks: game.benchmarks(),
    returns: game.returns(),
    equityCurve: game.equityCurve(),
    dayMarkers: game.dayMarkers(),
  };
}

test('存檔後讀回：K 棒、進度、部位、現金、交易紀錄和比較基準數值都完全相同', () => {
  const game = createGame({ seed: 99, startPrice: 80, initialCash: 1200000 });
  advance(game, 37);
  game.order({ side: 'buy', shares: 3000 });
  game.order({ side: 'buy', shares: 15 }); // 同一個 tick 連續下單
  advance(game, TICKS_PER_DAY * 22 + 100);
  game.order({ side: 'sell', shares: 1000 });
  advance(game, TICKS_PER_DAY - 137); // 停在交易日收盤的 tick
  assert.deepEqual(game.progress(), { day: HISTORY_DAYS + 22, tick: TICKS_PER_DAY });
  game.order({ side: 'sell', shares: 15 });
  advance(game, 58);

  const save = JSON.parse(JSON.stringify(game.save())); // 存進 localStorage 會經過 JSON
  assert.deepEqual(save.progress, { day: HISTORY_DAYS + 23, tick: 58 });
  const restored = restoreGame(save);
  assert.equal(restored.ok, true);
  assert.deepEqual(observableState(restored.game), observableState(game));

  // 讀回後接著玩，行情和帳務也和原本的局一致
  advance(game, 500);
  advance(restored.game, 500);
  game.order({ side: 'sell', shares: 2000 });
  restored.game.order({ side: 'sell', shares: 2000 });
  assert.deepEqual(observableState(restored.game), observableState(game));
});

test('引擎版本號為第 4 版以上，且版本號不符或缺少每月入金的舊存檔拒絕讀檔', () => {
  assert.ok(ENGINE_VERSION >= 4);
  const game = createGame({ seed: 99, monthlyContribution: 15000 });
  advance(game, 300);
  const save = game.save();
  assert.equal(save.version, ENGINE_VERSION);
  assert.equal(save.settings.monthlyContribution, 15000);
  assert.deepEqual(restoreGame(Object.assign({}, save, { version: 3 })), { ok: false, reason: 'engine-version' });
  assert.deepEqual(restoreGame(Object.assign({}, save, { version: ENGINE_VERSION - 1 })), { ok: false, reason: 'engine-version' });
  assert.deepEqual(restoreGame(Object.assign({}, save, { version: undefined })), { ok: false, reason: 'engine-version' });
  const withoutMonthly = Object.assign({}, save, {
    settings: { startPrice: save.settings.startPrice, initialCash: save.settings.initialCash, startDate: save.settings.startDate },
  });
  assert.deepEqual(restoreGame(withoutMonthly), { ok: false, reason: 'engine-version' });
});

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

test('日曆日期：第一個即時交易日等於起始日期，預產歷史的最後一天是前一個平日，連續交易日遞增且跳過週末', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-01' }); // 2024-01-01 是週一
  assert.equal(game.startDate, '2024-01-01');
  assert.equal(game.candles()[HISTORY_DAYS - 1].date, '2023-12-29'); // 前一個平日是週五
  advance(game, TICKS_PER_DAY * 10);
  const dates = game.candles().map((c) => c.date);
  assert.equal(dates[HISTORY_DAYS], '2024-01-01');
  assert.deepEqual(dates.slice(HISTORY_DAYS, HISTORY_DAYS + 10), [
    '2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05',
    '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12',
  ]);
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i] > dates[i - 1]);
  for (const d of dates) assert.ok(weekday(d) !== 0 && weekday(d) !== 6, d);
  assert.ok(dates.includes('2023-12-25')); // 國定假日照常是交易日
});

test('日曆日期：起始日期落在週六、週日時順延到下週一', () => {
  for (const weekend of ['2024-01-06', '2024-01-07']) {
    const game = createGame({ seed: 7, startDate: weekend });
    assert.equal(game.startDate, '2024-01-08');
    assert.equal(game.candles()[HISTORY_DAYS - 1].date, '2024-01-05');
    advance(game, 1);
    assert.equal(game.candles()[HISTORY_DAYS].date, '2024-01-08');
  }
});

test('日曆日期：起始日期寫進存檔，讀回後日期序列相同', () => {
  const game = createGame({ seed: 7, startDate: '2031-03-14' });
  advance(game, TICKS_PER_DAY * 7 + 30);
  const save = JSON.parse(JSON.stringify(game.save()));
  assert.equal(save.settings.startDate, '2031-03-14');
  const restored = restoreGame(save).game;
  assert.equal(restored.startDate, '2031-03-14');
  assert.deepEqual(restored.candles().map((c) => c.date), game.candles().map((c) => c.date));
});

test('加入日曆日期之前的舊存檔（引擎版本 2、沒有起始日期）被拒絕讀檔', () => {
  const old = { version: 2, seed: 7, settings: { startPrice: 100, initialCash: 1000000 }, progress: { day: HISTORY_DAYS - 1, tick: TICKS_PER_DAY }, trades: [] };
  assert.deepEqual(restoreGame(old), { ok: false, reason: 'engine-version' });
});

// 模擬期限：起始日期 2024-01-05（週五）滿 30 年是 2054-01-05（週一），前一個交易日是 2054-01-02（週五）
// 推進到期要算 30 年行情，同一局給下面幾個測試共用
let expiredGame = null;
function playToExpiry() {
  if (expiredGame) return expiredGame;
  const game = createGame({ seed: 5, startDate: '2024-01-05' });
  let lastTradeDay = -1;
  while (!game.expired()) {
    game.tick();
    const { day, tick } = game.progress();
    if (tick === 100 && day % 50 === 0 && day !== lastTradeDay) {
      lastTradeDay = day;
      game.order({ side: day % 100 === 0 ? 'buy' : 'sell', shares: 1000 });
    }
  }
  expiredGame = game;
  return game;
}

test('模擬期限：起始日期滿 30 年的前一個交易日收盤時到期，之前都未到期', () => {
  const fresh = createGame({ seed: 5, startDate: '2024-01-05' });
  assert.equal(fresh.expired(), false);
  const game = playToExpiry(); // 迴圈停在第一個到期的 tick，所以之前的 tick 都未到期
  assert.equal(game.candles().at(-1).date, '2054-01-02');
  assert.equal(game.progress().tick, TICKS_PER_DAY);
  assert.equal(game.expired(), true);
});

test('模擬期限：到期後推進 tick 不改變 K 棒、進度、價格與資產曲線', () => {
  const game = playToExpiry();
  const before = observableState(game);
  advance(game, TICKS_PER_DAY * 3);
  assert.deepEqual(observableState(game), before);
});

test('模擬期限：到期後下單一律拒絕，帳務不變', () => {
  const game = playToExpiry();
  const before = observableState(game);
  assert.deepEqual(game.order({ side: 'buy', shares: 1 }), { ok: false, reason: 'expired' });
  assert.deepEqual(game.order({ side: 'sell', shares: 1 }), { ok: false, reason: 'expired' });
  assert.deepEqual(observableState(game), before);
});

test('模擬期限：到期的 30 年存檔讀回仍為到期，在 Node 中重算時間小於 3 秒', () => {
  const game = playToExpiry();
  const save = JSON.parse(JSON.stringify(game.save()));
  assert.ok(save.trades.length > 100);

  const startedAt = performance.now();
  const restored = restoreGame(save);
  const elapsed = performance.now() - startedAt;

  assert.equal(restored.ok, true);
  assert.equal(restored.game.expired(), true);
  assert.deepEqual(observableState(restored.game), observableState(game));
  assert.ok(elapsed < 3000, `重算花了 ${Math.round(elapsed)} ms`);
});

// 依定義由日 K 組出一根聚合 K 棒：開盤取期初、收盤取期末、高低取期間極值、量為加總
function combine(daily, firstDay, lastDay) {
  const days = daily.slice(firstDay, lastDay + 1);
  return {
    startDate: days[0].date,
    endDate: days.at(-1).date,
    firstDay,
    lastDay,
    open: days[0].open,
    high: Math.max(...days.map((c) => c.high)),
    low: Math.min(...days.map((c) => c.low)),
    close: days.at(-1).close,
    volume: days.reduce((s, c) => s + c.volume, 0),
  };
}

test('週 K：同一週週一到週五為一根，跨月的週不拆開，開高低收量符合定義', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-01' }); // 2024-01-01 是週一
  advance(game, TICKS_PER_DAY * 25); // 收盤在 2024-02-02（週五）
  const daily = game.candles();
  const weeks = game.candles('week').slice(-5);
  const h = HISTORY_DAYS;
  assert.deepEqual(weeks, [
    combine(daily, h, h + 4),
    combine(daily, h + 5, h + 9),
    combine(daily, h + 10, h + 14),
    combine(daily, h + 15, h + 19),
    combine(daily, h + 20, h + 24),
  ]);
  assert.equal(weeks[4].startDate, '2024-01-29');
  assert.equal(weeks[4].endDate, '2024-02-02'); // 跨月仍是同一根週 K
});

test('月 K：同一個日曆月的交易日為一根，開高低收量符合定義', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-01' });
  advance(game, TICKS_PER_DAY * 44); // 2024 年 1 月有 23 個平日、2 月有 21 個，收盤在 2024-02-29
  const daily = game.candles();
  const h = HISTORY_DAYS;
  const months = game.candles('month').slice(-2);
  assert.deepEqual(months, [combine(daily, h, h + 22), combine(daily, h + 23, h + 43)]);
  assert.equal(months[0].endDate, '2024-01-31');
  assert.equal(months[1].startDate, '2024-02-01');
  assert.equal(months[1].endDate, '2024-02-29');
});

test('週 K、月 K 的交易日範圍首尾相接、涵蓋全部交易日，預產歷史最前面不完整的週或月照樣成為一根', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-03' }); // 週三起始，預產歷史第一天是 2023-01-18（週三）
  advance(game, TICKS_PER_DAY * 40 + 77);
  const daily = game.candles();
  assert.equal(daily[0].date, '2023-01-18');
  for (const period of ['week', 'month']) {
    const bars = game.candles(period);
    assert.equal(bars[0].firstDay, 0);
    assert.equal(bars.at(-1).lastDay, daily.length - 1);
    for (let i = 1; i < bars.length; i++) assert.equal(bars[i].firstDay, bars[i - 1].lastDay + 1, `${period} 第 ${i} 根`);
  }
  assert.deepEqual(game.candles('week')[0], combine(daily, 0, 2)); // 2023-01-18～2023-01-20
  assert.deepEqual(game.candles('month')[0], combine(daily, 0, 9)); // 2023-01-18～2023-01-31
});

test('盤中正在形成的最後一根週 K、月 K 隨 tick 更新，收盤等於當下 tick 價', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-01' });
  advance(game, TICKS_PER_DAY * 2 + 40); // 2024-01-03 盤中
  for (const period of ['week', 'month']) {
    const before = game.candles(period).at(-1);
    assert.equal(before.lastDay, HISTORY_DAYS + 2);
    assert.equal(before.close, game.price());
  }
  advance(game, 30);
  const daily = game.candles();
  assert.deepEqual(game.candles('week').at(-1), combine(daily, HISTORY_DAYS, HISTORY_DAYS + 2));
  assert.equal(game.candles('month').at(-1).close, game.price());
  assert.equal(game.candles('month').at(-1).volume, combine(daily, game.candles('month').at(-1).firstDay, HISTORY_DAYS + 2).volume);
});

test('資產曲線依週 K、月 K 取點：即時區段一根一點，取期末交易日收盤值，最後一點是當下即時值', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-03' }); // 週三起始，第一根即時週 K 跨預產歷史與即時區段
  advance(game, TICKS_PER_DAY * 3 + 20);
  game.order({ side: 'buy', shares: 2000 });
  advance(game, TICKS_PER_DAY * 30 + 15);

  const daily = game.equityCurve();
  for (const period of ['week', 'month']) {
    const bars = game.candles(period);
    const live = bars.map((b, i) => ({ b, i })).filter(({ b }) => b.lastDay >= HISTORY_DAYS);
    const curve = game.equityCurve(period);
    assert.equal(curve.length, live.length, period);
    curve.forEach((p, k) => {
      const { b, i } = live[k];
      assert.deepEqual(p, Object.assign({ bar: i }, daily.find((d) => d.day === b.lastDay)));
    });
    assert.deepEqual(curve.at(-1), Object.assign({ bar: bars.length - 1, day: HISTORY_DAYS + 33 }, game.returns()));
  }
  // 2024-01-03 起：週 K 為 01-01 週、01-08 週…共 8 根即時週 K（第 8 根是 02-19 週盤中）；月 K 為 1、2 月共 2 根
  assert.equal(game.equityCurve('week').length, 8);
  assert.equal(game.equityCurve('month').length, 2);
});

// 獨立以收盤價序列計算 N 根均線，不足 N 根時為 null
function expectedMa(bars, n) {
  return bars.map((_, i) => {
    if (i + 1 < n) return null;
    let sum = 0;
    for (let j = i + 1 - n; j <= i; j++) sum += bars[j].close;
    return sum / n;
  });
}

function assertMaMatches(bars, indicators) {
  assert.equal(indicators.length, bars.length);
  for (const [key, n] of [['ma5', 5], ['ma20', 20], ['ma60', 60]]) {
    const expected = expectedMa(bars, n);
    indicators.forEach((v, i) => {
      if (expected[i] === null) assert.equal(v[key], null);
      else assert.ok(Math.abs(v[key] - expected[i]) < 1e-9);
    });
  }
}

test('均線：日 K 的 5、20、60 均線數值正確，不足 N 根時為 null', () => {
  const game = createGame({ seed: 7 });
  const daily = game.candles();
  const indicators = game.indicators();
  assert.equal(indicators[4].ma5 !== null && indicators[3].ma5 === null, true);
  assert.equal(indicators[19].ma20 !== null && indicators[18].ma20 === null, true);
  assert.equal(indicators[59].ma60 !== null && indicators[58].ma60 === null, true);
  assertMaMatches(daily, indicators);
});

test('均線：週 K 與月 K 以該週期收盤價計算，不足 N 根時為 null，且盤中隨當下 tick 價即時更新', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-01' });
  // 預產 250 個交易日約 51 週、12 個月，週 K 的 60 均線與月 K 的 20、60 均線此時都應為 null
  const initWeeks = game.indicators('week');
  const initMonths = game.indicators('month');
  assert.ok(initWeeks.length > 20 && initWeeks.length < 60);
  assert.ok(initMonths.length > 5 && initMonths.length < 20);
  assert.equal(initWeeks.at(-1).ma60, null);
  assert.equal(initMonths.at(-1).ma20, null);

  // 推進 250 個交易日又 35 個 tick（讓週 K 超過 60 根、月 K 超過 20 根，且最後一根都在盤中）
  advance(game, TICKS_PER_DAY * 250 + 35);
  for (const period of ['day', 'week', 'month']) {
    const bars = game.candles(period);
    assert.equal(bars.at(-1).close, game.price());
    assertMaMatches(bars, game.indicators(period));
  }

  // 再推進 100 個 tick，確認盤中最新一根的 5 均線隨現價變化而更新
  const beforeLast = game.indicators('week').at(-1).ma5;
  advance(game, 100);
  const afterWeeks = game.candles('week');
  const afterLast = game.indicators('week').at(-1).ma5;
  assert.notEqual(afterLast, beforeLast);
  assert.ok(Math.abs(afterLast - expectedMa(afterWeeks, 5).at(-1)) < 1e-9);
});

// 獨立實作 KD(9,3,3)：RSV 取最近 9 根，K 與 D 各以 1/3 平滑，第一根之前以 50 起算，高低相等時 RSV 取 50
function expectedKd(bars) {
  let k = 50, d = 50;
  return bars.map((b, i) => {
    const window = bars.slice(Math.max(0, i - 8), i + 1);
    const hi = Math.max(...window.map((x) => x.high));
    const lo = Math.min(...window.map((x) => x.low));
    const rsv = hi === lo ? 50 : ((b.close - lo) / (hi - lo)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    return { k, d };
  });
}

function assertKdMatches(bars, indicators) {
  assert.equal(indicators.length, bars.length);
  const expected = expectedKd(bars);
  indicators.forEach((v, i) => {
    assert.equal(Number.isFinite(v.k), true, `第 ${i} 根 K 為 ${v.k}`);
    assert.equal(Number.isFinite(v.d), true, `第 ${i} 根 D 為 ${v.d}`);
    assert.ok(Math.abs(v.k - expected[i].k) < 1e-9);
    assert.ok(Math.abs(v.d - expected[i].d) < 1e-9);
  });
}

test('KD：日 K、週 K 與月 K 符合 KD(9,3,3) 且第一根之前以 50 起算，盤中隨 tick 即時更新', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-01' });
  const daily = game.candles();
  const dailyInd = game.indicators();
  // 第一根之前 K、D 皆為 50
  const rsv0 = ((daily[0].close - daily[0].low) / (daily[0].high - daily[0].low)) * 100;
  const k0 = (2 / 3) * 50 + (1 / 3) * rsv0;
  const d0 = (2 / 3) * 50 + (1 / 3) * k0;
  assert.ok(Math.abs(dailyInd[0].k - k0) < 1e-9);
  assert.ok(Math.abs(dailyInd[0].d - d0) < 1e-9);

  advance(game, TICKS_PER_DAY * 30 + 35);
  for (const period of ['day', 'week', 'month']) {
    assertKdMatches(game.candles(period), game.indicators(period));
  }

  // 盤中最後一根隨 tick 即時更新
  const before = game.indicators('week').at(-1);
  advance(game, 100);
  const after = game.indicators('week').at(-1);
  assert.notEqual(after.k, before.k);
  assert.notEqual(after.d, before.d);
  assertKdMatches(game.candles('week'), game.indicators('week'));
});

test('KD：9 根高低相等時 RSV 取 50，不出現 NaN', () => {
  const game = createGame({ seed: 7, startPrice: 0.01 });
  const bars = game.candles();
  assert.ok(bars.slice(0, 9).every((b) => b.high === b.low));
  for (const v of game.indicators()) {
    assert.equal(Number.isNaN(v.k), false);
    assert.equal(Number.isNaN(v.d), false);
    assert.equal(v.k, 50);
    assert.equal(v.d, 50);
  }
});

function advanceToDayClose(game, date) {
  if (game.progress().tick < TICKS_PER_DAY) advance(game, TICKS_PER_DAY - game.progress().tick);
  while (game.candles().at(-1).date !== date) advance(game, TICKS_PER_DAY);
}

function assertTotalPnlIdentity(a) {
  assert.ok(Math.abs(a.totalPnl - (a.totalAssets - a.investedCapital)) < 1e-6);
  assert.ok(Math.abs(a.totalPnl - (a.realizedPnl + a.unrealizedPnl)) < 1e-6);
}

test('每月入金：預產歷史與第一個即時交易日不發放，從次一個日曆月首個交易日開盤起每月撥入現金與累計投入本金（含跨週末與到期日邊界）', () => {
  const game = createGame({ seed: 7, startDate: '2024-05-15', initialCash: 100000, monthlyContribution: 10000 });
  // 預產歷史期間結束時仍只有初始資金
  assert.equal(game.account().cash, 100000);
  assert.equal(game.account().investedCapital, 100000);
  assert.equal(game.account().totalPnl, 0);

  // 第一個即時交易日（2024-05-15）開盤與整個五月都不發放
  advance(game, 1);
  assert.equal(game.candles().at(-1).date, '2024-05-15');
  assert.equal(game.account().cash, 100000);
  assert.equal(game.account().investedCapital, 100000);

  advanceToDayClose(game, '2024-05-31');
  assert.equal(game.account().cash, 100000);
  assert.equal(game.account().investedCapital, 100000);

  // 跨週末到 2024-06-03（週一，六月首個交易日）開盤立即發放
  advance(game, 1);
  assert.equal(game.candles().at(-1).date, '2024-06-03');
  assert.equal(game.account().cash, 110000);
  assert.equal(game.account().investedCapital, 110000);
  assert.equal(game.account().totalPnl, 0);

  // 到 2024-07-01 開盤再發放一次
  advanceToDayClose(game, '2024-06-28');
  advance(game, 1);
  assert.equal(game.candles().at(-1).date, '2024-07-01');
  assert.equal(game.account().cash, 120000);
  assert.equal(game.account().investedCapital, 120000);

  // 到期日若逢日曆月首個交易日開盤照常發放（2024-07-02 起算 30 年到期日為 2054-07-01 週三）
  const expGame = createGame({ seed: 7, startDate: '2024-07-02', initialCash: 50000, monthlyContribution: 10000 });
  advance(expGame, 1);
  advanceToDayClose(expGame, '2054-06-30');
  const beforeExpCash = expGame.account().cash;
  const beforeExpInvested = expGame.account().investedCapital;
  advance(expGame, 1);
  assert.equal(expGame.candles().at(-1).date, '2054-07-01');
  assert.equal(expGame.account().cash, beforeExpCash + 10000);
  assert.equal(expGame.account().investedCapital, beforeExpInvested + 10000);
  advance(expGame, TICKS_PER_DAY - 1);
  assert.equal(expGame.expired(), true);
  advance(expGame, 10);
  assert.equal(expGame.account().cash, beforeExpCash + 10000);
  assert.equal(expGame.account().investedCapital, beforeExpInvested + 10000);
});

test('總損益恆等式：跨月領取每月入金前後，總損益等於總資產減累計投入本金亦等於已實現損益加未實現損益', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 100000, monthlyContribution: 10000 });
  advance(game, 10);
  assert.equal(game.order({ side: 'buy', shares: 500 }).ok, true);
  advance(game, TICKS_PER_DAY * 3);
  assert.equal(game.order({ side: 'sell', shares: 200 }).ok, true);

  advanceToDayClose(game, '2024-01-31');
  const beforePrice = game.price();
  const before = game.account();
  assertTotalPnlIdentity(before);

  // 跨入 2024-02-01 開盤領取每月入金
  advance(game, 1);
  assert.equal(game.candles().at(-1).date, '2024-02-01');
  const after = game.account();
  assert.equal(after.investedCapital, 110000);
  assert.equal(after.cash, before.cash + 10000);
  assertTotalPnlIdentity(after);
  assert.ok(Math.abs((after.totalPnl - before.totalPnl) - 300 * (game.price() - beforePrice)) < 1e-6);
});

test('零元邊界與資產曲線：初始資金為 0 時買進持有不買進且報酬率維持 0，每月入金為 0 時使用者不追加入金', () => {
  const zeroStart = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 0, monthlyContribution: 10000 });
  assert.equal(zeroStart.account().investedCapital, 0);
  assert.deepEqual(zeroStart.returns(), { user: 0, buyHold: 0, dca: 0 });

  // 第一個即時交易日（一月）內使用者累計投入本金與買進持有皆為 0，定期定額則於首日開盤投入 10,000，資產曲線不出現 NaN / Infinity
  advance(zeroStart, 1);
  assert.deepEqual(zeroStart.benchmarks().buyHold.trades, []);
  assert.equal(zeroStart.benchmarks().buyHold.shares, 0);
  assert.equal(zeroStart.returns().user, 0);
  assert.equal(zeroStart.returns().buyHold, 0);
  assert.equal(zeroStart.benchmarks().dca.investedCapital, 10000);
  assert.ok(zeroStart.benchmarks().dca.shares > 0);

  advanceToDayClose(zeroStart, '2024-01-31');
  for (const pt of zeroStart.equityCurve()) {
    assert.equal(Number.isFinite(pt.user), true);
    assert.equal(Number.isFinite(pt.buyHold), true);
    assert.equal(Number.isFinite(pt.dca), true);
    assert.equal(pt.buyHold, 0);
  }

  // 2024-02-01 開盤使用者領到第一筆每月入金 10,000，買進持有仍維持 0 股與 0%
  advance(zeroStart, 1);
  assert.equal(zeroStart.candles().at(-1).date, '2024-02-01');
  assert.equal(zeroStart.account().cash, 10000);
  assert.equal(zeroStart.account().investedCapital, 10000);
  assert.equal(zeroStart.benchmarks().buyHold.shares, 0);
  assert.equal(zeroStart.returns().buyHold, 0);

  zeroStart.order({ side: 'buy', shares: 50 });
  advance(zeroStart, TICKS_PER_DAY);
  const a = zeroStart.account();
  const r = zeroStart.returns();
  assert.ok(Math.abs(r.user - (a.totalAssets - 10000) / 10000) < 1e-12);
  assert.equal(r.buyHold, 0);
  assert.deepEqual(zeroStart.equityCurve().at(-1), Object.assign({ day: zeroStart.candles().length - 1 }, r));

  // 存檔讀回後包含每月入金、累計投入本金與比較基準都一致
  const saved = JSON.parse(JSON.stringify(zeroStart.save()));
  const restored = restoreGame(saved);
  assert.equal(restored.ok, true);
  assert.deepEqual(observableState(restored.game), observableState(zeroStart));

  // 每月入金為 0 時跨越多月也不追加資金，且定期定額不買進、報酬率維持 0
  const zeroMonthly = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 100000, monthlyContribution: 0 });
  advance(zeroMonthly, TICKS_PER_DAY * 50);
  assert.equal(zeroMonthly.account().cash, 100000);
  assert.equal(zeroMonthly.account().investedCapital, 100000);
  assert.deepEqual(zeroMonthly.benchmarks().dca, { cash: 0, shares: 0, investedCapital: 0, trades: [] });
  assert.equal(zeroMonthly.returns().dca, 0);
  for (const pt of zeroMonthly.equityCurve()) {
    assert.equal(Number.isFinite(pt.dca), true);
    assert.equal(pt.dca, 0);
  }
});

test('定期定額零頭滾存：高股價單月買不完或買不起時保留現金，累積數月後成功買進 1 股且存檔讀回一致', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 100000, monthlyContribution: 1000, startPrice: 2000 });
  // 第一個即時交易日開盤入金 1,000，股價約 2,000 元買不起 1 股
  advance(game, 1);
  const firstDca = game.benchmarks().dca;
  assert.equal(firstDca.investedCapital, 1000);
  assert.equal(firstDca.cash, 1000);
  assert.equal(firstDca.shares, 0);
  assert.deepEqual(firstDca.trades, []);
  assert.equal(game.returns().dca, 0);

  // 推進直到累計餘額終於足夠買進第 1 股（最多推進一年交易日）
  for (let d = 0; d < 260 && game.benchmarks().dca.shares === 0; d++) advance(game, TICKS_PER_DAY);
  const boughtDca = game.benchmarks().dca;
  assert.ok(boughtDca.shares >= 1);
  assert.ok(boughtDca.investedCapital >= 2000);
  assert.equal(boughtDca.trades.length, 1);
  assert.ok(boughtDca.cash >= 0 && boughtDca.cash < boughtDca.trades[0].price + 20);

  // 存檔後以種子重算讀回，定期定額與買進持有完全一致
  advance(game, 37);
  const saved = JSON.parse(JSON.stringify(game.save()));
  const restored = restoreGame(saved);
  assert.equal(restored.ok, true);
  assert.deepEqual(observableState(restored.game), observableState(game));

  // 到期日逢日曆月首個交易日開盤，定期定額照常投入該月入金並買進
  const expGame = createGame({ seed: 7, startDate: '2024-07-02', initialCash: 50000, monthlyContribution: 10000 });
  advance(expGame, 1);
  advanceToDayClose(expGame, '2054-06-30');
  const beforeExpInvested = expGame.benchmarks().dca.investedCapital;
  advance(expGame, 1);
  assert.equal(expGame.candles().at(-1).date, '2054-07-01');
  assert.equal(expGame.benchmarks().dca.investedCapital, beforeExpInvested + 10000);
  advance(expGame, TICKS_PER_DAY - 1);
  assert.equal(expGame.expired(), true);
});

test('投資報告：開局未推進時三方損益與報酬率為 0，年化報酬率與風險指標為空值、最大回撤為 0，情境資訊為起始狀態', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 10000 });
  const r = game.report();
  assert.equal(r.seed, 7);
  assert.equal(r.startDate, '2024-01-15');
  assert.equal(r.currentDate, null);
  assert.equal(r.liveDays, 0);
  assert.equal(r.simYear, 1);
  assert.equal(r.expired, false);
  assert.deepEqual(r.user, {
    investedCapital: 1000000, totalAssets: 1000000, totalPnl: 0, totalReturn: 0, annualizedReturn: null,
    maxDrawdown: 0, peakDate: null, troughDate: null, recoveryDate: null, currentDrawdown: 0,
    annualizedVolatility: null, sharpeRatio: null, calmarRatio: null,
    realizedPnl: 0, unrealizedPnl: 0, totalFees: 0, totalTax: 0,
  });
  assert.deepEqual(r.buyHold, {
    investedCapital: 1000000, totalAssets: 1000000, totalPnl: 0, totalReturn: 0, annualizedReturn: null,
    maxDrawdown: 0, peakDate: null, troughDate: null, recoveryDate: null, currentDrawdown: 0,
    annualizedVolatility: null, sharpeRatio: null, calmarRatio: null,
  });
  assert.deepEqual(r.dca, {
    investedCapital: 0, totalAssets: 0, totalPnl: 0, totalReturn: 0, annualizedReturn: null,
    maxDrawdown: 0, peakDate: null, troughDate: null, recoveryDate: null, currentDrawdown: 0,
    annualizedVolatility: null, sharpeRatio: null, calmarRatio: null,
  });
});

test('投資報告：盤中持有部位時，總資產、未實現損益與總報酬率隨當下 tick 價即時更新，手續費與證交稅累計所有成交', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 10000 });
  advance(game, 10);
  const buy = game.order({ side: 'buy', shares: 2000 }).trade;
  advance(game, 30);
  const sell = game.order({ side: 'sell', shares: 500 }).trade;
  const cost = buy.price * 2000 + buy.fee;
  for (let i = 0; i < 3; i++) {
    advance(game, 50);
    const p = game.price();
    const r = game.report();
    const cash = 1000000 - cost + (sell.price * 500 - sell.fee - sell.tax);
    assert.equal(r.liveDays, 1);
    assert.equal(r.currentDate, '2024-01-15');
    assert.ok(Math.abs(r.user.totalAssets - (cash + 1500 * p)) < 1e-6);
    assert.ok(Math.abs(r.user.unrealizedPnl - (1500 * p - cost * 0.75)) < 1e-6);
    assert.ok(Math.abs(r.user.realizedPnl - (sell.price * 500 - sell.fee - sell.tax - cost * 0.25)) < 1e-6);
    assert.ok(Math.abs(r.user.totalPnl - (r.user.realizedPnl + r.user.unrealizedPnl)) < 1e-6);
    assert.ok(Math.abs(r.user.totalReturn - (cash + 1500 * p - 1000000) / 1000000) < 1e-12);
    assert.equal(r.user.annualizedReturn, null);
    assert.equal(r.user.totalFees, buy.fee + sell.fee);
    assert.equal(r.user.totalTax, sell.tax);
    const bh = game.benchmarks().buyHold;
    assert.ok(Math.abs(r.buyHold.totalAssets - (bh.cash + bh.shares * p)) < 1e-6);
  }
});

function calendarYears(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 / 365.25;
}

test('投資報告：未滿 20 個即時交易日時年化報酬率為空值，滿 20 個後依日曆天數 ÷ 365.25 複利年化（三方一致）', () => {
  const game = createGame({ seed: 11, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 10000 });
  game.order({ side: 'buy', shares: 1000 });
  advance(game, TICKS_PER_DAY * 19);
  let r = game.report();
  assert.equal(r.liveDays, 19);
  assert.equal(r.user.annualizedReturn, null);
  assert.equal(r.buyHold.annualizedReturn, null);
  assert.equal(r.dca.annualizedReturn, null);

  advance(game, TICKS_PER_DAY * 40 + 77);
  r = game.report();
  assert.equal(r.liveDays, 60);
  // 2024-01-15 起第 60 個平日為 2024-04-05，共 81 個日曆天
  assert.equal(r.currentDate, '2024-04-05');
  const years = 81 / 365.25;
  assert.ok(Math.abs(years - calendarYears(r.startDate, r.currentDate)) < 1e-12);
  // 總資產由當下 tick 價與各自帳戶獨立算出，不取自報告
  const p = game.price();
  const a = game.account();
  const { buyHold, dca } = game.benchmarks();
  const sides = {
    user: [a.cash + a.shares * p, a.investedCapital],
    buyHold: [buyHold.cash + buyHold.shares * p, buyHold.investedCapital],
    dca: [dca.cash + dca.shares * p, dca.investedCapital],
  };
  for (const [key, [assets, invested]] of Object.entries(sides)) {
    const expected = Math.pow(assets / invested, 1 / years) - 1;
    assert.ok(Math.abs(r[key].annualizedReturn - expected) < 1e-12, key);
  }
  assert.equal(r.simYear, 1);
});

test('投資報告：模擬年度與到期狀態，存檔以種子重算讀回後報告完全一致', () => {
  const game = createGame({ seed: 5, startDate: '2024-01-15' });
  advance(game, 5);
  game.order({ side: 'buy', shares: 3000 });
  advance(game, TICKS_PER_DAY * 270);
  game.order({ side: 'sell', shares: 1000 });
  advance(game, 123);
  const r = game.report();
  assert.equal(r.liveDays, 271);
  assert.equal(r.currentDate, '2025-01-27');
  assert.equal(r.simYear, 2);
  const restored = restoreGame(JSON.parse(JSON.stringify(game.save())));
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.game.report(), r);
});

// 買進持有在無每月入金時，股數與現金於第一個即時交易日開盤後固定；以每日收盤價獨立算出各交易日的總資產
function buyHoldCloses(game) {
  const { buyHold } = game.benchmarks();
  return game.candles().slice(HISTORY_DAYS).map((c) => ({ date: c.date, assets: buyHold.cash + buyHold.shares * c.close }));
}

test('最大回撤：自開局 0% 起算的單調下跌，波峰日為起始日期、波谷日為最後一個交易日且尚未恢復', () => {
  const game = createGame({ seed: 28, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  advance(game, TICKS_PER_DAY * 6);
  const days = buyHoldCloses(game);
  // 前提：六個收盤總資產皆低於初始資金且逐日下降
  days.forEach((d, i) => assert.ok(d.assets < (i ? days[i - 1].assets : 1000000)));
  const r = game.report().buyHold;
  const expected = days[5].assets / 1000000 - 1;
  assert.ok(Math.abs(r.maxDrawdown - expected) < 1e-12);
  assert.equal(r.peakDate, '2024-01-15');
  assert.equal(r.troughDate, days[5].date);
  assert.equal(r.recoveryDate, null);
  assert.ok(Math.abs(r.currentDrawdown - expected) < 1e-12);
});

test('最大回撤：先漲後跌再創新高時記錄波峰日、波谷日與恢復日，創新高後當前回撤歸零', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  // 第 21 個交易日收盤：第 17 日創高後回落、第 20 日為最深波谷，尚未回到波峰
  advance(game, TICKS_PER_DAY * 21);
  let days = buyHoldCloses(game);
  const peak = days[16].assets;
  const trough = days[19].assets;
  assert.ok(days.slice(0, 16).every((d) => d.assets < peak) && days[0].assets > 1000000);
  assert.ok(days[20].assets < peak && days[20].assets > trough);
  let r = game.report().buyHold;
  assert.ok(Math.abs(r.maxDrawdown - (trough / peak - 1)) < 1e-12);
  assert.equal(r.peakDate, days[16].date);
  assert.equal(r.troughDate, days[19].date);
  assert.equal(r.recoveryDate, null);
  assert.ok(Math.abs(r.currentDrawdown - (days[20].assets / peak - 1)) < 1e-12);

  // 第 24 日收盤首次超越第 17 日波峰，之後到第 30 日收盤創新高
  advance(game, TICKS_PER_DAY * 9);
  days = buyHoldCloses(game);
  assert.ok(days.slice(20, 23).every((d) => d.assets < peak) && days[23].assets >= peak);
  assert.ok(days.slice(0, 29).every((d) => d.assets < days[29].assets));
  r = game.report().buyHold;
  assert.ok(Math.abs(r.maxDrawdown - (trough / peak - 1)) < 1e-12);
  assert.equal(r.peakDate, days[16].date);
  assert.equal(r.troughDate, days[19].date);
  assert.equal(r.recoveryDate, days[23].date);
  assert.equal(r.currentDrawdown, 0);
});

// 獨立手算：由收盤總資產序列（含開局基準）算出日報酬樣本標準差 × √260，以及兩兩比較的最大回撤
function handRisk(values) {
  const daily = values.slice(1).map((v, i) => v / values[i] - 1);
  const m = daily.reduce((a, b) => a + b, 0) / daily.length;
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / (daily.length - 1));
  let mdd = 0;
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) mdd = Math.min(mdd, values[j] / values[i] - 1);
  return { volatility: sd * Math.sqrt(260), maxDrawdown: mdd };
}

test('風險調整指標：年化波動率、夏普比率與卡瑪比率與獨立手算相符', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  game.order({ side: 'buy', shares: 5000 });
  advance(game, TICKS_PER_DAY * 25);
  const { cash, shares } = game.account();
  const values = [1].concat(game.candles().slice(HISTORY_DAYS).map((c) => (cash + shares * c.close) / 1000000));
  const hand = handRisk(values);
  const r = game.report();
  const cagr = Math.pow(values[values.length - 1], 1 / calendarYears(r.startDate, r.currentDate)) - 1;
  assert.ok(hand.volatility > 0 && hand.maxDrawdown < 0);
  assert.ok(Math.abs(r.user.maxDrawdown - hand.maxDrawdown) < 1e-12);
  assert.ok(Math.abs(r.user.annualizedVolatility - hand.volatility) < 1e-12);
  assert.ok(Math.abs(r.user.sharpeRatio - cagr / hand.volatility) < 1e-9);
  assert.ok(Math.abs(r.user.calmarRatio - cagr / Math.abs(hand.maxDrawdown)) < 1e-9);
});

test('風險調整指標：未滿 5 個交易日為空值，滿 5 個交易日即計算波動率；零波動與零回撤時夏普與卡瑪為空值', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  game.order({ side: 'buy', shares: 5000 });
  advance(game, TICKS_PER_DAY * 4);
  let r = game.report();
  assert.equal(r.liveDays, 4);
  for (const k of ['user', 'buyHold']) {
    assert.equal(r[k].annualizedVolatility, null);
    assert.equal(r[k].sharpeRatio, null);
    assert.equal(r[k].calmarRatio, null);
  }
  advance(game, TICKS_PER_DAY);
  r = game.report();
  assert.equal(r.liveDays, 5);
  assert.ok(r.user.annualizedVolatility > 0);
  // 年化報酬率未滿 20 個交易日為空值，比率也跟著為空值
  assert.equal(r.user.sharpeRatio, null);
  assert.equal(r.user.calmarRatio, null);

  // 從未下單且無每月入金：總資產恆等於初始資金，波動率與最大回撤皆為 0
  const idle = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  advance(idle, TICKS_PER_DAY * 30);
  const u = idle.report().user;
  assert.equal(u.annualizedReturn, 0);
  assert.equal(u.annualizedVolatility, 0);
  assert.equal(u.maxDrawdown, 0);
  assert.equal(u.peakDate, null);
  assert.equal(u.currentDrawdown, 0);
  assert.equal(u.sharpeRatio, null);
  assert.equal(u.calmarRatio, null);
  for (const v of Object.values(idle.report().buyHold)) assert.ok(v === null || typeof v === 'string' || Number.isFinite(v));
});

test('比較基準一致性：定期定額以累計投入報酬率淨值套用相同的回撤與波動率公式，盤中當前回撤反映當下 tick 價', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 10000 });
  advance(game, TICKS_PER_DAY * 70 + 135);
  const { dca } = game.benchmarks();
  const live = game.candles().slice(HISTORY_DAYS);
  // 逐日由入金次數與定期定額成交紀錄獨立重建：第一個即時交易日與每個跨月的交易日各入金一次
  let contributions = 0;
  const values = [1].concat(live.map((c, k) => {
    if (k === 0 || c.date.slice(0, 7) !== live[k - 1].date.slice(0, 7)) contributions += 10000;
    const bought = dca.trades.filter((t) => t.day <= HISTORY_DAYS + k);
    const spent = bought.reduce((s, t) => s + t.price * t.shares + t.fee, 0);
    const held = bought.reduce((s, t) => s + t.shares, 0);
    const close = k === live.length - 1 ? game.price() : c.close;
    return (contributions - spent + held * close) / contributions;
  }));
  assert.equal(contributions, 40000); // 1 月至 4 月
  const hand = handRisk(values);
  const r = game.report().dca;
  assert.ok(hand.maxDrawdown < 0);
  assert.ok(Math.abs(r.maxDrawdown - hand.maxDrawdown) < 1e-12);
  assert.ok(Math.abs(r.annualizedVolatility - hand.volatility) < 1e-12);
  const peak = Math.max(...values);
  assert.ok(Math.abs(r.currentDrawdown - (values[values.length - 1] / peak - 1)) < 1e-12);
});

// 一筆成交的現金流：買進為負（成交金額 + 手續費），賣出為正（成交金額 − 手續費 − 證交稅）
function cashFlow(t) {
  return t.side === 'buy' ? -(t.price * t.shares + t.fee) : t.price * t.shares - t.fee - t.tax;
}

test('持倉回合：單回合完整買賣後計入已完結回合，統計勝率、最大盈虧與持有交易日數，無進行中部位', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  advance(game, 10); // 第 1 個即時交易日盤中進場
  const buy = game.order({ side: 'buy', shares: 1000 }).trade;
  advance(game, TICKS_PER_DAY * 3); // 第 4 個即時交易日盤中出場
  const sell = game.order({ side: 'sell', shares: 1000 }).trade;
  const pnl = cashFlow(buy) + cashFlow(sell);
  const s = game.report().tradeStats;
  assert.equal(s.buyCount, 1);
  assert.equal(s.sellCount, 1);
  assert.equal(s.completedRounds, 1);
  assert.equal(s.winRate, pnl > 0 ? 1 : 0);
  assert.equal(s.avgHoldingDays, 4);
  assert.ok(Math.abs((pnl > 0 ? s.maxRoundProfit : s.maxRoundLoss) - pnl) < 1e-9);
  assert.equal(pnl > 0 ? s.maxRoundLoss : s.maxRoundProfit, null);
  // 只有一個回合，必定缺少獲利或虧損回合，賺賠比無法定義
  assert.equal(s.profitLossRatio, null);
  assert.equal(s.openPosition, null);
});

test('持倉回合：分批加碼與部分減碼未歸零前不計入已完結回合，進行中部位顯示股數、持有交易日數、回合已實現與未實現損益', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  advance(game, 10);
  const b1 = game.order({ side: 'buy', shares: 1000 }).trade;
  advance(game, TICKS_PER_DAY);
  const b2 = game.order({ side: 'buy', shares: 500 }).trade;
  advance(game, TICKS_PER_DAY);
  const s1 = game.order({ side: 'sell', shares: 600 }).trade; // 第 3 個即時交易日部分減碼
  advance(game, TICKS_PER_DAY * 2 + 50); // 第 5 個即時交易日盤中
  // 平均成本法：1500 股的總成本依股數比例分攤到賣出的 600 股與剩下的 900 股
  const cost = -cashFlow(b1) - cashFlow(b2);
  const s = game.report().tradeStats;
  assert.equal(s.buyCount, 2);
  assert.equal(s.sellCount, 1);
  assert.equal(s.completedRounds, 0);
  for (const k of ['winRate', 'profitLossRatio', 'maxRoundProfit', 'maxRoundLoss', 'avgHoldingDays']) assert.equal(s[k], null);
  const o = s.openPosition;
  assert.equal(o.shares, 900);
  assert.equal(o.holdingDays, 5);
  assert.ok(Math.abs(o.realizedPnl - (cashFlow(s1) - (cost * 600) / 1500)) < 1e-6);
  assert.ok(Math.abs(o.unrealizedPnl - (900 * game.price() - (cost * 900) / 1500)) < 1e-6);
});

test('持倉回合：多回合清倉歸零後再開新回合，勝率、賺賠比、最大獲利／虧損與平均持有交易日數符合獨立手算', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  advance(game, 10);
  // 五個回合，持有 3、6、4、9、2 個交易日；第 2 回合分兩次賣出，歸零時才完結
  for (const [days, partial] of [[2, false], [5, true], [3, false], [8, false], [1, false]]) {
    game.order({ side: 'buy', shares: 1000 });
    if (partial) {
      advance(game, TICKS_PER_DAY * 2);
      game.order({ side: 'sell', shares: 400 });
      advance(game, TICKS_PER_DAY * (days - 2));
      game.order({ side: 'sell', shares: 600 });
    } else {
      advance(game, TICKS_PER_DAY * days);
      game.order({ side: 'sell', shares: 1000 });
    }
    advance(game, TICKS_PER_DAY);
  }
  // 以每回合現金流加總獨立算出回合淨損益
  const pnls = [];
  let held = 0, flow = 0;
  for (const t of game.trades()) {
    flow += cashFlow(t);
    held += t.side === 'buy' ? t.shares : -t.shares;
    if (held === 0) { pnls.push(flow); flow = 0; }
  }
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  assert.ok(wins.length > 0 && losses.length > 0);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const s = game.report().tradeStats;
  assert.equal(s.buyCount, 5);
  assert.equal(s.sellCount, 6);
  assert.equal(s.completedRounds, 5);
  assert.equal(s.winRate, wins.length / 5);
  assert.ok(Math.abs(s.profitLossRatio - avg(wins) / Math.abs(avg(losses))) < 1e-9);
  assert.ok(Math.abs(s.maxRoundProfit - Math.max(...wins)) < 1e-6);
  assert.ok(Math.abs(s.maxRoundLoss - Math.min(...losses)) < 1e-6);
  assert.equal(s.avgHoldingDays, (3 + 6 + 4 + 9 + 2) / 5);
  assert.equal(s.openPosition, null);
});

// 以資產曲線（累計投入報酬率）獨立算出某交易日的「1 + 報酬率」；date 為 null 表示起始基準點
function growthAt(game, date, key) {
  if (date === null) return 1;
  const candles = game.candles();
  const p = game.equityCurve().find((x) => candles[x.day].date === date);
  return 1 + p[key];
}

test('分年報酬明細：起始日期非 1 月 1 日時依滿一個日曆年切分模擬年度，進行中年度報酬累計至今，各年度連乘等於總報酬', () => {
  const game = createGame({ seed: 21, startDate: '2024-03-15', initialCash: 1000000, monthlyContribution: 10000 });
  advance(game, 10);
  game.order({ side: 'buy', shares: 3000 });
  advance(game, TICKS_PER_DAY * 280 + 50); // 第 281 個即時交易日盤中
  const r = game.report();
  const rows = r.yearlyReturns;
  assert.equal(rows.length, 2);
  // 2024-03-15 滿一年是 2025-03-15（週六），第 2 年的第一個交易日是 2025-03-17
  assert.deepEqual(rows.map(({ year, startDate, endDate, inProgress }) => ({ year, startDate, endDate, inProgress })), [
    { year: 1, startDate: '2024-03-15', endDate: '2025-03-14', inProgress: false },
    { year: 2, startDate: '2025-03-17', endDate: r.currentDate, inProgress: true },
  ]);
  for (const key of ['user', 'buyHold', 'dca']) {
    const y1 = growthAt(game, '2025-03-14', key);
    assert.ok(Math.abs(rows[0][key] - (y1 - 1)) < 1e-12, key);
    assert.ok(Math.abs(rows[1][key] - ((1 + r[key].totalReturn) / y1 - 1)) < 1e-12, key);
    const product = rows.reduce((s, row) => s * (1 + row[key]), 1);
    assert.ok(Math.abs(product - (1 + r[key].totalReturn)) < 1e-12, key);
  }
});

test('分年報酬明細：開局未推進時為空，第 1 個即時交易日盤中只有進行中的第 1 年且等於當下總報酬率', () => {
  const game = createGame({ seed: 7, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 10000 });
  assert.deepEqual(game.report().yearlyReturns, []);
  advance(game, 40);
  const r = game.report();
  assert.equal(r.yearlyReturns.length, 1);
  const row = r.yearlyReturns[0];
  assert.deepEqual([row.year, row.startDate, row.endDate, row.inProgress], [1, '2024-01-15', '2024-01-15', true]);
  for (const key of ['user', 'buyHold', 'dca']) assert.ok(Math.abs(row[key] - r[key].totalReturn) < 1e-12, key);
});

test('分年報酬明細：到期時共 30 個模擬年度且皆已滿一年，年度首尾相接，三方連乘皆等於總報酬', () => {
  const game = playToExpiry();
  const r = game.report();
  const rows = r.yearlyReturns;
  assert.equal(rows.length, 30);
  assert.deepEqual(rows.map((x) => x.year), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.ok(rows.every((x) => !x.inProgress));
  assert.equal(rows[0].startDate, '2024-01-05');
  assert.equal(rows[29].endDate, '2054-01-02');
  // 第 N 年從起始日期滿 N − 1 年那天（遇週末順延）開始
  assert.equal(rows[1].startDate, '2025-01-06');
  assert.equal(rows[10].startDate, '2034-01-05');
  const dates = game.candles().slice(HISTORY_DAYS).map((c) => c.date);
  for (let i = 1; i < rows.length; i++) assert.equal(dates.indexOf(rows[i].startDate), dates.indexOf(rows[i - 1].endDate) + 1);
  for (const key of ['user', 'buyHold', 'dca']) {
    const product = rows.reduce((s, row) => s * (1 + row[key]), 1);
    assert.ok(Math.abs(product / (1 + r[key].totalReturn) - 1) < 1e-9, key);
    assert.ok(Math.abs(rows[5][key] - (growthAt(game, rows[5].endDate, key) / growthAt(game, rows[4].endDate, key) - 1)) < 1e-12, key);
  }
});

test('報告曲線：開局未推進時為空；之後每個即時交易日一點且日期對齊，累積報酬率與回撤幅度符合獨立手算，末點等於總覽報酬率與當前回撤', () => {
  const game = createGame({ seed: 51, startDate: '2024-01-15', initialCash: 1000000, monthlyContribution: 0 });
  assert.deepEqual(game.report().curve, []);
  game.order({ side: 'buy', shares: 5000 });
  advance(game, TICKS_PER_DAY * 25 + 100); // 第 26 個即時交易日盤中
  const r = game.report();
  const live = game.candles().slice(HISTORY_DAYS);
  assert.equal(r.curve.length, r.liveDays);
  assert.deepEqual(r.curve.map((p) => p.date), live.map((c) => c.date));
  // 使用者：由固定的現金與股數逐日以收盤價（最後一點為當下 tick 價）重建「1 + 累計投入報酬率」
  const { cash, shares } = game.account();
  const values = live.map((c, i) => (cash + shares * (i === live.length - 1 ? game.price() : c.close)) / 1000000);
  let peak = 1;
  values.forEach((v, i) => {
    peak = Math.max(peak, v);
    assert.ok(Math.abs(r.curve[i].user - (v - 1)) < 1e-12);
    assert.ok(Math.abs(r.curve[i].drawdown.user - (v / peak - 1)) < 1e-12);
  });
  const last = r.curve.at(-1);
  for (const key of ['user', 'buyHold', 'dca']) {
    assert.ok(Math.abs(last[key] - r[key].totalReturn) < 1e-12, key);
    assert.equal(last.drawdown[key], r[key].currentDrawdown, key);
    assert.equal(Math.min(...r.curve.map((p) => p.drawdown[key])), r[key].maxDrawdown, key);
    assert.ok(r.curve.every((p) => p.drawdown[key] <= 0), key);
    // 每點回撤 = (1 + 報酬率) ÷ 含起始基準點 1 在內的歷史最高點 − 1
    let high = 1;
    r.curve.forEach((p) => {
      high = Math.max(high, 1 + p[key]);
      assert.ok(Math.abs(p.drawdown[key] - ((1 + p[key]) / high - 1)) < 1e-12, key);
    });
  }
  assert.ok(r.user.maxDrawdown < 0);
});

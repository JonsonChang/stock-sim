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

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

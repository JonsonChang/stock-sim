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

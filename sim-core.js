// 模擬核心：不碰 DOM，瀏覽器（<script>）與 Node（require）都能載入。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SimCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TICKS_PER_DAY = 270;
  const HISTORY_DAYS = 250;
  const DAILY_SIGMA = 0.02;
  const NU = 4;
  const T_SCALE = Math.sqrt((NU - 2) / NU); // 讓 Student-t(ν=4) 的變異數為 1
  const VOLUME_PER_TICK = 100;

  // mulberry32：32 位元種子的決定性亂數產生器，輸出 (0, 1)
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
    };
  }

  function makeStudentT(rng) {
    return function () {
      // Box-Muller 標準常態；自由度 4 的卡方 = -2·ln(U1·U2)
      const z = Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng());
      const chi2 = -2 * Math.log(rng() * rng());
      return (z / Math.sqrt(chi2 / NU)) * T_SCALE;
    };
  }

  function createGame(options) {
    const opts = options || {};
    const seed = opts.seed === undefined ? Math.floor(Math.random() * 4294967296) : opts.seed >>> 0;
    const startPrice = opts.startPrice === undefined ? 100 : opts.startPrice;
    const studentT = makeStudentT(makeRng(seed));
    const tickSigma = DAILY_SIGMA / Math.sqrt(TICKS_PER_DAY);

    const candles = [];
    let price = startPrice;
    let tickInDay = TICKS_PER_DAY; // 尚未開始新的交易日

    function tick() {
      const z = studentT();
      price *= Math.exp(tickSigma * z);
      const volume = Math.round(VOLUME_PER_TICK * (0.5 + Math.abs(z)));
      if (tickInDay === TICKS_PER_DAY) {
        candles.push({ open: price, high: price, low: price, close: price, volume: volume });
        tickInDay = 1;
        return;
      }
      const c = candles[candles.length - 1];
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.close = price;
      c.volume += volume;
      tickInDay++;
    }

    for (let i = 0; i < HISTORY_DAYS * TICKS_PER_DAY; i++) tick();

    return {
      seed: seed,
      tick: tick,
      price: function () { return price; },
      // 回傳 K 棒序列；最後一根在盤中時是正在形成的當日 K 棒
      candles: function () { return candles.map(function (c) { return Object.assign({}, c); }); },
    };
  }

  return { createGame: createGame, TICKS_PER_DAY: TICKS_PER_DAY, HISTORY_DAYS: HISTORY_DAYS };
});

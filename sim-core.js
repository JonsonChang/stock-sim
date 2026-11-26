// 模擬核心：不碰 DOM，瀏覽器（<script>）與 Node（require）都能載入。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SimCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TICKS_PER_DAY = 270;
  const HISTORY_DAYS = 250;
  // GARCH 的長期日波動；加上空頭 σ×1.3 與跳躍後，整體日波動約 2%
  const DAILY_SIGMA = 0.016;
  const TICK_SIGMA = DAILY_SIGMA / Math.sqrt(TICKS_PER_DAY);
  const NU = 4;
  const T_SCALE = Math.sqrt((NU - 2) / NU); // 讓 Student-t(ν=4) 的變異數為 1
  const VOLUME_PER_TICK = 100;

  const PRICE_LIMIT = 0.1;

  // 市場狀態：μ 是每個交易日的對數漂移
  const STATE_PARAMS = {
    bull: { mu: 0.0008, sigmaMult: 1 },
    bear: { mu: -0.001, sigmaMult: 1.3 },
    sideways: { mu: 0, sigmaMult: 1 },
  };
  const STATES = Object.keys(STATE_PARAMS);
  const STAY_PROB = 0.98;

  // GARCH(1,1) 條件波動；DAILY_SIGMA 是長期日波動（未乘上市場狀態倍數）
  const GARCH_ALPHA = 0.08;
  const GARCH_BETA = 0.9;
  const GARCH_OMEGA = DAILY_SIGMA * DAILY_SIGMA * (1 - GARCH_ALPHA - GARCH_BETA);

  // 盤中波動權重呈 U 型：開盤與收盤附近較劇烈，平均為 1
  const INTRADAY_TICKS = TICKS_PER_DAY - 1; // 第 0 個 tick 是開盤
  const U_DEPTH = 2;
  const INTRADAY_WEIGHTS = (function () {
    const w = [];
    for (let i = 1; i <= INTRADAY_TICKS; i++) {
      const x = (2 * (i - 1)) / (INTRADAY_TICKS - 1) - 1; // -1 ～ 1
      w.push(1 + U_DEPTH * x * x);
    }
    const avg = w.reduce(function (a, b) { return a + b; }, 0) / w.length;
    return w.map(function (v) { return v / avg; });
  })();

  // 跳躍：每個交易日發生機率，幅度為漲跌幅
  const JUMP_PROB = 0.015;
  const JUMP_MIN = 0.05;
  const JUMP_MAX = 0.09;
  // 開盤跳空佔日變異數的比例
  const GAP_SHARE = 0.1;

  // 台股升降單位
  function tickSize(p) {
    if (p < 10) return 0.01;
    if (p < 50) return 0.05;
    if (p < 100) return 0.1;
    if (p < 500) return 0.5;
    if (p < 1000) return 1;
    return 5;
  }

  // 取整到升降單位，並去掉浮點誤差（例如 12.350000000000001）
  function snap(n, size) { return Number((n * size).toFixed(2)); }
  function roundToTick(p) { const s = tickSize(p); return snap(Math.round(p / s), s); }
  // 漲停價往下取、跌停價往上取，確保不超過 ±10%
  function floorToTick(p) { const s = tickSize(p); return snap(Math.floor(p / s + 1e-9), s); }
  function ceilToTick(p) { const s = tickSize(p); return snap(Math.ceil(p / s - 1e-9), s); }

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
    const rng = makeRng(seed);
    const studentT = makeStudentT(rng);

    const candles = [];
    const markers = []; // 每個交易日的市場狀態與跳躍標記，和 candles 對齊
    let price = startPrice; // 連續價格；對外顯示的價格依升降單位取整
    let limitUp = startPrice, limitDown = startPrice;
    let state = STATES[Math.floor(rng() * STATES.length)];
    let variance = DAILY_SIGMA * DAILY_SIGMA; // GARCH 條件變異數（未乘上市場狀態倍數）
    let sigma = DAILY_SIGMA; // 當日的日波動
    let jumpTick = -1; // 當日跳躍發生在第幾個 tick，-1 表示沒有跳躍
    let jumpSize = 0;
    let tickInDay = TICKS_PER_DAY; // 尚未開始新的交易日

    function startDay() {
      const n = candles.length;
      const prevClose = n ? candles[n - 1].close : startPrice;
      limitUp = floorToTick(prevClose * (1 + PRICE_LIMIT));
      limitDown = ceilToTick(prevClose * (1 - PRICE_LIMIT));

      if (n) {
        // 以前一交易日的報酬（扣掉漂移、除掉狀態倍數）更新條件變異數
        const params = STATE_PARAMS[state];
        const prevPrevClose = n > 1 ? candles[n - 2].close : startPrice;
        // 跳躍不計入，否則長期波動會被跳躍放大
        const jump = jumpTick >= 0 ? jumpSize : 0;
        const shock = (Math.log(prevClose / prevPrevClose) - jump - params.mu) / params.sigmaMult;
        variance = GARCH_OMEGA + GARCH_ALPHA * shock * shock + GARCH_BETA * variance;
      }

      if (rng() > STAY_PROB) {
        const others = STATES.filter(function (s) { return s !== state; });
        state = others[Math.floor(rng() * others.length)];
      }
      sigma = Math.sqrt(variance) * STATE_PARAMS[state].sigmaMult;

      jumpTick = -1;
      if (rng() < JUMP_PROB) {
        jumpTick = Math.floor(rng() * TICKS_PER_DAY);
        const size = JUMP_MIN + (JUMP_MAX - JUMP_MIN) * rng();
        jumpSize = Math.log(1 + (rng() < 0.5 ? -size : size)); // 漲跌幅換成對數增量
      }
      markers.push({ state: state, jump: jumpTick >= 0 });
    }

    // 盤中第 i 個 tick 的對數價格增量；第 0 個 tick 是開盤跳空
    function logIncrement(i) {
      const mu = STATE_PARAMS[state].mu;
      const z = studentT();
      let inc = i === 0
        ? sigma * Math.sqrt(GAP_SHARE) * z
        : mu / INTRADAY_TICKS + sigma * Math.sqrt(((1 - GAP_SHARE) * INTRADAY_WEIGHTS[i - 1]) / INTRADAY_TICKS) * z;
      if (i === jumpTick) inc += jumpSize;
      return inc;
    }

    function tick() {
      const newDay = tickInDay === TICKS_PER_DAY;
      if (newDay) {
        startDay();
        tickInDay = 0;
      }
      const inc = logIncrement(tickInDay);
      const before = price;
      price = Math.min(limitUp, Math.max(limitDown, price * Math.exp(inc)));
      const shown = roundToTick(price);
      // 成交量 ∝ |報酬| × 波動率 × 隨機因子（另加底量，避免無變動的 tick 沒有量）
      const absReturn = Math.abs(Math.log(price / before)) / TICK_SIGMA;
      const volume = Math.round(VOLUME_PER_TICK * (0.2 + absReturn) * (sigma / DAILY_SIGMA) * (0.5 + rng()));
      if (newDay) {
        candles.push({ open: shown, high: shown, low: shown, close: shown, volume: volume });
        tickInDay = 1;
        return;
      }
      const c = candles[candles.length - 1];
      if (shown > c.high) c.high = shown;
      if (shown < c.low) c.low = shown;
      c.close = shown;
      c.volume += volume;
      tickInDay++;
    }

    for (let i = 0; i < HISTORY_DAYS * TICKS_PER_DAY; i++) tick();

    return {
      seed: seed,
      tick: tick,
      price: function () { return roundToTick(price); },
      // 回傳 K 棒序列；最後一根在盤中時是正在形成的當日 K 棒
      candles: function () { return candles.map(function (c) { return Object.assign({}, c); }); },
      // 回傳每個交易日的市場狀態（bull／bear／sideways）與跳躍標記，和 candles() 對齊
      dayMarkers: function () { return markers.map(function (m) { return Object.assign({}, m); }); },
    };
  }

  return { createGame: createGame, TICKS_PER_DAY: TICKS_PER_DAY, HISTORY_DAYS: HISTORY_DAYS };
});

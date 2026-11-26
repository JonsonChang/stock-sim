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
  const FEE_RATE = 0.001425;
  const MIN_FEE = 20;
  const TAX_RATE = 0.003;

  const PRICE_LIMIT = 0.1;
  // 定期定額：每 20 個交易日投入初始資金的 1/12
  const DCA_INTERVAL = 20;
  const DCA_PERIODS = 12;

  // 市場狀態：μ 是每個交易日的對數漂移，stay 是每個交易日維持原狀態的機率
  // 多頭較持久（平均一段約 111 個交易日，空頭與盤整約 33 個），長期約 63% 時間處於多頭，年化漂移約 +7%～8%（參考 VT）
  const STATE_PARAMS = {
    bull: { mu: 0.0008, sigmaMult: 1, stay: 0.991 },
    bear: { mu: -0.001, sigmaMult: 1.3, stay: 0.97 },
    sideways: { mu: 0, sigmaMult: 1, stay: 0.97 },
  };
  const STATES = Object.keys(STATE_PARAMS);

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

  function feeFor(amount) { return Math.max(MIN_FEE, Math.floor(amount * FEE_RATE)); }

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

  function copyAccount(a) {
    return { cash: a.cash, shares: a.shares, trades: a.trades.map(function (t) { return Object.assign({}, t); }) };
  }

  function createGame(options) {
    const opts = options || {};
    const seed = opts.seed === undefined ? Math.floor(Math.random() * 4294967296) : opts.seed >>> 0;
    const startPrice = opts.startPrice === undefined ? 100 : opts.startPrice;
    const rng = makeRng(seed);
    const studentT = makeStudentT(rng);

    const candles = [];
    const markers = []; // 每個交易日的市場狀態與跳躍標記，和 candles 對齊
    let rawPrice = startPrice; // 連續價格，盤中路徑在這上面推進
    let price = startPrice; // 當下 tick 價：連續價格依升降單位取整，也是市價單的成交價
    let limitUp = startPrice, limitDown = startPrice;
    let state = STATES[Math.floor(rng() * STATES.length)];
    let variance = DAILY_SIGMA * DAILY_SIGMA; // GARCH 條件變異數（未乘上市場狀態倍數）
    let sigma = DAILY_SIGMA; // 當日的日波動
    let jumpTick = -1; // 當日跳躍發生在第幾個 tick，-1 表示沒有跳躍
    let jumpSize = 0;
    let tickInDay = TICKS_PER_DAY; // 尚未開始新的交易日
    const initialCash = opts.initialCash === undefined ? 1000000 : opts.initialCash;

    // 帳務：只讀行情、不碰亂數，所以市價單不會影響行情（ADR-0001）
    let cash = initialCash;
    let shares = 0;
    let costBasis = 0; // 部位成本，含買進手續費
    let realizedPnl = 0;
    const trades = [];

    // 比較基準：只讀行情、不碰亂數，所以不影響行情（ADR-0001）
    const buyHold = { cash: initialCash, shares: 0, trades: [] };
    const dca = { cash: initialCash, shares: 0, trades: [] };
    const closedCurve = []; // 已收盤的即時交易日的報酬率，在下一個交易日開盤前記下

    // 以當下 tick 價計算使用者與比較基準的報酬率
    function returns() {
      function r(c, n) { return (c + n * price - initialCash) / initialCash; }
      return { user: r(cash, shares), buyHold: r(buyHold.cash, buyHold.shares), dca: r(dca.cash, dca.shares) };
    }

    // 最後一根 K 棒在當下 tick 價的資產曲線點；還在預產的歷史區段時回傳 null
    function latestCurvePoint() {
      return candles.length > HISTORY_DAYS ? Object.assign({ day: candles.length - 1 }, returns()) : null;
    }

    // 以開盤價用預算買進，股數無條件捨去，扣手續費
    function benchmarkBuy(account, budget, day) {
      let n = Math.floor(budget / price);
      while (n > 0 && price * n + feeFor(price * n) > budget) n--;
      if (n === 0) return;
      const fee = feeFor(price * n);
      account.cash -= price * n + fee;
      account.shares += n;
      account.trades.push({ day: day, shares: n, price: price, fee: fee });
    }

    // 每個即時交易日開盤時執行比較基準的買進
    function openBenchmarks(day) {
      const liveDay = day - HISTORY_DAYS;
      if (liveDay === 0) benchmarkBuy(buyHold, buyHold.cash, day);
      if (liveDay % DCA_INTERVAL === 0 && liveDay / DCA_INTERVAL < DCA_PERIODS) {
        benchmarkBuy(dca, initialCash / DCA_PERIODS, day);
      }
    }

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

      if (rng() > STATE_PARAMS[state].stay) {
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
        const closed = latestCurvePoint();
        if (closed) closedCurve.push(closed);
        startDay();
        tickInDay = 0;
      }
      const inc = logIncrement(tickInDay);
      const before = rawPrice;
      rawPrice = Math.min(limitUp, Math.max(limitDown, rawPrice * Math.exp(inc)));
      price = roundToTick(rawPrice);
      // 成交量 ∝ |報酬| × 波動率 × 隨機因子（另加底量，避免無變動的 tick 沒有量）
      const absReturn = Math.abs(Math.log(rawPrice / before)) / TICK_SIGMA;
      const volume = Math.round(VOLUME_PER_TICK * (0.2 + absReturn) * (sigma / DAILY_SIGMA) * (0.5 + rng()));
      if (newDay) {
        candles.push({ open: price, high: price, low: price, close: price, volume: volume });
        tickInDay = 1;
        if (candles.length > HISTORY_DAYS) openBenchmarks(candles.length - 1);
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

    // 以當下 tick 價預估一筆市價單；total 是買進要付出、賣出會收到的現金
    function quote(side, n) {
      const amount = price * n;
      const fee = feeFor(amount);
      const tax = side === 'sell' ? Math.floor(amount * TAX_RATE) : 0;
      const total = side === 'buy' ? amount + fee : amount - fee - tax;
      return { amount: amount, fee: fee, tax: tax, total: total };
    }

    function maxBuyShares() {
      let n = Math.floor(cash / (price * (1 + FEE_RATE)));
      while (n > 0 && quote('buy', n).total > cash) n--;
      return n;
    }

    function order(o) {
      if (!Number.isInteger(o.shares) || o.shares <= 0) return { ok: false, reason: 'invalid-shares' };
      const q = quote(o.side, o.shares);
      if (o.side === 'buy') {
        if (q.total > cash) return { ok: false, reason: 'insufficient-cash' };
        cash -= q.total;
        costBasis += q.total;
        shares += o.shares;
      } else {
        if (o.shares > shares) return { ok: false, reason: 'insufficient-shares' };
        const soldCost = (costBasis * o.shares) / shares;
        cash += q.total;
        realizedPnl += q.total - soldCost;
        shares -= o.shares;
        costBasis = shares === 0 ? 0 : costBasis - soldCost;
      }
      const trade = { day: candles.length - 1, side: o.side, shares: o.shares, price: price, fee: q.fee, tax: q.tax };
      trades.push(trade);
      return { ok: true, trade: Object.assign({}, trade) };
    }

    function account() {
      const marketValue = shares * price;
      return {
        shares: shares,
        avgCost: shares > 0 ? costBasis / shares : 0,
        cash: cash,
        totalAssets: cash + marketValue,
        unrealizedPnl: marketValue - costBasis,
        realizedPnl: realizedPnl,
      };
    }

    return {
      seed: seed,
      tick: tick,
      order: order,
      quote: quote,
      maxBuyShares: maxBuyShares,
      account: account,
      // 交易紀錄，依成交先後排列；day 是成交當下 K 棒的索引
      trades: function () { return trades.map(function (t) { return Object.assign({}, t); }); },
      price: function () { return price; },
      returns: returns,
      // 資產曲線：從第一個即時交易日起每個交易日一筆報酬率，已收盤的用收盤值，最後一筆是當下即時值
      equityCurve: function () {
        const curve = closedCurve.map(function (p) { return Object.assign({}, p); });
        const latest = latestCurvePoint();
        if (latest) curve.push(latest);
        return curve;
      },
      // 兩個比較基準的帳戶；trades 的 day 是買進當下 K 棒的索引
      benchmarks: function () {
        return { buyHold: copyAccount(buyHold), dca: copyAccount(dca) };
      },
      // 回傳 K 棒序列；最後一根在盤中時是正在形成的當日 K 棒
      candles: function () { return candles.map(function (c) { return Object.assign({}, c); }); },
      // 回傳每個交易日的市場狀態（bull／bear／sideways）與跳躍標記，和 candles() 對齊
      dayMarkers: function () { return markers.map(function (m) { return Object.assign({}, m); }); },
    };
  }

  return { createGame: createGame, TICKS_PER_DAY: TICKS_PER_DAY, HISTORY_DAYS: HISTORY_DAYS };
});

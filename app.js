/* InvestTracker — 个人投资行情面板
 * 纯静态前端：TradingView 免费 widget 提供实时行情，TradingView scanner 接口拉取数字价格用于计算总资产。
 * 持仓数据存于浏览器 localStorage。无构建步骤、无后端依赖，可部署到 GitHub Pages。
 */
(function () {
  "use strict";

  const STORAGE_KEY = "investtracker-dashboard-v1";
  const HINT_DISMISS_KEY = "investtracker-hint-dismissed-v1";   // 首次提示条每台设备只显示一次
  const SCANNER = "https://scanner.tradingview.com/";
  const TV_EMBED = "https://s3.tradingview.com/external-embedding/";
  const GOLD_GRAMS_PER_OUNCE = 31.1035;
  const FALLBACK_USDCNY = 7.2;
  const TD_BASE = "https://api.twelvedata.com/quote";   // 美股实时行情（CORS 允许，按符号计费）
  const REFRESH_OPTIONS = [30, 60, 300];                // 可选刷新间隔（秒）
  const REFRESH_DEFAULT = 60;                           // 默认 1 分钟
  const MAX_HOLDINGS = 500;                             // 导入时 holdings 条数上限，防止异常文件撑爆 localStorage
  const MAX_FIELD_LEN = 64;                             // 单个 symbol / label 字段长度上限

  const CATS = {
    us:     { name: "美股",   color: "#2962ff", region: "america", currency: "USD", costUnit: "美元" },
    cn:     { name: "A股",    color: "#e53935", region: "china",   currency: "CNY", costUnit: "人民币" },
    crypto: { name: "虚拟币", color: "#f7931a", region: "crypto",  currency: "USD", costUnit: "美元" },
    gold:   { name: "黄金",   color: "#d4a017", region: "cfd",     currency: "USD", qtyUnit: "克", costUnit: "元/克" },
  };
  const CAT_ORDER = ["us", "cn", "crypto", "gold"];

  const SYMBOL_HINTS = {
    us:     "示例：NASDAQ:AAPL · NYSE:BABA · NASDAQ:TSLA",
    cn:     "示例：SSE:600519（沪市）· SZSE:000858（深市）",
    crypto: "示例：BINANCE:BTCUSDT · BINANCE:ETHUSDT（BNB 要填 BINANCE:BNBUSDT，必须带计价币）",
    gold:   "示例：TVC:GOLD（现货金）· COMEX:GC1!（期货）",
  };

  const EXAMPLES = [
    { cat: "us",     symbol: "NASDAQ:AAPL",   label: "苹果",       qty: "10",  cost: "220" },
    { cat: "us",     symbol: "NASDAQ:TSLA",   label: "特斯拉",     qty: "20",  cost: "300" },
    { cat: "cn",     symbol: "SSE:600519",    label: "贵州茅台",   qty: "5",   cost: "1500" },
    { cat: "cn",     symbol: "SZSE:000858",   label: "五粮液",     qty: "100", cost: "130" },
    { cat: "crypto", symbol: "BINANCE:BTCUSDT", label: "比特币",   qty: "0.5", cost: "60000" },
    { cat: "crypto", symbol: "BINANCE:ETHUSDT", label: "以太坊",   qty: "5",   cost: "3000" },
    { cat: "gold",   symbol: "TVC:GOLD",      label: "现货黄金",   qty: "100", cost: "550" },
  ];

  let state = null;
  let formCat = "us";
  const prices = {};   // symbol -> { price, change }
  let fx = null;       // { rate, fallback }
  let lastSuccessAt = null;   // 最近一次真正取到行情的毫秒时间戳（区分"发起刷新"和"拿到数据"）
  let lastAttemptAt = 0;      // 最近一次发起 scanner 刷新的时间戳，用于判断最近一次是否失败
  let priceTimer = null;      // 主行情定时器句柄
  let tdTimer = null;         // 美股实时行情定时器句柄
  let suggestResults = [];
  let suggestIndex = -1;

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function trunc(s, n) {
    const v = String(s == null ? "" : s);
    return v.length > n ? v.slice(0, n) : v;
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function $(sel) { return document.querySelector(sel); }

  // 统计显示货币（"CNY" | "USD"），金额函数收到的参数一律是「人民币」金额，这里再换算。
  function curSymbol() {
    return (state && state.currency === "USD") ? "$" : "¥";
  }

  function inDisplay(nCNY) {
    if (state && state.currency === "USD") {
      const rate = (fx && isFinite(fx.rate)) ? fx.rate : FALLBACK_USDCNY;
      return nCNY / rate;
    }
    return nCNY;
  }

  function fmtMoney(nCNY) {
    const v = inDisplay(nCNY);
    return curSymbol() + " " + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtCompact(nCNY) {
    const v = inDisplay(nCNY);
    const s = curSymbol();
    if (v >= 1e8) return s + " " + (v / 1e8).toFixed(2) + " 亿";
    if (v >= 1e4) return s + " " + (v / 1e4).toFixed(2) + " 万";
    return s + " " + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtSigned(nCNY) {
    const sign = nCNY > 0 ? "+" : nCNY < 0 ? "-" : "";
    const v = inDisplay(Math.abs(nCNY));
    return sign + curSymbol() + " " + v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function agoText(ms) {
    if (!isFinite(ms)) return "很久前";
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return mins + " 分钟前";
    const h = Math.floor(mins / 60);
    if (h < 24) return h + " 小时前";
    return Math.floor(h / 24) + " 天前";
  }

  /* ---------------- 存储 ---------------- */

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function normalize(data) {
    const all = Array.isArray(data && data.holdings) ? data.holdings : [];
    const holdings = all
      .map(function (h) {
        return {
          id: h.id || genId(),
          cat: CATS[h.cat] ? h.cat : "us",
          symbol: trunc(String(h.symbol || "").trim(), MAX_FIELD_LEN),
          label: trunc(String(h.label || "").trim(), MAX_FIELD_LEN),
          qty: String(h.qty || "").trim(),
          cost: String(h.cost || "").trim(),
        };
      })
      .filter(function (h) { return h.symbol; })
      .slice(0, MAX_HOLDINGS);

    if (all.length > MAX_HOLDINGS) toast("仅导入前 " + MAX_HOLDINGS + " 条（超出已丢弃）");

    return {
      theme: data && data.theme === "light" ? "light" : "dark",
      currency: data && data.currency === "USD" ? "USD" : "CNY",
      tdKey: data && typeof data.tdKey === "string" ? data.tdKey : "",
      refreshSec: REFRESH_OPTIONS.indexOf(data && Number(data.refreshSec)) >= 0 ? Number(data.refreshSec) : REFRESH_DEFAULT,
      holdings: holdings,
    };
  }

  function load() {
    const raw = safeGet(STORAGE_KEY);
    if (raw) {
      try { return normalize(JSON.parse(raw)); } catch (e) {}
    }
    return normalize({
      theme: "dark",
      holdings: EXAMPLES.map(function (h) { return Object.assign({ id: genId() }, h); }),
    });
  }

  /* ---------------- 行情抓取（TradingView scanner） ---------------- */

  // 对 scanner POST 做一次轻量重试：失败后等 2.5s 再试一次，再失败就交给调用方等下个周期。
  // 减少偶发网络抖动造成的「未计入」闪烁。
  async function postScan(region, body) {
    async function attempt() {
      const res = await fetch(SCANNER + region + "/scan", {
        method: "POST",
        // 不显式设 Content-Type，浏览器会用 text/plain，避免触发 CORS 预检失败。
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("scanner " + res.status);
      return res.json();
    }
    try {
      return await attempt();
    } catch (e) {
      await new Promise(function (r) { setTimeout(r, 2500); });
      return await attempt();
    }
  }

  async function fetchSymbol(symbol, region) {
    try {
      const json = await postScan(region, {
        symbols: { tickers: [symbol], query: { types: [] } },
        columns: ["name", "close", "change"],
      });
      const row = json && json.data && json.data[0];
      if (row && row.d && isFinite(row.d[1])) return { price: row.d[1], change: row.d[2] };
      return null;
    } catch (e) {
      return null;
    }
  }

  // 批量查询：一次请求取回同一区域内的多个符号，按返回行的 s（符号名）对应回结果，
  // 大幅减少请求数，从而允许更快的刷新间隔而不被限流。
  async function fetchBatch(region, symbols) {
    if (!symbols || !symbols.length) return {};
    try {
      const json = await postScan(region, {
        symbols: { tickers: symbols, query: { types: [] } },
        columns: ["name", "close", "change"],
      });
      const out = {};
      (json && json.data ? json.data : []).forEach(function (row) {
        if (row && row.s && row.d && isFinite(row.d[1])) {
          out[row.s] = { price: row.d[1], change: row.d[2] };
        }
      });
      return out;
    } catch (e) {
      return {};
    }
  }

  // 根据交易所前缀决定 scanner 区域，找不到就用类别默认区域。
  function regionFor(symbol) {
    const ex = String(symbol).split(":")[0].toUpperCase();
    const MAP = {
      BINANCE: "crypto", COINBASE: "crypto", BITSTAMP: "crypto", KRAKEN: "crypto",
      BITFINEX: "crypto", HUOBI: "crypto", OKX: "crypto", BYBIT: "crypto",
      GATEIO: "crypto", KUCOIN: "crypto", CRYPTO: "crypto",
      NASDAQ: "america", NYSE: "america", AMEX: "america", ARCA: "america", BATS: "america",
      CME: "america", CBOT: "america", NYMEX: "america",
      SSE: "china", SZSE: "china", HKEX: "hong_kong",
      OANDA: "forex", FX: "forex", FOREXCOM: "forex", FX_IDC: "forex",
      TVC: "cfd", CAPITALCOM: "cfd",
    };
    return MAP[ex] || null;
  }

  /* ---------------- 美股实时行情（Twelve Data） ----------------
   * TradingView scanner 对美股返回约 15 分钟延迟数据；Twelve Data 免费版是实时美股，
   * 但按符号计 800 积分/天。因此美股单独走这里（刷新节奏更慢），其余资产仍走 scanner。 */

  // NASDAQ:AAPL -> AAPL ; NYSE:BRK.B -> BRK.B（去掉交易所前缀，Twelve Data 只认裸 ticker）
  function toTDSymbol(symbol) {
    const parts = String(symbol).split(":");
    return parts[parts.length - 1];
  }

  function fetchTD(symbols) {
    if (!state.tdKey || !symbols.length) return Promise.resolve({});
    // 逐个转义再以逗号拼接：encodeURIComponent 会把逗号转成 %2C，必须保留逗号分隔符。
    const q = symbols.map(function (s) { return encodeURIComponent(toTDSymbol(s)); }).join(",");
    return fetch(TD_BASE + "?symbol=" + q + "&apikey=" + encodeURIComponent(state.tdKey))
      .then(function (res) { return res.ok ? res.json() : Promise.reject(); })
      .then(function (json) {
        const out = {};
        // 多符号返回数组，单符号返回对象
        const list = Array.isArray(json) ? json : [json];
        list.forEach(function (r) {
          if (r && r.symbol && isFinite(parseFloat(r.close)) && isFinite(parseFloat(r.percent_change))) {
            // 用原始符号（带交易所前缀）作为 prices 的 key，需反向匹配
            const full = symbols.find(function (s) { return toTDSymbol(s) === r.symbol; });
            if (full) out[full] = { price: parseFloat(r.close), change: parseFloat(r.percent_change) };
          }
        });
        return out;
      })
      .catch(function () { return {}; });
  }

  function refreshTD() {
    if (!state.tdKey || document.hidden) return Promise.resolve();
    const seen = {};
    const syms = [];
    state.holdings.forEach(function (h) {
      if (seen[h.symbol]) return;
      if (CATS[h.cat] && CATS[h.cat].region === "america") {
        seen[h.symbol] = true;
        syms.push(h.symbol);
      }
    });
    if (!syms.length) return Promise.resolve();
    return fetchTD(syms).then(function (m) {
      Object.keys(m).forEach(function (sym) { prices[sym] = m[sym]; });
      renderLive();
      renderSummary();
      if (Object.keys(m).length) lastSuccessAt = Date.now(); // 真实拿到实时数据才更新
    });
  }

  function refreshPrices() {
    // 按交易所区域分组去重，每个区域发一次批量请求，替代「每个持仓一个请求」。
    lastAttemptAt = Date.now();
    const seen = {};
    const byRegion = {};
    state.holdings.forEach(function (h) {
      if (seen[h.symbol]) return;
      // 已接入实时接口时，美股（america 区）不在 scanner 抓取，避免 15 分钟延迟数据覆盖实时值。
      if (state.tdKey && CATS[h.cat] && CATS[h.cat].region === "america") return;
      seen[h.symbol] = true;
      const region = regionFor(h.symbol) || (CATS[h.cat] && CATS[h.cat].region) || "america";
      (byRegion[region] = byRegion[region] || []).push(h.symbol);
    });

    return Promise.all(Object.keys(byRegion).map(function (region) {
      return fetchBatch(region, byRegion[region])
        .then(function (m) {
          Object.keys(m).forEach(function (sym) { prices[sym] = m[sym]; });
        })
        .catch(function () {});
    })).then(function () {
      return fetchSymbol("FX_IDC:USDCNY", "forex");
    }).then(function (p) {
      fx = p ? { rate: p.price, fallback: false } : { rate: FALLBACK_USDCNY, fallback: true };
      if (p) lastSuccessAt = Date.now(); // 汇率取到即认为本轮成功
    }).catch(function () {
      fx = { rate: FALLBACK_USDCNY, fallback: true };
    }).then(function () {
      renderLive();
      renderSummary();
    });
  }

  // 按用户选择的频率启动/重置两个定时器；改频率时清旧的重开。
  function applyInterval() {
    const sec = (state && REFRESH_OPTIONS.indexOf(state.refreshSec) >= 0) ? state.refreshSec : REFRESH_DEFAULT;
    clearInterval(priceTimer);
    clearInterval(tdTimer);
    priceTimer = setInterval(refreshPrices, sec * 1000);
    tdTimer = setInterval(refreshTD, sec * 1000);
  }

  /* ---------------- 估值 ---------------- */

  function valueCNY(h) {
    const qty = parseFloat(h.qty);
    if (!isFinite(qty)) return null;
    const p = prices[h.symbol];
    if (!p || !isFinite(p.price)) return null;
    const cat = CATS[h.cat] || CATS.us;
    if (cat.currency === "CNY") return qty * p.price;
    if (!fx || !isFinite(fx.rate)) return null;
    if (h.cat === "gold") return qty * (p.price * fx.rate / GOLD_GRAMS_PER_OUNCE); // 按克
    return qty * p.price * fx.rate;
  }

  // 本金（成本）：数量 × 成本价，换算成人民币。黄金的成本价按「元/克」记，A股按人民币，美股/虚拟币按美元。
  function costCNY(h) {
    const qty = parseFloat(h.qty);
    if (!isFinite(qty)) return null;
    const cost = parseFloat(h.cost);
    if (!isFinite(cost)) return null;
    const cat = CATS[h.cat] || CATS.us;
    if (cat.currency === "CNY") return qty * cost; // A股：成本已是人民币
    if (h.cat === "gold") return qty * cost;       // 黄金：数量(克) × 成本(元/克)
    if (!fx || !isFinite(fx.rate)) return null;
    return qty * cost * fx.rate;                    // 美股/虚拟币：美元成本 × 汇率
  }

  // 今日涨跌（人民币）：用实时涨跌幅反推昨收，算每个持仓今天的变动。
  function dayChangeCNY(h) {
    const qty = parseFloat(h.qty);
    if (!isFinite(qty)) return null;
    const p = prices[h.symbol];
    if (!p || !isFinite(p.price) || !isFinite(p.change)) return null;
    const prevClose = p.price / (1 + p.change / 100);
    const diff = p.price - prevClose;
    const cat = CATS[h.cat] || CATS.us;
    if (cat.currency === "CNY") return qty * diff;
    if (!fx || !isFinite(fx.rate)) return null;
    if (h.cat === "gold") return qty * diff * fx.rate / GOLD_GRAMS_PER_OUNCE;
    return qty * diff * fx.rate;
  }

  /* ---------------- TradingView widget ---------------- */

  function mountWidget(container, file, config) {
    container.classList.add("tradingview-widget-container");
    container.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    container.appendChild(inner);
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.async = true;
    s.src = TV_EMBED + file + ".js";
    s.textContent = JSON.stringify(config);
    container.appendChild(s);
  }

  function quoteConfig(h) {
    return {
      symbol: h.symbol,
      width: "100%",
      height: 220,
      isTransparent: true,
      colorTheme: state.theme,
      locale: "zh_CN",
      dateRange: "1D",
      largeChartUrl: "",
    };
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    renderGrid();
  }

  function cardHTML(h) {
    const cat = CATS[h.cat] || CATS.us;
    const meta = [];
    if (h.qty) meta.push("<b>" + esc(h.qty) + "</b> 份");
    if (h.cost) meta.push("成本 <b>" + esc(h.cost) + "</b>");

    return (
      '<article class="card" data-id="' + esc(h.id) + '">' +
        '<div class="card__head">' +
          '<span class="badge" style="background:' + cat.color + ';color:#fff">' + esc(cat.name) + "</span>" +
          '<div class="card__titles">' +
            '<div class="card__title">' + esc(h.label || h.symbol) + "</div>" +
            '<div class="card__sym">' + esc(h.symbol) + "</div>" +
          "</div>" +
          '<div class="card__head-right">' +
            '<button class="card__menu" data-action="edit" title="编辑">✎</button>' +
            '<button class="card__menu" data-action="del" title="删除">×</button>' +
          "</div>" +
        "</div>" +
        '<div class="card__quote"><div class="quote-host" data-id="' + esc(h.id) + '"></div></div>' +
        '<div class="card__live"><span class="live-price">现价 加载中…</span><span class="live-val">市值 —</span></div>' +
        '<div class="card__pnl"><span class="pnl-cost">本金 —</span><span class="pnl-profit">盈亏 —</span></div>' +
        '<div class="card__foot">' +
          '<div class="card__meta">' + (meta.join(" · ") || "—") + "</div>" +
          '<div class="card__foot-right">' +
            '<button class="btn btn--ghost btn--sm" data-action="chart">图表</button>' +
          "</div>" +
        "</div>" +
      "</article>"
    );
  }

  function renderGrid() {
    const grid = $("#grid");
    const empty = $("#empty");
    grid.innerHTML = "";

    if (!state.holdings.length) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    CAT_ORDER.forEach(function (cat) {
      const items = state.holdings.filter(function (h) { return h.cat === cat; });
      if (!items.length) return;
      const section = document.createElement("section");
      section.className = "cat-section";
      section.innerHTML =
        '<header class="cat-section__head">' +
          '<span class="cat-section__dot" style="background:' + CATS[cat].color + '"></span>' +
          '<h3 class="cat-section__name">' + CATS[cat].name + "</h3>" +
          '<span class="cat-section__count">' + items.length + " 项</span>" +
          '<span class="cat-section__total" data-cat-total="' + cat + '">—</span>' +
        "</header>" +
        '<div class="cat-section__row">' + items.map(cardHTML).join("") + "</div>";
      grid.appendChild(section);
    });

    grid.querySelectorAll(".quote-host").forEach(function (host) {
      const h = state.holdings.find(function (x) { return x.id === host.dataset.id; });
      if (h) mountWidget(host, "embed-widget-mini-symbol-overview", quoteConfig(h));
    });
  }

  function renderLive() {
    document.querySelectorAll(".card").forEach(function (card) {
      const h = state.holdings.find(function (x) { return x.id === card.dataset.id; });
      if (!h) return;
      const live = card.querySelector(".card__live");
      if (!live) return;
      const p = prices[h.symbol];
      const hasPrice = p && isFinite(p.price);
      const hasQty = isFinite(parseFloat(h.qty));
      const v = valueCNY(h);

      let left, right;
      if (!hasPrice) {
        left = "无行情";
        right = "未计入";
      } else if (!hasQty) {
        left = "现价 " + p.price.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
        right = "未填数量";
      } else {
        left = "现价 " + p.price.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
        right = "市值 " + fmtMoney(v);
      }
      live.innerHTML =
        '<span class="live-price">' + left + "</span>" +
        '<span class="live-val">' + right + "</span>";

      // 成本 / 盈亏 / 盈亏比例
      const pnl = card.querySelector(".card__pnl");
      if (pnl) {
        const pnlCost = pnl.querySelector(".pnl-cost");
        const pnlProfit = pnl.querySelector(".pnl-profit");
        const c = costCNY(h);
        const v = valueCNY(h);
        if (c != null && v != null) {
          const prof = v - c;
          const pct = c > 0 ? (prof / c) * 100 : 0;
          pnlCost.textContent = "本金 " + fmtCompact(c);
          pnlProfit.textContent = "盈亏 " + fmtSigned(prof) + " (" + (prof > 0 ? "+" : "") + pct.toFixed(2) + "%)";
          pnlProfit.className = "pnl-profit" + (prof > 0 ? " change-up" : prof < 0 ? " change-down" : "");
        } else {
          pnlCost.textContent = "本金 —";
          pnlProfit.textContent = "盈亏 —";
          pnlProfit.className = "pnl-profit";
        }
      }
    });
  }

  /* ---------------- 总资产汇总 ---------------- */

  function renderSummary() {
    const summary = $("#summary");
    if (!state.holdings.length) { summary.hidden = true; return; }
    summary.hidden = false;

    const totals = { us: 0, cn: 0, crypto: 0, gold: 0 };
    let total = 0;
    state.holdings.forEach(function (h) {
      const v = valueCNY(h);
      if (v != null) { totals[h.cat] += v; total += v; }
    });

    let dayChange = 0;
    state.holdings.forEach(function (h) {
      const d = dayChangeCNY(h);
      if (d != null) dayChange += d;
    });

    $("#sum-total").textContent = total > 0 ? fmtCompact(total) : curSymbol() + " 0";

    const prevTotal = total - dayChange;
    let changeText = "今日 " + fmtSigned(dayChange);
    if (prevTotal > 0) {
      changeText += " (" + (dayChange > 0 ? "+" : "") + ((dayChange / prevTotal) * 100).toFixed(2) + "%)";
    }
    const changeEl = $("#sum-change");
    changeEl.textContent = changeText;
    changeEl.className = "summary__change" + (dayChange > 0 ? " change-up" : dayChange < 0 ? " change-down" : "");

    // 本金 / 盈亏
    let totalCost = 0, profit = 0, profitCost = 0;
    state.holdings.forEach(function (h) {
      const c = costCNY(h);
      if (c == null) return;
      totalCost += c;
      const v = valueCNY(h);
      if (v != null) { profit += v - c; profitCost += c; }
    });
    $("#sum-principal").textContent = "本金 " + (totalCost > 0 ? fmtCompact(totalCost) : "—");
    const profitEl = $("#sum-profit");
    if (profitCost > 0) {
      const pct = (profit / profitCost) * 100;
      profitEl.textContent = "盈亏 " + fmtSigned(profit) + " (" + (profit > 0 ? "+" : "") + pct.toFixed(2) + "%)";
      profitEl.className = "summary__profit" + (profit > 0 ? " change-up" : profit < 0 ? " change-down" : "");
    } else {
      profitEl.textContent = "盈亏 —";
      profitEl.className = "summary__profit";
    }

    // 环形图
    const R = 80, CX = 100, CY = 100, CIRC = 2 * Math.PI * R;
    let inner = '<circle class="donut-track" cx="100" cy="100" r="80" fill="none" stroke-width="26"></circle>';
    let offset = 0;
    if (total > 0) {
      CAT_ORDER.forEach(function (c) {
        const v = totals[c];
        if (!v || v <= 0) return;
        const len = (v / total) * CIRC;
        inner +=
          '<circle cx="100" cy="100" r="80" fill="none" stroke="' + CATS[c].color + '" stroke-width="26"' +
          ' stroke-dasharray="' + len + " " + (CIRC - len) + '"' +
          ' stroke-dashoffset="' + (-offset) + '"' +
          ' transform="rotate(-90 100 100)"></circle>';
        offset += len;
      });
    }
    $("#donut").innerHTML = inner;

    // 图例
    $("#legend").innerHTML = CAT_ORDER.map(function (c) {
      const v = totals[c];
      const pct = total > 0 ? Math.round((v / total) * 100) : 0;
      return (
        '<li class="legend__item">' +
          '<span class="legend__dot" style="background:' + CATS[c].color + '"></span>' +
          '<span class="legend__name">' + CATS[c].name + "</span>" +
          '<span class="legend__val">' + fmtMoney(v) + "</span>" +
          '<span class="legend__pct">' + pct + "%</span>" +
        "</li>"
      );
    }).join("");

    // 各分类区块的小计
    CAT_ORDER.forEach(function (c) {
      const el = document.querySelector('[data-cat-total="' + c + '"]');
      if (el) el.textContent = fmtCompact(totals[c]);
    });

    // 元信息
    let meta;
    if (!fx) {
      meta = "加载行情中…";
    } else {
      meta = "1 美元 ≈ " + fx.rate.toFixed(4) + " 人民币" + (fx.fallback ? "（估算）" : "") + " · ";
      // 用真正拿到数据的时间戳，而不是本次渲染时间；最近一次刷新失败时如实提示数据有多旧。
      const failed = !lastSuccessAt || lastAttemptAt > lastSuccessAt;
      if (failed) {
        meta += lastSuccessAt
          ? "价格获取失败，显示的是 " + agoText(Date.now() - lastSuccessAt) + " 的数据"
          : "价格获取失败（暂未取得数据）";
      } else {
        meta += "更新于 " + new Date(lastSuccessAt).toLocaleTimeString("zh-CN", { hour12: false });
      }
      if (state.tdKey) meta += " · 美股已接入实时";
      const excluded = state.holdings.length - state.holdings.filter(function (h) { return valueCNY(h) != null; }).length;
      if (excluded > 0) meta += " · " + excluded + " 项未计入（缺数量或无行情）";
      else if (total === 0) meta += " · 填写持仓数量后自动计算总资产";
    }
    $("#sum-meta").textContent = meta;
  }

  /* ---------------- 弹窗 ---------------- */

  function openModal(id) {
    const m = document.getElementById(id);
    m.hidden = false;
    document.body.style.overflow = "hidden";
    if (id === "modal-backup") {
      $("#backup-area").value = JSON.stringify(state, null, 2);
    }
  }

  function closeModal(id) {
    document.getElementById(id).hidden = true;
    document.body.style.overflow = "";
    if (id === "modal-chart") $("#chart-host").innerHTML = "";
  }

  /* ---------------- 持仓操作 ---------------- */

  function deleteHolding(id) {
    const h = state.holdings.find(function (x) { return x.id === id; });
    const name = h ? (h.label || h.symbol) : "这条持仓";
    if (!window.confirm("删除「" + name + "」？")) return;
    state.holdings = state.holdings.filter(function (x) { return x.id !== id; });
    save();
    render();
    renderSummary();
    toast("已删除「" + name + "」");
  }

  function openEdit(id) {
    const h = state.holdings.find(function (x) { return x.id === id; });
    if (!h) return;
    $("#edit-title").textContent = "编辑持仓";
    $("#f-id").value = h.id;
    $("#f-label").value = h.label;
    $("#f-symbol").value = h.symbol;
    $("#f-qty").value = h.qty;
    $("#f-cost").value = h.cost;
    selectCat(h.cat);
    openModal("modal-edit");
  }

  function resetForm() {
    $("#edit-title").textContent = "添加持仓";
    $("#f-id").value = "";
    $("#f-label").value = "";
    $("#f-symbol").value = "";
    $("#f-qty").value = "";
    $("#f-cost").value = "";
  }

  function openChart(id) {
    const h = state.holdings.find(function (x) { return x.id === id; });
    if (!h) return;
    $("#chart-title").textContent = (h.label || h.symbol) + " · " + h.symbol;
    openModal("modal-chart");
    mountWidget($("#chart-host"), "embed-widget-advanced-chart", {
      autosize: true,
      symbol: h.symbol,
      interval: "D",
      timezone: "Asia/Shanghai",
      theme: state.theme,
      style: "1",
      locale: "zh_CN",
      allow_symbol_change: true,
      support_host: "https://www.tradingview.com",
    });
  }

  /* ---------------- 表单分类 ---------------- */

  function renderCats() {
    const wrap = $("#f-cats");
    wrap.innerHTML = "";
    Object.keys(CATS).forEach(function (key) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cat-btn";
      b.textContent = CATS[key].name;
      b.dataset.cat = key;
      b.addEventListener("click", function () { selectCat(key); });
      wrap.appendChild(b);
    });
  }

  function selectCat(key) {
    formCat = key;
    document.querySelectorAll("#f-cats .cat-btn").forEach(function (b) {
      const on = b.dataset.cat === key;
      b.classList.toggle("is-active", on);
      b.style.background = on ? CATS[key].color : "";
      b.style.color = on ? "#fff" : "";
    });
    $("#f-symbol-hint").textContent = SYMBOL_HINTS[key];
    $("#f-qty-label").textContent = CATS[key].qtyUnit ? "数量（" + CATS[key].qtyUnit + "）" : "数量（可选）";
    $("#f-cost-label").textContent = "成本价（可选，" + (CATS[key].costUnit || "本币") + "）";
  }

  /* ---------------- 符号自动联想 ---------------- */

  function showSuggest(query) {
    const q = query.trim().toLowerCase();
    const box = $("#symbol-suggest");
    if (!q) { hideSuggest(); return; }
    const db = window.SYMBOL_DB || [];
    suggestResults = db
      .filter(function (e) {
        return e[0].toLowerCase().indexOf(q) !== -1 || e[1].toLowerCase().indexOf(q) !== -1;
      })
      .sort(function (a, b) {
        const ap = a[0].toLowerCase().indexOf(q) === 0 ? 0 : 1;
        const bp = b[0].toLowerCase().indexOf(q) === 0 ? 0 : 1;
        return ap - bp;
      })
      .slice(0, 8);
    suggestIndex = -1;
    if (!suggestResults.length) { hideSuggest(); return; }

    box.innerHTML = suggestResults.map(function (m, i) {
      const cat = CATS[m[2]] || CATS.us;
      return (
        '<button type="button" class="suggest__item" data-i="' + i + '">' +
          '<span class="suggest__id">' + esc(m[0]) + "</span>" +
          '<span class="suggest__name">' + esc(m[1]) + "</span>" +
          '<span class="suggest__cat" style="background:' + cat.color + '">' + esc(cat.name) + "</span>" +
        "</button>"
      );
    }).join("");
    box.hidden = false;
  }

  function hideSuggest() {
    $("#symbol-suggest").hidden = true;
    suggestResults = [];
    suggestIndex = -1;
  }

  function pickSuggest(m) {
    $("#f-symbol").value = m[0];
    if (!$("#f-label").value.trim()) $("#f-label").value = m[1];
    selectCat(m[2]);
    hideSuggest();
  }

  function highlightSuggest(items) {
    items.forEach(function (it, idx) {
      it.classList.toggle("is-active", idx === suggestIndex);
    });
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    $('meta[name="theme-color"]').setAttribute(
      "content",
      state.theme === "dark" ? "#0e1117" : "#f4f6fa"
    );
  }

  function updateCurrencyBtn() {
    const b = $("#btn-currency");
    if (b) b.textContent = (state && state.currency === "USD") ? "$" : "¥";
  }

  /* ---------------- Toast ---------------- */

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    $("#btn-add").addEventListener("click", function () {
      resetForm();
      openModal("modal-edit");
    });
    $("#btn-empty-add").addEventListener("click", function () {
      resetForm();
      openModal("modal-edit");
    });

    $("#btn-theme").addEventListener("click", function () {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme();
      save();
      render();
      renderSummary();
    });

    $("#btn-currency").addEventListener("click", function () {
      state.currency = state.currency === "USD" ? "CNY" : "USD";
      save();
      updateCurrencyBtn();
      render();
      renderLive();
      renderSummary();
    });

    $("#btn-settings").addEventListener("click", function () {
      $("#td-key").value = state.tdKey || "";
      $("#f-refresh").value = String((state && REFRESH_OPTIONS.indexOf(state.refreshSec) >= 0) ? state.refreshSec : REFRESH_DEFAULT);
      openModal("modal-settings");
    });
    $("#settings-form").addEventListener("submit", function (e) {
      e.preventDefault();
      state.tdKey = $("#td-key").value.trim();
      state.refreshSec = parseInt($("#f-refresh").value, 10) || REFRESH_DEFAULT;
      save();
      applyInterval();
      closeModal("modal-settings");
      toast(state.tdKey ? "已接入美股实时行情" : "已清除，美股回到延迟行情");
      refreshPrices();
      refreshTD();
    });

    $("#btn-refresh").addEventListener("click", function () {
      $("#sum-meta").textContent = "刷新中…";
      refreshPrices();
    });

    $("#btn-backup").addEventListener("click", function () { openModal("modal-backup"); });
    $("#backup-export").addEventListener("click", function () {
      $("#backup-area").value = JSON.stringify(state, null, 2);
      toast("已导出到文本框");
    });
    $("#backup-copy").addEventListener("click", function () {
      const text = $("#backup-area").value || JSON.stringify(state, null, 2);
      navigator.clipboard.writeText(text).then(
        function () { toast("已复制到剪贴板"); },
        function () { toast("复制失败，请手动复制"); }
      );
    });
    $("#backup-download").addEventListener("click", function () {
      const json = JSON.stringify(state, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "investtracker-holdings-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast("已下载 JSON 文件");
    });
    $("#backup-import").addEventListener("click", function () {
      try {
        const data = JSON.parse($("#backup-area").value);
        state = normalize(data);
        save();
        applyTheme();
        render();
        closeModal("modal-backup");
        toast("导入成功");
        refreshPrices();
      } catch (e) {
        toast("导入失败：JSON 格式不正确");
      }
    });

    $("#edit-form").addEventListener("submit", function (e) {
      e.preventDefault();
      const id = $("#f-id").value;
      const symbol = $("#f-symbol").value.trim();
      const label = $("#f-label").value.trim();
      const qty = $("#f-qty").value.trim();
      const cost = $("#f-cost").value.trim();

      if (!symbol) { toast("请填写 TradingView 代码"); return; }

      if (id) {
        const h = state.holdings.find(function (x) { return x.id === id; });
        if (h) Object.assign(h, { cat: formCat, symbol: symbol, label: label, qty: qty, cost: cost });
      } else {
        state.holdings.push({ id: genId(), cat: formCat, symbol: symbol, label: label, qty: qty, cost: cost });
      }
      save();
      render();
      closeModal("modal-edit");
      toast(id ? "已更新" : "已添加");
      refreshPrices();
    });

    $("#f-symbol").addEventListener("input", function () {
      showSuggest(this.value);
    });
    $("#f-symbol").addEventListener("keydown", function (e) {
      const items = $("#symbol-suggest").querySelectorAll(".suggest__item");
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        suggestIndex = (suggestIndex + 1) % items.length;
        highlightSuggest(items);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        suggestIndex = (suggestIndex - 1 + items.length) % items.length;
        highlightSuggest(items);
      } else if (e.key === "Enter") {
        if (suggestIndex >= 0 && suggestResults[suggestIndex]) {
          e.preventDefault();
          pickSuggest(suggestResults[suggestIndex]);
        }
      } else if (e.key === "Escape") {
        hideSuggest();
      }
    });
    $("#symbol-suggest").addEventListener("mousedown", function (e) {
      const btn = e.target.closest(".suggest__item");
      if (!btn) return;
      const i = parseInt(btn.dataset.i, 10);
      if (suggestResults[i]) pickSuggest(suggestResults[i]);
    });

    $("#grid").addEventListener("click", function (e) {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const card = btn.closest(".card");
      if (!card) return;
      const id = card.dataset.id;
      if (btn.dataset.action === "del") deleteHolding(id);
      else if (btn.dataset.action === "edit") openEdit(id);
      else if (btn.dataset.action === "chart") openChart(id);
    });

    document.addEventListener("click", function (e) {
      const c = e.target.closest("[data-close]");
      if (c) closeModal(c.dataset.close);
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".suggest-wrap")) hideSuggest();
    });

    $("#hint-close").addEventListener("click", function () {
      try { localStorage.setItem(HINT_DISMISS_KEY, "1"); } catch (e) {}
      $("#hint").classList.add("hidden");
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    const hadData = !!safeGet(STORAGE_KEY);
    state = load();
    applyTheme();
    updateCurrencyBtn();
    renderCats();
    selectCat("us");
    bindEvents();
    render();
    renderSummary();
    refreshPrices();
    refreshTD();
    applyInterval();
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { refreshPrices(); refreshTD(); }
    });
    if (!hadData && !safeGet(HINT_DISMISS_KEY)) $("#hint").classList.remove("hidden");
  }

  init();
})();

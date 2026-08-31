# InvestTracker · 个人投资行情面板（静态版）

一个**零后端、零构建**的纯静态单页应用，用 [TradingView 免费 widget](https://www.tradingview.com/widget/) 展示美股、A股、虚拟币、黄金的**实时行情**。电脑和手机浏览器都能打开，可直接部署到 GitHub Pages。

> 与仓库根目录的 `backend/`（FastAPI）和 `mobile/`（Flutter）是两套独立的方案。本目录是那个「非常简单、只展示实时行情」的轻量版本。

## 功能

- 实时行情：每个持仓一张卡片，内嵌 TradingView 实时价格 + 涨跌 + 迷你走势；顶部一条滚动行情带。
- 四大类：美股 / A股 / 虚拟币 / 黄金，卡片带分类色标。
- 点「图表」弹出一个完整 K 线图（可切换品种/周期）。
- 深浅色主题切换。
- 持仓在网页上直接增删改，数据存在浏览器 `localStorage`。
- 备份 / 导入：导出 JSON，在电脑和手机之间手动同步。

## 本地测试

不需要安装任何依赖。两种方式任选：

**方式一（推荐，最接近 GitHub Pages 行为）：**

```bash
cd dashboard
python3 -m http.server 8000
```

然后浏览器打开 <http://localhost:8000>。

**方式二：** 直接双击 `index.html` 用浏览器打开（`file://` 也能运行）。

> 首次打开会载入 7 条示例持仓，方便确认行情正常加载；点卡片右上角 `×` 逐个删除，删完即可添加自己的。

## 添加持仓：TradingView 代码格式

每个标的需要一个 TradingView 代码，格式为 `交易所:代码`：

| 类别   | 格式                | 示例                          |
| ------ | ------------------- | ----------------------------- |
| 美股   | `NASDAQ:代码` / `NYSE:代码` | `NASDAQ:AAPL`、`NYSE:BABA`    |
| A股    | `SSE:代码`（沪）/ `SZSE:代码`（深） | `SSE:600519`、`SZSE:000858`   |
| 虚拟币 | `BINANCE:代码`       | `BINANCE:BTCUSDT`、`BINANCE:ETHUSDT` |
| 黄金   | `TVC:GOLD` / `COMEX:GC1!` | `TVC:GOLD`（现货）、`COMEX:GC1!`（期货） |

不确定代码时，去 <https://www.tradingview.com> 搜索你的标的，打开后浏览器地址栏里 `symbols/` 后面那段就是代码（例如 `NASDAQ-AAPL` 对应 `NASDAQ:AAPL`，把 `-` 换成 `:` 即可）。

## 部署到 GitHub Pages

1. 把本仓库推到一个 GitHub 仓库。
2. 仓库 **Settings → Pages**，在 **Build and deployment** 里：
   - Source 选 **Deploy from a branch**
   - Branch 选 `main`，目录选 **`/docs`**（或先把 `dashboard/` 改名/复制为 `docs/`）
3. 保存后 GitHub 会给出形如 `https://<用户名>.github.io/<仓库名>/` 的地址。

> 因为这是纯静态站点，`index.html` 里引用的 `styles.css` / `app.js` 都是**相对路径**，所以放在 `/docs` 子目录（即仓库子路径）下也能正常加载。

## 注意事项

- 行情来自 TradingView 免费 widget，仅供个人查看，**不作为下单依据**（A股行情受交易所源影响可能有延迟）。
- 持仓数据存在浏览器本地，**换设备不自动同步**；用「备份」导出一份 JSON，在另一台设备「导入」即可。
- 免费版 widget 需要联网，且每个卡片是一个 iframe，持仓很多时加载会稍慢。

## License

[MIT](LICENSE) © 2026 RimuruTempest0

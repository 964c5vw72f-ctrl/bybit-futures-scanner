# Bybit Futures Scanner

[Open the scanner](https://964c5vw72f-ctrl.github.io/bybit-futures-scanner/) in Safari on iPhone. To create a shortcut, use **Share → Add to Home Screen**. The free page starts scanning when opened. It uses Bybit's public V5 market endpoints with no API keys, account login or orders.

## Browser scanner

GitHub Pages publishes `main:/docs`. The browser scans trading USDT perpetuals returned by a reachable official Bybit host with at least 1 million USDT in 24h turnover. A scan uses one host and one set of closed five-minute candles. Up to ten setups per side appear in descending score order, LONG first. Thin markets and incomplete or stale data cannot receive READY TO REVIEW.

- **EARLY** means recent turnover buildup with unconfirmed momentum.
- **WAIT** gives the reason a setup failed a screening check.
- **READY TO REVIEW** requires aligned 5m and 15m momentum, volume and RSI confirmation, complete fresh data, and passing quote checks.

The quote panel uses actual Bybit best bid and ask with the exchange API response timestamp. Quotes refresh every ten seconds and the full scan runs after each five-minute candle closes while the page is visible. The displayed R:R uses ask for LONG or bid for SHORT against candle-derived stop and target estimates. It excludes execution costs. Scores rank heuristic setups and do not measure win probability. If Bybit does not serve public futures to the device's network, the scanner reports the failure and retries.

[GYLEX watchlist](https://964c5vw72f-ctrl.github.io/bybit-futures-scanner/?market=gylex) starts with 82 USDT perpetual symbols supplied from the app. Use **Import GYLEX futures list** to replace the starter list in one paste. The browser keeps the list on the device and scans its overlap with eligible Bybit perpetuals. All candles, quotes and screening come from Bybit, so verify the corresponding contract and execution price in GYLEX.

## Local checks

```sh
node --check docs/scanner.js
node --test tests/scanner.test.cjs
python3 -m py_compile scanner.py
python3 -m http.server 8000 --directory docs
```

## GitHub Actions

The workflow runs code checks on pushes and pull requests. Manual **Run workflow** also runs the optional Python candle watchlist and uploads a timestamped `output/latest.json` artifact. This is a separate candle-only report with up to ten candidates per side. It may fail when Bybit denies the runner's requests. It does not supply data to the browser page.

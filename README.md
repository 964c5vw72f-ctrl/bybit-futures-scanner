# Bybit Futures Scanner

Free, read-only USDT perpetual futures watchlist scanner using Bybit's **public V5 API**. No API keys, no exchange login, no orders.

## How to run from iPhone

1. Open this GitHub repository and tap **Actions**.
2. Select **Bybit Futures Scan**, then **Run workflow**.
3. Open the latest completed run. View the **Scan public Bybit futures** log, or download the JSON artifact.
4. GitHub Actions is also scheduled every 15 minutes (GitHub may delay or skip scheduled runs).

## What it checks

- All currently trading Bybit USDT linear perpetual instruments for eligibility
- Top 60 eligible instruments by 24h turnover, minimum 1 million USDT turnover
- Last **closed** 5-minute candles: RSI(6), RSI(14), 15-minute price momentum, turnover spike vs previous 20 candles
- LONG WATCH / SHORT WATCH ranked by a simple heuristic score

This is a **scanner, not a live tick-by-tick feed**. Results are timestamped and may be delayed. Scores are not probabilities. False positives and rapid reversals are common. The scanner does not account for funding, spread, order book, slippage, liquidation risk, or news. Never use it alone to justify leveraged trades.

## Run locally

```bash
python3 scanner.py
```

No third-party packages required. Public repository contains no credentials. If Bybit blocks GitHub-hosted requests in the runner's region, the workflow will fail rather than silently invent data.

## Output

`output/latest.json` in each run's artifact and the job logs. GitHub-hosted public runners and free Actions minutes are subject to GitHub's current limits.

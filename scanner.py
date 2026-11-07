"""Read-only Bybit USDT perpetual futures opportunity scanner. Python stdlib only."""
import concurrent.futures
import datetime as dt
import json
import os
import time
import urllib.parse
import urllib.request

BASES = ["https://api.bybit.com", "https://api.bytick.com", "https://api.bybit.nl", "https://api.bybit-tr.com"]
HEADERS = {"User-Agent": "bybit-public-futures-scanner/1.0"}
TOP_N = int(os.getenv("TOP_N", "0"))
WORKERS = 12

def get(path, params):
    """Try official Bybit API domains; never replace blocked data with estimates."""
    failures = []
    for base in BASES:
        url = base + path + "?" + urllib.parse.urlencode(params)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=12) as response:
                obj = json.load(response)
            if obj.get("retCode") != 0:
                raise RuntimeError(str(obj.get("retMsg")))
            return obj["result"]
        except Exception as exc:
            failures.append(f"{base}: {type(exc).__name__}: {exc}")
    raise RuntimeError("All official Bybit API hosts failed. " + " | ".join(failures))

def active_symbols():
    found, cursor = set(), None
    while True:
        args = {"category": "linear", "limit": 1000, "status": "Trading"}
        if cursor:
            args["cursor"] = cursor
        result = get("/v5/market/instruments-info", args)
        for item in result.get("list", []):
            if (item.get("quoteCoin") == "USDT"
                and item.get("contractType") == "LinearPerpetual"
                and item.get("status") == "Trading"):
                found.add(item["symbol"])
        new_cursor = result.get("nextPageCursor")
        if not new_cursor or new_cursor == cursor:
            break
        cursor = new_cursor
    return found

def rsi(closes, period=14):
    changes = [b - a for a, b in zip(closes, closes[1:])]
    if len(changes) < period:
        return None
    gains = [max(x, 0) for x in changes]
    losses = [max(-x, 0) for x in changes]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for gain, loss in zip(gains[period:], losses[period:]):
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
    if avg_loss == 0:
        return 100.0 if avg_gain else 50.0
    return 100 - 100 / (1 + avg_gain / avg_loss)

def analyze(ticker):
    symbol = ticker["symbol"]
    result = get("/v5/market/kline", {
        "category": "linear", "symbol": symbol, "interval": "5", "limit": 45
    })
    rows = sorted(result.get("list", []), key=lambda x: int(x[0]))
    # Exclude current unclosed 5-minute candle.
    now_ms = int(time.time() * 1000)
    rows = [x for x in rows if int(x[0]) + 300000 <= now_ms]
    if len(rows) < 25:
        return None
    closes = [float(x[4]) for x in rows]
    volumes = [float(x[6]) for x in rows]  # turnover in quote currency
    price = closes[-1]
    if not price or closes[-4] <= 0:
        return None
    momentum = 100 * (price / closes[-4] - 1)
    avg_volume = sum(volumes[-21:-1]) / 20
    ratio = volumes[-1] / avg_volume if avg_volume else 0
    rsi6, rsi14 = rsi(closes, 6), rsi(closes, 14)
    if rsi6 is None or rsi14 is None:
        return None
    direction = None
    if momentum > 0.35 and ratio >= 1.4 and 52 <= rsi6 <= 85 and rsi14 >= 50:
        direction = "LONG WATCH"
    elif momentum < -0.35 and ratio >= 1.4 and 15 <= rsi6 <= 48 and rsi14 <= 50:
        direction = "SHORT WATCH"
    if direction is None:
        return None
    score = round(abs(momentum) * 2 + min(ratio, 6) * 2, 2)
    long_side = direction.startswith("LONG")
    highs = [float(x[2]) for x in rows]
    lows = [float(x[3]) for x in rows]
    stop = min(lows[-7:]) if long_side else max(highs[-7:])
    risk = (price - stop) if long_side else (stop - price)
    if risk <= 0 or risk / price > 0.045 or risk / price < 0.001:
        return None
    target = price + 2 * risk if long_side else price - 2 * risk
    if target <= 0:
        return None
    trend5 = "UP" if closes[-1] > closes[-2] else "DOWN"
    trend15 = "UP" if closes[-1] > closes[-4] else "DOWN"
    if trend5 != trend15 or trend5 != ("UP" if long_side else "DOWN"):
        return None
    if (rsi6 > 78 if long_side else rsi6 < 22) or abs(momentum) > 4.5:
        return None
    return {
        "symbol": symbol, "signal": direction, "score": score,
        "side": "LONG" if long_side else "SHORT",
        "stage": "DEVELOPING", "entry_reference": price,
        "stop": stop, "target": target, "trend5": trend5, "trend15": trend15,
        "last_closed_5m_price": price, "momentum_15m_pct": round(momentum, 3),
        "volume_ratio": round(ratio, 2), "rsi6": round(rsi6, 1),
        "rsi14": round(rsi14, 1), "candle_close_utc":
        dt.datetime.fromtimestamp((int(rows[-1][0]) + 300000) / 1000,
                                  dt.timezone.utc).isoformat(),
        "turnover24h_usdt": round(float(ticker.get("turnover24h", 0)))
    }

def main():
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    valid = active_symbols()
    tickers = get("/v5/market/tickers", {"category": "linear"}).get("list", [])
    eligible = [t for t in tickers if t["symbol"] in valid
                and float(t.get("turnover24h") or 0) >= 1000000]
    eligible.sort(key=lambda t: float(t.get("turnover24h") or 0), reverse=True)
    candidates = eligible[:TOP_N] if TOP_N > 0 else eligible
    results, errors = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        jobs = {pool.submit(analyze, t): t["symbol"] for t in candidates}
        for future in concurrent.futures.as_completed(jobs):
            try:
                item = future.result()
                if item:
                    results.append(item)
            except Exception as exc:
                errors.append({"symbol": jobs[future], "error": str(exc)})
    results.sort(key=lambda x: (not x["signal"].startswith("LONG"), -x["score"]))
    report = {
        "generated_utc": started, "source": "Bybit public V5 REST API",
        "market": "USDT linear perpetual", "eligible_symbols": len(eligible),
        "scanned_symbols": len(candidates), "signals": results[:10],
        "errors": errors, "disclaimer": "Watchlist only; not a trade instruction. "
        "No orders are placed. No signal guarantees profit."
    }
    os.makedirs("output", exist_ok=True)
    with open("output/latest.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
    if not results:
        print("No qualifying setups at this scan; do not force a trade.")
    if errors and len(errors) == len(candidates):
        raise RuntimeError("All market requests failed; scan unreliable")

if __name__ == "__main__":
    main()

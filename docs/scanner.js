'use strict';

const HOSTS = ['https://api.bybit.com', 'https://api.bytick.com', 'https://api.bybit.eu'];
const CANDLE_MS = 300_000;
const CLOSE_GRACE_MS = 10_000;
const QUOTE_MAX_AGE_MS = 25_000;
const FUTURE_TOLERANCE_MS = 5_000;
const QUOTE_INTERVAL_MS = 10_000;
const LIVE_QUOTE_MAX_AGE_MS = 8_000;
const STREAM_RETRY_MS = 15_000;
const STREAM_URL = 'wss://stream.bybit.com/v5/public/linear';
const SCAN_RETRY_MS = 30_000;
const SCAN_TIMEOUT_MS = 75_000;
const MARKET = {category: 'linear'};
const GYLEX_STARTER_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT',
  'LINKUSDT', 'LTCUSDT', 'DOTUSDT', 'BCHUSDT', 'ETCUSDT', 'APTUSDT', 'OPUSDT', 'ARBUSDT',
  'NEARUSDT', 'UNIUSDT', 'FILUSDT', 'INJUSDT', 'SUIUSDT', 'AAVEUSDT', 'ATOMUSDT', 'TRXUSDT',
  'ACAUSDT', 'ACCUSDT', 'AGTUSDT', 'AIIUSDT', 'APRUSDT', 'AVAUSDT', 'BATUSDT', 'BERAUSDT',
  'BRUSDT', 'BTWUSDT', 'CAUSDT', 'CRCLUSDT', 'CS1USDT', 'CS2USDT', 'CXMMUSDT', 'DEXEUSDT',
  'DSDUSDT', 'ENJUSDT', 'EPICUSDT', 'ERAUSDT', 'FOLKSUSDT', 'GTCUSDT', 'HBARUSDT', 'HUSDT',
  'HYPEUSDT', 'ICNTUSDT', 'IRYSUSDT', 'LDCUSDT', 'LNDUSDT', 'LSKUSDT', 'LYNUSDT', 'MAGMAUSDT',
  'MDOUSDT', 'ONEUSDT', 'OPNUSDT', 'OTNUSDT', 'PARTIUSDT', 'PONSUSDT', 'PUMPUSDT', 'QQQUSDT',
  'QUSDT', 'SAKUSDT', 'SANDUSDT', 'SNDKUSDT', 'SNXXBUSDT', 'SPCXCUSDT', 'STARUSDT', 'STCUSDT',
  'STRKUSDT', 'TAOUSDT', 'TCUSDT', 'TXUSDT', 'UAIUSDT', 'VVVUSDT', 'ZECUSDT', 'ZEREBROUSDT',
  'ZROUSDT', '龙虾USDT'
];
const GYLEX_STORAGE_KEY = 'scanner.gylex-pairs';
const gylexMode = new URLSearchParams(location.search).get('market') === 'gylex';
const importedGylexPairs = gylexMode ? loadGylexPairs() : new Set();
const gylexPairs = importedGylexPairs.size ? importedGylexPairs : new Set(GYLEX_STARTER_PAIRS);
const $ = id => document.getElementById(id);
const fmt = n => Number.isFinite(n) ? n.toLocaleString('en-US', {maximumSignificantDigits: 8}) : '—';
const priceText = n => n.toLocaleString('en-US', {useGrouping: false, maximumFractionDigits: 20});
const stamp = n => new Date(n).toLocaleString();
const num = v => typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;

let scanBusy = false;
let quoteRequest = null;
let nextScanAt = 0;
let nextQuoteAt = 0;
let host = null;
let signals = [];
let visibleSetups = [];
let scanClose = 0;
let incomplete = false;
let quoteSnapshot = null;
let stream = null;
let streamDeadline = 0;
let nextStreamAt = 0;
let nextPingAt = 0;
let quotePaint = null;
const streamedQuotes = new Map();
let quoteIssue = '';
let pageSuspended = false;

function parseGylexPairs(text) {
  const tokens = text.trim().toUpperCase().split(/[\s,;]+/);
  return new Set(tokens.filter(token => /^[\p{L}0-9]{1,32}(?:[/-])?USDT$/u.test(token))
    .map(token => token.replace(/[/-]/, '')));
}

function loadGylexPairs() {
  try {
    return parseGylexPairs(localStorage.getItem(GYLEX_STORAGE_KEY) || '');
  } catch {
    return new Set();
  }
}

function fresh(time, maxAge, now = Date.now()) {
  return Number.isSafeInteger(time) && now - time >= -FUTURE_TOLERANCE_MS && now - time < maxAge;
}

async function api(base, endpoint, params, parentSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (parentSignal.aborted) throw Error('Request cancelled');
  parentSignal.addEventListener('abort', cancel, {once: true});
  const timeout = setTimeout(cancel, 6500);
  try {
    const response = await fetch(base + '/v5/market/' + endpoint + '?' + new URLSearchParams(params), {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw Error('HTTP ' + response.status);
    if (!response.headers.get('content-type')?.includes('json')) throw Error('Bybit did not return JSON');
    const payload = await response.json();
    if (payload.retCode !== 0) throw Error(payload.retMsg || 'Bybit API error');
    const time = num(payload.time);
    if (!fresh(time, QUOTE_MAX_AGE_MS)) throw Error('Missing or stale Bybit response timestamp');
    if (payload.result?.category !== MARKET.category || !Array.isArray(payload.result.list)) {
      throw Error('Unexpected Bybit market response');
    }
    return {time, list: payload.result.list, cursor: payload.result.nextPageCursor, symbol: payload.result.symbol};
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', cancel);
  }
}

async function universe(base, signal) {
  const instruments = new Set();
  const cursors = new Set();
  let cursor;
  do {
    const params = {...MARKET, limit: 1000, status: 'Trading'};
    if (cursor) params.cursor = cursor;
    const page = await api(base, 'instruments-info', params, signal);
    for (const row of page.list) {
      if (row.quoteCoin === 'USDT' && row.settleCoin === 'USDT' &&
          row.contractType === 'LinearPerpetual' && row.status === 'Trading' &&
          (!gylexMode || gylexPairs.has(row.symbol))) {
        instruments.add(row.symbol);
      }
    }
    cursor = page.cursor;
    if (cursor && cursors.has(cursor)) throw Error('Repeated instrument page cursor');
    cursors.add(cursor);
  } while (cursor);
  const tickers = await api(base, 'tickers', MARKET, signal);
  const eligible = new Map(tickers.list
    .filter(row => instruments.has(row.symbol) && Number.isFinite(num(row.turnover24h)) && num(row.turnover24h) >= 1_000_000)
    .map(row => [row.symbol, row]));
  if (!eligible.size) {
    throw Error(gylexMode ? 'No GYLEX watchlist pairs passed the Bybit market filters' :
      'No eligible USDT perpetuals returned');
  }
  return {base, tickers, eligible: [...eligible.values()]};
}

async function connect(signal) {
  const failures = [];
  const preferred = [...new Set([host, ...HOSTS].filter(Boolean))];
  for (const base of preferred) {
    try {
      return await universe(base, signal);
    } catch (error) {
      if (signal.aborted) throw Error('Scan timed out');
      failures.push(new URL(base).hostname + ' (' + error.message + ')');
    }
  }
  throw Error('Bybit unavailable. ' + failures.join(' · '));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rsi(closes, period) {
  const changes = closes.slice(1).map((value, i) => value - closes[i]);
  const gains = changes.map(value => Math.max(0, value));
  const losses = changes.map(value => Math.max(0, -value));
  let gain = average(gains.slice(0, period));
  let loss = average(losses.slice(0, period));
  for (let i = period; i < changes.length; i++) {
    gain = (gain * (period - 1) + gains[i]) / period;
    loss = (loss * (period - 1) + losses[i]) / period;
  }
  return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
}

function momentumConfirmation(momentum, rsi6, rsi14, volumeRatio) {
  const long = momentum > 0;
  const gaps = [];
  if (!(Math.abs(momentum) > 0.35 && Math.abs(momentum) < 2)) {
    gaps.push('15m momentum ' + fmt(momentum) + '% (needs ' + (long ? '> +0.35% and < +2%' : '< −0.35% and > −2%') + ')');
  }
  if (!(long ? rsi6 >= 52 && rsi6 < 75 : rsi6 > 25 && rsi6 <= 48)) {
    gaps.push('RSI6 ' + fmt(rsi6) + ' (needs ' + (long ? '≥52 and <75' : '>25 and ≤48') + ')');
  }
  if (!(long ? rsi14 >= 50 && rsi14 < 70 : rsi14 > 30 && rsi14 <= 50)) {
    gaps.push('RSI14 ' + fmt(rsi14) + ' (needs ' + (long ? '≥50 and <70' : '>30 and ≤50') + ')');
  }
  if (!(volumeRatio >= 1.4)) gaps.push('5m volume ' + fmt(volumeRatio) + '× (needs ≥1.4×)');
  return gaps;
}

function analyze(ticker, rows, close) {
  const candles = rows.map(row => ({
    time: num(row[0]), high: num(row[2]), low: num(row[3]),
    close: num(row[4]), turnover: num(row[6])
  })).sort((a, b) => a.time - b.time);
  const last = candles.at(-1);
  if (!last || last.time + CANDLE_MS !== close) throw Error('Latest closed candle missing');
  if (candles.some((row, i) => row.time !== close - (candles.length - i) * CANDLE_MS ||
      ![row.high, row.low, row.close, row.turnover].every(Number.isFinite) ||
      row.low <= 0 || row.close < row.low || row.close > row.high || row.turnover < 0)) {
    throw Error('Invalid or missing candles');
  }
  if (candles.length < 25) return null;

  const prices = candles.map(row => row.close);
  const volumes = candles.map(row => row.turnover);
  const momentum = 100 * (last.close / prices.at(-4) - 1);
  const rsi6 = rsi(prices, 6);
  const rsi14 = rsi(prices, 14);
  const baseline = average(volumes.slice(-21, -1));
  const previous = average(volumes.slice(-8, -3));
  const volumeRatio = baseline > 0 ? last.turnover / baseline : 0;
  const buildup = previous > 0 ? average(volumes.slice(-3)) / previous : 0;
  const confirmationGaps = momentumConfirmation(momentum, rsi6, rsi14, volumeRatio);
  const confirmed = confirmationGaps.length === 0;
  const earlyLong = momentum > 0 && momentum <= 0.7 && rsi6 >= 48 && rsi6 <= 67 && rsi14 >= 45 && rsi14 <= 62;
  const earlyShort = momentum < 0 && momentum >= -0.7 && rsi6 >= 33 && rsi6 <= 52 && rsi14 >= 38 && rsi14 <= 55;
  if (!confirmed && !(buildup >= 1.3 && (earlyLong || earlyShort))) return null;

  const long = momentum > 0;
  const aligned = long ? last.close > prices.at(-2) : last.close < prices.at(-2);
  const ranges = candles.slice(-14).map((row, i) => {
    const prior = prices.at(i - 15);
    return Math.max(row.high - row.low, Math.abs(row.high - prior), Math.abs(row.low - prior));
  });
  const atr = average(ranges);
  const swing = long ? Math.min(...candles.slice(-7).map(row => row.low)) :
    Math.max(...candles.slice(-7).map(row => row.high));
  const stop = long ? Math.min(swing, last.close - 1.2 * atr) : Math.max(swing, last.close + 1.2 * atr);
  const risk = Math.abs(last.close - stop);
  const target = last.close + (long ? 2 : -2) * risk;
  if (!(stop > 0 && risk > 0 && target > 0)) return null;

  const baseIssue = !aligned ? '5m trend conflicts with 15m momentum' :
    Math.abs(last.close - prices.at(-4)) > 2.5 * atr ? 'Extended relative to candle range' : '';
  const score = Math.round(10 * (Math.min(volumeRatio, 5) * 2 + Math.min(Math.abs(momentum), 1.5) * 2 +
    Math.min(buildup, 3) + (aligned ? 3 : 0) + Math.min(num(ticker.turnover24h) / 10_000_000, 3))) / 10;

  return {symbol: ticker.symbol, side: long ? 'LONG' : 'SHORT', confirmed, confirmationGaps, baseIssue, score,
    reference: last.close, stop, target, risk, momentum, rsi6, rsi14, volumeRatio, buildup,
    candleTurnover: last.turnover};
}

function quoteMetrics(row, setup) {
  const bid = num(row?.bid1Price), ask = num(row?.ask1Price);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
  const long = setup.side === 'LONG';
  const price = long ? ask : bid;
  const spread = 100 * (ask - bid) / ((ask + bid) / 2);
  const depth = Math.min(bid * num(row.bid1Size), ask * num(row.ask1Size));
  const turnover = num(row.turnover24h);
  const funding = num(row.fundingRate);
  const risk = long ? price - setup.stop : setup.stop - price;
  const reward = long ? setup.target - price : price - setup.target;
  const rr = risk > 0 && reward > 0 ? reward / risk : NaN;
  return {bid, ask, price, spread, depth, turnover, funding, riskPct: 100 * risk / price, rr};
}

function verdict(setup, quote) {
  if (pageSuspended) return ['WAIT', 'Page paused'];
  if (scanBusy) return ['WAIT', 'Scan in progress'];
  if (incomplete) return ['WAIT', 'Incomplete candle scan'];
  if (Date.now() >= scanClose + CANDLE_MS + CLOSE_GRACE_MS) return ['WAIT', 'Candle scan expired'];
  if (!quote) return ['WAIT', quoteIssue || 'Bybit quote unavailable or stale'];
  if (setup.baseIssue) return ['WAIT', setup.baseIssue];
  if (quote.spread > 0.15) return ['WAIT', 'Spread above 0.15%'];
  if (!Number.isFinite(quote.turnover) || !Number.isFinite(quote.depth) ||
      quote.turnover < 2_000_000 || quote.depth < 1000) return ['WAIT', 'Insufficient top-of-book liquidity or turnover'];
  if (!Number.isFinite(quote.funding)) return ['WAIT', 'Funding unavailable'];
  if (Math.abs(quote.funding) > 0.003) return ['WAIT', 'Funding above 0.30% in absolute value'];
  if (!(quote.rr >= 1.8 && quote.riskPct >= 0.15 && quote.riskPct <= 5)) return ['WAIT', 'Quote-based risk/reward or stop distance outside limits'];
  if (Math.abs(quote.price - setup.reference) > Math.min(setup.reference * 0.003, setup.risk * 0.5)) {
    return ['WAIT', 'Quote moved away from candle reference'];
  }
  if (setup.confirmed) return ['READY TO REVIEW', 'Screening checks passed'];
  return ['EARLY', setup.confirmationGaps.join(' · ') + ' · Next candle close ' +
    new Date(scanClose + CANDLE_MS).toLocaleTimeString()];
}

function node(tag, content, css) {
  const el = document.createElement(tag);
  if (content) el.textContent = content;
  if (css) el.className = css;
  return el;
}

function addCard(setup) {
  const card = node('article');
  card.dataset.symbol = setup.symbol;
  const rank = node('div', '', 'score');
  card.append(rank);
  card.append(node('div', setup.symbol + ' · ' + setup.side, 'symbol ' + setup.side.toLowerCase()));
  const flag = node('p', '', 'verdict');
  const quotes = node('div', '', 'live-price');
  const bidAsk = node('strong');
  const quoteTime = node('div', '', 'live-time');
  quotes.append(bidAsk, quoteTime);
  const levels = node('div', '', 'metrics');
  const entry = node('strong');
  for (const [label, value] of [['Bybit quote', entry], ['Stop estimate', node('strong', fmt(setup.stop))],
    ['Target estimate', node('strong', fmt(setup.target))]]) {
    const cell = node('div');
    cell.append(node('small', label), value);
    levels.append(cell);
  }
  const market = node('p', '', 'muted quote');
  const details = node('details');
  details.append(node('summary', 'More indicators'),
    node('p', 'RSI6 ' + fmt(setup.rsi6) + ' · RSI14 ' + fmt(setup.rsi14) +
      ' · 15m momentum ' + fmt(setup.momentum) + '% · Volume ×' + fmt(setup.volumeRatio) +
      ' · Volume buildup ×' + fmt(setup.buildup)),
    node('p', 'Closed candle ' + stamp(scanClose) + ' · Close ' + fmt(setup.reference) +
      ' · 5m turnover ' + fmt(setup.candleTurnover) + ' USDT'));
  card.append(flag, quotes, levels, market, details);
  setup.card = {element: card, rank, flag, bidAsk, quoteTime, entry, market};
  return card;
}

function render(groups) {
  const ordered = groups.flatMap(group => group.rows.map(row => row.setup));
  if (visibleSetups && ordered.length === visibleSetups.length &&
      ordered.every((setup, i) => setup === visibleSetups[i])) return;
  visibleSetups = ordered;
  const results = $('results');
  results.replaceChildren();
  for (const {side, rows} of groups) {
    results.append(node('h2', 'Top ' + side, side.toLowerCase()));
    if (!rows.length) results.append(node('p', 'No qualifying ' + side + ' candidates in this scan.', 'muted'));
    rows.forEach(({setup}, i) => {
      const card = setup.card?.element || addCard(setup);
      setup.card.rank.textContent = '#' + (i + 1) + ' · Score ' + fmt(setup.score);
      results.append(card);
    });
  }
}

function updateCards() {
  const now = Date.now();
  const active = !pageSuspended && navigator.onLine;
  const snapshot = active && quoteSnapshot && fresh(quoteSnapshot.time, QUOTE_MAX_AGE_MS, now) ? quoteSnapshot : null;
  const evaluated = signals.map(setup => {
    const live = active && streamedQuotes.get(setup.symbol);
    const rest = snapshot?.rows.get(setup.symbol);
    const useLive = live && fresh(live.time, LIVE_QUOTE_MAX_AGE_MS, now) &&
      (!rest || live.time >= snapshot.time);
    const quote = quoteMetrics(useLive ? live.row : rest, setup);
    const [label, reason] = verdict(setup, quote);
    return {setup, quote, label, reason, time: useLive ? live.time : snapshot?.time, useLive};
  });
  const ready = evaluated.filter(row => row.label === 'READY TO REVIEW');
  const other = evaluated.filter(row => row.label !== 'READY TO REVIEW');
  const groups = ['LONG', 'SHORT'].map(side => ({
    side,
    rows: [...ready, ...other].filter(row => row.setup.side === side).slice(0, 10)
  }));
  if (scanClose) render(groups);
  for (const {rows} of groups) {
    for (const {setup, quote, label, reason, time, useLive} of rows) {
      const {flag, bidAsk, quoteTime, entry, market} = setup.card;
      flag.textContent = label + ' · ' + reason;
      flag.className = 'verdict ' + (label === 'READY TO REVIEW' ? 'ready' : label.toLowerCase());
      bidAsk.textContent = quote ? 'Bid ' + priceText(quote.bid) + ' · Ask ' + priceText(quote.ask) : 'Bid — · Ask —';
      quoteTime.textContent = quote ? (useLive ? 'Bybit LIVE · ' : 'Bybit snapshot · ') + stamp(time) : 'No fresh bid/ask';
      entry.textContent = quote ? priceText(quote.price) : '—';
      market.textContent = quote ? 'R:R 1:' + fmt(quote.rr) + ' · Spread ' + fmt(quote.spread) +
        '% · Funding ' + fmt(quote.funding * 100) + '% · 24h turnover ' + fmt(quote.turnover) +
        ' USDT · Top-of-book ' + fmt(quote.depth) + ' USDT' : '';
    }
  }
  const readiness = $('readiness');
  const readySides = ['LONG', 'SHORT'].map(side => {
    const matches = ready.filter(row => row.setup.side === side);
    return side + ' ' + (matches.length ? matches[0].setup.symbol + ' (' + matches.length + ')' : '0');
  });
  const text = scanBusy ? 'Checking for setups…' : ready.length ?
    ready.length + ' READY TO REVIEW · ' + readySides.join(' · ') :
    '0 READY TO REVIEW · ' + (!scanClose || incomplete || (signals.length && !evaluated.some(row => row.quote)) ?
      'Waiting for complete, fresh Bybit data' : 'No LONG or SHORT passed all Bybit checks');
  if (readiness.textContent !== text) readiness.textContent = text;
  readiness.className = ready.length ? 'ready' : 'muted';
}

function mergeTicker(previous, message) {
  if (!fresh(message.ts, LIVE_QUOTE_MAX_AGE_MS) || !message.data ||
      (previous && message.ts < previous.time)) return null;
  if (message.type === 'snapshot') return {row: message.data, time: message.ts};
  if (message.type === 'delta' && previous) {
    return {row: {...previous.row, ...message.data}, time: message.ts};
  }
  return null;
}

function stopStream() {
  const socket = stream;
  stream = null;
  streamedQuotes.clear();
  clearTimeout(quotePaint);
  quotePaint = null;
  if (socket && socket.readyState < 2) socket.close();
}

function maintainStream() {
  // The documented global futures stream matches the global REST hosts.
  if (host === 'https://api.bybit.eu' || typeof WebSocket === 'undefined' ||
      !navigator.onLine || scanBusy || pageSuspended || !signals.length) return;
  const now = Date.now();
  if (stream && now >= streamDeadline) {
    stopStream();
    nextStreamAt = now + STREAM_RETRY_MS;
  }
  if (stream) {
    if (stream.readyState === 1 && now >= nextPingAt) {
      stream.send(JSON.stringify({op: 'ping'}));
      nextPingAt = now + 20_000;
    }
    return;
  }
  if (now < nextStreamAt) return;
  nextStreamAt = now + STREAM_RETRY_MS;
  let socket;
  try {
    socket = new WebSocket(STREAM_URL);
  } catch {
    return;
  }
  stream = socket;
  streamDeadline = now + 8_000;
  const topics = new Set(signals.slice(0, 100).map(setup => 'tickers.' + setup.symbol));
  socket.onopen = () => {
    if (stream !== socket) return;
    streamDeadline = Date.now() + 45_000;
    nextPingAt = Date.now() + 20_000;
    socket.send(JSON.stringify({op: 'subscribe', args: [...topics]}));
  };
  socket.onmessage = event => {
    if (stream !== socket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    streamDeadline = Date.now() + 45_000;
    if (message.op === 'subscribe' && message.success === false) {
      socket.close();
      return;
    }
    if (!topics.has(message.topic)) return;
    const symbol = message.topic.slice('tickers.'.length);
    if (message.data?.symbol !== undefined && message.data.symbol !== symbol) return;
    const quote = mergeTicker(streamedQuotes.get(symbol), message);
    if (!quote) return;
    streamedQuotes.set(symbol, quote);
    if (quotePaint === null) {
      quotePaint = setTimeout(() => {
        quotePaint = null;
        updateCards();
      }, 250);
    }
  };
  socket.onerror = () => {
    if (stream === socket && socket.readyState < 2) socket.close();
  };
  socket.onclose = () => {
    if (stream !== socket) return;
    stopStream();
    nextStreamAt = Date.now() + STREAM_RETRY_MS;
    updateCards();
  };
}

function invalidateQuotes() {
  stopStream();
  nextStreamAt = 0;
  quoteRequest?.abort();
  quoteRequest = null;
  quoteSnapshot = null;
  nextQuoteAt = 0;
}

async function refreshQuotes() {
  if (pageSuspended || !navigator.onLine || scanBusy || quoteRequest || !signals.length) return;
  const request = new AbortController();
  quoteRequest = request;
  nextQuoteAt = Date.now() + QUOTE_INTERVAL_MS;
  try {
    const snapshot = await api(host, 'tickers', MARKET, request.signal);
    if (quoteRequest !== request) return;
    if (!snapshot.list.length) throw Error('Empty ticker snapshot');
    quoteSnapshot = {time: snapshot.time, rows: new Map(snapshot.list.map(row => [row.symbol, row]))};
    quoteIssue = '';
    if (!incomplete) $('warning').textContent = '';
  } catch (error) {
    if (quoteRequest !== request) return;
    quoteSnapshot = null;
    quoteIssue = 'Bybit quote refresh failed';
    $('warning').textContent = quoteIssue + '. ' + error.message;
  } finally {
    if (quoteRequest === request) {
      quoteRequest = null;
      updateCards();
    }
  }
}

async function scan() {
  if (scanBusy || pageSuspended || !navigator.onLine) return;
  scanBusy = true;
  invalidateQuotes();
  $('scan').disabled = true;
  $('warning').textContent = '';
  $('status').textContent = 'Connecting to the Bybit public API…';
  updateCards();
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), SCAN_TIMEOUT_MS);
  try {
    const {base, tickers, eligible} = await connect(request.signal);
    host = base;
    const close = Math.floor((tickers.time - 2000) / CANDLE_MS) * CANDLE_MS;
    const found = [];
    let next = 0, done = 0, failures = 0, firstError = '';
    await Promise.all(Array.from({length: Math.min(8, eligible.length)}, async () => {
      while (!request.signal.aborted && next < eligible.length) {
        const ticker = eligible[next++];
        try {
          const data = await api(host, 'kline', {...MARKET, symbol: ticker.symbol, interval: 5,
            end: close - 1, limit: 45}, request.signal);
          if (data.symbol !== undefined && data.symbol !== ticker.symbol) throw Error('Unexpected candle symbol');
          const result = analyze(ticker, data.list, close);
          if (result) found.push(result);
        } catch (error) {
          failures++;
          if (!firstError) firstError = ticker.symbol + ' · ' + error.message;
        }
        done++;
        if (done === 1 || done % 15 === 0) $('status').textContent = 'Scanning ' + done + ' / ' + eligible.length + ' contracts…';
      }
    }));
    if (failures === done) throw Error(request.signal.aborted ? 'Candle scan timed out' : firstError);
    incomplete = failures > 0 || done < eligible.length;
    scanClose = close;
    quoteIssue = '';
    found.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    signals = found;
    visibleSetups = null;
    $('status').textContent = (incomplete ? 'Partial scan' : 'Scan complete') + ' · ' +
      (done - failures) + ' / ' + eligible.length + ' contracts checked · ' + new URL(host).hostname +
      ' · ' + new Date().toLocaleTimeString();
    $('warning').textContent = incomplete ? (firstError || 'Scan timed out') + ' · Results may omit setups.' : '';
    const nextClose = close + CANDLE_MS + 2500;
    nextScanAt = incomplete ? Math.min(Date.now() + SCAN_RETRY_MS, Math.max(Date.now() + 2500, nextClose)) :
      Math.max(Date.now() + 2500, nextClose);
  } catch (error) {
    scanClose = 0;
    visibleSetups = [];
    signals = [];
    $('results').replaceChildren();
    $('status').textContent = 'Scan unavailable · retrying automatically';
    $('warning').textContent = error.message + ' · Check your connection and Bybit availability.';
    nextScanAt = Date.now() + SCAN_RETRY_MS;
  } finally {
    clearTimeout(timeout);
    scanBusy = false;
    $('scan').disabled = false;
    updateCards();
  }
  maintainStream();
  refreshQuotes();
}

function tick() {
  if (pageSuspended) return;
  if (navigator.onLine && !scanBusy && Date.now() >= nextScanAt) {
    scan();
  } else {
    maintainStream();
    updateCards();
    if (Date.now() >= nextQuoteAt) refreshQuotes();
  }
}

$(gylexMode ? 'gylex-market' : 'bybit-market').setAttribute('aria-current', 'page');
$('gylex-note').hidden = !gylexMode;
if (gylexMode) {
  $('gylex-count').textContent = importedGylexPairs.size ?
    'Imported list · ' + gylexPairs.size + ' pairs.' :
    'Default list · ' + gylexPairs.size + ' pairs supplied from GYLEX.';
  $('gylex-pairs').value = [...gylexPairs].join('\n');
  $('gylex-form').onsubmit = event => {
    event.preventDefault();
    const pairs = parseGylexPairs($('gylex-pairs').value);
    if (!pairs.size) {
      $('gylex-error').textContent = 'Add at least one USDT pair, such as BTC/USDT.';
      return;
    }
    try {
      localStorage.setItem(GYLEX_STORAGE_KEY, [...pairs].join('\n'));
    } catch {
      $('gylex-error').textContent = 'This browser could not save the list.';
      return;
    }
    location.reload();
  };
}
$('scan').onclick = scan;
document.addEventListener('visibilitychange', () => {
  // Keep scanning in a hidden tab while the browser lets it run.
  if (document.hidden) return;
  invalidateQuotes();
  updateCards();
  tick();
});
// Safari can freeze and restore this page through its back/forward cache.
window.addEventListener('pagehide', () => {
  pageSuspended = true;
  invalidateQuotes();
  updateCards();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted && !pageSuspended) return;
  pageSuspended = false;
  invalidateQuotes();
  updateCards();
  tick();
});
window.addEventListener('offline', () => {
  invalidateQuotes();
  $('warning').textContent = 'Network offline · waiting to reconnect';
  updateCards();
});
window.addEventListener('online', () => {
  $('warning').textContent = '';
  nextScanAt = 0;
  tick();
});
setInterval(tick, 1000);
if (!navigator.onLine) $('status').textContent = 'Network offline · waiting to reconnect';
tick();

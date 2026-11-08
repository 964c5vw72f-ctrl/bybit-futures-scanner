const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const {candles} = require('./bybit-fixture.cjs');

const context = vm.createContext({
  document: {hidden: true, addEventListener() {}, getElementById() { return {setAttribute() {}}; }},
  location: {search: ''},
  URLSearchParams,
  window: {addEventListener() {}},
  navigator: {onLine: false},
  setInterval() {}
});
vm.runInContext(fs.readFileSync('docs/scanner.js', 'utf8'), context);
const run = expression => vm.runInContext(expression, context);

test('Wilder RSI handles rising, falling and flat prices', () => {
  assert.equal(run('rsi([1, 2, 3, 4, 5, 6, 7], 6)'), 100);
  assert.equal(run('rsi([7, 6, 5, 4, 3, 2, 1], 6)'), 0);
  assert.equal(run('rsi(Array(15).fill(10), 14)'), 50);
});

test('timestamp rejects stale, absent and future quotes', () => {
  assert.equal(run('fresh(95000, 25000, 100000)'), true);
  assert.equal(run('fresh(75000, 25000, 100000)'), false);
  assert.equal(run('fresh(undefined, 25000, 100000)'), false);
  assert.equal(run('fresh(106000, 25000, 100000)'), false);
});

test('best ask drives LONG R:R and best bid drives SHORT R:R', () => {
  run(`const book = {bid1Price: '99', ask1Price: '101', bid1Size: '20', ask1Size: '20',
    turnover24h: '3000000', fundingRate: '-0.001'};`);
  assert.equal(run("quoteMetrics(book, {side: 'LONG', stop: 98, target: 107}).rr"), 2);
  assert.equal(run("quoteMetrics(book, {side: 'SHORT', stop: 102, target: 93}).rr"), 2);
  assert.equal(run("quoteMetrics({...book, ask1Price: '98'}, {side: 'LONG'})"), null);
  assert.equal(run("quoteMetrics(book, {side: 'LONG', stop: 98, target: 100}).rr"), NaN);
});

test('stale scan, partial results, missing funding and stale quote fail closed', () => {
  run(`document.hidden = false;
    scanClose = Date.now();
    const setup = {reference: 100, risk: 1, confirmed: true};
    const healthy = {price: 100, rr: 2, riskPct: 1, spread: 0.01, depth: 2000, turnover: 4000000, funding: -0.0001};`);
  assert.equal(run('verdict(setup, healthy)[0]'), 'READY TO REVIEW');
  const early = run("verdict({...setup, confirmed: false, confirmationGaps: ['5m volume 1.2× (needs ≥1.4×)']}, healthy)");
  assert.equal(early[0], 'EARLY');
  assert.match(early[1], /5m volume 1.2× .*Next candle close/);
  assert.equal(run('verdict(setup, null)[0]'), 'WAIT');
  assert.equal(run('verdict(setup, {...healthy, funding: NaN})[0]'), 'WAIT');
  assert.equal(run('incomplete = true; verdict(setup, healthy)[0]'), 'WAIT');
  assert.equal(run('incomplete = false; scanClose -= CANDLE_MS + CLOSE_GRACE_MS; verdict(setup, healthy)[0]'), 'WAIT');
});

test('confirmation names only the failing checks with their actual values', () => {
  assert.deepEqual([...run('momentumConfirmation(0.5, 60, 55, 1.4)')], []);
  assert.deepEqual([...run('momentumConfirmation(-0.5, 40, 45, 1.4)')], []);
  const gaps = [...run('momentumConfirmation(0.2, 51, 55, 1.2)')];
  assert.equal(gaps.length, 3);
  assert.match(gaps[0], /15m momentum 0.2%/);
  assert.match(gaps[1], /RSI6 51/);
  assert.match(gaps[2], /5m volume 1.2×/);
  assert.equal(run('momentumConfirmation(-0.35, 48, 50, 1.4).length'), 1);
});

test('candles must be contiguous and end at the pinned close', () => {
  run(`const end = 30000000;
    const rows = Array.from({length: 45}, (_, i) =>
      [end - (i + 1) * CANDLE_MS, 100, 101, 99, 100, 10, 1000]);
    const ticker = {symbol: 'TESTUSDT', turnover24h: '5000000'};`);
  assert.equal(run('analyze(ticker, rows, end)'), null);
  assert.throws(() => run('analyze(ticker, rows.slice(1), end)'), /Latest closed candle missing/);
  assert.throws(() => run('analyze(ticker, rows.filter((_, i) => i !== 2), end)'), /Invalid or missing candles/);
  assert.throws(() => run('analyze(ticker, rows.slice(0, 24), end)'), /Insufficient closed candle history/);
});

test('a full scan paginates and renders both rankings, then fails closed on quote errors', async () => {
  function element() {
    return {
      children: [], dataset: {},
      append(...children) { this.children.push(...children); },
      replaceChildren() { this.children = []; },
      setAttribute(name, value) { this[name] = value; }
    };
  }
  const dom = Object.fromEntries(['scan', 'status', 'warning', 'results', 'readiness', 'quote-source',
    'reference-book', 'reference-time', 'quote-warning',
    'bybit-market', 'gylex-market', 'gylex-note'].map(id => [id, element()]));
  const firstClose = 1_800_000_000_000;
  let now = firstClose + 120_000;
  let expectedClose = firstClose;
  const events = {};
  const symbols = ['L', 'S'].flatMap(side => Array.from({length: 12}, (_, i) => side + i));
  let mode = 'healthy';
  let l0Requests = 0;
  let heldCandles;
  let tick;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const app = vm.createContext({
    document: {hidden: true, addEventListener(name, callback) { events[name] = callback; },
      getElementById: id => dom[id], createElement: element},
    window: {addEventListener(name, callback) { events[name] = callback; }},
    navigator: {onLine: false},
    location: {search: ''},
    setInterval: callback => { tick = callback; },
    setTimeout, clearTimeout, AbortController, URL, URLSearchParams, Date: Clock,
    async fetch(url, options) {
      const {hostname, pathname, searchParams: params} = new URL(url);
      const endpoint = pathname.split('/').at(-1);
      const result = {category: 'linear'};
      if (endpoint === 'instruments-info') {
        result.list = (params.has('cursor') ? symbols.slice(12) : symbols.slice(0, 12)).map(symbol =>
          ({symbol, quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading',
            launchTime: mode === 'newly listed' ? String(expectedClose - 300_000) : '1000000000'}));
        result.nextPageCursor = params.has('cursor') ? '' : 'page2';
      } else if (endpoint === 'tickers') {
        if (mode === 'HTTP failure') return {ok: false, status: 503};
        result.list = symbols.map((symbol, index) => {
          const reference = symbol.startsWith('L') ? 100.6 : 99.4;
          return {symbol, turnover24h: String(3_000_000 + index * 400_000),
            fundingRate: mode === 'missing funding' || (mode === 'only low score ready' && !['L0', 'S0'].includes(symbol)) ? '' : '-0.0001',
            bid1Price: (reference - 0.005).toFixed(3), ask1Price: (reference + 0.005).toFixed(3),
            bid1Size: '100', ask1Size: '100'};
        });
        result.list.push({symbol: 'BTCUSDT', bid1Price: '79999', ask1Price: '80001'});
      } else {
        assert.equal(endpoint, 'kline');
        const symbol = params.get('symbol');
        if (symbol === 'L0') l0Requests++;
        if (mode === 'transient candle error' && symbol === 'L0' && l0Requests === 1) {
          return {ok: false, status: 503};
        }
        if (mode === 'host candle outage' && hostname === 'api.bybit.com') return {ok: false, status: 503};
        if (mode === 'partial' && symbol === 'L0') return {ok: false, status: 503};
        if (heldCandles) {
          await Promise.race([heldCandles, new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(Error('Cancelled fixture request')), {once: true});
          })]);
        }
        const end = Number(params.get('end')) + 1;
        assert.equal(end, expectedClose);
        result.symbol = symbol;
        result.list = candles(symbol, end);
      }
      const quoteAge = mode === 'stale' ? 60_000 : mode === 'older snapshot' ? 20_000 : 0;
      const time = endpoint === 'tickers' ? now - quoteAge : now;
      return new Response(JSON.stringify({retCode: 0, time, result}), {
        headers: {'Content-Type': 'application/json'}
      });
    }
  });
  vm.runInContext(fs.readFileSync('docs/scanner.js', 'utf8'), app);
  const read = code => vm.runInContext(code, app);
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(read('!!(scanRequest || quoteRequest)'), false);
  };
  const firstCard = () => dom.results.children[1];
  const firstVerdict = () => firstCard().children[2].textContent;
  const cards = () => dom.results.children.filter(el => el.dataset.symbol);
  const currentVerdict = () => [...read('verdict(signals[0], quoteMetrics(quoteSnapshot?.rows.get(signals[0].symbol), signals[0]))')];
  read('document.hidden = false; navigator.onLine = true');
  tick();
  await settle();
  assert.match(dom.status.textContent, /Scan complete · 24 \/ 24/);
  const groups = [dom.results.children.slice(1, 11), dom.results.children.slice(12, 22)];
  assert.deepEqual(groups.map(group => group.length), [10, 10]);
  assert.equal(dom.results.children[0].textContent, 'Top LONG');
  assert.equal(dom.results.children[11].textContent, 'Top SHORT');
  for (const [group, side] of groups.map((rows, i) => [rows, i ? 'S' : 'L'])) {
    assert(group.every(card => card.dataset.symbol.startsWith(side)));
    assert.match(group.at(-1).children[0].textContent, /^#10 · Score/);
    const scores = group.map(card => Number(card.children[0].textContent.split(' ').at(-1)));
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  }
  assert.match(firstVerdict(), /^READY TO REVIEW/);
  assert.match(dom.readiness.textContent, /^24 READY TO REVIEW/);
  assert.match(firstCard().children[3].children[0].textContent, /Bid 100.595 · Ask 100.605/);
  assert.match(firstCard().children[3].children[1].textContent, /^Bybit snapshot · response .* · 0s ago$/);
  assert.equal(dom['quote-source'].textContent, '0 live · 20 REST snapshots shown');
  assert.equal(dom['reference-book'].textContent, 'Bid 79999 · Ask 80001');

  mode = 'only low score ready';
  now += 10_000;
  tick();
  await settle();
  assert.match(dom.readiness.textContent, /^2 READY TO REVIEW · LONG L0 \(1\) · SHORT S0 \(1\)$/);
  assert.equal(firstCard().dataset.symbol, 'L0');
  assert.match(firstVerdict(), /^READY TO REVIEW/);
  assert.deepEqual(cards().map(card => card.dataset.symbol), ['L0', 'S0']);

  const acceptedTime = read('quoteSnapshot.time');
  mode = 'older snapshot';
  now += 10_000;
  tick();
  await settle();
  assert.equal(read('quoteSnapshot.time'), acceptedTime);
  assert.deepEqual(cards().map(card => card.dataset.symbol), ['L0', 'S0']);
  assert.match(dom['quote-warning'].textContent, /older quote snapshot · Ignored/);

  for (const [failure, reason] of [['missing funding', /Funding unavailable/],
    ['stale', /Bybit quote refresh failed/], ['HTTP failure', /Bybit quote refresh failed/]]) {
    mode = failure;
    now += 10_000;
    tick();
    await settle();
    assert.equal(currentVerdict()[0], 'WAIT');
    assert.match(currentVerdict()[1], reason);
    assert.equal(cards().length, 0);
    assert.match(dom.readiness.textContent, /^0 READY TO REVIEW/);
  }
  mode = 'healthy';
  now += 10_000;
  tick();
  await settle();
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  events.pagehide();
  assert.deepEqual(currentVerdict(), ['WAIT', 'Page paused']);
  assert.equal(cards().length, 0);
  now += 60_000;
  tick();
  await settle();
  assert.deepEqual(currentVerdict(), ['WAIT', 'Page paused']);
  events.pageshow({persisted: true});
  await settle();
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  read('document.hidden = true');
  events.visibilitychange();
  assert.match(firstVerdict(), /^READY TO REVIEW/);
  now += 10_000;
  tick();
  await settle();
  assert.equal(read('quoteSnapshot.time'), now);

  expectedClose += 300_000;
  now = expectedClose + 2500;
  const previousCard = firstCard();
  let releaseCandles;
  heldCandles = new Promise(resolve => { releaseCandles = resolve; });
  tick();
  assert.deepEqual(currentVerdict(), ['WAIT', 'Scan in progress']);
  assert.equal(cards().length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(dom['reference-time'].textContent, /^Bybit snapshot/);
  now += 10_000;
  tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read('quoteSnapshot.time'), now);
  assert.equal(read('!!scanRequest'), true);
  assert.match(dom['reference-time'].textContent, /^Bybit snapshot .* · 0s ago$/);
  heldCandles = null;
  releaseCandles();
  await settle();
  assert.notEqual(firstCard(), previousCard);
  assert.equal(read('scanClose'), expectedClose);
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  read('document.hidden = false');
  events.visibilitychange();
  assert.deepEqual(currentVerdict(), ['WAIT', 'Bybit quote unavailable or stale']);
  await settle();
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  heldCandles = new Promise(() => {});
  const interruptedScan = dom.scan.onclick();
  await new Promise(resolve => setImmediate(resolve));
  events.pagehide();
  await interruptedScan;
  assert.equal(read('!!scanRequest'), false);
  assert.equal(dom['reference-book'].textContent, 'Bid — · Ask —');
  heldCandles = null;
  events.pageshow({persisted: true});
  await settle();
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  mode = 'partial';
  await dom.scan.onclick();
  await settle();
  assert.match(dom.status.textContent, /Partial scan · 23 \/ 24/);
  assert.deepEqual(currentVerdict(), ['WAIT', 'Incomplete candle scan']);
  assert.equal(cards().length, 0);
  mode = 'healthy';
  now += 30_000;
  tick();
  await settle();
  assert.match(dom.status.textContent, /Scan complete · 24 \/ 24/);
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  mode = 'transient candle error';
  l0Requests = 0;
  await dom.scan.onclick();
  await settle();
  assert.equal(l0Requests, 2);
  assert.match(dom.status.textContent, /Scan complete · 24 \/ 24/);

  let socket;
  const sent = [];
  app.WebSocket = class {
    constructor(url) {
      assert.equal(url, 'wss://stream.bybit.com/v5/public/linear');
      socket = this;
      this.readyState = 0;
    }
    send(message) { sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.onclose?.(); }
  };
  tick();
  socket.readyState = 1;
  socket.onopen();
  const symbol = firstCard().dataset.symbol;
  const book = firstCard().children[3];
  assert(sent[0].args.includes('tickers.' + symbol));
  assert(sent[0].args.includes('tickers.BTCUSDT'));
  const sendTicker = (type, data, ts = now) =>
    socket.onmessage({data: JSON.stringify({topic: 'tickers.' + symbol, type, ts, data})});
  const sendReference = () => socket.onmessage({data: JSON.stringify({
    topic: 'tickers.BTCUSDT', type: 'snapshot', ts: now, data: {bid1Price: '79999', ask1Price: '80001'}
  })});
  sendTicker('delta', {ask1Price: '101'});
  assert.match(book.children[1].textContent, /^Bybit snapshot/);
  sendTicker('snapshot', {symbol, bid1Price: '100.595', ask1Price: '100.606',
    bid1Size: '100', ask1Size: '100', fundingRate: '0', turnover24h: '5000000'});
  sendTicker('delta', {ask1Price: '100.607'});
  sendTicker('delta', {ask1Price: '101'}, now - 1);
  tick();
  assert.match(book.children[0].textContent, /Ask 100.607$/);
  assert.match(book.children[1].textContent, /^Bybit LIVE · ticker update .* · 0s ago$/);
  sendTicker('delta', {ask1Price: '99'});
  tick();
  assert.match(book.children[1].textContent, /^Bybit snapshot/);
  assert.match(firstVerdict(), /^READY TO REVIEW/);
  sendTicker('delta', {ask1Price: '100.607'});
  tick();
  assert.match(book.children[1].textContent, /^Bybit LIVE/);
  now += 8_000;
  read('updateCards()');
  assert.match(book.children[1].textContent, /^Bybit snapshot/);
  sendReference();
  now += 17_000;
  read('updateCards()');
  assert.equal(cards().length, 0);
  tick();
  await settle();
  sendTicker('delta', {ask1Price: '100.607'});
  tick();
  assert.match(book.children[1].textContent, /^Bybit LIVE/);
  socket.close();
  assert.match(book.children[1].textContent, /^Bybit snapshot/);

  // A setup ranked outside the initial subscription cap can become visible.
  read(`const sample = signals.find(setup => setup.symbol === '${symbol}');
    const bookRow = quoteSnapshot.rows.get(sample.symbol);
    const waiting = Array.from({length: 100}, (_, i) => ({
      ...sample, card: undefined, symbol: 'WAIT' + i, score: 200 - i, baseIssue: 'Screening failed'
    }));
    const early = {...sample, card: undefined, symbol: 'EARLY', score: 1, confirmed: false,
      confirmationGaps: ['5m volume']};
    signals = [...waiting, early];
    nextStreamAt = 0;
    updateCards();
    maintainStream();`);
  socket.readyState = 1;
  socket.onopen();
  assert.equal(sent.at(-1).args.length, 100);
  assert(!sent.at(-1).args.includes('tickers.EARLY'));
  read(`quoteSnapshot.rows.set('EARLY', bookRow); updateCards(); maintainStream();`);
  assert.deepEqual(cards().map(card => card.dataset.symbol), ['EARLY']);
  assert.match(firstVerdict(), /^EARLY · 5m volume/);
  assert.equal(sent.at(-2).op, 'unsubscribe');
  assert.deepEqual(sent.at(-1), {op: 'subscribe', args: ['tickers.EARLY']});
  assert.equal(read('streamTopics.size'), 100);
  now += 25_000;
  socket.onmessage({data: JSON.stringify({op: 'ping', success: true})});
  read('maintainStream()');
  assert.equal(socket.readyState, 3);
  assert.equal(read('stream'), null);

  mode = 'host candle outage';
  read("host = HOSTS[0]; failedHosts.clear()");
  await dom.scan.onclick();
  assert.match(dom.status.textContent, /Scan unavailable/);
  assert.match(dom['reference-time'].textContent, /^Bybit snapshot/);
  await dom.scan.onclick();
  assert.match(dom.status.textContent, /Scan complete .* api.bytick.com/);
  mode = 'newly listed';
  await dom.scan.onclick();
  assert.match(dom.status.textContent, /No eligible contracts · 0 \/ 0/);
  assert.match(dom['reference-time'].textContent, /^Bybit snapshot/);
  assert.equal(cards().length, 0);
});

test('GYLEX catalog accepts hundreds of symbols and deduplicates pair formats', () => {
  const pairs = Array.from({length: 350}, (_, i) => 'TOKEN' + i + '/USDT');
  const input = [...pairs, 'TOKEN0USDT', 'token1-usdt', 'ETH/USDC', 'invalid'].join(', ');
  context.catalogInput = input;
  assert.equal(run('parseGylexPairs(catalogInput).size'), 350);
  assert.equal(run("parseGylexPairs(catalogInput).has('TOKEN349USDT')"), true);
  assert.equal(run("parseGylexPairs('garbage').size"), 0);
  assert.deepEqual([...run("parseGylexPairs('龙虾/USDT 龙虾USDT')")], ['龙虾USDT']);
});

test('the default GYLEX list contains the supplied symbols', () => {
  assert.equal(run('gylexPairs.size'), 82);
  for (const symbol of ['AVAXUSDT', 'STRKUSDT', 'ZEREBROUSDT', '龙虾USDT']) {
    context.symbolToCheck = symbol;
    assert.equal(run('gylexPairs.has(symbolToCheck)'), true);
  }
});

test('GYLEX mode intersects the imported pairs with eligible Bybit perpetuals', async () => {
  const symbols = ['BTCUSDT', 'ICNTUSDT', 'SOLUSDT', 'BZUSDT', 'ETHUSDT', 'AVAXUSDT'];
  const app = vm.createContext({
    document: {hidden: true, addEventListener() {}, getElementById() { return {setAttribute() {}}; }},
    window: {addEventListener() {}},
    navigator: {onLine: false},
    location: {search: '?market=gylex'},
    localStorage: {getItem() { return 'BTC/USDT ICNT/USDT SOLUSDT ETHUSDT AVAX/USDT'; }},
    setInterval() {}, setTimeout, clearTimeout, AbortController, URLSearchParams,
    async fetch(url) {
      const instruments = url.includes('/instruments-info?');
      const list = symbols.map(symbol => instruments ?
        {symbol, quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading',
          contractType: symbol === 'ETHUSDT' ? 'LinearFutures' : 'LinearPerpetual'} :
        {symbol, turnover24h: symbol === 'SOLUSDT' ? '500000' : '3000000'});
      return new Response(JSON.stringify({retCode: 0, time: Date.now(), result: {category: 'linear', list}}),
        {headers: {'Content-Type': 'application/json'}});
    }
  });
  vm.runInContext(fs.readFileSync('docs/scanner.js', 'utf8'), app);
  const symbolsFound = await vm.runInContext(
    "universe('https://api.bybit.com', new AbortController().signal).then(data => data.eligible.map(row => row.symbol))", app);
  assert.deepEqual([...symbolsFound], ['BTCUSDT', 'ICNTUSDT', 'AVAXUSDT']);
});

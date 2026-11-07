const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({
  document: {hidden: true, addEventListener() {}, getElementById() { return {setAttribute() {}}; }},
  location: {search: ''},
  URLSearchParams,
  window: {addEventListener() {}},
  navigator: {onLine: true},
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
  assert.equal(run('verdict({...setup, confirmed: false}, healthy)[0]'), 'EARLY');
  assert.equal(run('verdict(setup, null)[0]'), 'WAIT');
  assert.equal(run('verdict(setup, {...healthy, funding: NaN})[0]'), 'WAIT');
  assert.equal(run('incomplete = true; verdict(setup, healthy)[0]'), 'WAIT');
  assert.equal(run('incomplete = false; scanClose -= CANDLE_MS + CLOSE_GRACE_MS; verdict(setup, healthy)[0]'), 'WAIT');
});

test('candles must be contiguous and end at the pinned close', () => {
  run(`const end = 30000000;
    const rows = Array.from({length: 45}, (_, i) =>
      [end - (i + 1) * CANDLE_MS, 100, 101, 99, 100, 10, 1000]);
    const ticker = {symbol: 'TESTUSDT', turnover24h: '5000000'};`);
  assert.equal(run('analyze(ticker, rows, end)'), null);
  assert.throws(() => run('analyze(ticker, rows.slice(1), end)'), /Latest closed candle missing/);
  assert.throws(() => run('analyze(ticker, rows.filter((_, i) => i !== 2), end)'), /Invalid or missing candles/);
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
  const dom = Object.fromEntries(['scan', 'status', 'warning', 'results', 'readiness', 'bybit-market', 'gylex-market', 'gylex-note'].map(id => [id, element()]));
  const firstClose = 1_800_000_000_000;
  let now = firstClose + 120_000;
  let expectedClose = firstClose;
  const events = {};
  const symbols = ['L', 'S'].flatMap(side => Array.from({length: 12}, (_, i) => side + i));
  let mode = 'healthy';
  let tick;
  class Clock extends Date {
    static now() { return now; }
  }
  const app = vm.createContext({
    document: {hidden: true, addEventListener() {}, getElementById: id => dom[id], createElement: element},
    window: {addEventListener(name, callback) { events[name] = callback; }},
    navigator: {onLine: true},
    location: {search: ''},
    setInterval: callback => { tick = callback; },
    setTimeout, clearTimeout, AbortController, URL, URLSearchParams, Date: Clock,
    async fetch(url) {
      const {pathname, searchParams: params} = new URL(url);
      const endpoint = pathname.split('/').at(-1);
      const result = {category: 'linear'};
      if (endpoint === 'instruments-info') {
        result.list = (params.has('cursor') ? symbols.slice(12) : symbols.slice(0, 12)).map(symbol =>
          ({symbol, quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading'}));
        result.nextPageCursor = params.has('cursor') ? '' : 'page2';
      } else if (endpoint === 'tickers') {
        if (mode === 'HTTP failure') return {ok: false, status: 503};
        result.list = symbols.map((symbol, index) => {
          const reference = symbol.startsWith('L') ? 100.6 : 99.4;
          return {symbol, turnover24h: String(3_000_000 + index * 400_000),
            fundingRate: mode === 'missing funding' ? '' : '-0.0001',
            bid1Price: (reference - 0.005).toFixed(3), ask1Price: (reference + 0.005).toFixed(3),
            bid1Size: '100', ask1Size: '100'};
        });
      } else {
        assert.equal(endpoint, 'kline');
        const symbol = params.get('symbol');
        if (mode === 'partial' && symbol === 'L0') return {ok: false, status: 503};
        const end = Number(params.get('end')) + 1;
        assert.equal(end, expectedClose);
        const direction = symbol.startsWith('L') ? 1 : -1;
        const levels = Array.from({length: 42}, (_, i) => 100 + direction * (i % 2) * 0.2);
        levels[41] = 100;
        levels.push(...[0.2, 0.4, 0.6].map(offset => 100 + direction * offset));
        result.symbol = symbol;
        result.list = levels.map((price, i) => [
          end - (45 - i) * 300_000, price, price + 0.4, price - 0.4, price, 10, i >= 42 ? 2300 : 1000
        ]).reverse();
      }
      const time = mode === 'stale' && endpoint === 'tickers' ? now - 60_000 : now;
      return new Response(JSON.stringify({retCode: 0, time, result}), {
        headers: {'Content-Type': 'application/json'}
      });
    }
  });
  vm.runInContext(fs.readFileSync('docs/scanner.js', 'utf8'), app);
  const read = code => vm.runInContext(code, app);
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(read('scanBusy || !!quoteRequest'), false);
  };
  const firstCard = () => dom.results.children[1];
  const firstVerdict = () => firstCard().children[2].textContent;
  read('document.hidden = false');
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
  assert.match(dom.readiness.textContent, /^20 READY TO REVIEW/);
  assert.match(firstCard().children[3].children[0].textContent, /Bid 100.595 · Ask 100.605/);
  assert.match(firstCard().children[3].children[1].textContent, /^Bybit snapshot/);

  for (const [failure, reason] of [['missing funding', /Funding unavailable/],
    ['stale', /Bybit quote refresh failed/], ['HTTP failure', /Bybit quote refresh failed/]]) {
    mode = failure;
    now += 10_000;
    tick();
    await settle();
    assert.match(firstVerdict(), /^WAIT/);
    assert.match(firstVerdict(), reason);
    assert.match(dom.readiness.textContent, /^0 READY TO REVIEW/);
  }
  mode = 'healthy';
  now += 10_000;
  tick();
  await settle();
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  events.pagehide();
  assert.match(firstVerdict(), /^WAIT · Page paused/);
  assert.equal(firstCard().children[3].children[1].textContent, 'No fresh bid/ask');
  now += 60_000;
  tick();
  await settle();
  assert.match(firstVerdict(), /^WAIT · Page paused/);
  events.pageshow({persisted: true});
  await settle();
  assert.match(firstVerdict(), /^READY TO REVIEW/);

  expectedClose += 300_000;
  now = expectedClose + 2500;
  const previousCard = firstCard();
  tick();
  assert.match(firstVerdict(), /^WAIT · Scan in progress/);
  await settle();
  assert.notEqual(firstCard(), previousCard);
  assert.equal(read('scanClose'), expectedClose);
  assert.match(firstVerdict(), /^READY TO REVIEW/);
  mode = 'partial';
  await dom.scan.onclick();
  await settle();
  assert.match(dom.status.textContent, /Partial scan · 23 \/ 24/);
  assert.match(firstVerdict(), /^WAIT · Incomplete candle scan/);
  mode = 'healthy';
  now += 30_000;
  tick();
  await settle();
  assert.match(dom.status.textContent, /Scan complete · 24 \/ 24/);
  assert.match(firstVerdict(), /^READY TO REVIEW/);
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
    navigator: {onLine: true},
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

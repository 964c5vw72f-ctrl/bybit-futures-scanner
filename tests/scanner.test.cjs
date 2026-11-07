const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({
  document: {hidden: true, addEventListener() {}, getElementById() { return {}; }},
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

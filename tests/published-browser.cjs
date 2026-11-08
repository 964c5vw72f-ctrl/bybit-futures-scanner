const assert = require('node:assert/strict');
const {readFile} = require('node:fs/promises');
const {setTimeout: delay} = require('node:timers/promises');
const {devices, webkit} = require('playwright');
const {candles} = require('./bybit-fixture.cjs');

const published = new URL(process.argv[2]);
const close = 1_800_000_000_000;
const initialTime = close + 120_000;
const symbols = ['LTESTUSDT', 'STESTUSDT'];
const quotes = symbols.map((symbol, index) => {
  const reference = index ? 99.4 : 100.6;
  return {symbol, bid1Price: String(reference - 0.005), ask1Price: String(reference + 0.005),
    bid1Size: '100', ask1Size: '100', turnover24h: '5000000', fundingRate: '0'};
});

async function waitForPublishedFiles() {
  const [html, script] = await Promise.all([
    readFile('docs/index.html', 'utf8'),
    readFile('docs/scanner.js', 'utf8')
  ]);
  const scriptPath = html.match(/<script defer src="([^"]+)"/)[1];
  const deadline = Date.now() + 240_000;
  let lastError;
  while (Date.now() < deadline) {
    published.searchParams.set('pages-check', String(Date.now()));
    try {
      const responses = await Promise.all([published, new URL(scriptPath, published)].map(url =>
        fetch(url, {cache: 'no-store', signal: AbortSignal.timeout(10_000)})));
      const [publishedHtml, publishedScript] = await Promise.all(responses.map(response => {
        if (!response.ok) throw Error(response.url + ' returned HTTP ' + response.status);
        return response.text();
      }));
      if (publishedHtml === html && publishedScript === script) return;
      lastError = Error('GitHub Pages is serving a different HTML or JavaScript revision');
    } catch (error) {
      lastError = error;
    }
    await delay(5000);
  }
  throw lastError;
}

async function checkBrowser() {
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage(devices['iPhone 15']);
    page.setDefaultTimeout(10_000);
    await page.clock.install({time: initialTime});
    let failRest = false;
    await page.route('https://api.bybit.com/v5/market/**', async route => {
      const {pathname, searchParams} = new URL(route.request().url());
      const endpoint = pathname.split('/').at(-1);
      const result = {category: 'linear'};
      if (endpoint === 'instruments-info') {
        result.list = symbols.map(symbol =>
          ({symbol, quoteCoin: 'USDT', settleCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading'}));
      } else if (endpoint === 'tickers') {
        if (failRest) return route.fulfill({status: 503});
        result.list = quotes;
      } else {
        assert.equal(endpoint, 'kline');
        result.symbol = searchParams.get('symbol');
        const end = Number(searchParams.get('end')) + 1;
        assert.equal(end, close);
        result.list = candles(result.symbol, end);
      }
      return route.fulfill({
        headers: {'access-control-allow-origin': '*'},
        json: {retCode: 0, time: await page.evaluate(() => Date.now()), result}
      });
    });
    let tickerSocket;
    await page.routeWebSocket('wss://stream.bybit.com/v5/public/linear', socket => {
      socket.onMessage(message => {
        const {op, args} = JSON.parse(message);
        if (op === 'subscribe' && args.includes('tickers.' + symbols[0])) tickerSocket = socket;
      });
    });

    await page.goto(published.href);
    await page.getByText('2 READY TO REVIEW', {exact: false}).waitFor();
    assert.deepEqual(await page.locator('#results h2').allTextContents(), ['Top LONG', 'Top SHORT']);
    assert.deepEqual(await page.locator('#results article .symbol').allTextContents(),
      [symbols[0] + ' · LONG', symbols[1] + ' · SHORT']);
    const quoteTime = page.locator('#results article').first().locator('.live-time');
    assert.match(await quoteTime.textContent(), /^Bybit snapshot/);

    const subscribeDeadline = Date.now() + 5000;
    while (!tickerSocket && Date.now() < subscribeDeadline) await delay(50);
    assert(tickerSocket, 'Browser did not subscribe to the visible LONG ticker');
    const timestamp = await page.evaluate(() => Date.now());
    tickerSocket.send(JSON.stringify({topic: 'tickers.' + symbols[0], type: 'snapshot', ts: timestamp, data: quotes[0]}));
    await quoteTime.filter({hasText: /^Bybit LIVE/}).waitFor();
    await tickerSocket.close();
    await quoteTime.filter({hasText: /^Bybit snapshot/}).waitFor();

    failRest = true;
    await page.clock.fastForward(11_000);
    await page.getByText('Bybit quote refresh failed', {exact: false}).waitFor();
    assert.equal(await page.locator('#results article').count(), 0);
    assert.match(await page.locator('#readiness').textContent(), /^0 READY TO REVIEW/);
  } finally {
    await browser.close();
  }
}

(async () => {
  await waitForPublishedFiles();
  await checkBrowser();
  console.log('Published assets match checkout. WebKit verified LONG/SHORT and LIVE → snapshot → WAIT with simulated Bybit data.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

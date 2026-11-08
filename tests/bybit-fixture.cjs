const CANDLE_MS = 300_000;

function candles(symbol, end) {
  const direction = symbol.startsWith('L') ? 1 : -1;
  const levels = Array.from({length: 42}, (_, i) => 100 + direction * (i % 2) * 0.2);
  levels[41] = 100;
  levels.push(...[0.2, 0.4, 0.6].map(offset => 100 + direction * offset));
  return levels.map((price, i) => [
    end - (45 - i) * CANDLE_MS, price, price + 0.4, price - 0.4, price, 10, i >= 42 ? 2300 : 1000
  ]).reverse();
}

module.exports = {candles};

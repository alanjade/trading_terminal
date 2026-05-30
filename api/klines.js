export default async function handler(req, res) {
  const { exchange, sym, tf } = req.query;
  
  const urls = {
    binance: `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=500`,
    bybit:   `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${tf}&limit=500`,
    okx:     `https://www.okx.com/api/v5/market/candles?instId=${sym.replace('USDT','-USDT')}&bar=${tf}&limit=500`,
  };

  const url = urls[exchange];
  if (!url) return res.status(400).json({ error: 'unknown exchange' });

  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'upstream ' + r.status });
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=10');
    res.json(data);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
}
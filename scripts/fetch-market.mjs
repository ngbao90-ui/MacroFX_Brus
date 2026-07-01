// Pulls fresh prices from Financial Modeling Prep and updates ONLY numeric
// fields (market bar values, pair prices) in data/dashboard.json.
// This is pure data-fetching — zero LLM tokens spent. Run this before
// llm-update.mjs so the model always reasons from today's real prices.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dataPath = path.join(root, 'data/dashboard.json');

const FMP_KEY = process.env.FMP_API_KEY;
if (!FMP_KEY) {
  console.error('Missing FMP_API_KEY secret. Skipping live price fetch (dashboard.json left unchanged).');
  process.exit(0);
}

// Try v4 first, fallback to v3
const FMP_BASES = [
  'https://financialmodelingprep.com/api/v4',
  'https://financialmodelingprep.com/api/v3'
];
let FMP_BASE = FMP_BASES[0];

async function fmpQuote(symbols) {
  const url = `${FMP_BASE}/quote/${symbols.join(',')}?apikey=${FMP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP error ${res.status}: ${await res.text()}`);
  return res.json();
}

// All FX pairs we track, mapped to FMP forex symbols.
const ALL_PAIRS = [
  'EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF',
  'EURJPY', 'EURGBP', 'EURCHF', 'EURCAD', 'EURAUD', 'EURNZD',
  'GBPJPY', 'GBPCHF', 'GBPCAD', 'GBPAUD', 'GBPNZD',
  'AUDCAD', 'AUDCHF', 'AUDJPY', 'AUDNZD',
  'NZDJPY', 'NZDCAD', 'NZDCHF',
  'CADJPY', 'CADCHF', 'CHFJPY',
];

const OTHER_SYMBOLS = {
  gold: 'GCUSD',
  wti: 'CLUSD',
  brent: 'BZUSD',
  sp500: '%5EGSPC',
  us10y: '%5ETNX', // CBOE 10Y yield index, value/10 = %
};

function fmtPrice(v, digits) {
  return Number(v).toFixed(digits);
}

async function main() {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  try {
    // ---- FX pairs (chunk requests to stay under URL limits) ----
    const priceByCode = {};
    const chunks = [];
    for (let i = 0; i < ALL_PAIRS.length; i += 10) chunks.push(ALL_PAIRS.slice(i, i + 10));
    for (const chunk of chunks) {
      try {
        const quotes = await fmpQuote(chunk);
        for (const q of quotes) {
          const digits = q.symbol.includes('JPY') ? 2 : 4;
          priceByCode[q.symbol] = fmtPrice(q.price, digits);
        }
      } catch (e) {
        console.warn(`Failed to fetch chunk ${chunk.join(',')}: ${e.message}`);
        // Continue with next chunk
      }
    }

    for (const p of data.pairs.usd) if (priceByCode[p.code]) p.price = priceByCode[p.code];
    for (const p of data.pairs.cross) if (priceByCode[p.code]) p.price = priceByCode[p.code];

    // ---- Market bar (Gold / WTI / Brent / S&P500 / US10Y / DXY) ----
    try {
      const others = await fmpQuote(Object.values(OTHER_SYMBOLS));
      const byUnderlying = Object.fromEntries(others.map(o => [o.symbol, o]));

      const setBar = (label, value) => {
        const item = data.marketBar.find(m => m.label === label);
        if (item) item.value = value;
      };
      if (byUnderlying[OTHER_SYMBOLS.gold]) setBar('Gold', `$${Math.round(byUnderlying[OTHER_SYMBOLS.gold].price).toLocaleString('en-US')}`);
      if (byUnderlying[OTHER_SYMBOLS.wti]) setBar('WTI', `$${fmtPrice(byUnderlying[OTHER_SYMBOLS.wti].price, 2)}`);
      if (byUnderlying[OTHER_SYMBOLS.brent]) setBar('Brent', `$${fmtPrice(byUnderlying[OTHER_SYMBOLS.brent].price, 2)}`);
      if (byUnderlying[OTHER_SYMBOLS.sp500]) setBar('S&P500', Math.round(byUnderlying[OTHER_SYMBOLS.sp500].price).toLocaleString('en-US'));
      if (byUnderlying[OTHER_SYMBOLS.us10y]) setBar('US10Y', `${fmtPrice(byUnderlying[OTHER_SYMBOLS.us10y].price / 10, 2)}%`);

      // DXY: FMP symbol "DX" or "DX-Y.NYB" often unavailable on free tier; try, else leave as-is.
      try {
        const dxy = await fmpQuote(['DX-Y.NYB']);
        if (dxy[0]) setBar('DXY', fmtPrice(dxy[0].price, 2));
      } catch { /* leave existing value */ }
    } catch (e) {
      console.warn(`Failed to fetch market bar commodities: ${e.message}`);
      // Continue - we still have FX pairs updated
    }
  } catch (e) {
    console.warn('FMP fetch failed, skipping price update:', e.message);
    console.log('Dashboard prices left unchanged - will use existing data.');
  }

  data.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log('Updated dashboard data. FX pairs and market bar updated where FMP data available.');
}

main().catch(e => {
  console.error('fetch-market.mjs failed:', e);
  process.exit(1);
});

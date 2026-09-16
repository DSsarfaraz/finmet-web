#!/usr/bin/env node
/**
 * Finmet Daily News — data fetcher
 * -------------------------------------------------
 * Writes data.json (read by Daily_News.html) once a day via the GitHub
 * Action in .github/workflows/daily-update.yml (9:00 AM IST).
 *
 * Manual test run:
 *   ALPHAVANTAGE_KEY=xxx NEWSAPI_KEY=xxx node scripts/fetch-data.js
 *
 * Requires Node 18+ (built-in fetch). No npm install needed.
 *
 * Data sources:
 *   - Nifty 50, Sensex, Crude (WTI), Gold (USD), USD/INR
 *       Primary:  Yahoo Finance's public chart endpoint (no key/signup required)
 *       Backup:   Alpha Vantage, used only if Yahoo fails for crude/gold
 *                 (Alpha Vantage does not carry Nifty/Sensex index data)
 *   - Nifty 200 gainers/losers: NSE India public endpoint (no key)
 *   - News (international / Indian / stocks-in-news): NewsAPI.org
 *
 * Required secrets (see ../SETUP_GUIDE.md):
 *   ALPHAVANTAGE_KEY  - free key from https://www.alphavantage.co/support/#api-key
 *   NEWSAPI_KEY       - free key from https://newsapi.org
 */

const fs = require('fs');
const path = require('path');

const ALPHAVANTAGE_KEY = process.env.ALPHAVANTAGE_KEY || '';
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || '';

// Writes next to Daily_News.html by default (one level up from /scripts).
// Set DATA_OUT_DIR if your site keeps pages in a different folder.
const OUT_DIR = process.env.DATA_OUT_DIR
  ? path.resolve(process.env.DATA_OUT_DIR)
  : path.join(__dirname, '..');
const OUT_FILE = path.join(OUT_DIR, 'data.json');

function log(...args) { console.log(new Date().toISOString(), '-', ...args); }

async function safeJsonFetch(url, options = {}, label = url) {
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    if (!res.ok) {
      log(`✗ ${label}: HTTP ${res.status}`, text.slice(0, 300));
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      log(`✗ ${label}: response was not JSON`, text.slice(0, 300));
      return null;
    }
  } catch (err) {
    log(`✗ ${label}: ${err.message}`);
    return null;
  }
}

// ------------------------------------------------------------------
// 1a. Primary: Yahoo Finance public chart endpoint (no key needed)
// ------------------------------------------------------------------
async function getYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const data = await safeJsonFetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinmetBot/1.0)' },
  }, `Yahoo:${symbol}`);
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  if (price == null || prevClose == null) return null;
  const changePct = ((price - prevClose) / prevClose) * 100;
  return { price: Number(price), changePct: Number(changePct) };
}

// ------------------------------------------------------------------
// 1b. Backup: Alpha Vantage — only used if Yahoo fails, for crude & gold
// ------------------------------------------------------------------
async function getAlphaVantageWTI() {
  if (!ALPHAVANTAGE_KEY) return null;
  const url = `https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${ALPHAVANTAGE_KEY}`;
  const data = await safeJsonFetch(url, {}, 'AlphaVantage:WTI');
  const series = data?.data;
  if (!Array.isArray(series) || series.length < 2) return null;
  const latest = Number(series[0].value);
  const prev = Number(series[1].value);
  if (!latest || !prev) return null;
  return { price: latest, changePct: ((latest - prev) / prev) * 100 };
}

async function getAlphaVantageGoldUsd() {
  if (!ALPHAVANTAGE_KEY) return null;
  // Daily XAU/USD series so we can compute a day-over-day % change.
  const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=XAU&to_symbol=USD&apikey=${ALPHAVANTAGE_KEY}`;
  const data = await safeJsonFetch(url, {}, 'AlphaVantage:XAUUSD');
  const series = data?.['Time Series FX (Daily)'];
  if (!series) return null;
  const dates = Object.keys(series).sort().reverse();
  if (dates.length < 2) return null;
  const latest = Number(series[dates[0]]['4. close']);
  const prev = Number(series[dates[1]]['4. close']);
  if (!latest || !prev) return null;
  return { price: latest, changePct: ((latest - prev) / prev) * 100 };
}

async function getUsdInrRate() {
  const y = await getYahooQuote('INR=X');
  if (y) return y.price;
  if (ALPHAVANTAGE_KEY) {
    const data = await safeJsonFetch(
      `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=USD&to_currency=INR&apikey=${ALPHAVANTAGE_KEY}`,
      {}, 'AlphaVantage:USDINR'
    );
    const rate = data?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate'];
    if (rate) return Number(rate);
  }
  return 83.5; // last-resort static fallback so gold-in-INR still renders something reasonable
}

async function getIndices(previous) {
  const indices = { ...previous };

  const nifty = await getYahooQuote('^NSEI');
  if (nifty) indices.nifty = { label: 'NIFTY 50', value: nifty.price, change_pct: Number(nifty.changePct.toFixed(2)) };
  else log('Nifty: Yahoo lookup failed, keeping previous value.');

  const sensex = await getYahooQuote('^BSESN');
  if (sensex) indices.sensex = { label: 'SENSEX', value: sensex.price, change_pct: Number(sensex.changePct.toFixed(2)) };
  else log('Sensex: Yahoo lookup failed, keeping previous value.');

  let crude = await getYahooQuote('CL=F');
  if (!crude) { log('Crude: Yahoo failed, trying Alpha Vantage...'); crude = await getAlphaVantageWTI(); }
  if (crude) indices.crude = { label: 'CRUDE (WTI)', value: crude.price, change_pct: Number(crude.changePct.toFixed(2)), unit: 'USD/bbl' };
  else log('Crude: no source available, keeping previous value.');

  let goldUsd = await getYahooQuote('GC=F');
  if (!goldUsd) { log('Gold: Yahoo failed, trying Alpha Vantage...'); goldUsd = await getAlphaVantageGoldUsd(); }
  if (goldUsd) {
    indices.gold_usd = { label: 'GOLD (USD)', value: goldUsd.price, change_pct: Number(goldUsd.changePct.toFixed(2)), unit: 'USD/oz' };
    const usdInrRate = await getUsdInrRate();
    const gramsPerOz = 31.1035;
    const inrPer10g = (goldUsd.price / gramsPerOz) * 10 * usdInrRate;
    indices.gold_inr = {
      label: 'GOLD (India, spot equiv.)',
      value: Math.round(inrPer10g),
      change_pct: Number(goldUsd.changePct.toFixed(2)),
      unit: 'INR/10g*',
    };
  } else {
    log('Gold: no source available, keeping previous value.');
  }

  return indices;
}

// ------------------------------------------------------------------
// 2. Nifty 200 top gainers / losers (NSE India public endpoints, no key)
// ------------------------------------------------------------------
async function getNifty200Movers() {
  try {
    const homeRes = await fetch('https://www.nseindia.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const cookie = homeRes.headers.get('set-cookie') || '';

    const url = 'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20200';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/',
        Cookie: cookie,
      },
    });
    if (!res.ok) { log(`✗ NSE Nifty200 movers: HTTP ${res.status}`); return null; }
    const json = await res.json();
    const rows = (json.data || []).filter(r => r.symbol && r.symbol !== 'NIFTY 200');
    const sorted = [...rows].sort((a, b) => b.pChange - a.pChange);
    const toEntry = (r) => ({
      symbol: r.symbol,
      name: r.meta?.companyName || r.symbol,
      change_pct: Number(r.pChange.toFixed(2)),
      price: Number(r.lastPrice),
    });
    return { gainers: sorted.slice(0, 5).map(toEntry), losers: sorted.slice(-5).reverse().map(toEntry) };
  } catch (err) {
    log('✗ NSE Nifty200 movers:', err.message);
    return null;
  }
}

// ------------------------------------------------------------------
// 3. News (NewsAPI.org)
// ------------------------------------------------------------------
async function newsQuery(q, pageSize = 6, sortBy = 'publishedAt') {
  if (!NEWSAPI_KEY) { log('NEWSAPI_KEY not set — skipping news query:', q); return null; }
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=${sortBy}&pageSize=${pageSize}&apiKey=${NEWSAPI_KEY}`;
  const data = await safeJsonFetch(url, {}, `NewsAPI: ${q}`);
  if (!data || data.status !== 'ok') return null;
  return data.articles.map(a => ({ title: a.title, source: a.source?.name, url: a.url, published_at: a.publishedAt }));
}

// "Most impactful" isn't something NewsAPI can rank directly — as a proxy, we
// pull a wider pool sorted by relevancy (NewsAPI's closest signal to
// importance for a query) and keep only the top N actually shown on the page.
async function getInternationalNews() {
  const pool = await newsQuery('"Dow Jones" OR "Federal Reserve" OR "US President" OR tariff OR "import export" OR "global fund"', 8, 'relevancy');
  return pool ? pool.slice(0, 2) : null;
}
async function getIndianNews() {
  const pool = await newsQuery('Nifty OR RBI OR "Reserve Bank of India" OR "Finance Ministry" India', 8, 'relevancy');
  return pool ? pool.slice(0, 3) : null;
}
async function getStocksInNews() {
  const raw = await newsQuery('(NSE OR BSE) (stock OR shares) -"small cap"', 10);
  if (!raw) return null;
  return raw.slice(0, 5).map(a => ({ symbol: guessSymbolFromTitle(a.title), cap: 'Large/Mid Cap', title: a.title, url: a.url }));
}
function guessSymbolFromTitle(title) {
  const match = title.match(/\b[A-Z]{3,}\b/);
  return match ? match[0] : 'NEWS';
}

// ------------------------------------------------------------------
// main
// ------------------------------------------------------------------
async function main() {
  const previous = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
    : { indices: {}, movers: { gainers: [], losers: [] }, news: {} };

  log('Fetching indices (Nifty, Sensex, Crude, Gold)...');
  const indices = await getIndices(previous.indices);

  log('Fetching Nifty 200 movers...');
  const movers = (await getNifty200Movers()) || previous.movers;

  log('Fetching international news...');
  const international = (await getInternationalNews()) || previous.news.international || [];

  log('Fetching Indian markets news...');
  const indian = (await getIndianNews()) || previous.news.indian || [];

  log('Fetching stocks-in-news...');
  const stocksInNews = (await getStocksInNews()) || previous.news.stocks_in_news || [];

  const output = {
    updated_at: new Date().toISOString(),
    indices,
    movers,
    news: { international, indian, stocks_in_news: stocksInNews },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  log('✓ Wrote', OUT_FILE);
}

main().catch(err => {
  console.error('Fatal error in fetch-data.js:', err);
  process.exit(1);
});

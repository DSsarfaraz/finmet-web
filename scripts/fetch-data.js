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
  if (price == null) return null;

  // Prefer computing the previous close from the raw daily closes array
  // (today's close vs the trading day right before it) rather than trusting
  // meta.chartPreviousClose, which can reflect a stale reference point
  // depending on the requested range and cause incorrect % changes.
  const closes = result.indicators?.quote?.[0]?.close;
  let prevClose = null;
  if (Array.isArray(closes)) {
    const validCloses = closes.filter(c => c != null);
    if (validCloses.length >= 2) {
      // If the most recent close is essentially today's live price, use the
      // one before it as "previous close"; otherwise fall back sensibly.
      prevClose = validCloses[validCloses.length - 2];
    }
  }
  if (prevClose == null) {
    prevClose = meta.chartPreviousClose ?? meta.previousClose;
  }
  if (prevClose == null) return null;

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
// 2. Broad indices (Nifty Midcap 150, Nifty Smallcap 100) and top 5
//    sector indices by weightage (Bank, IT, Auto, FMCG, Metal) — all
//    via the same free Yahoo endpoint used for the main indices above.
// ------------------------------------------------------------------
const BROAD_INDEX_SYMBOLS = [
  { symbol: 'NIFTYMIDCAP150.NS', label: 'NIFTY MIDCAP 150' },
  { symbol: '^CNXSC',            label: 'NIFTY SMALLCAP 100' },
];
const SECTOR_INDEX_SYMBOLS = [
  { symbol: '^NSEBANK',  label: 'NIFTY BANK' },
  { symbol: '^CNXIT',    label: 'NIFTY IT' },
  { symbol: '^CNXAUTO',  label: 'NIFTY AUTO' },
  { symbol: '^CNXFMCG',  label: 'NIFTY FMCG' },
  { symbol: '^CNXMETAL', label: 'NIFTY METAL' },
];
const CRYPTO_SYMBOLS = [
  { symbol: 'BTC-USD', label: 'BITCOIN' },
  { symbol: 'ETH-USD', label: 'ETHEREUM' },
];

async function getIndexGroup(symbolList, previous) {
  const results = [];
  for (const { symbol, label } of symbolList) {
    const q = await getYahooQuote(symbol);
    if (q) {
      results.push({ symbol: label, price: q.price, change_pct: Number(q.changePct.toFixed(2)) });
    } else {
      log(`${label}: Yahoo lookup failed, keeping previous value.`);
      const prev = (previous || []).find(p => p.symbol === label);
      if (prev) results.push(prev);
    }
  }
  return results.length > 0 ? results : (previous || []);
}

// ------------------------------------------------------------------
// 3. News (NewsAPI.org)
// ------------------------------------------------------------------
async function newsQuery(q, pageSize = 6, sortBy = 'publishedAt', domain = null) {
  if (!NEWSAPI_KEY) { log('NEWSAPI_KEY not set — skipping news query:', q); return null; }
  const domainParam = domain ? `&domains=${encodeURIComponent(domain)}` : '';
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}${domainParam}&language=en&sortBy=${sortBy}&pageSize=${pageSize}&apiKey=${NEWSAPI_KEY}`;
  const data = await safeJsonFetch(url, {}, `NewsAPI: ${q} (${domain || 'any'})`);
  if (!data || data.status !== 'ok') return null;
  return data.articles.map(a => ({ title: a.title, source: a.source?.name, url: a.url, published_at: a.publishedAt }));
}

// Pull exactly one article from each of 3 named top business/economic outlets,
// so every day's briefing has one unique perspective per source rather than
// several headlines that might all come from the same outlet. Falls back to
// a general (non-domain-restricted) query for any outlet that returns
// nothing — some premium outlets (Bloomberg, WSJ) have sparse coverage on
// NewsAPI's free tier, and we'd rather show 3 relevant finance headlines
// than leave a slot empty.
async function getOneFromEachOutlet(query, domains) {
  const picks = [];
  const usedUrls = new Set();

  for (const domain of domains) {
    const results = await newsQuery(query, 3, 'relevancy', domain);
    const hit = (results || []).find(a => !usedUrls.has(a.url));
    if (hit) { picks.push(hit); usedUrls.add(hit.url); }
  }

  if (picks.length < domains.length) {
    log(`Only found ${picks.length}/${domains.length} outlet-specific results for "${query}" — topping up with a general query.`);
    const needed = domains.length - picks.length;
    const pool = await newsQuery(query, 10, 'relevancy');
    for (const a of (pool || [])) {
      if (picks.length >= domains.length) break;
      if (!usedUrls.has(a.url)) { picks.push(a); usedUrls.add(a.url); }
    }
  }

  return picks.length > 0 ? picks : null;
}

const INTERNATIONAL_QUERY = '(crypto OR bitcoin OR "Federal Reserve" OR "Dow Jones" OR "US President" OR "crude oil" OR gold) AND (market OR economy OR finance OR price OR Fed)';
const INTERNATIONAL_OUTLETS = ['bloomberg.com', 'reuters.com', 'wsj.com'];

const INDIA_QUERY = '(Sensex OR Nifty OR "Finance Ministry" OR economy OR economic OR RBI) AND (India OR market OR finance OR rupee)';
const INDIA_OUTLETS = ['economictimes.indiatimes.com', 'business-standard.com', 'livemint.com'];

async function getInternationalNews() {
  return getOneFromEachOutlet(INTERNATIONAL_QUERY, INTERNATIONAL_OUTLETS);
}
async function getIndianNews() {
  return getOneFromEachOutlet(INDIA_QUERY, INDIA_OUTLETS);
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
    : { indices: {}, broad_indices: [], sector_indices: [], crypto: [], news: {} };

  log('Fetching indices (Nifty, Sensex, Crude, Gold)...');
  const indices = await getIndices(previous.indices);

  log('Fetching broad indices (Midcap 150, Smallcap 100)...');
  const broadIndices = await getIndexGroup(BROAD_INDEX_SYMBOLS, previous.broad_indices);

  log('Fetching top sector indices (Bank, IT, Auto, FMCG, Metal)...');
  const sectorIndices = await getIndexGroup(SECTOR_INDEX_SYMBOLS, previous.sector_indices);

  log('Fetching crypto (BTC, ETH)...');
  const crypto = await getIndexGroup(CRYPTO_SYMBOLS, previous.crypto);

  log('Fetching international news...');
  const international = (await getInternationalNews()) || previous.news.international || [];

  log('Fetching Indian markets news...');
  const indian = (await getIndianNews()) || previous.news.indian || [];

  log('Fetching stocks-in-news...');
  const stocksInNews = (await getStocksInNews()) || previous.news.stocks_in_news || [];

  const output = {
    updated_at: new Date().toISOString(),
    indices,
    broad_indices: broadIndices,
    sector_indices: sectorIndices,
    crypto,
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

# Daily News — Setup Guide (Finmet)

## What's in this folder
```
index.html                          ← your homepage, with a new "Daily News" nav link added
Daily_News.html                     ← the new page, styled to match your site
data.json                           ← sample data (auto-overwritten daily once live)
scripts/fetch-data.js               ← fetches market data + news, writes data.json
.github/workflows/daily-update.yml  ← runs the script every day at 9:00 AM IST
```

Drop `Daily_News.html`, `data.json`, and `scripts/` into the same place in
your repo where `index.html`, `overlap.html`, etc. already live (so the
relative link `Daily_News.html` and the `fetch('data.json')` call both
resolve correctly). Then merge the `.github/workflows/daily-update.yml`
file into your repo's `.github/workflows/` folder.

**Note on `index.html`:** I only added a "Daily News" nav link (desktop
menu, mobile drawer, footer) — everything else in your file is untouched.
Diff it against your current version before overwriting, in case you've
made other edits since you gave me this copy.

## How the auto-update works
```
GitHub Action (cron, 9:00 AM IST)
        │
        ▼
scripts/fetch-data.js  →  calls RapidAPI (market data) + NewsAPI (news)
        │
        ▼
   writes data.json  →  committed back to your repo  →  deployed to Firebase Hosting
        │
        ▼
Daily_News.html reads data.json on every page load (no server, no exposed keys)
```

## 1. Your API keys

**Good news: your Alpha Vantage key is already confirmed and wired in.**
I checked its actual response format for crude oil (`WTI`) and gold
(`CURRENCY_EXCHANGE_RATE` treating gold as the currency code `XAU`) against
Alpha Vantage's real documentation, and `scripts/fetch-data.js` matches it.

One thing worth knowing: **Alpha Vantage doesn't carry Nifty/Sensex index
data** — it's built for individual stocks, forex, and a short list of
commodities. So for Nifty and Sensex (and as the primary source for crude
and gold too), the script uses **Yahoo Finance's public data endpoint,
which needs no signup or key at all**. Alpha Vantage kicks in automatically
only as a backup, if that free Yahoo endpoint ever has a hiccup for crude
or gold specifically.

So you're done with signups for market data. You still need one more free
key, for the news sections:

### NewsAPI key — news (international, Indian, stocks-in-news)
1. Sign up free at https://newsapi.org/register
2. Copy your API key from the dashboard → this is `NEWSAPI_KEY`.

## 2. Add GitHub Secrets
`Settings → Secrets and variables → Actions → New repository secret`

| Name | Value |
|---|---|
| `ALPHAVANTAGE_KEY` | `KI2Q5UMZQN5L1ZVW` (the key you already have) |
| `NEWSAPI_KEY` | your NewsAPI key, once you get it |
| `FIREBASE_TOKEN` | from `firebase login:ci` (see below) |
| `FIREBASE_PROJECT_ID` | your existing Firebase project ID |

Note: Alpha Vantage's free tier is 25 requests/day — plenty, since it's
only called as a fallback, not on every run.

## 3. Firebase
Since you already host on Firebase, you likely have `firebase.json` in your
repo already — just confirm its `"public"` value matches the folder where
`Daily_News.html` lives. If you don't have a CI token yet:
```
npm install -g firebase-tools
firebase login
firebase login:ci   # copy the printed token into FIREBASE_TOKEN
```

## 4. Test it
- Repo → **Actions** tab → "Daily Finmet News Update" → **Run workflow**
  (manual trigger). Check the logs for what was fetched.
- Once it runs clean, it will fire automatically every day at 9:00 AM IST.

## What's already built in
- **Ticker**: Nifty, Sensex, Crude (WTI), Gold India (computed spot
  equivalent), Gold (USD) — via Yahoo Finance's free public endpoint,
  with Alpha Vantage as an automatic backup for crude & gold.
- **Movers**: Top 5 Nifty 200 gainers/losers, live from NSE India's public
  index endpoint (no key needed for this part).
- **International panel**: Top 2 headlines (ranked by relevance as a proxy
  for impact) on Dow Jones / Fed / US administration / trade / global
  funds.
- **India panel**: Top 3 headlines on Nifty, RBI, Finance Ministry.
- **Stocks in the news**: 5 headlines tagged mid/large cap.
- If `data.json` can't be reached, the page falls back to built-in sample
  data, so it never looks broken.

## Worth knowing
- Gold (India) is a **computed spot conversion** (USD/oz → INR/10g using
  the day's USD-INR rate) — it runs a little below retail jewellery prices,
  which include duty, GST, and making charges. Labelled "spot equiv." on
  the page for that reason.
- NSE's public gainers/losers endpoint occasionally changes its anti-bot
  behaviour; if that step fails on a given day, the page just keeps
  yesterday's values rather than breaking.
- No API key is ever sent to the browser — everything happens inside the
  GitHub Action, using GitHub Secrets.

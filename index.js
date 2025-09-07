// Discord Live Options Bot — Option A FINAL (with /health)
// Works for: equities, ETFs, crypto (spot). Live quotes + weekly options ATM±1.
// Slash commands: /alert, /deep, /health
// Primary data: Yahoo Finance (all). Secondary: Polygon (equities/ETFs, optional)
// Timezone: America/New_York (configurable via TZ env)
// -----------------------------------------------------------------------
// Setup
//   npm init -y
//   npm i discord.js axios dayjs yahoo-finance2 dotenv tzdata
//   node index.js
// .env (Railway or local)
//   DISCORD_TOKEN=your_bot_token
//   DISCORD_CLIENT_ID=your_app_id
//   POLYGON_KEY=your_polygon_key   # optional
//   TZ=America/New_York
// -----------------------------------------------------------------------

import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import axios from 'axios';
import * as yf2 from 'yahoo-finance2';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';

dayjs.extend(utc); dayjs.extend(tz);

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const POLY = process.env.POLYGON_KEY;
const TZ = process.env.TZ || 'UTC';

// --- Helpers ---------------------------------------------------------------
const ts = () => dayjs().tz(TZ).format('MMM D, HH:mm z');
const fmt = (n, d = 2) => Number(n).toFixed(d);
const normalizeTicker = (s) => {
  const x = (s || '').trim().toUpperCase();
  const map = { 'BRK.B': 'BRK-B', 'BRK.A': 'BRK-A' };
  return map[x] || x.replace(/\s+/g, '');
};
const validTicker = (s) => /^[A-Z0-9.+\-=_/:]{1,15}$/.test(s);

function getSession(now = dayjs().tz('America/New_York')) {
  const dow = now.day(); // 0=Sun .. 6=Sat
  const isWeekday = dow >= 1 && dow <= 5;
  const mins = now.hour() * 60 + now.minute();
  if (!isWeekday) return 'OFF';
  if (mins >= 570 && mins < 960) return 'RTH'; // 09:30-16:00 ET
  if (mins >= 240 && mins < 570) return 'PRE'; // 04:00-09:30 ET
  if (mins >= 960 && mins < 1200) return 'POST'; // 16:00-20:00 ET
  return 'OFF';
}

// Yahoo type-aware quote (works for equities/ETFs/crypto/indices)
async function yahooQuoteFull(ticker) {
  const q = await yf2.default.quoteSummary(ticker, { modules: ['price'] });
  const p = q?.price; if (!p) throw new Error('No quote');
  const price = p.regularMarketPrice ?? p.postMarketPrice ?? p.preMarketPrice;
  const chg = p.regularMarketChangePercent ?? p.postMarketChangePercent ?? p.preMarketChangePercent ?? 0;
  const type = p.quoteType || 'EQUITY'; // EQUITY/ETF/CRYPTOCURRENCY/INDEX
  return { price: Number(price), chg: Number(chg), type, source: 'Yahoo Finance' };
}

// Polygon quote (optional, equities/ETFs only)
async function polygonQuote(ticker) {
  if (!POLY) return null;
  try {
    const r = await axios.get(`https://api.polygon.io/v2/last/nbbo/${ticker}`, { params: { apiKey: POLY } });
    const nbbo = r.data?.results; const price = nbbo ? (nbbo.bid.price + nbbo.ask.price) / 2 : null;
    if (!price) return null;
    const pr = await axios.get(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`, { params: { apiKey: POLY } });
    const prev = pr.data?.results?.[0];
    const chg = prev ? ((price - prev.c) / prev.c) * 100 : null;
    return { price, chg, source: 'Polygon' };
  } catch { return null; }
}

async function getQuote(ticker) {
  const y = await yahooQuoteFull(ticker);
  if (y.type === 'EQUITY' || y.type === 'ETF') {
    const p = await polygonQuote(ticker);
    if (p) return { ...p, type: y.type, session: getSession(), source: 'Polygon (primary) → Yahoo (meta)' };
  }
  return { ...y, session: getSession(), source: 'Yahoo Finance' }; // crypto/indices or no Polygon
}

// Weekly options via Yahoo (equities/ETFs only)
function nextFriday(now = dayjs().tz(TZ)) {
  const dow = now.day();
  const add = ((5 - dow) + 7) % 7 || 7; // next Fri
  return now.add(add, 'day').startOf('day');
}

async function getWeeklyOptions(ticker, spot) {
  const meta = await yf2.default.options(ticker);
  const exps = (meta?.expirationDates || []).map(d => dayjs.utc(d));
  if (!exps.length) return null;
  const target = nextFriday();
  let chosen = exps.find(d => d.isAfter(target.subtract(1, 'minute')));
  if (!chosen) chosen = exps[exps.length - 1];
  const chain = await yf2.default.options(ticker, { date: chosen.toDate() });
  const calls = chain?.calls || []; const puts = chain?.puts || [];
  const strikes = [...new Set([...calls, ...puts].map(o => Number(o.strike)))].filter(Number.isFinite).sort((a,b)=>a-b);
  if (!strikes.length) return null;
  const atmIdx = strikes.reduce((best, s, i) => (Math.abs(s-spot) < Math.abs(strikes[best]-spot) ? i : best), 0);
  const sATM = strikes[atmIdx]; const sPlus = strikes[Math.min(atmIdx+1, strikes.length-1)]; const sMinus = strikes[Math.max(atmIdx-1, 0)];
  const pick = (arr, strike) => arr.find(o => Number(o.strike) === strike);
  const cATM = pick(calls, sATM) || pick(calls, sPlus) || pick(calls, sMinus);
  const pATM = pick(puts, sATM)  || pick(puts, sMinus) || pick(puts, sPlus);
  return {
    expiry: chosen.format('YYYY-MM-DD'),
    strikes: { sMinus, sATM, sPlus },
    call: cATM ? { contract: cATM.contractSymbol, bid: cATM.bid, ask: cATM.ask, iv: cATM.impliedVolatility } : null,
    put:  pATM ? { contract: pATM.contractSymbol, bid: pATM.bid, ask: pATM.ask, iv: pATM.impliedVolatility } : null,
    source: 'Yahoo Finance options'
  };
}

// Build EXPRESS alert text
function buildSetup(tkr, price, chg, type, weekly, session, source) {
  const entryLow = +(price * 0.995).toFixed(2);
  const entryHigh = +(price * 1.005).toFixed(2);
  const sl = +(price * 0.98).toFixed(2);
  const t1 = +(price * 1.01).toFixed(2);
  const t2 = +(price * 1.03).toFixed(2);
  const t3 = +(price * 1.05).toFixed(2);
  const bias = chg >= 0 ? '🟢' : '🟡';
  const rr = ((t2 - price) / (price - sl)).toFixed(1);
  const banner = `$${tkr} | ${fmt(price)} (${chg>=0?'+':''}${fmt(chg)}%) @ ${ts()} | ${bias} | Entry ${entryLow}-${entryHigh} | SL ${sl} | T: ${t1}/${t2}/${t3} | R:R ~${rr}`;

  const optLines = (type === 'EQUITY' || type === 'ETF') && weekly ? [
    `• Weekly: ${weekly.expiry} | ATM≈ ${weekly.strikes.sATM}`,
    weekly.call ? `• Calls: ${weekly.call.contract} | ${fmt(weekly.call.bid)}/${fmt(weekly.call.ask)} IV ${fmt(weekly.call.iv*100,1)}%` : `• Calls: n/a`,
    weekly.put  ? `• Puts : ${weekly.put.contract} | ${fmt(weekly.put.bid)}/${fmt(weekly.put.ask)} IV ${fmt(weekly.put.iv*100,1)}%`  : `• Puts : n/a`,
  ] : [ type === 'CRYPTOCURRENCY' ? '• Options: n/a (crypto spot)' : '• Options: n/a (no chain)' ];

  const lines = [
    `• Mode: Opening scalp ⚡ / swing 📆`,
    `• Bias: ${bias} Above VWAP favors calls`,
    `• Session: ${session} | Source: ${source}`,
    `• Key S/R: VWAP; ±1% band`,
    `• 🚫 SL: ${sl} — below structure`,
    `• 🎯 ${t1} / ${t2} / ${t3}`,
    `• Prob/Conf: 55% | Medium`,
    `• Mgmt: Trim @ T1, BE stop, trail EMA`,
    `• Alt: Lose VWAP → fade to band low`,
    ...optLines,
    `— — —`,
    `This is not financial advice. Do your own research.`
  ];
  return { banner, lines };
}

// --- Discord ---------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('alert').setDescription('Live EXPRESS ALERT for a ticker')
      .addStringOption(o => o.setName('ticker').setDescription('e.g., NVDA, AAPL, SPY, BTC-USD').setRequired(false)),
    new SlashCommandBuilder().setName('deep').setDescription('DEEP DIVE with HTF context')
      .addStringOption(o => o.setName('ticker').setDescription('e.g., SPY, TSLA, ETH-USD').setRequired(false)),
    new SlashCommandBuilder().setName('health').setDescription('Check bot health & connectivity')
  ].map(c=>c.toJSON());
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

client.on('ready', () => console.log(`Logged in as ${client.user.tag}`));

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'alert') {
    await i.deferReply();
    let tkr = normalizeTicker(i.options.getString('ticker') || 'NVDA');
    if (!validTicker(tkr)) { await i.editReply('Invalid ticker symbol.'); return; }
    try {
      const q = await getQuote(tkr);
      const weekly = (q.type === 'EQUITY' || q.type === 'ETF') ? await getWeeklyOptions(tkr, q.price).catch(()=>null) : null;
      const { banner, lines } = buildSetup(tkr, q.price, q.chg, q.type, weekly || undefined, q.session, q.source);
      const msg = ['⚡ EXPRESS ALERT — OPENING PLAY', '', banner, ...lines].join('\\n');
      await i.editReply(msg);
    } catch (err) {
      await i.editReply('Live feed unavailable — using structure only; lower confidence.');
    }
  }

  if (i.commandName === 'deep') {
    await i.deferReply();
    let tkr = normalizeTicker(i.options.getString('ticker') || 'NVDA');
    if (!validTicker(tkr)) { await i.editReply('Invalid ticker symbol.'); return; }
    try {
      const q = await getQuote(tkr);
      const end = dayjs().tz(TZ); const start = end.subtract(60, 'day');
      const hist = await yf2.default.historical(tkr, { period1: start.toDate(), period2: end.toDate(), interval: '1d' });
      const candles = hist.slice(-30); const closes = candles.map(c => c.close);
      const sma = (arr, n) => arr.slice(-n).reduce((a,b)=>a+b,0)/Math.min(n, arr.length);
      const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
      const pdh = candles[candles.length-2]?.high; const pdl = candles[candles.length-2]?.low;
      const trend = sma20 > sma50 ? 'Uptrend (20>50)' : 'Mixed/Down (20<=50)';
      const lines = [
        `DEEP DIVE 📚 — ${tkr} @ ${fmt(q.price)} (${q.chg>=0?'+':''}${fmt(q.chg)}%) — ${ts()}`,
        `• Type: ${q.type} | Session: ${q.session}`,
        `• Trend: ${trend}`,
        `• PDH/PDL: ${fmt(pdh)}/${fmt(pdl)}`,
        `• SMA20/50: ${fmt(sma20)}/${fmt(sma50)}`,
        `• Liquidity: watch PDH/PDL sweeps`,
        `• Plan: buy dips > PDH; lose PDL → hedge`,
        `— — —`,
        `This is not financial advice. Do your own research.`
      ].join('\\n');
      await i.editReply(lines);
    } catch (err) {
      await i.editReply('Deep Dive unavailable — data error.');
    }
  }

  if (i.commandName === 'health') {
    await i.deferReply();
    try {
      const now = ts();
      const sess = getSession();
      const spy = await yahooQuoteFull('SPY');
      const polyOk = POLY ? 'present' : 'missing';
      const msg = [
        `HEALTH ✅ — ${now}`,
        `• Session (NY): ${sess}`,
        `• Yahoo: OK — SPY ${fmt(spy.price)} (${spy.chg>=0?'+':''}${fmt(spy.chg)}%)`,
        `• Polygon key: ${polyOk}`,
        `• TZ: ${TZ}`
      ].join('\\n');
      await i.editReply(msg);
    } catch (e) {
      await i.editReply('HEALTH ❌ — check tokens, internet, or Yahoo rate limits.');
    }
  }
});

registerCommands().then(() => client.login(TOKEN));

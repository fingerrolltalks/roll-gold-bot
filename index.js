// Chart Assassin — Discord Live Options Bot
// SAFE v3.10 (compact alerts + scheduler + low-cap scanner)
// -----------------------------------------------------------------------------
// Env (Railway → Variables):
//   DISCORD_TOKEN, DISCORD_CLIENT_ID
//   DISCORD_GUILD_ID         (optional: for faster command updates)
//   DISCORD_CHANNEL_ID       (optional: default channel for auto posts)
//   TZ=America/New_York      (recommended)
//   POLYGON_KEY              (optional: for news + quote cross-check)
//   DISCREPANCY_BPS=50       (optional; Yahoo vs Polygon tolerance)

import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';
import axios from 'axios';
import * as yf2 from 'yahoo-finance2';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import cron from 'node-cron';
import fs from 'fs';

dayjs.extend(utc);
dayjs.extend(tz);

// ---------- ENV ------------------------------------------------------------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const TZSTR = process.env.TZ || 'UTC';
const POLY = process.env.POLYGON_KEY || '';
const DISC_BPS = Number(process.env.DISCREPANCY_BPS ?? 50);

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or DISCORD_CLIENT_ID');
  process.exit(1);
}
console.log('Boot v3.10', { TZ: TZSTR, DISC_BPS, GUILD_ID: !!GUILD_ID, DEFAULT_CHANNEL_ID: !!DEFAULT_CHANNEL_ID });

// ---------- Utils ----------------------------------------------------------
const ts = () => dayjs().tz(TZSTR).format('MMM D, HH:mm z');
const fmt = (n, d = 2) => Number(n).toFixed(d);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const clean = (s) => (s || '').trim();
const norm = (s) => {
  const x = clean(s).toUpperCase();
  const map = { 'BRK.B': 'BRK-B', 'BRK.A': 'BRK-A' };
  return map[x] || x.replace(/\s+/g, '');
};
const isTicker = (s) => /^[A-Z][A-Z0-9.\-]{0,10}(?:-USD)?$/.test(s);

function getSession(now = dayjs().tz('America/New_York')) {
  const dow = now.day();
  const mins = now.hour() * 60 + now.minute();
  if (dow === 0 || dow === 6) return 'OFF';
  if (mins >= 240 && mins < 570) return 'PRE';
  if (mins >= 570 && mins < 960) return 'RTH';
  if (mins >= 960 && mins < 1200) return 'POST';
  return 'OFF';
}
function minutesSinceOpenNY(now = dayjs().tz('America/New_York')) {
  return Math.max(0, (now.hour() * 60 + now.minute()) - 570); // 9:30 = 570
}

// ---------- Quotes ---------------------------------------------------------
async function yahooQuoteFull(ticker) {
  try {
    const q = await yf2.default.quote(ticker);
    const price = q?.regularMarketPrice ?? q?.postMarketPrice ?? q?.preMarketPrice;
    const chg   = q?.regularMarketChangePercent ?? 0;
    const type  = q?.quoteType || 'EQUITY';
    if (price == null) throw new Error('No price on quote');
    return { price: Number(price), chg: Number(chg), type, source: 'Yahoo', raw: q };
  } catch {
    const q = await yf2.default.quoteSummary(ticker, { modules: ['price','summaryDetail'] });
    const p = q?.price, s = q?.summaryDetail || {};
    if (!p) throw new Error('No price on quoteSummary');
    const price = p.regularMarketPrice ?? p.postMarketPrice ?? p.preMarketPrice;
    const chg   = p.regularMarketChangePercent ?? p.postMarketChangePercent ?? p.preMarketChangePercent ?? 0;
    const type  = p.quoteType || 'EQUITY';
    const raw   = { regularMarketVolume: p.regularMarketVolume, averageDailyVolume3Month: s?.averageVolume || s?.averageVolume3Month };
    return { price: Number(price), chg: Number(chg), type, source: 'Yahoo (fallback)', raw };
  }
}

async function polygonQuote(ticker) {
  if (!POLY) return null;
  const http = axios.create({ timeout: 6000, headers: { 'User-Agent': 'ChartAssassinBot/Poly' } });
  const retry = async (fn, tries = 2) => { try { return await fn(); } catch (e) { if (tries <= 0) throw e; return retry(fn, tries - 1); } };
  try {
    const nb = await retry(() => http.get(`https://api.polygon.io/v2/last/nbbo/${ticker}`, { params: { apiKey: POLY } })).then(r => r.data?.results);
    const price = nb ? (nb.bid.price + nb.ask.price) / 2 : null;
    if (!price) return null;
    const prev = await retry(() => http.get(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`, { params: { apiKey: POLY } })).then(r => r.data?.results?.[0]);
    const chg = prev ? ((price - prev.c) / prev.c) * 100 : 0;
    return { price, chg, source: 'Polygon' };
  } catch { return null; }
}

async function getQuote(ticker) {
  const y = await yahooQuoteFull(ticker);
  if (y.type === 'EQUITY' || y.type === 'ETF') {
    const p = await polygonQuote(ticker);
    if (p) {
      const diff = Math.abs((p.price - y.price) / y.price) * 100;
      const flag = diff > (DISC_BPS / 100) ? `⚠️ Discrepancy ${fmt(diff, 2)}% (Poly vs Y)` : '';
      return { ...p, type: y.type, session: getSession(), source: 'Polygon', flag, alt: `Yahoo ${fmt(y.price)}`, raw: y.raw };
    }
  }
  return { ...y, session: getSession(), alt: null, flag: '' };
}

// ---------- RVOL -----------------------------------------------------------
function estimateRVOLFromQuote(raw, session = 'OFF') {
  const vol = Number(raw?.regularMarketVolume ?? 0);
  const avg = Number(raw?.averageDailyVolume3Month ?? raw?.averageVolume ?? 0);
  if (!avg || avg <= 0) return null;

  if (session === 'RTH') {
    const mins = minutesSinceOpenNY();
    const frac = clamp(mins / 390, 0.05, 1);
    const expectedSoFar = avg * frac;
    if (expectedSoFar <= 0) return null;
    return vol / expectedSoFar;
  }
  return vol / avg;
}

// ---------- Weekly options (ATM picks) ------------------------------------
function nextFriday(now = dayjs().tz(TZSTR)) {
  const add = ((5 - now.day()) + 7) % 7 || 7;
  return now.add(add, 'day').startOf('day');
}
async function weeklyOptions(ticker, spot) {
  try {
    const meta = await yf2.default.options(ticker);
    const exps = (meta?.expirationDates || []).map((d) => dayjs.utc(d));
    if (!exps.length) return null;
    const target = nextFriday();
    let chosen = exps.find((d) => d.isAfter(target.subtract(1, 'minute'))) || exps.at(-1);
    const chain = await yf2.default.options(ticker, { date: chosen.toDate() });
    const calls = chain?.calls || [];
    const puts  = chain?.puts  || [];
    const strikes = [...new Set([...calls, ...puts].map((o) => +o.strike))].filter(Number.isFinite).sort((a, b) => a - b);
    if (!strikes.length) return null;
    const idx = strikes.reduce((b, s, i) => (Math.abs(s - spot) < Math.abs(strikes[b] - spot) ? i : b), 0);
    const sATM = strikes[idx], sPlus = strikes[Math.min(idx + 1, strikes.length - 1)], sMinus = strikes[Math.max(idx - 1, 0)];
    const pick = (arr, k) => arr.find((o) => +o.strike === k);
    const c = pick(calls, sATM) || pick(calls, sPlus) || pick(calls, sMinus);
    const p = pick(puts , sATM) || pick(puts , sMinus) || pick(puts , sPlus);
    return {
      expiry: chosen.format('YYYY-MM-DD'),
      s: { sMinus, sATM, sPlus },
      call: c ? { cs: c.contractSymbol, bid: c.bid, ask: c.ask, iv: c.impliedVolatility } : null,
      put : p ? { cs: p.contractSymbol, bid: p.bid, ask: p.ask, iv: p.impliedVolatility } : null
    };
  } catch { return null; }
}

// ---------- Context / mode -------------------------------------------------
async function buildDailyContext(ticker, spot, tzStr = TZSTR) {
  try {
    const end = dayjs().tz(tzStr);
    const start = end.subtract(90, 'day');
    const hist = await yf2.default.historical(ticker, { period1: start.toDate(), period2: end.toDate(), interval: '1d' });
    if (!hist?.length) return {};
    const last = hist.slice(-60);
    const closes = last.map(c => c.close);
    const sma = (a, n) => { const k = Math.min(n, a.length); return k ? a.slice(-k).reduce((x,y)=>x+y,0) / k : NaN; };
    const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
    const y = hist.at(-2);
    return { sma20, sma50, PDH: y?.high, PDL: y?.low };
  } catch { return {}; }
}
function decideMode(q, ctx) {
  const nyMins = minutesSinceOpenNY();
  const isOpenWindow = q.session === 'RTH' && nyMins > 0 && nyMins <= 45;
  if (isOpenWindow && ctx?.trend) return ctx.trend === 'up' ? 'Opening Scalp (Calls)' : 'Opening Scalp (Puts)';
  const d = ctx?.daily || {};
  if (Number.isFinite(d.sma20) && Number.isFinite(d.sma50)) {
    const upTrend = d.sma20 > d.sma50, downTrend = d.sma20 < d.sma50;
    if (upTrend && q.price >= d.sma20 && (d.PDH ? q.price >= d.PDH : true)) return 'Swing Long';
    if (downTrend && q.price <= d.sma20 && (d.PDL ? q.price <= d.PDL : true)) return 'Swing Short';
  }
  return 'Neutral / Range';
}

// ---------- Compact alert formatting --------------------------------------
function bannerCompact(t, q, ctx = {}) {
  const price = fmt(q.price);
  const pct = (q.chg >= 0 ? '+' : '') + fmt(q.chg) + '%';
  const biasEmoji = q.chg >= 0 ? '🟢' : '🟡';

  const entryL = +(q.price * 0.995).toFixed(2);
  const entryH = +(q.price * 1.005).toFixed(2);
  const sl     = +(q.price * 0.98).toFixed(2);
  const t1 = +(q.price * 1.01).toFixed(2);
  const t2 = +(q.price * 1.03).toFixed(2);
  const t3 = +(q.price * 1.05).toFixed(2);

  const flags = [
    ctx.trend ? (ctx.trend === 'up' ? '9>21' : '9<21') : null,
    ctx.abovePMH ? '>PMH' : null,
    ctx.belowPDL ? '<PDL' : null,
    (ctx.rvol && ctx.rvol > 0) ? `RVOL ${fmt(ctx.rvol, 1)}x` : null
  ].filter(Boolean);
  const flagStr = flags.length ? ` (${flags.join(', ')})` : '';

  return [
    `⚡ **$${t}** ${price} (${pct}) ${biasEmoji}${flagStr}`,
    `🧭 Mode: ${decideMode(q, ctx)}`,
    `🎯 Targets: ${t1} / ${t2} / ${t3}`,
    `🚫 SL: ${sl} | Entry: ${entryL}–${entryH}`
  ];
}

function optionsCompact(w) {
  if (!w) return [];
  const spreadPct = (b, a) => (b && a && a > 0 ? ((a - b) / a) * 100 : null);
  const parts = [];
  const okCall = w.call && w.call.bid > 0 && spreadPct(w.call.bid, w.call.ask) < 10;
  const okPut  = w.put  && w.put.bid  > 0 && spreadPct(w.put.bid , w.put.ask ) < 10;
  if (okCall) {
    const sp = spreadPct(w.call.bid, w.call.ask);
    parts.push(`📈 Best Call: ${w.call.cs} (IV ${fmt(w.call.iv * 100, 1)}%, spread ${fmt(sp,1)}%)`);
  }
  if (okPut) {
    const sp = spreadPct(w.put.bid, w.put.ask);
    parts.push(`📉 Best Put: ${w.put.cs} (IV ${fmt(w.put.iv * 100, 1)}%, spread ${fmt(sp,1)}%)`);
  }
  return parts.length ? [parts.join(' | ')] : [];
}

// ---------- Discord client -------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- Scheduler storage/runtime -------------------------------------
const SFILE = 'schedules.json';
let SCHEDULES = [];      // [{id, cron, tickers:string[], channelId}]
const JOBS = new Map();  // id -> cron job
let NEXT_ID = 1;

function loadSchedules() {
  try {
    if (fs.existsSync(SFILE)) {
      const raw = fs.readFileSync(SFILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        SCHEDULES = data;
        NEXT_ID = (Math.max(0, ...SCHEDULES.map(x => x.id || 0)) + 1) || 1;
        console.log('Loaded schedules:', SCHEDULES.length);
      }
    }
  } catch (e) { console.error('loadSchedules error:', e?.message || e); }
}
function saveSchedules() { try { fs.writeFileSync(SFILE, JSON.stringify(SCHEDULES, null, 2)); } catch (e) { console.error('saveSchedules error:', e?.message || e); } }
function startJob(entry) {
  if (!cron.validate(entry.cron)) { console.error('Invalid cron, skip id', entry.id, entry.cron); return; }
  const job = cron.schedule(entry.cron, () => { postExpressAlert(entry.tickers, entry.channelId); }, { timezone: TZSTR });
  JOBS.set(entry.id, job);
}
function stopJob(id) { const job = JOBS.get(id); if (job) { job.stop(); JOBS.delete(id); } }
function restartAllJobs() { for (const [,job] of JOBS) job.stop(); JOBS.clear(); for (const e of SCHEDULES) startJob(e); }

// ---------- Register slash commands ---------------------------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('alert')
      .

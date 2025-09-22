// Chart Assassin — Discord Live Options Bot
// SAFE v3.11 — Compact Alerts + Schedules + Low-cap Scanner (Top 4) + Gapper Scan + 🔥 A+ Runner
// ----------------------------------------------------------------------------------
// Required: DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_CHANNEL_ID
// Optional: DISCORD_GUILD_ID, TZ=America/New_York, POLYGON_KEY, DISCREPANCY_BPS=50, LOWCAP_LIST

import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType, EmbedBuilder } from 'discord.js';
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

if (!TOKEN || !CLIENT_ID) { console.error('❌ Missing DISCORD_TOKEN or DISCORD_CLIENT_ID'); process.exit(1); }
console.log('Boot v3.11', { TZ: TZSTR, DISC_BPS, GUILD_ID: !!GUILD_ID, DEFAULT_CHANNEL_ID: !!DEFAULT_CHANNEL_ID, POLY: !!POLY });

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
function humanNum(n){
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(n|0);
}
function truncate(str, max=140){
  if (!str) return '';
  return str.length <= max ? str : (str.slice(0, max-1) + '…');
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

// ---------- RVOL (relative volume) ----------------------------------------
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
  return vol / avg; // PRE/POST/OFF → coarse
}

// ---------- Weekly Options (ATM picks) ------------------------------------
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

// ---------- “AI” Context (mode decision) ----------------------------------
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

// ---------- Compact Formatters --------------------------------------------
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

  const lines = [
    `⚡ **$${t}** ${price} (${pct}) ${biasEmoji}${flagStr}`,
    `🧭 Mode: ${decideMode(q, ctx)}`,
    `🎯 Targets: ${t1} / ${t2} / ${t3}`,
    `🚫 SL: ${sl} | Entry: ${entryL}–${entryH}`
  ];
  return { head: lines[0], core: lines.slice(1) };
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

// ---------- Register Slash Commands (resilient) ----------------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('alert')
      .setDescription('EXPRESS ALERT: live levels (multi-ticker)')
      .addStringOption(o => o.setName('text').setDescription('e.g., NVDA, AAPL or “check NVDA and BTC”').setRequired(false)),
    new SlashCommandBuilder().setName('deep')
      .setDescription('DEEP DIVE: HTF context')
      .addStringOption(o => o.setName('ticker').setDescription('One ticker, e.g. SPY').setRequired(false)),
    new SlashCommandBuilder().setName('scalp')
      .setDescription('CRYPTO SCALPS: BTC/ETH/SOL/XRP/ADA/DOGE quick levels')
      .addStringOption(o => o.setName('symbol').setDescription('e.g., BTC-USD').setRequired(false)),
    new SlashCommandBuilder().setName('flow')
      .setDescription('OPTIONS FLOW placeholder (configure provider later)')
      .addStringOption(o => o.setName('ticker').setDescription('e.g., NVDA').setRequired(true)),
    new SlashCommandBuilder().setName('health').setDescription('Health check: data + time + session'),
    new SlashCommandBuilder().setName('schedule_add')
      .setDescription('Add an auto-post schedule')
      .addStringOption(o => o.setName('cron').setDescription('Cron like 0 9 * * 1-5 (9:00 AM Mon–Fri) or */1 * * * * (every minute)').setRequired(true))
      .addStringOption(o => o.setName('tickers').setDescription('Tickers (comma/space-separated, max 4)').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post in').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('schedule_list').setDescription('List all auto-post schedules'),
    new SlashCommandBuilder().setName('schedule_remove')
      .setDescription('Remove an auto-post schedule by ID')
      .addIntegerOption(o => o.setName('id').setDescription('Schedule ID (see /schedule_list)').setRequired(true)),
    // ---- Low-cap scan (manual)
    new SlashCommandBuilder()
      .setName('lowscan')
      .setDescription('Scan low-caps ($0.50–$7) by highest (pre)market volume + RVOL + float + news')
      .addChannelOption(o => o.setName('channel').setDescription('Where to post (defaults to current channel)').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    // ---- Gapper scan (manual)
    new SlashCommandBuilder()
      .setName('gappers')
      .setDescription('Top % premarket gainers with volume (price $0.50–$10, float≤50M)')
      .addChannelOption(o => o.setName('channel').setDescription('Where to post').addChannelTypes(ChannelType.GuildText).setRequired(false))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = { body: commands };
  if (GUILD_ID) {
    try { console.log('Registering GUILD commands for', GUILD_ID); await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), body); console.log('GUILD commands registered.'); return; }
    catch (e) { console.warn('Guild registration failed (fallback to GLOBAL):', e?.status || '', e?.message || e); }
  }
  try { console.log('Registering GLOBAL commands…'); await rest.put(Routes.applicationCommands(CLIENT_ID), body); console.log('GLOBAL commands registered.'); }
  catch (e) { console.error('Global registration failed:', e?.status || '', e?.message || e); }
}

// ---------- Build compact alert block -------------------------------------
async function buildDailyContextQuick(ticker) {
  try {
    const end = dayjs().tz(TZSTR), start = end.subtract(10, 'day');
    const hist = await yf2.default.historical(ticker, { period1: start.toDate(), period2: end.toDate(), interval: '1d' });
    const last = hist.slice(-3);
    const sma = (a, n) => a.slice(-n).reduce((x,y)=>x+y,0)/Math.min(n,a.length);
    const closes = last.map(c=>c.close);
    const ema9  = sma(closes, 9);
    const ema21 = sma(closes, 21) || sma(closes, 9);
    const y = last.at(-2);
    return { trend: (Number.isFinite(ema9) && Number.isFinite(ema21)) ? (ema9 >= ema21 ? 'up' : 'down') : null, y };
  } catch { return {}; }
}

async function buildCompactBlock(t, q) {
  let ctx = {};
  try {
    ctx = await buildDailyContextQuick(t);
    if (ctx.y) {
      ctx.belowPDL = q.price < ctx.y.low;
      ctx.abovePMH = q.price > ctx.y.high;
    }
  } catch {}
  ctx.rvol = estimateRVOLFromQuote(q.raw, q.session) || null;
  ctx.daily = await buildDailyContext(t, q.price, TZSTR);

  const compact = bannerCompact(t, q, ctx);
  const w = (q.type === 'EQUITY' || q.type === 'ETF') ? await weeklyOptions(t, q.price).catch(() => null) : null;
  const opt = optionsCompact(w);
  return [ compact.head, ...compact.core, ...opt, '⛔ Invalidate: lose VWAP or hit SL' ];
}

// ---------- Auto-post helper (equity alert) --------------------------------
async function postExpressAlert(tickers, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    const list = (tickers || []).map(norm).slice(0, 4);
    const chunks = [];
    for (const t of list) {
      const q = await getQuote(t);
      const block = await buildCompactBlock(t, q);
      chunks.push(block.join('\n'));
    }
    if (!chunks.length) return;
    await channel.send(chunks.join('\n\n'));
  } catch (e) {
    console.error('Scheduled post error:', e?.message || e);
  }
}

// ---------- Low-cap Scanner (Top 4) ---------------------------------------
const LOW_PRICE_MIN = 0.5, LOW_PRICE_MAX = 7.0;
const LOW_TOP_N = 4; // Top 4
const LOW_UNIVERSE = (process.env.LOWCAP_LIST || (
  'GROM,COSM,CEI,SNTG,HILS,ATHE,RNXT,SNOA,VERB,TTOO,BBIG,SOUN,HUT,CLSK,MARA,RIOT,TLRY,FFIE,NVOS,BEAT,TOP,HOLO,PXMD,BNED,KULR,OTRK,NAOV,AGRX,AMC,GME,CVNA'
)).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const MIN_RVOL = 1.5;        // ≥1.5x relative volume
const MAX_FLOAT_M = 50;      // float ≤ 50M
const REQUIRE_NEWS = true;   // require headline if POLY present

async function discoverUniverseFromPolygon(max = 150) {
  if (!POLY) return LOW_UNIVERSE;
  try {
    const http = axios.create({ timeout: 6000 });
    const urls = [
      'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/active',
      'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers'
    ];
    const all = new Set();
    for (const u of urls) {
      const r = await http.get(u, { params: { apiKey: POLY } });
      const list = r?.data?.tickers || r?.data?.results || [];
      for (const row of list) {
        const t = (row.ticker || row.T || '').toUpperCase();
        if (t) all.add(t);
        if (all.size >= max) break;
      }
      if (all.size >= max) break;
    }
    const arr = [...all].filter(isTicker);
    return arr.length ? arr : LOW_UNIVERSE;
  } catch { return LOW_UNIVERSE; }
}

async function fetchFloatAndNews(ticker){
  let floatM = null, headline = null;
  try {
    const qs = await yf2.default.quoteSummary(ticker, { modules: ['defaultKeyStatistics'] });
    const ks = qs?.defaultKeyStatistics || {};
    const floatShares = ks.floatShares ?? ks.sharesOutstanding ?? null;
    if (Number.isFinite(Number(floatShares))) floatM = Number(floatShares)/1e6;
  } catch {}
  if (POLY) {
    try {
      const r = await axios.get('https://api.polygon.io/v2/reference/news', {
        params: { ticker, limit: 1, order: 'desc', apiKey: POLY },
        timeout: 5000
      });
      headline = r?.data?.results?.[0]?.title || null;
    } catch {}
  }
  return { floatM, headline };
}

async function scanLowCaps() {
  const rows = [];
  const universe = await discoverUniverseFromPolygon(180);
  for (const t of universe) {
    try {
      const q = await yahooQuoteFull(t);
      const price = Number(q.price);
      if (!Number.isFinite(price) || price < LOW_PRICE_MIN || price > LOW_PRICE_MAX) continue;

      const vol  = Number(q?.raw?.preMarketVolume ?? q?.raw?.regularMarketVolume ?? 0);
      const rvol = estimateRVOLFromQuote(q.raw, q.session) || 0;
      const { floatM, headline } = await fetchFloatAndNews(t);

      if (floatM != null && floatM > MAX_FLOAT_M) continue;
      if (rvol && rvol < MIN_RVOL) continue;
      if (REQUIRE_NEWS && POLY && !headline) continue;

      rows.push({ t, price, chg: q.chg, vol, rvol, floatM, headline });
    } catch {}
  }
  rows.sort((a,b) => (b.vol - a.vol) || (b.rvol - a.rvol));
  return rows.slice(0, LOW_TOP_N);
}

async function postLowcapScan(channelId){
  try{
    const ch = await client.channels.fetch(channelId);
    const picks = await scanLowCaps();
    if (!picks.length) { await ch.send(`🧪 Low-cap scan: none in $${LOW_PRICE_MIN}–$${LOW_PRICE_MAX}. (${ts()})`); return; }

    const embed = new EmbedBuilder()
      .setTitle(`🧪 Low-Cap Scanner — Top ${LOW_TOP_N}`)
      .setDescription(`$${LOW_PRICE_MIN}–$${LOW_PRICE_MAX} | RVOL≥${MIN_RVOL}x | Float≤${MAX_FLOAT_M}M ${REQUIRE_NEWS && POLY ? '| News✅' : ''}\n*Data: Yahoo; News: Polygon if available*\n${ts()}`)
      .setColor(0x00D084);

    for (const p of picks) {
      const dirEmoji = p.chg >= 0 ? '🟢' : '🔴';
      const hot = (p.rvol >= 3 && p.floatM != null && p.floatM <= 20) ? ' 🔥' : '';
      const name = `$${p.t}${hot}`;
      const value = [
        `${dirEmoji} **${p.price.toFixed(2)}** (${p.chg>=0?'+':''}${p.chg.toFixed(2)}%)`,
        `Vol ${humanNum(p.vol)} | RVOL ${p.rvol ? p.rvol.toFixed(1)+'x' : '—'} | Float ${p.floatM!=null ? `~${p.floatM.toFixed(1)}M` : '—'}`,
        p.headline ? `📰 ${truncate(p.headline, 120)}` : ''
      ].filter(Boolean).join('\n');
      embed.addFields({ name, value, inline: true });
    }

    await ch.send({ embeds: [embed] });
  }catch(e){ console.error('Lowcap scan post error:', e?.message || e); }
}

// ---------- Gapper Scan (Top % premarket gainers) -------------------------
const GAPPER_PRICE_MIN = 0.5, GAPPER_PRICE_MAX = 10;
const GAPPER_MIN_VOL = 300_000; // min (pre/regular) volume to care
const GAPPER_TOP_N = 6;         // show top 6 gappers
const REQUIRE_NEWS_GAPPER = !!POLY; // if we have Polygon, require a headline

async function getPrevClose(t){
  try{
    const qs = await yf2.default.quoteSummary(t, { modules: ['price'] });
    const prev = qs?.price?.regularMarketPreviousClose ?? qs?.price?.previousClose;
    if (Number.isFinite(Number(prev))) return Number(prev);
  }catch{}
  try{
    const end = new Date(); const start = new Date(end.getTime() - 7*24*3600*1000);
    const hist = await yf2.default.historical(t, { period1: start, period2: end, interval: '1d' });
    const last = hist.slice(-2)[0]; // prior trading day
    return Number(last?.close);
  }catch{}
  return null;
}

async function scanGappers(){
  const rows = [];
  const universe = await discoverUniverseFromPolygon(200);
  for (const t of universe) {
    try {
      const q = await yahooQuoteFull(t);
      const price = Number(q.price);
      if (!Number.isFinite(price) || price < GAPPER_PRICE_MIN || price > GAPPER_PRICE_MAX) continue;

      const prev = await getPrevClose(t);
      if (!Number.isFinite(prev) || prev <= 0) continue;
      const gapPct = ((price - prev) / prev) * 100;

      if (gapPct < 5) continue; // only strong gappers

      const vol  = Number(q?.raw?.preMarketVolume ?? q?.raw?.regularMarketVolume ?? 0);
      if (!Number.isFinite(vol) || vol < GAPPER_MIN_VOL) continue;

      const rvol = estimateRVOLFromQuote(q.raw, q.session) || 0;
      const { floatM, headline } = await fetchFloatAndNews(t);

      if (floatM != null && floatM > 50) continue; // low-float bias
      if (REQUIRE_NEWS_GAPPER && !headline) continue;

      rows.push({ t, price, chg: q.chg, gapPct, vol, rvol, floatM, headline });
    } catch {}
  }
  rows.sort((a,b) => (b.gapPct - a.gapPct) || (b.vol - a.vol));
  return rows.slice(0, GAPPER_TOP_N);
}

async function postGapperScan(channelId){
  try{
    const ch = await client.channels.fetch(channelId);
    const picks = await scanGappers();
    if (!picks.length) { await ch.send(`🚀 Gappers: no strong premarket gappers found. (${ts()})`); return; }

    const embed = new EmbedBuilder()
      .setTitle(`🚀 Premarket Gappers — Top ${GAPPER_TOP_N}`)
      .setDescription(`Price $${GAPPER_PRICE_MIN}–$${GAPPER_PRICE_MAX} | Vol ≥ ${humanNum(GAPPER_MIN_VOL)} | Float≤50M ${REQUIRE_NEWS_GAPPER ? '| News✅' : ''}\n*Gap from prior close*\n${ts()}`)
      .setColor(0xF59E0B);

    for (const p of picks) {
      const dirEmoji = p.gapPct >= 0 ? '🟢' : '🔴';
      const name = `$${p.t}`;
      const value = [
        `${dirEmoji} **${p.price.toFixed(2)}** (Gap ${p.gapPct >= 0 ? '+' : ''}${p.gapPct.toFixed(1)}%)`,
        `Vol ${humanNum(p.vol)} | RVOL ${p.rvol ? p.rvol.toFixed(1)+'x' : '—'} | Float ${p.floatM!=null ? `~${p.floatM.toFixed(1)}M` : '—'}`,
        p.headline ? `📰 ${truncate(p.headline, 120)}` : ''
      ].filter(Boolean).join('\n');
      embed.addFields({ name, value, inline: true });
    }

    await ch.send({ embeds: [embed] });
  }catch(e){ console.error('Gapper scan post error:', e?.message || e); }
}

// ---------- 🔥 A+ Runner (single ping) ------------------------------------
async function findAPlusRunner(){
  // criteria: price 0.5–7, RVOL ≥ 3, float ≤ 20M, has news (if POLY)
  const universe = await discoverUniverseFromPolygon(200);
  let best = null;
  for (const t of universe) {
    try{
      const q = await yahooQuoteFull(t);
      const price = Number(q.price);
      if (!Number.isFinite(price) || price < 0.5 || price > 7) continue;

      const rvol = estimateRVOLFromQuote(q.raw, q.session) || 0;
      if (rvol < 3) continue;

      const { floatM, headline } = await fetchFloatAndNews(t);
      if (floatM == null || floatM > 20) continue;
      if (POLY && !headline) continue;

      const vol  = Number(q?.raw?.preMarketVolume ?? q?.raw?.regularMarketVolume ?? 0);
      const score = rvol * Math.log10((vol||1)+10); // simple score
      const row = { t, price, chg: q.chg, rvol, floatM, vol, headline, score };
      if (!best || row.score > best.score) best = row;
    }catch{}
  }
  return best;
}

async function postAPlusRunner(channelId){
  try{
    const ch = await client.channels.fetch(channelId);
    const p = await findAPlusRunner();
    if (!p) return; // only ping when a true A+ exists

    const embed = new Embed

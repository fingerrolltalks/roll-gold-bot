// Chart Assassin — Discord Live Options Bot
// SAFE v3.13 (compact alerts + scheduler + low-cap + gappers + runner ping)

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder
} from 'discord.js';
import axios from 'axios';
import yahooFinance from 'yahoo-finance2';
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
console.log('Boot v3.13', {
  TZ: TZSTR,
  DISC_BPS,
  GUILD_ID: !!GUILD_ID,
  DEFAULT_CHANNEL_ID: !!DEFAULT_CHANNEL_ID
});

// ---------- Utils ----------------------------------------------------------
const ts = () => dayjs().tz(TZSTR).format('MMM D, HH:mm z');
const fmt = (n, d = 2) => Number(n).toFixed(d);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// hard-safe string helpers (prevents your toUpperCase crash)
const safeStr = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const clean = (s) => safeStr(s).trim();
const norm = (s) => {
  const x = clean(s).toUpperCase();
  const map = { 'BRK.B': 'BRK-B', 'BRK.A': 'BRK-A' };
  return map[x] || x.replace(/\s+/g, '');
};
const isTicker = (s) => /^[A-Z][A-Z0-9.\-]{0,10}(?:-USD)?$/.test(clean(s).toUpperCase());

// market session helpers
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
  return Math.max(0, (now.hour() * 60 + now.minute()) - 570);
}

// ---------- Quotes ---------------------------------------------------------
async function yahooQuoteFull(ticker) {
  const t = norm(ticker);

  // Try quote first
  try {
    const q = await yahooFinance.quote(t);
    const price = q?.regularMarketPrice ?? q?.postMarketPrice ?? q?.preMarketPrice;
    const chg = q?.regularMarketChangePercent ?? 0;
    const type = q?.quoteType || 'EQUITY';
    if (price == null) throw new Error('No price on quote');
    return { price: Number(price), chg: Number(chg), type, source: 'Yahoo', raw: q };
  } catch (e) {
    // Fallback to quoteSummary
    const qs = await yahooFinance.quoteSummary(t, { modules: ['price', 'summaryDetail'] });
    const p = qs?.price;
    const s = qs?.summaryDetail || {};
    if (!p) throw new Error('No price on quoteSummary');
    const price = p.regularMarketPrice ?? p.postMarketPrice ?? p.preMarketPrice;
    const chg =
      p.regularMarketChangePercent ??
      p.postMarketChangePercent ??
      p.preMarketChangePercent ??
      0;
    const type = p.quoteType || 'EQUITY';
    const raw = {
      regularMarketVolume: p.regularMarketVolume,
      averageDailyVolume3Month: s?.averageVolume || s?.averageVolume3Month
    };
    return { price: Number(price), chg: Number(chg), type, source: 'Yahoo (fallback)', raw };
  }
}

async function polygonQuote(ticker) {
  if (!POLY) return null;
  const t = norm(ticker);
  const http = axios.create({ timeout: 7000, headers: { 'User-Agent': 'ChartAssassinBot/Poly' } });
  const retry = async (fn, tries = 2) => {
    try { return await fn(); }
    catch (e) { if (tries <= 0) throw e; return retry(fn, tries - 1); }
  };

  try {
    const nb = await retry(() =>
      http.get(`https://api.polygon.io/v2/last/nbbo/${t}`, { params: { apiKey: POLY } })
    ).then(r => r.data?.results);

    const price = nb ? (nb.bid.price + nb.ask.price) / 2 : null;
    if (!price) return null;

    const prev = await retry(() =>
      http.get(`https://api.polygon.io/v2/aggs/ticker/${t}/prev`, { params: { apiKey: POLY } })
    ).then(r => r.data?.results?.[0]);

    const chg = prev ? ((price - prev.c) / prev.c) * 100 : 0;
    return { price, chg, source: 'Polygon' };
  } catch {
    return null;
  }
}

async function getQuote(ticker) {
  const y = await yahooQuoteFull(ticker);

  if (y.type === 'EQUITY' || y.type === 'ETF') {
    const p = await polygonQuote(ticker);
    if (p) {
      const diff = Math.abs((p.price - y.price) / y.price) * 100;
      const flag = diff > (DISC_BPS / 100)
        ? `⚠️ Discrepancy ${fmt(diff, 2)}% (Poly vs Y)`
        : '';
      return {
        ...p,
        type: y.type,
        session: getSession(),
        source: 'Polygon',
        flag,
        alt: `Yahoo ${fmt(y.price)}`,
        raw: y.raw
      };
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
  const t = norm(ticker);
  try {
    const meta = await yahooFinance.options(t);
    const exps = (meta?.expirationDates || []).map((d) => dayjs.utc(d));
    if (!exps.length) return null;

    const target = nextFriday();
    const chosen = exps.find((d) => d.isAfter(target.subtract(1, 'minute'))) || exps.at(-1);
    const chain = await yahooFinance.options(t, { date: chosen.toDate() });

    const calls = chain?.calls || [];
    const puts = chain?.puts || [];
    const strikes = [...new Set([...calls, ...puts].map((o) => +o.strike))]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    if (!strikes.length) return null;

    const idx = strikes.reduce(
      (best, s, i) => (Math.abs(s - spot) < Math.abs(strikes[best] - spot) ? i : best),
      0
    );

    const sATM = strikes[idx];
    const sPlus = strikes[Math.min(idx + 1, strikes.length - 1)];
    const sMinus = strikes[Math.max(idx - 1, 0)];

    const pick = (arr, k) => arr.find((o) => +o.strike === k);
    const c = pick(calls, sATM) || pick(calls, sPlus) || pick(calls, sMinus);
    const p = pick(puts, sATM) || pick(puts, sMinus) || pick(puts, sPlus);

    return {
      expiry: chosen.format('YYYY-MM-DD'),
      s: { sMinus, sATM, sPlus },
      call: c ? { cs: c.contractSymbol, bid: c.bid, ask: c.ask, iv: c.impliedVolatility } : null,
      put: p ? { cs: p.contractSymbol, bid: p.bid, ask: p.ask, iv: p.impliedVolatility } : null
    };
  } catch {
    return null;
  }
}

// ---------- Context / mode -------------------------------------------------
async function buildDailyContext(ticker, spot, tzStr = TZSTR) {
  const t = norm(ticker);
  try {
    const end = dayjs().tz(tzStr);
    const start = end.subtract(90, 'day');
    const hist = await yahooFinance.historical(t, {
      period1: start.toDate(),
      period2: end.toDate(),
      interval: '1d'
    });
    if (!hist?.length) return {};

    const last = hist.slice(-60);
    const closes = last.map(c => c.close);
    const sma = (a, n) => {
      const k = Math.min(n, a.length);
      return k ? a.slice(-k).reduce((x, y) => x + y, 0) / k : NaN;
    };

    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const y = hist.at(-2);
    return { sma20, sma50, PDH: y?.high, PDL: y?.low };
  } catch {
    return {};
  }
}

function decideMode(q, ctx) {
  const nyMins = minutesSinceOpenNY();
  const isOpenWindow = q.session === 'RTH' && nyMins > 0 && nyMins <= 45;
  if (isOpenWindow && ctx?.trend) return ctx.trend === 'up' ? 'Opening Scalp (Calls)' : 'Opening Scalp (Puts)';

  const d = ctx?.daily || {};
  if (Number.isFinite(d.sma20) && Number.isFinite(d.sma50)) {
    const upTrend = d.sma20 > d.sma50;
    const downTrend = d.sma20 < d.sma50;
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
  const sl = +(q.price * 0.98).toFixed(2);
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
  const okPut = w.put && w.put.bid > 0 && spreadPct(w.put.bid, w.put.ask) < 10;

  if (okCall) {
    const sp = spreadPct(w.call.bid, w.call.ask);
    parts.push(`📈 Best Call: ${w.call.cs} (IV ${fmt(w.call.iv * 100, 1)}%, spread ${fmt(sp, 1)}%)`);
  }
  if (okPut) {
    const sp = spreadPct(w.put.bid, w.put.ask);
    parts.push(`📉 Best Put: ${w.put.cs} (IV ${fmt(w.put.iv * 100, 1)}%, spread ${fmt(sp, 1)}%)`);
  }

  return parts.length ? [parts.join(' | ')] : [];
}

// ---------- Discord client -------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- Scheduler storage/runtime -------------------------------------
const SFILE = 'schedules.json';
let SCHEDULES = [];
const JOBS = new Map();
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
  } catch (e) {
    console.error('loadSchedules error:', e?.message || e);
  }
}

function saveSchedules() {
  try {
    fs.writeFileSync(SFILE, JSON.stringify(SCHEDULES, null, 2));
  } catch (e) {
    console.error('saveSchedules error:', e?.message || e);
  }
}

function startJob(entry) {
  if (!cron.validate(entry.cron)) {
    console.error('Invalid cron, skip id', entry.id, entry.cron);
    return;
  }
  const job = cron.schedule(
    entry.cron,
    () => { postExpressAlert(entry.tickers, entry.channelId); },
    { timezone: TZSTR }
  );
  JOBS.set(entry.id, job);
}

function stopJob(id) {
  const job = JOBS.get(id);
  if (job) { job.stop(); JOBS.delete(id); }
}

function restartAllJobs() {
  for (const [, job] of JOBS) job.stop();
  JOBS.clear();
  for (const e of SCHEDULES) startJob(e);
}

// ---------- Low-cap universe & helpers ------------------------------------
const DEFAULT_LOWCAP_UNIVERSE = [
  'SNTG','RNXT','KULR','HOLO','TOP','COSM','GROM','SIDU','NVOS','CEI','AITX','AGRI',
  'BBIG','VRAX','HCDI','CRKN','AIOT','NKLA','CYN','GFAI','ETON','HLTH','SOUN','IONQ'
];

function lowcapUniverse() {
  if (process.env.LOWCAP_LIST) {
    return process.env.LOWCAP_LIST.split(/[,\s]+/).filter(Boolean).map(norm);
  }
  return DEFAULT_LOWCAP_UNIVERSE;
}

async function polygonNewsHeadline(ticker) {
  if (!POLY) return null;
  const t = norm(ticker);
  try {
    const r = await axios.get('https://api.polygon.io/v2/reference/news', {
      params: { ticker: t, limit: 1, sort: 'published_utc', order: 'desc', apiKey: POLY },
      timeout: 7000,
      headers: { 'User-Agent': 'ChartAssassinBot/News' }
    });
    const a = r.data?.results?.[0];
    if (!a) return null;
    const src = a.publisher?.name ? ` — ${a.publisher.name}` : '';
    return `${a.title}${src}`;
  } catch {
    return null;
  }
}

async function scanLowcapsTopN(n = 4) {
  const list = lowcapUniverse();
  const out = [];

  for (const t of list) {
    try {
      const q = await yahooQuoteFull(t);
      const price = q.price;
      const chg = q.chg;
      const vol = Number(q.raw?.regularMarketVolume || 0);
      const avg = Number(q.raw?.averageDailyVolume3Month || q.raw?.averageVolume || 0);

      if (!(price >= 0.5 && price <= 7)) continue;
      if (vol < 200_000 || avg <= 0) continue;

      const rvol = vol / Math.max(1, avg);
      if (rvol < 1.5) continue;

      let floatDisp = '—';
      if (POLY) {
        try {
          const info = await axios.get(`https://api.polygon.io/v3/reference/tickers/${norm(t)}`, {
            params: { apiKey: POLY }, timeout: 7000
          }).then(r => r.data?.results);

          const floatShares = info?.weighted_shares_outstanding || info?.share_class_shares_outstanding;
          if (floatShares) floatDisp = `~${fmt(floatShares / 1e6, 1)}M`;
        } catch {}
      }

      const news = await polygonNewsHeadline(t);
      out.push({ t: norm(t), price, chg, vol, rvol, floatDisp, news });
    } catch {}
  }

  out.forEach(x => { x.score = 2 * (x.rvol || 0) + (x.chg || 0); });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, n);
}

function buildLowcapEmbed(items, whenLabel, topN = 4) {
  const embed = new EmbedBuilder()
    .setTitle(`🧪 Low-Cap Scanner — Top ${topN}`)
    .setDescription('_$0.5–$7 | RVOL≥1.5× | Float≤? | News if available_')
    .setFooter({ text: whenLabel })
    .setColor(0x00D084);

  if (!items.length) {
    embed.addFields({ name: 'No matches', value: 'No tickers met filters.', inline: false });
    return embed;
  }

  for (const a of items) {
    const dir = a.chg >= 0 ? '🟢' : '🔴';
    const name = `$${a.t} — ${dir} ${fmt(a.price)} (${a.chg >= 0 ? '+' : ''}${fmt(a.chg)}%)`;
    const valLines = [
      `Vol **${fmt(a.vol / 1e6, 2)}M** | RVOL **${fmt(a.rvol, 1)}×** | Float **${a.floatDisp}**`,
      a.news ? `📰 ${a.news}` : '_No fresh headline_'
    ];
    embed.addFields({ name, value: valLines.join('\n'), inline: true });
  }

  if (items.length % 2 === 1) {
    embed.addFields({ name: '\u200B', value: '\u200B', inline: true });
  }
  return embed;
}

async function postLowcapTopN(channelId, n = 4) {
  try {
    const ch = await client.channels.fetch(channelId);
    const items = await scanLowcapsTopN(n);
    const embed = buildLowcapEmbed(items, ts(), n);
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error('Lowcap post error:', e?.message || e);
  }
}

// ---------- Gapper Scan ----------------------------------------------------
async function scanGappersTopN(n = 6) {
  const list = lowcapUniverse();
  const rows = [];

  for (const t of list) {
    try {
      const q = await yahooQuoteFull(t);
      const price = q.price;
      const vol = Number(q.raw?.regularMarketVolume || 0);

      if (!(price >= 0.5 && price <= 20)) continue;
      if (vol < 300_000) continue;

      rows.push({ t: norm(t), price, chg: q.chg, vol });
    } catch {}
  }

  rows.sort((a, b) => b.chg - a.chg || b.vol - a.vol);
  return rows.slice(0, n);
}

function formatGappersEmbed(items, whenLabel) {
  const embed = new EmbedBuilder()
    .setTitle(`🚀 Gapper Scan — Top ${items.length} by %`)
    .setDescription('_Min vol 300k | Price $0.5–$20_')
    .setFooter({ text: whenLabel })
    .setColor(0x5865F2);

  if (!items.length) {
    embed.addFields({ name: 'No matches', value: 'No gappers meeting filters.', inline: false });
    return embed;
  }

  for (const x of items) {
    const dir = x.chg >= 0 ? '🟢' : '🔴';
    embed.addFields({
      name: `$${x.t} — ${dir} ${fmt(x.price)} (${x.chg >= 0 ? '+' : ''}${fmt(x.chg)}%)`,
      value: `Vol **${fmt(x.vol / 1e6, 2)}M**`,
      inline: true
    });
  }

  if (items.length % 2 === 1) embed.addFields({ name: '\u200B', value: '\u200B', inline: true });
  return embed;
}

async function postGapperScan(channelId, n = 6) {
  try {
    const ch = await client.channels.fetch(channelId);
    const items = await scanGappersTopN(n);
    const embed = formatGappersEmbed(items, ts());
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error('Gapper post error:', e?.message || e);
  }
}

// ---------- Runner Ping ----------------------------------------------------
async function postRunnerPing(channelId) {
  try {
    const ch = await client.channels.fetch(channelId);
    const cands = await scanLowcapsTopN(8);

    if (!cands.length) {
      await ch.send(`🔥 **A+ Runner** — ${ts()}\n_No standout right now._`);
      return;
    }

    cands.sort((a, b) => b.score - a.score);
    const a = cands[0];

    const msg = [
      `🔥 **A+ Runner** — ${ts()}`,
      `**$${a.t}** — ${a.chg >= 0 ? '🟢' : '🔴'} ${fmt(a.price)} (${a.chg >= 0 ? '+' : ''}${fmt(a.chg)}%)`,
      `RVOL ${fmt(a.rvol, 1)}x | Vol ${fmt((a.vol || 0) / 1e6, 2)}M | Float ${a.floatDisp}`,
      a.news ? `📰 ${a.news}` : '_No fresh headline_',
      `⚠️ Day-trading low caps is high risk.`
    ].join('\n');

    await ch.send(msg);
  } catch (e) {
    console.error('Runner ping error:', e?.message || e);
  }
}

// ---------- Build & send one compact alert --------------------------------
async function buildCompactBlock(ticker, q) {
  const t = norm(ticker);
  const ctx = {};

  try {
    const end = dayjs().tz(TZSTR);
    const start = end.subtract(10, 'day');
    const hist = await yahooFinance.historical(t, {
      period1: start.toDate(),
      period2: end.toDate(),
      interval: '1d'
    });

    const last = (hist || []).slice(-3);
    const sma = (a, n) => a.slice(-n).reduce((x, y) => x + y, 0) / Math.min(n, a.length);
    const closes = last.map(c => c.close);

    const ema9 = sma(closes, 9);
    const ema21 = sma(closes, 21) || sma(closes, 9);
    ctx.trend = (Number.isFinite(ema9) && Number.isFinite(ema21)) ? (ema9 >= ema21 ? 'up' : 'down') : null;

    const y = last.at(-2);
    ctx.belowPDL = y ? q.price < y.low : false;
    ctx.abovePMH = y ? q.price > y.high : false;
  } catch {}

  ctx.rvol = estimateRVOLFromQuote(q.raw, q.session) || null;
  ctx.daily = await buildDailyContext(t, q.price, TZSTR);

  const lines = bannerCompact(t, q, ctx);
  const w = (q.type === 'EQUITY' || q.type === 'ETF') ? await weeklyOptions(t, q.price).catch(() => null) : null;
  const opt = optionsCompact(w);

  return [...lines, ...opt, '⛔ Invalidate: lose VWAP or hit SL'];
}

async function postExpressAlert(tickers, channelId) {
  const ch = await client.channels.fetch(channelId);
  const list = (tickers || []).map(norm).slice(0, 4);
  if (!list.length) return;

  const chunks = [];
  for (const t of list) {
    const q = await getQuote(t);
    const block = await buildCompactBlock(t, q);
    chunks.push(block.join('\n'));
  }
  await ch.send(chunks.join('\n\n'));
}

// ---------- Register slash commands ---------------------------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('alert')
      .setDescription('EXPRESS ALERT: live levels (multi-ticker)')
      .addStringOption(o => o.setName('text').setDescription('e.g., NVDA, AAPL or “check NVDA and BTC”').setRequired(false)),
    new SlashCommandBuilder().setName('deep')
      .setDescription('DEEP DIVE: HTF context')
      .addStringOption(o => o.setName('ticker').setDescription('One ticker, e.g. SPY').setRequired(false)),
    new SlashCommandBuilder().setName('scalp')
      .setDescription('CRYPTO SCALPS: BTC-USD / ETH-USD etc.')
      .addStringOption(o => o.setName('symbol').setDescription('e.g., BTC-USD').setRequired(false)),
    new SlashCommandBuilder().setName('flow')
      .setDescription('OPTIONS FLOW placeholder (configure provider later)')
      .addStringOption(o => o.setName('ticker').setDescription('e.g., NVDA').setRequired(true)),
    new SlashCommandBuilder().setName('health').setDescription('Health check: data + time + session'),

    new SlashCommandBuilder().setName('schedule_add')
      .setDescription('Add an auto-post schedule')
      .addStringOption(o => o.setName('cron').setDescription('Cron like 0 9 * * 1-5 or */1 * * * *').setRequired(true))
      .addStringOption(o => o.setName('tickers').setDescription('Tickers (comma/space-separated, max 4)').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post in').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('schedule_list').setDescription('List all auto-post schedules'),
    new SlashCommandBuilder().setName('schedule_remove')
      .setDescription('Remove an auto-post schedule by ID')
      .addIntegerOption(o => o.setName('id').setDescription('Schedule ID (see /schedule_list)').setRequired(true)),

    new SlashCommandBuilder().setName('scan_lowcap')
      .setDescription('Run the Low-Cap Top-4 scan now')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post in').addChannelTypes(ChannelType.GuildText).setRequired(false)),
    new SlashCommandBuilder().setName('scan_gappers')
      .setDescription('Run the Gapper scan now')
      .addChannelOption(o => o.setName('channel').setDescription('Channel to post in').addChannelTypes(ChannelType.GuildText).setRequired(false)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (GUILD_ID) {
    try {
      console.log('Registering GUILD commands for', GUILD_ID);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('GUILD commands registered.');
      return;
    } catch (e) {
      console.warn('Guild registration failed (fallback to GLOBAL):', e?.status || '', e?.message || e);
    }
  }

  console.log('Registering GLOBAL commands…');
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('GLOBAL commands registered.');
}

// ---------- Interaction handlers ------------------------------------------
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  const safeReply = async (content, ephemeral = false) => {
    try {
      if (i.deferred || i.replied) return await i.editReply({ content });
      return await i.reply({ content, ephemeral });
    } catch {}
  };

  try {
    if (i.commandName === 'alert') {
      await i.deferReply({ ephemeral: false });

      const text = safeStr(i.options.getString('text') || 'NVDA');
      const words = text
        .replace(/[“”‘’"]/g, '')
        .replace(/\$/g, '')
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/)
        .filter(Boolean);

      const list = [...new Set(words.filter(isTicker))].slice(0, 4);
      const tickers = list.length ? list : ['NVDA'];

      const chunks = [];
      for (const t of tickers) {
        const q = await getQuote(t);
        const block = await buildCompactBlock(t, q);
        chunks.push(block.join('\n'));
      }

      await safeReply(chunks.join('\n\n'));
      return;
    }

    if (i.commandName === 'deep') {
      await i.deferReply({ ephemeral: false });

      const t = norm(i.options.getString('ticker') || 'SPY');
      const q = await getQuote(t);

      const end = dayjs().tz(TZSTR);
      const start = end.subtract(90, 'day');
      const hist = await yahooFinance.historical(t, {
        period1: start.toDate(),
        period2: end.toDate(),
        interval: '1d'
      });

      const last30 = (hist || []).slice(-30);
      const closes = last30.map(c => c.close);
      const sma = (a, n) => a.slice(-n).reduce((x, y) => x + y, 0) / Math.min(n, a.length);

      const sma20 = sma(closes, 20);
      const sma50 = sma(closes, 50);
      const pdh = last30.at(-2)?.high;
      const pdl = last30.at(-2)?.low;

      const trend = sma20 > sma50 ? '🟢 Up (20>50)' : '🟡 Mixed/Down (20<=50)';

      await safeReply([
        `DEEP DIVE 📚 — ${t} @ ${fmt(q.price)} (${q.chg >= 0 ? '+' : ''}${fmt(q.chg)}%) — ${ts()}`,
        `• Type: ${q.type} | Session: ${q.session} | Source: ${q.source}${q.flag ? ` | ${q.flag}` : ''}`,
        `• Trend: ${trend}`,
        `• PDH/PDL: ${fmt(pdh)}/${fmt(pdl)}`,
        `• SMA20/50: ${fmt(sma20)}/${fmt(sma50)}`,
        `• Plan: buy dips > PDH; lose PDL → hedge`
      ].join('\n'));
      return;
    }

    if (i.commandName === 'scalp') {
      await i.deferReply({ ephemeral: false });

      const sym = norm(i.options.getString('symbol') || 'BTC-USD');
      const q = await getQuote(sym);

      const r = 0.006;
      const s1 = +(q.price * (1 - r)).toFixed(2);
      const s2 = +(q.price * (1 - 2 * r)).toFixed(2);
      const t1 = +(q.price * (1 + r)).toFixed(2);
      const t2 = +(q.price * (1 + 2 * r)).toFixed(2);

      await safeReply([
        `CRYPTO SCALP ⚡ — ${sym} @ ${fmt(q.price)} (${q.chg >= 0 ? '+' : ''}${fmt(q.chg)}%) — ${ts()}`,
        `• Bias: ${q.chg >= 0 ? '🟢' : '🟡'} Range scalp via VWAP`,
        `• Key S/R: ${s2} / ${s1} | ${t1} / ${t2}`,
        `• 🚫 SL: below ${s2}`,
        `• 🎯 ${t1} / ${t2}`
      ].join('\n'));
      return;
    }

    if (i.commandName === 'flow') {
      await i.deferReply({ ephemeral: false });
      const t = norm(i.options.getString('ticker'));
      await safeReply(`OPTIONS FLOW 🔍 — ${t}\n• Provider not configured. Use /alert and /deep.`);
      return;
    }

    if (i.commandName === 'health') {
      await i.deferReply({ ephemeral: false });

      let yahooLine = '• Yahoo: unavailable (rate limited?)';
      try {
        const spy = await yahooFinance.quote('SPY');
        const price = spy?.regularMarketPrice ?? spy?.postMarketPrice ?? spy?.preMarketPrice;
        const chg = spy?.regularMarketChangePercent ?? 0;
        if (price != null) yahooLine = `• Yahoo: OK — SPY ${fmt(price)} (${chg >= 0 ? '+' : ''}${fmt(chg)}%)`;
      } catch {}

      await safeReply([
        `HEALTH ✅ — ${ts()}`,
        `• Session (NY): ${getSession()}`,
        yahooLine,
        `• Polygon key: ${POLY ? 'present' : 'missing'}`,
        `• TZ: ${TZSTR}`
      ].join('\n'));
      return;
    }

    if (i.commandName === 'schedule_add') {
      await i.deferReply({ ephemeral: true });

      const cronStr = safeStr(i.options.getString('cron'));
      const tickStr = safeStr(i.options.getString('tickers'));
      const chOpt = i.options.getChannel('channel');
      const channelId = (chOpt?.id) || (DEFAULT_CHANNEL_ID || i.channelId);

      if (!cron.validate(cronStr)) {
        await safeReply(`❌ Invalid cron: ${cronStr}\nExamples:\n• 0 9 * * 1-5\n• 30 15 * * 1-5\n• */1 * * * * (testing)`, true);
        return;
      }

      const rawTickers = tickStr
        .replace(/[“”‘’"]/g, '')
        .replace(/\$/g, '')
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/)
        .filter(Boolean)
        .map(norm);

      const unique = [...new Set(rawTickers.filter(isTicker))].slice(0, 4);
      if (!unique.length) {
        await safeReply('❌ No valid tickers found. Try: SPY, QQQ, NVDA, TSLA', true);
        return;
      }

      const entry = { id: NEXT_ID++, cron: cronStr, tickers: unique, channelId };
      SCHEDULES.push(entry);
      saveSchedules();
      startJob(entry);

      await safeReply(
        `✅ Added schedule #${entry.id}\n• Cron: ${entry.cron}\n• Tickers: ${entry.tickers.join(', ')}\n• Channel: <#${entry.channelId}>`,
        true
      );
      return;
    }

    if (i.commandName === 'schedule_list') {
      await i.deferReply({ ephemeral: true });
      if (!SCHEDULES.length) { await safeReply('No schedules yet. Add one with /schedule_add.', true); return; }
      await safeReply(SCHEDULES.map(e => `#${e.id} — ${e.cron} → [${e.tickers.join(', ')}] → <#${e.channelId}>`).join('\n'), true);
      return;
    }

    if (i.commandName === 'schedule_remove') {
      await i.deferReply({ ephemeral: true });

      const id = i.options.getInteger('id');
      const idx = SCHEDULES.findIndex(e => e.id === id);
      if (idx === -1) { await safeReply(`❌ Schedule #${id} not found.`, true); return; }

      stopJob(id);
      const removed = SCHEDULES.splice(idx, 1)[0];
      saveSchedules();

      await safeReply(`🗑️ Removed schedule #${id}: ${removed.cron} [${removed.tickers.join(', ')}]`, true);
      return;
    }

    if (i.commandName === 'scan_lowcap') {
      await i.deferReply({ ephemeral: false });
      const chOpt = i.options.getChannel('channel');
      const channelId = (chOpt?.id) || (DEFAULT_CHANNEL_ID || i.channelId);
      await postLowcapTopN(channelId, 4);
      await safeReply(`✅ Low-cap Top 4 posted in <#${channelId}>`);
      return;
    }

    if (i.commandName === 'scan_gappers') {
      await i.deferReply({ ephemeral: false });
      const chOpt = i.options.getChannel('channel');
      const channelId = (chOpt?.id) || (DEFAULT_CHANNEL_ID || i.channelId);
      await postGapperScan(channelId, 6);
      await safeReply(`✅ Gapper scan posted in <#${channelId}>`);
      return;
    }
  } catch (e) {
    console.error('interaction error:', e?.message || e);
    await safeReply('❌ Data provider error. Try again in 30–60s.');
  }
});

// ---------- Startup --------------------------------------------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadSchedules();
  restartAllJobs();

  if (DEFAULT_CHANNEL_ID && !SCHEDULES.length) {
    const defaults = [
      { cron: '0 9 * * 1-5', tickers: ['SPY','QQQ','NVDA','TSLA'], channelId: DEFAULT_CHANNEL_ID },
      { cron: '0 12 * * 1-5', tickers: ['SPY'], channelId: DEFAULT_CHANNEL_ID },
      { cron: '30 15 * * 1-5', tickers: ['SPY','AAPL'], channelId: DEFAULT_CHANNEL_ID }
    ];
    for (const d of defaults) {
      const entry = { id: NEXT_ID++, ...d };
      SCHEDULES.push(entry);
      startJob(entry);
    }
    saveSchedules();
    console.log('Baseline schedules created.');
  }

  if (DEFAULT_CHANNEL_ID) {
    const addLC = (cronStr) => cron.schedule(cronStr, () => postLowcapTopN(DEFAULT_CHANNEL_ID, 4), { timezone: TZSTR });
    const addGP = (cronStr) => cron.schedule(cronStr, () => postGapperScan(DEFAULT_CHANNEL_ID, 6), { timezone: TZSTR });
    const addRP = (cronStr) => cron.schedule(cronStr, () => postRunnerPing(DEFAULT_CHANNEL_ID), { timezone: TZSTR });

    addLC('0 7 * * 1-5'); addGP('0 7 * * 1-5');
    addLC('0 8 * * 1-5'); addGP('0 8 * * 1-5');
    addLC('0 9 * * 1-5'); addGP('0 9 * * 1-5');
    addLC('0 16 * * 1-5'); addGP('0 16 * * 1-5');

    addRP('15 8 * * 1-5');
    addRP('45 9 * * 1-5');
  }
});

// keep alive
setInterval(() => {}, 60 * 1000);

// errors
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

// register & login
registerCommands()
  .catch(e => console.warn('Command registration threw (continuing):', e?.message || e))
  .finally(() => {
    client.login(TOKEN)
      .then(() => console.log('Logged in OK'))
      .catch(e => console.error('Login failed:', e?.message || e));
  });

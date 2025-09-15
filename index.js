// Chart Assassin — Discord Live Options Bot
// SAFE v3.7 (Guild Commands + Tolerant Tickers + Scheduler)
// ---------------------------------------------------------
// New in v3.7:
// • Registers slash commands to your SERVER (fast refresh) if DISCORD_GUILD_ID is set
// • Very tolerant ticker parsing (commas/spaces/$/quotes)
// • In-Discord scheduler: /schedule_add, /schedule_list, /schedule_remove
// • schedules.json persistence
//
// Railway → Variables (required):
//   DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, DISCORD_CHANNEL_ID
// Optional:
//   TZ=America/New_York, POLYGON_KEY, DISCREPANCY_BPS (default 50)
//
// Notes:
// - If commands look "outdated", ensure DISCORD_GUILD_ID is your server's ID and that logs show "Registering GUILD commands".
// - If Discord says "application did not respond", make sure the bot is online and logs show "Logged in as ...".

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
const GUILD_ID = process.env.DISCORD_GUILD_ID || '';         // set this!
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const TZSTR = process.env.TZ || 'UTC';
const POLY = process.env.POLYGON_KEY;
const DISC_BPS = Number(process.env.DISCREPANCY_BPS ?? 50);

if (!TOKEN || !CLIENT_ID) {
  console.error('❌ Missing DISCORD_TOKEN or DISCORD_CLIENT_ID');
  process.exit(1);
}

console.log('Boot v3.7', { TZ: TZSTR, DISC_BPS, hasGUILD_ID: !!GUILD_ID, hasCHANNEL: !!DEFAULT_CHANNEL_ID });

// ---------- Small utils ----------------------------------------------------
const ts = () => dayjs().tz(TZSTR).format('MMM D, HH:mm z');
const fmt = (n, d = 2) => Number(n).toFixed(d);
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

// ---------- Data: Yahoo + Polygon -----------------------------------------
async function yahooQuoteFull(ticker) {
  try {
    const q = await yf2.default.quote(ticker);
    const price = q?.regularMarketPrice ?? q?.postMarketPrice ?? q?.preMarketPrice;
    const chg   = q?.regularMarketChangePercent ?? 0;
    const type  = q?.quoteType || 'EQUITY';
    if (price == null) throw new Error('No price on quote');
    return { price: Number(price), chg: Number(chg), type, source: 'Yahoo' };
  } catch {
    const q = await yf2.default.quoteSummary(ticker, { modules: ['price'] });
    const p = q?.price;
    if (!p) throw new Error('No price on quoteSummary');
    const price = p.regularMarketPrice ?? p.postMarketPrice ?? p.preMarketPrice;
    const chg   = p.regularMarketChangePercent ?? p.postMarketChangePercent ?? p.preMarketChangePercent ?? 0;
    const type  = p.quoteType || 'EQUITY';
    return { price: Number(price), chg: Number(chg), type, source: 'Yahoo (fallback)' };
  }
}

async function polygonQuote(ticker) {
  if (!POLY) return null;
  const http = axios.create({ timeout: 6000, headers: { 'User-Agent': 'ChartAssassinBot/Poly' } });
  const retry = async (fn, tries = 2) => { try { return await fn(); } catch (e) { if (tries <= 0) throw e; return retry(fn, tries - 1); } };

  try {
    const nb = await retry(() =>
      http.get(`https://api.polygon.io/v2/last/nbbo/${ticker}`, { params: { apiKey: POLY } })
    ).then(r => r.data?.results);
    const price = nb ? (nb.bid.price + nb.ask.price) / 2 : null;
    if (!price) return null;

    const prev = await retry(() =>
      http.get(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`, { params: { apiKey: POLY } })
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
      const flag = diff > (DISC_BPS / 100) ? `⚠️ Discrepancy ${fmt(diff, 2)}% (Poly vs Y)` : '';
      return { ...p, type: y.type, session: getSession(), source: 'Polygon', flag, alt: `Yahoo ${fmt(y.price)}` };
    }
  }
  return { ...y, session: getSession(), alt: null, flag: '' };
}

// ---------- Options (weekly, ATM) -----------------------------------------
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
    const strikes = [...new Set([...calls, ...puts].map((o) => +o.strike))]
      .filter(Number.isFinite).sort((a, b) => a - b);
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
  } catch {
    return null;
  }
}

// ---------- Text formatters ------------------------------------------------
function banner(t, q) {
  const price = fmt(q.price);
  const pct = (q.chg >= 0 ? '+' : '') + fmt(q.chg) + '%';
  const bias = q.chg >= 0 ? '🟢' : '🟡';
  const entryL = +(q.price * 0.995).toFixed(2);
  const entryH = +(q.price * 1.005).toFixed(2);
  const sl     = +(q.price * 0.98).toFixed(2);
  const t1 = +(q.price * 1.01).toFixed(2);
  const t2 = +(q.price * 1.03).toFixed(2);
  const t3 = +(q.price * 1.05).toFixed(2);
  const rr = ((t2 - q.price) / (q.price - sl)).toFixed(1);

  const head = `$${t} | ${price} (${pct}) @ ${ts()} | ${bias} | Entry ${entryL}-${entryH} | SL ${sl} | T: ${t1}/${t2}/${t3} | R:R ~${rr}`;
  const core = [
    `• Mode: Opening scalp ⚡ / swing 📆`,
    `• Bias: ${bias} Above VWAP favors calls`,
    `• Session: ${q.session} | Source: ${q.source}${q.flag ? ` | ${q.flag}` : ''}`,
    `• Key S/R: VWAP; ±1% band`,
    `• 🚫 SL: ${sl} — below structure`,
    `• 🎯 ${t1} / ${t2} / ${t3}`,
    `• Prob/Conf: 55% | Medium`,
    `• Mgmt: Trim @ T1, BE stop, trail EMA`,
    `• Alt: Lose VWAP → fade to band low`
  ];
  return { head, core };
}

function optLines(w) {
  if (!w) return ['• Options: n/a'];
  return [
    `• Weekly: ${w.expiry} | ATM≈ ${w.s.sATM}`,
    w.call ? `• Calls: ${w.call.cs} | ${fmt(w.call.bid)}/${fmt(w.call.ask)} IV ${fmt(w.call.iv * 100, 1)}%` : `• Calls: n/a`,
    w.put  ? `• Puts : ${w.put.cs} | ${fmt(w.put.bid)}/${fmt(w.put.ask)} IV ${fmt(w.put.iv * 100, 1)}%` : `• Puts : n/a`
  ];
}

// ---------- Discord client -------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- Schedules storage/runtime -------------------------------------
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
        console.log('Loaded schedules from file:', SCHEDULES.length);
      }
    }
  } catch (e) {
    console.error('loadSchedules error:', e?.message || e);
  }
}
function saveSchedules() {
  try { fs.writeFileSync(SFILE, JSON.stringify(SCHEDULES, null, 2)); }
  catch (e) { console.error('saveSchedules error:', e?.message || e); }
}
function startJob(entry) {
  if (!cron.validate(entry.cron)) {
    console.error('Invalid cron, skip id', entry.id, entry.cron);
    return;
  }
  const job = cron.schedule(entry.cron, () => {
    postExpressAlert(entry.tickers, entry.channelId);
  }, { timezone: TZSTR });
  JOBS.set(entry.id, job);
}
function stopJob(id) {
  const job = JOBS.get(id);
  if (job) { job.stop(); JOBS.delete(id); }
}
function restartAllJobs() {
  for (const [id, job] of JOBS.entries()) { job.stop(); JOBS.delete(id); }
  for (const e of SCHEDULES) startJob(e);
}

// ---------- Slash commands registration -----------------------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('alert')
      .setDescription('EXPRESS ALERT: live levels (multi-ticker)')
      .addStringOption((o) =>
        o.setName('text').setDescription('e.g., NVDA, AAPL or “check NVDA and BTC”').setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('deep')
      .setDescription('DEEP DIVE: HTF context')
      .addStringOption((o) => o.setName('ticker').setDescription('One ticker, e.g. SPY').setRequired(false)),
    new SlashCommandBuilder()
      .setName('scalp')
      .setDescription('CRYPTO SCALPS: BTC/ETH/SOL/XRP/ADA/DOGE quick levels')
      .addStringOption((o) => o.setName('symbol').setDescription('e.g., BTC-USD').setRequired(false)),
    new SlashCommandBuilder()
      .setName('flow')
      .setDescription('OPTIONS FLOW placeholder (configure provider later)')
      .addStringOption((o) => o.setName('ticker').setDescription('e.g., NVDA').setRequired(true)),
    new SlashCommandBuilder()
      .setName('health')
      .setDescription('Health check: data + time + session'),

    new SlashCommandBuilder()
      .setName('schedule_add')
      .setDescription('Add an auto-post schedule')
      .addStringOption(o =>
        o.setName('cron')
         .setDescription('Cron like "0 9 * * 1-5" (9:00 AM Mon–Fri) or "*/1 * * * *" (every minute)')
         .setRequired(true))
      .addStringOption(o =>
        o.setName('tickers')
         .setDescription('Tickers (comma/space-separated, max 4): e.g. "SPY, QQQ, NVDA, TSLA"')
         .setRequired(true))
      .addChannelOption(o =>
        o.setName('channel')
         .setDescription('Channel to post in (defaults to this channel)')
         .addChannelTypes(ChannelType.GuildText)
         .setRequired(false)),

    new SlashCommandBuilder()
      .setName('schedule_list')
      .setDescription('List all auto-post schedules'),

    new SlashCommandBuilder()
      .setName('schedule_remove')
      .setDescription('Remove an auto-post schedule by ID')
      .addIntegerOption(o =>
        o.setName('id')
         .setDescription('Schedule ID (see /schedule_list)')
         .setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (GUILD_ID) {
    console.log('Registering GUILD commands for', GUILD_ID);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  } else {
    console.log('Registering GLOBAL commands (no DISCORD_GUILD_ID set)');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  }
}

// ---------- Auto-post helper ----------------------------------------------
async function postExpressAlert(tickers, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    const list = (tickers || []).map(norm).slice(0, 4);

    const chunks = [];
    for (const t of list) {
      const q = await getQuote(t);
      const { head, core } = banner(t, q);
      const w = (q.type === 'EQUITY' || q.type === 'ETF')
        ? await weeklyOptions(t, q.price).catch(() => null)
        : null;

      const block = [
        '⚡ EXPRESS ALERT — SCHEDULED',
        '',
        head,
        ...core,
        ...optLines(w),
        '— — —',
        'This is not financial advice. Do your own research.'
      ];
      chunks.push(block.join('\n'));
    }
    if (!chunks.length) return;
    await channel.send(chunks.join('\n\n'));
  } catch (e) {
    console.error('Scheduled post error:', e?.message || e);
  }
}

// ---------- Interaction handlers ------------------------------------------
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    // Ensure we acknowledge fast
    // (we individually defer in each command block below)

    // /alert
    if (i.commandName === 'alert') {
      await i.deferReply({ ephemeral: false });
      const text = i.options.getString('text') || 'NVDA';
      const words = (text || '')
        .replace(/[“”‘’"]/g, '')
        .replace(/\$/g, '')
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/);
      const list = [...new Set(words.filter(isTicker))].slice(0, 4);
      const tickers = list.length ? list : ['NVDA'];

      const chunks = [];
      for (const t of tickers) {
        const q = await getQuote(t);
        const { head, core } = banner(t, q);
        const w = (q.type === 'EQUITY' || q.type === 'ETF') ? await weeklyOptions(t, q.price).catch(() => null) : null;
        const block = [
          '⚡ EXPRESS ALERT — OPENING PLAY',
          '',
          head,
          ...core,
          ...optLines(w),
          '— — —',
          'This is not financial advice. Do your own research.'
        ];
        chunks.push(block.join('\n'));
      }
      await i.editReply(chunks.join('\n\n'));
      return;
    }

    // /deep
    if (i.commandName === 'deep') {
      await i.deferReply({ ephemeral: false });
      const t = norm(i.options.getString('ticker') || 'SPY');
      const q = await getQuote(t);
      const end = dayjs().tz(TZSTR), start = end.subtract(90, 'day');
      const hist = await yf2.default.historical(t, { period1: start.toDate(), period2: end.toDate(), interval: '1d' });
      const last30 = hist.slice(-30);
      const closes = last30.map(c => c.close);
      const sma = (a, n) => a.slice(-n).reduce((x, y) => x + y, 0) / Math.min(n, a.length);
      const sma20 = sma(closes, 20), sma50 = sma(closes, 50);
      const pdh = last30.at(-2)?.high, pdl = last30.at(-2)?.low;
      const trend = sma20 > sma50 ? '🟢 Up (20>50)' : '🟡 Mixed/Down (20<=50)';
      const lines = [
        `DEEP DIVE 📚 — ${t} @ ${fmt(q.price)} (${q.chg >= 0 ? '+' : ''}${fmt(q.chg)}%) — ${ts()}`,
        `• Type: ${q.type} | Session: ${q.session} | Source: ${q.source}${q.flag ? ` | ${q.flag}` : ''}`,
        `• Trend: ${trend}`,
        `• PDH/PDL: ${fmt(pdh)}/${fmt(pdl)}`,
        `• SMA20/50: ${fmt(sma20)}/${fmt(sma50)}`,
        `• Liquidity: watch PDH/PDL sweeps`,
        `• Plan: buy dips > PDH; lose PDL → hedge`,
        `— — —`,
        `This is not financial advice. Do your own research.`
      ].join('\n');
      await i.editReply(lines);
      return;
    }

    // /scalp
    if (i.commandName === 'scalp') {
      await i.deferReply({ ephemeral: false });
      const sym = norm(i.options.getString('symbol') || 'BTC-USD');
      const q = await getQuote(sym);
      const r = 0.006;
      const s1 = +(q.price * (1 - r)).toFixed(2), s2 = +(q.price * (1 - 2 * r)).toFixed(2);
      const t1 = +(q.price * (1 + r)).toFixed(2), t2 = +(q.price * (1 + 2 * r)).toFixed(2);
      const txt = [
        `CRYPTO SCALP ⚡ — ${sym} @ ${fmt(q.price)} (${q.chg >= 0 ? '+' : ''}${fmt(q.chg)}%) — ${ts()}`,
        `• Bias: ${q.chg >= 0 ? '🟢' : '🟡'} Range scalp via VWAP`,
        `• Key S/R: ${s2} / ${s1} | ${t1} / ${t2}`,
        `• 🚫 SL: below ${s2}`,
        `• 🎯 ${t1} / ${t2}`,
        `— — —`,
        `This is not financial advice. Do your own research.`
      ].join('\n');
      await i.editReply(txt);
      return;
    }

    // /flow (placeholder)
    if (i.commandName === 'flow') {
      await i.deferReply({ ephemeral: false });
      const t = norm(i.options.getString('ticker'));
      await i.editReply(`OPTIONS FLOW 🔍 — ${t}\n• Provider not configured. Add API + code to enable.\n• Meanwhile, use /alert for live levels and /deep for HTF.`);
      return;
    }

    // /health
    if (i.commandName === 'health') {
      await i.deferReply({ ephemeral: false });
      let yahooLine = '• Yahoo: unavailable (rate limited?)';
      try {
        const spy = await yf2.default.quote('SPY');
        const price = spy?.regularMarketPrice ?? spy?.postMarketPrice ?? spy?.preMarketPrice;
        const chg   = spy?.regularMarketChangePercent ?? 0;
        if (price != null) yahooLine = `• Yahoo: OK — SPY ${fmt(price)} (${chg >= 0 ? '+' : ''}${fmt(chg)}%)`;
      } catch (e) {}
      const msg = [
        `HEALTH ✅ — ${ts()}`,
        `• Session (NY): ${getSession()}`,
        yahooLine,
        `• Polygon key: ${POLY ? 'present' : 'missing'}`,
        `• TZ: ${TZSTR}`
      ].join('\n');
      await i.editReply(msg);
      return;
    }

    // ===== Scheduler commands =====

    // /schedule_add
    if (i.commandName === 'schedule_add') {
      await i.deferReply({ ephemeral: true });

      const cronStr = i.options.getString('cron');
      const tickStr = i.options.getString('tickers');
      const chOpt   = i.options.getChannel('channel');
      const channelId = (chOpt?.id) || (DEFAULT_CHANNEL_ID || i.channelId);

      if (!cron.validate(cronStr)) {
        await i.editReply(`❌ Invalid cron: \`${cronStr}\`\nExamples:\n• \`0 9 * * 1-5\` (9:00 AM Mon–Fri)\n• \`30 15 * * 1-5\` (3:30 PM Mon–Fri)\n• \`*/1 * * * *\` (every minute, testing)`);
        return;
      }

      // tolerant ticker parser: removes quotes/$, splits on any non-ticker char
      const rawTickers = (tickStr || '')
        .replace(/[“”‘’"]/g, '')
        .replace(/\$/g, '')
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/)
        .filter(Boolean)
        .map(s => norm(s));

      const unique = [...new Set(rawTickers.filter(isTicker))].slice(0, 4);
      if (!unique.length) {
        await i.editReply('❌ No valid tickers found. Try: `SPY, QQQ, NVDA, TSLA`');
        return;
      }

      const entry = { id: NEXT_ID++, cron: cronStr, tickers: unique, channelId };
      SCHEDULES.push(entry);
      saveSchedules();
      startJob(entry);

      await i.editReply(`✅ Added schedule #${entry.id}\n• Cron: \`${entry.cron}\`\n• Tickers: ${entry.tickers.join(', ')}\n• Channel: <#${entry.channelId}>`);
      return;
    }

    // /schedule_list
    if (i.commandName === 'schedule_list') {
      await i.deferReply({ ephemeral: true });
      if (!SCHEDULES.length) {
        await i.editReply('No schedules yet. Add one with `/schedule_add`.');
        return;
      }
      const lines = SCHEDULES.map(e => `#${e.id} — \`${e.cron}\` → [${e.tickers.join(', ')}] → <#${e.channelId}>`);
      await i.editReply(lines.join('\n'));
      return;
    }

    // /schedule_remove
    if (i.commandName === 'schedule_remove') {
      await i.deferReply({ ephemeral: true });
      const id = i.options.getInteger('id');
      const idx = SCHEDULES.findIndex(e => e.id === id);
      if (idx === -1) {
        await i.editReply(`❌ Schedule #${id} not found.`);
        return;
      }
      stopJob(id);
      const removed = SCHEDULES.splice(idx, 1)[0];
      saveSchedules();
      await i.editReply(`🗑️ Removed schedule #${id}: \`${removed.cron}\` [${removed.tickers.join(', ')}]`);
      return;
    }

  } catch (e) {
    console.error('interaction error:', e?.message || e);
    try { await i.reply({ content: 'Unexpected error — try again.', ephemeral: true }); } catch {}
  }
});

// ---------- Startup --------------------------------------------------------
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  loadSchedules();
  restartAllJobs();

  // Optional: baseline schedules on clean boot if none exist and a default channel is provided
  if (DEFAULT_CHANNEL_ID && !SCHEDULES.length) {
    const defaults = [
      { cron: '0 9 * * 1-5',  tickers: ['SPY','QQQ','NVDA','TSLA'], channelId: DEFAULT_CHANNEL_ID },
      { cron: '0 12 * * 1-5', tickers: ['SPY'],                     channelId: DEFAULT_CHANNEL_ID },
      { cron: '30 15 * * 1-5',tickers: ['SPY','AAPL'],              channelId: DEFAULT_CHANNEL_ID },
      { cron: '0 18 * * 0',   tickers: ['SPY','AAPL','NVDA','TSLA','AMZN','GOOGL','MSFT','META'], channelId: DEFAULT_CHANNEL_ID }
    ];
    for (const d of defaults) {
      const entry = { id: NEXT_ID++, ...d };
      SCHEDULES.push(entry);
      startJob(entry);
    }
    saveSchedules();
    console.log('Baseline schedules created.');
  }
});

// keep worker envs alive
setInterval(() => {}, 60 * 1000);

// errors
process.on('uncaughtException', (err) => console.error('Uncaught:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled:', err));

// register & login
registerCommands()
  .then(() => client.login(TOKEN))
  .catch((e) => { console.error('Startup error:', e?.message || e); process.exit(1); });

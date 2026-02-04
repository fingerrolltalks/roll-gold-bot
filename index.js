// Chart Assassin — Discord Live Options Bot
// STABLE v3.15 (Polygon-only: no Yahoo dependency)
// Fixes: Yahoo rate-limit/blocked errors, missing price, provider error spam
//
// Env (Railway → Variables):
// DISCORD_TOKEN
// DISCORD_CLIENT_ID
// DISCORD_GUILD_ID (optional)
// DISCORD_CHANNEL_ID (optional default channel)
// TZ=America/New_York (recommended)
// POLYGON_KEY (required for quotes/scans)
// LOWCAP_LIST (optional override universe, comma/space list)

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
} from "discord.js";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
import cron from "node-cron";
import fs from "fs";

dayjs.extend(utc);
dayjs.extend(tz);

// ---------- ENV ----------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "";
const TZSTR = process.env.TZ || "UTC";
const POLY = process.env.POLYGON_KEY || "";

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing DISCORD_TOKEN or DISCORD_CLIENT_ID");
  process.exit(1);
}
if (!POLY) {
  console.error("❌ Missing POLYGON_KEY (required in v3.15)");
  process.exit(1);
}

console.log("Boot v3.15", {
  TZ: TZSTR,
  GUILD_ID: !!GUILD_ID,
  DEFAULT_CHANNEL_ID: !!DEFAULT_CHANNEL_ID,
  POLY: !!POLY,
});

// ---------- Utils ----------
const ts = () => dayjs().tz(TZSTR).format("MMM D, HH:mm z");
const fmt = (n, d = 2) => Number(n).toFixed(d);
const clean = (s) => (s == null ? "" : String(s)).trim();
const norm = (s) => clean(s).toUpperCase().replace(/\s+/g, "");
const isTicker = (s) => /^[A-Z][A-Z0-9.\-]{0,10}$/.test(norm(s));

function getSessionNY(now = dayjs().tz("America/New_York")) {
  const dow = now.day();
  const mins = now.hour() * 60 + now.minute();
  if (dow === 0 || dow === 6) return "OFF";
  if (mins >= 240 && mins < 570) return "PRE";
  if (mins >= 570 && mins < 960) return "RTH";
  if (mins >= 960 && mins < 1200) return "POST";
  return "OFF";
}

// ---------- HTTP ----------
const http = axios.create({
  timeout: 10000,
  headers: { "User-Agent": "ChartAssassinBot/3.15" },
});

async function retry(fn, tries = 2) {
  try {
    return await fn();
  } catch (e) {
    if (tries <= 0) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return retry(fn, tries - 1);
  }
}

// ---------- Polygon Quote (robust) ----------
async function polygonPrevClose(ticker) {
  const prev = await retry(() =>
    http.get(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`, {
      params: { apiKey: POLY },
    })
  ).then((r) => r.data?.results?.[0]);

  if (!prev) return null;
  return { close: Number(prev.c), volume: Number(prev.v || 0) };
}

async function polygonLastTrade(ticker) {
  const tr = await retry(() =>
    http.get(`https://api.polygon.io/v2/last/trade/${ticker}`, {
      params: { apiKey: POLY },
    })
  ).then((r) => r.data?.results);

  const p = tr?.p;
  if (!Number.isFinite(p)) return null;
  return Number(p);
}

async function polygonDayAggMaybe(ticker) {
  // Use NY date for convenience; if Polygon returns empty (holiday/weekend), we fall back.
  const ny = dayjs().tz("America/New_York").format("YYYY-MM-DD");
  const d = await retry(() =>
    http.get(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${ny}/${ny}`, {
      params: { apiKey: POLY, adjusted: true, sort: "asc", limit: 1 },
    })
  ).then((r) => r.data?.results?.[0]);

  if (!d) return null;
  const price = Number.isFinite(d.c) ? Number(d.c) : Number.isFinite(d.o) ? Number(d.o) : null;
  const vol = Number(d.v || 0);
  if (!Number.isFinite(price)) return null;
  return { price, vol };
}

async function getQuote(ticker) {
  const t = norm(ticker);
  const session = getSessionNY();

  const [prev, last, dayAgg] = await Promise.all([
    polygonPrevClose(t).catch(() => null),
    polygonLastTrade(t).catch(() => null),
    polygonDayAggMaybe(t).catch(() => null),
  ]);

  const price =
    Number.isFinite(dayAgg?.price) ? dayAgg.price :
    Number.isFinite(last) ? last :
    null;

  if (!Number.isFinite(price)) {
    return { ok: false, ticker: t, session, error: "No Polygon price" };
  }

  const prevClose = prev?.close;
  const chg = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  const vol =
    Number.isFinite(dayAgg?.vol) ? dayAgg.vol :
    Number.isFinite(prev?.volume) ? prev.volume :
    0;

  return {
    ok: true,
    ticker: t,
    price: Number(price),
    chg: Number(chg),
    vol: Number(vol),
    prevClose: prevClose ? Number(prevClose) : null,
    session,
    source: "Polygon",
  };
}

// ---------- Alert formatting ----------
function buildAlertLines(q) {
  const dir = q.chg >= 0 ? "🟢" : "🔴";
  const pct = (q.chg >= 0 ? "+" : "") + fmt(q.chg, 2) + "%";

  // Simple, stable levels (no historical provider needed)
  const r = 0.006; // 0.6% band
  const s1 = +(q.price * (1 - r)).toFixed(2);
  const s2 = +(q.price * (1 - 2 * r)).toFixed(2);
  const t1 = +(q.price * (1 + r)).toFixed(2);
  const t2 = +(q.price * (1 + 2 * r)).toFixed(2);

  return [
    `⚡ **$${q.ticker}** ${fmt(q.price)} (${pct}) ${dir} — ${ts()}`,
    `• Session (NY): **${q.session}** | Source: **${q.source}**`,
    `• Key S/R: **${s2} / ${s1} | ${t1} / ${t2}**`,
    `• 🚫 SL: below **${s2}**`,
    `• ⛔ Invalidate: lose VWAP or hit SL`,
  ];
}

// ---------- Low-cap universe ----------
const DEFAULT_LOWCAP_UNIVERSE = [
  "SNTG","RNXT","KULR","HOLO","TOP","COSM","GROM","SIDU","NVOS","CEI","AITX","AGRI",
  "BBIG","VRAX","HCDI","CRKN","AIOT","NKLA","CYN","GFAI","ETON","HLTH","SOUN","IONQ"
];

function lowcapUniverse() {
  if (process.env.LOWCAP_LIST) return process.env.LOWCAP_LIST.split(/[,\s]+/).filter(Boolean).map(norm);
  return DEFAULT_LOWCAP_UNIVERSE;
}

async function scanLowcapsTopN(n = 4) {
  const list = lowcapUniverse();
  const out = [];

  for (const t of list) {
    const q = await getQuote(t).catch(() => null);
    if (!q?.ok) continue;

    // Filter window
    if (!(q.price >= 0.5 && q.price <= 7)) continue;
    if (q.vol < 200_000) continue;

    out.push({
      t: q.ticker,
      price: q.price,
      chg: q.chg,
      vol: q.vol,
      score: (q.chg || 0) + Math.log10(Math.max(1, q.vol)) // simple score
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, n);
}

function lowcapEmbed(items, whenLabel, topN = 4) {
  const embed = new EmbedBuilder()
    .setTitle(`🧪 Low-Cap Scanner — Top ${topN}`)
    .setDescription("_$0.5–$7 | Vol≥200k | Polygon-only_")
    .setFooter({ text: whenLabel })
    .setColor(0x00D084);

  if (!items.length) {
    embed.addFields({ name: "No matches", value: "No tickers met filters.", inline: false });
    return embed;
  }

  for (const a of items) {
    const dir = a.chg >= 0 ? "🟢" : "🔴";
    embed.addFields({
      name: `$${a.t} — ${dir} ${fmt(a.price)} (${a.chg >= 0 ? "+" : ""}${fmt(a.chg, 2)}%)`,
      value: `Vol **${fmt(a.vol / 1e6, 2)}M**`,
      inline: true,
    });
  }

  if (items.length % 2 === 1) embed.addFields({ name: "\u200B", value: "\u200B", inline: true });
  return embed;
}

// ---------- Discord client ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- Scheduler ----------
const SFILE = "schedules.json";
let SCHEDULES = [];
const JOBS = new Map();
let NEXT_ID = 1;

function loadSchedules() {
  try {
    if (fs.existsSync(SFILE)) {
      const raw = fs.readFileSync(SFILE, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        SCHEDULES = data;
        NEXT_ID = (Math.max(0, ...SCHEDULES.map((x) => x.id || 0)) + 1) || 1;
        console.log("Loaded schedules:", SCHEDULES.length);
      }
    }
  } catch (e) {
    console.error("loadSchedules error:", e?.message || e);
  }
}
function saveSchedules() {
  try {
    fs.writeFileSync(SFILE, JSON.stringify(SCHEDULES, null, 2));
  } catch (e) {
    console.error("saveSchedules error:", e?.message || e);
  }
}
function startJob(entry) {
  if (!cron.validate(entry.cron)) return;
  const job = cron.schedule(
    entry.cron,
    () => postAlert(entry.tickers, entry.channelId),
    { timezone: TZSTR }
  );
  JOBS.set(entry.id, job);
}
function stopJob(id) {
  const job = JOBS.get(id);
  if (job) job.stop();
  JOBS.delete(id);
}
function restartAllJobs() {
  for (const [, job] of JOBS) job.stop();
  JOBS.clear();
  for (const e of SCHEDULES) startJob(e);
}

// ---------- Posting ----------
async function postAlert(tickers, channelId) {
  const channel = await client.channels.fetch(channelId);
  const list = (tickers || []).map(norm).filter(Boolean).slice(0, 4);
  if (!list.length) return;

  const blocks = [];
  for (const t of list) {
    const q = await getQuote(t).catch(() => null);
    if (!q?.ok) {
      blocks.push(`⚠️ **$${norm(t)}** — Polygon quote failed. Try again in 30s.`);
      continue;
    }
    blocks.push(buildAlertLines(q).join("\n"));
  }
  await channel.send(blocks.join("\n\n"));
}

async function postLowcap(channelId, n = 4) {
  const ch = await client.channels.fetch(channelId);
  const items = await scanLowcapsTopN(n);
  const embed = lowcapEmbed(items, ts(), n);
  await ch.send({ embeds: [embed] });
}

// ---------- Commands ----------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("alert")
      .setDescription("EXPRESS ALERT: live levels (multi-ticker)")
      .addStringOption((o) =>
        o.setName("text").setDescription("e.g., NVDA, AAPL or “check SPY”").setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("health")
      .setDescription("Health check: Polygon + time + session"),

    new SlashCommandBuilder()
      .setName("scan_lowcap")
      .setDescription("Run Low-Cap Top-4 scan now (embed)")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel to post in").addChannelTypes(ChannelType.GuildText).setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("schedule_add")
      .setDescription("Add an auto-post schedule")
      .addStringOption((o) =>
        o.setName("cron").setDescription("Cron like 0 9 * * 1-5 or */5 * * * *").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("tickers").setDescription("Tickers (comma/space-separated, max 4)").setRequired(true)
      )
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel to post in").addChannelTypes(ChannelType.GuildText).setRequired(false)
      ),

    new SlashCommandBuilder().setName("schedule_list").setDescription("List all auto-post schedules"),

    new SlashCommandBuilder()
      .setName("schedule_remove")
      .setDescription("Remove an auto-post schedule by ID")
      .addIntegerOption((o) => o.setName("id").setDescription("Schedule ID").setRequired(true)),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const body = { body: commands };

  if (GUILD_ID) {
    console.log("Registering GUILD commands for", GUILD_ID);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), body);
    console.log("GUILD commands registered.");
    return;
  }

  console.log("Registering GLOBAL commands…");
  await rest.put(Routes.applicationCommands(CLIENT_ID), body);
  console.log("GLOBAL commands registered.");
}

// ---------- Interactions ----------
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === "health") {
      await i.deferReply({ ephemeral: false });

      const q = await getQuote("SPY");
      const line = q.ok
        ? `• Polygon: OK — SPY ${fmt(q.price)} (${q.chg >= 0 ? "+" : ""}${fmt(q.chg, 2)}%)`
        : `• Polygon: FAIL — ${q.error}`;

      await i.editReply([
        `HEALTH ✅ — ${ts()}`,
        `• Session (NY): ${getSessionNY()}`,
        line,
        `• TZ: ${TZSTR}`,
      ].join("\n"));
      return;
    }

    if (i.commandName === "alert") {
      await i.deferReply({ ephemeral: false });

      const text = clean(i.options.getString("text") || "SPY");
      const words = text.replace(/\$/g, "").toUpperCase().split(/[^A-Z0-9.\-]+/).filter(Boolean);
      const tickers = [...new Set(words.filter(isTicker))].slice(0, 4);
      const list = tickers.length ? tickers : ["SPY"];

      const chunks = [];
      for (const t of list) {
        const q = await getQuote(t);
        if (!q.ok) {
          chunks.push(`⚠️ **$${norm(t)}** — Polygon quote failed. Try again in 30s.`);
          continue;
        }
        chunks.push(buildAlertLines(q).join("\n"));
      }

      await i.editReply(chunks.join("\n\n"));
      return;
    }

    if (i.commandName === "scan_lowcap") {
      await i.deferReply({ ephemeral: false });
      const chOpt = i.options.getChannel("channel");
      const channelId = chOpt?.id || DEFAULT_CHANNEL_ID || i.channelId;
      await postLowcap(channelId, 4);
      await i.editReply(`✅ Low-cap Top 4 posted in <#${channelId}>`);
      return;
    }

    if (i.commandName === "schedule_add") {
      await i.deferReply({ ephemeral: true });

      const cronStr = i.options.getString("cron");
      const tickStr = clean(i.options.getString("tickers"));
      const chOpt = i.options.getChannel("channel");
      const channelId = chOpt?.id || DEFAULT_CHANNEL_ID || i.channelId;

      if (!cron.validate(cronStr)) {
        await i.editReply(`❌ Invalid cron: ${cronStr}\nExamples:\n• 0 9 * * 1-5\n• */5 * * * *`);
        return;
      }

      const rawTickers = tickStr.replace(/\$/g, "").toUpperCase().split(/[^A-Z0-9.\-]+/).filter(Boolean).map(norm);
      const unique = [...new Set(rawTickers.filter(isTicker))].slice(0, 4);

      if (!unique.length) {
        await i.editReply("❌ No valid tickers found. Try: SPY, QQQ, NVDA, TSLA");
        return;
      }

      const entry = { id: NEXT_ID++, cron: cronStr, tickers: unique, channelId };
      SCHEDULES.push(entry);
      saveSchedules();
      startJob(entry);

      await i.editReply(`✅ Added schedule #${entry.id}\n• Cron: ${entry.cron}\n• Tickers: ${entry.tickers.join(", ")}\n• Channel: <#${entry.channelId}>`);
      return;
    }

    if (i.commandName === "schedule_list") {
      await i.deferReply({ ephemeral: true });
      if (!SCHEDULES.length) {
        await i.editReply("No schedules yet. Add one with /schedule_add.");
        return;
      }
      await i.editReply(SCHEDULES.map((e) => `#${e.id} — ${e.cron} → [${e.tickers.join(", ")}] → <#${e.channelId}>`).join("\n"));
      return;
    }

    if (i.commandName === "schedule_remove") {
      await i.deferReply({ ephemeral: true });
      const id = i.options.getInteger("id");
      const idx = SCHEDULES.findIndex((e) => e.id === id);
      if (idx === -1) {
        await i.editReply(`❌ Schedule #${id} not found.`);
        return;
      }
      stopJob(id);
      const removed = SCHEDULES.splice(idx, 1)[0];
      saveSchedules();
      await i.editReply(`🗑️ Removed schedule #${id}: ${removed.cron} [${removed.tickers.join(", ")}]`);
      return;
    }
  } catch (e) {
    console.error("interaction error:", e?.message || e);
    try {
      await i.reply({ content: "Data provider error. Try again in 30–60s.", ephemeral: true });
    } catch {}
  }
});

// ---------- Startup ----------
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadSchedules();
  restartAllJobs();

  if (DEFAULT_CHANNEL_ID && !SCHEDULES.length) {
    const defaults = [
      { cron: "0 9 * * 1-5", tickers: ["SPY", "QQQ", "NVDA", "TSLA"], channelId: DEFAULT_CHANNEL_ID },
    ];
    for (const d of defaults) {
      const entry = { id: NEXT_ID++, ...d };
      SCHEDULES.push(entry);
      startJob(entry);
    }
    saveSchedules();
    console.log("Baseline schedules created.");
  }
});

// keep worker envs alive
setInterval(() => {}, 60 * 1000);

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

registerCommands()
  .catch((e) => console.warn("Command registration threw (continuing):", e?.message || e))
  .finally(() => {
    client.login(TOKEN)
      .then(() => console.log("Logged in OK"))
      .catch((e) => console.error("Login failed:", e?.message || e));
  });

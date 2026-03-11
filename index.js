import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
} from "discord.js";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
import cron from "node-cron";
import fs from "fs";

dayjs.extend(utc);
dayjs.extend(tz);

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "";
const POLY = process.env.POLYGON_KEY || "";
const TZSTR = process.env.TZ || "America/New_York";

if (!TOKEN || !CLIENT_ID) {
  console.error("❌ Missing DISCORD_TOKEN or DISCORD_CLIENT_ID");
  process.exit(1);
}
if (!POLY) {
  console.error("❌ Missing POLYGON_KEY");
  process.exit(1);
}

console.log("Boot (RollGPT Trading Assistant Lite)", {
  TZ: TZSTR,
  GUILD_ID: !!GUILD_ID,
  DEFAULT_CHANNEL_ID: !!DEFAULT_CHANNEL_ID,
  POLY: !!POLY,
});
console.log("POLYGON KEY PREFIX:", (process.env.POLYGON_KEY || "").slice(0, 8));

const http = axios.create({
  timeout: 12000,
  headers: { "User-Agent": "RollGPT/PolygonPrev/TradingAssistant/1.0" },
});

const nowET = () => dayjs().tz(TZSTR);
const ts = () => nowET().format("MMM D, h:mm A");
const fmt = (n, d = 2) => Number(n).toFixed(d);

const clean = (s) => (s == null ? "" : String(s).trim());
const normTicker = (s) => clean(s).toUpperCase().replace(/\$/g, "").replace(/\s+/g, "");
const isTicker = (s) => /^[A-Z][A-Z0-9.\-]{0,10}$/.test(normTicker(s));

function polygonErrorSummary(e) {
  return {
    status: e?.response?.status,
    data: e?.response?.data,
    message: e?.message || String(e),
  };
}

// ---------------- Polygon prev close ----------------
async function polygonPrevClose(ticker) {
  const t = normTicker(ticker);
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(t)}/prev`;

  try {
    const r = await http.get(url, {
      params: {
        adjusted: true,
        apiKey: POLY,
      },
    });

    const row = r?.data?.results?.[0];
    if (!row || !Number.isFinite(Number(row.c))) {
      throw new Error(`No prev close returned for ${t}`);
    }

    const close = Number(row.c);
    const open = Number(row.o ?? row.c);
    const high = Number(row.h ?? row.c);
    const low = Number(row.l ?? row.c);
    const vol = Number(row.v || 0);
    const chgPct = open ? ((close - open) / open) * 100 : 0;
    const rangePct = open ? ((high - low) / open) * 100 : 0;

    return {
      ticker: t,
      price: close,
      chgPct,
      open,
      high,
      low,
      vol,
      rangePct,
      source: "PolygonPrev",
    };
  } catch (e) {
    const info = polygonErrorSummary(e);
    throw Object.assign(new Error(`Polygon prev failed (${t})`), { _poly: info });
  }
}

async function getQuote(ticker) {
  return polygonPrevClose(ticker);
}

// ---------------- Trading assistant logic ----------------
function computeTradePlan(q) {
  const price = q.price;
  const high = q.high;
  const low = q.low;
  const open = q.open;
  const range = Math.max(0.01, high - low);
  const rangePct = q.rangePct;

  let mode = "Neutral / Range";
  if (price > open && price >= open + range * 0.35) mode = "Breakout Watch";
  else if (price < open && price <= open - range * 0.35) mode = "Weak / Fade Watch";
  else if (price > open) mode = "Pullback Long Watch";

  const entryLow = +(price - range * 0.08).toFixed(2);
  const entryHigh = +(price + range * 0.08).toFixed(2);

  const t1 = +(price + range * 0.35).toFixed(2);
  const t2 = +(price + range * 0.70).toFixed(2);
  const t3 = +(price + range * 1.05).toFixed(2);

  const sl = +(price - range * 0.35).toFixed(2);

  let risk = "Low";
  if (rangePct >= 2.25) risk = "High";
  else if (rangePct >= 1.1) risk = "Medium";

  const score =
    (q.chgPct * 1.8) +
    (rangePct * 1.5) +
    (Math.log10(Math.max(q.vol, 1)) - 6.5) * 2;

  return {
    mode,
    entryLow,
    entryHigh,
    t1,
    t2,
    t3,
    sl,
    risk,
    score,
  };
}

function buildAlertBlock(q) {
  const plan = computeTradePlan(q);
  const pct = `${q.chgPct >= 0 ? "+" : ""}${fmt(q.chgPct)}%`;

  return [
    `⚡ **$${q.ticker} ${fmt(q.price)} (${pct})**`,
    `🧭 Mode: **${plan.mode}**`,
    `🎯 Targets: **${fmt(plan.t1)} / ${fmt(plan.t2)} / ${fmt(plan.t3)}**`,
    `🚫 SL: **${fmt(plan.sl)}** | Entry: **${fmt(plan.entryLow)}–${fmt(plan.entryHigh)}**`,
    `⛔ Invalidate: lose entry support or hit SL`,
    `📊 Vol: **${q.vol.toLocaleString()}** | Risk: **${plan.risk}** | Source: **${q.source}** | ${ts()} ET`,
  ].join("\n");
}

function buildBiasFromQuotes(quotes) {
  const spy = quotes.find((q) => q.ticker === "SPY");
  const qqq = quotes.find((q) => q.ticker === "QQQ");

  const spyUp = spy ? spy.price > spy.open : false;
  const qqqUp = qqq ? qqq.price > qqq.open : false;

  let bias = "Mixed / Watch Open";
  let note = "Focus on clean confirmations, avoid forcing trades.";

  if (spyUp && qqqUp) {
    bias = "Bullish / Risk-On";
    note = "Leaders are above open. Focus on continuation names.";
  } else if (!spyUp && !qqqUp) {
    bias = "Bearish / Defensive";
    note = "Market pressure is weak. Focus on breakdowns or quick scalps only.";
  }

  return { bias, note };
}

function buildWatchlistPost(quotes) {
  const valid = quotes
    .map((q) => ({ q, plan: computeTradePlan(q) }))
    .sort((a, b) => b.plan.score - a.plan.score);

  const { bias, note } = buildBiasFromQuotes(quotes);
  const top = valid.slice(0, 4);
  const best = top[0];

  const lines = [];
  lines.push(`🚨 **RollGPT Morning Plan — ${ts()} ET**`);
  lines.push("");
  lines.push(`📌 **Market Bias:** ${bias}`);
  lines.push(`• ${note}`);
  lines.push("");

  lines.push(`🔥 **Priority Watchlist**`);
  top.forEach((item, idx) => {
    const q = item.q;
    const p = item.plan;
    const pct = `${q.chgPct >= 0 ? "+" : ""}${fmt(q.chgPct)}%`;

    lines.push(
      `${idx + 1}. **${q.ticker}** — ${p.mode} | ${pct}`
    );
    lines.push(`• Entry: **${fmt(p.entryLow)}–${fmt(p.entryHigh)}**`);
    lines.push(`• Targets: **${fmt(p.t1)} / ${fmt(p.t2)} / ${fmt(p.t3)}**`);
    lines.push(`• SL: **${fmt(p.sl)}** | Risk: **${p.risk}**`);
  });

  if (best) {
    lines.push("");
    lines.push(`⭐ **Best Setup:** ${best.q.ticker}`);
    lines.push(`⚠️ **Risk Note:** Wait for confirmation. Don’t chase the first candle.`);
  }

  return lines.join("\n");
}

// ---------------- Schedules ----------------
const SFILE = "schedules.json";
let SCHEDULES = [];
const JOBS = new Map();
let NEXT_ID = 1;

const DEFAULT_BUILTIN = {
  cron: "0 9 * * 1,3,5",
  tickers: ["SPY", "QQQ", "NVDA", "TSLA"],
};

function loadSchedules() {
  try {
    if (!fs.existsSync(SFILE)) return;
    const raw = fs.readFileSync(SFILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      SCHEDULES = data;
      NEXT_ID = (Math.max(0, ...SCHEDULES.map((x) => x.id || 0)) + 1) || 1;
      console.log("Loaded schedules:", SCHEDULES.length);
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
  if (!cron.validate(entry.cron)) {
    console.error("Invalid cron, skip id", entry.id, entry.cron);
    return;
  }

  const job = cron.schedule(
    entry.cron,
    async () => {
      try {
        await postWatchlist(entry.tickers, entry.channelId);
      } catch (e) {
        console.error("Scheduled post error:", e?.message || e);
      }
    },
    { timezone: TZSTR }
  );

  JOBS.set(entry.id, job);
}

function stopJob(id) {
  const job = JOBS.get(id);
  if (job) {
    job.stop();
    JOBS.delete(id);
  }
}

function restartAllJobs() {
  for (const [, job] of JOBS) job.stop();
  JOBS.clear();
  for (const e of SCHEDULES) startJob(e);
}

function ensureDefaultSchedule() {
  if (!DEFAULT_CHANNEL_ID) return;

  const alreadyExists = SCHEDULES.some(
    (e) =>
      e.cron === DEFAULT_BUILTIN.cron &&
      Array.isArray(e.tickers) &&
      e.tickers.join(",") === DEFAULT_BUILTIN.tickers.join(",") &&
      e.channelId === DEFAULT_CHANNEL_ID
  );

  if (alreadyExists) {
    console.log("Default schedule already exists.");
    return;
  }

  const entry = {
    id: NEXT_ID++,
    cron: DEFAULT_BUILTIN.cron,
    tickers: DEFAULT_BUILTIN.tickers,
    channelId: DEFAULT_CHANNEL_ID,
  };

  SCHEDULES.push(entry);
  saveSchedules();
  startJob(entry);
  console.log("Default M/W/F 9:00 AM watchlist schedule created.");
}

// ---------------- Discord ----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function postAlert(tickers, channelId) {
  const ch = await client.channels.fetch(channelId);
  const list = (tickers || []).map(normTicker).filter(isTicker).slice(0, 4);

  const blocks = [];
  for (const t of list) {
    try {
      const q = await getQuote(t);
      blocks.push(buildAlertBlock(q));
    } catch (e) {
      const poly = e?._poly;
      const extra = poly?.status ? ` (status ${poly.status})` : "";
      blocks.push(`⚠️ **$${t}** — Polygon failed${extra}. Check Railway logs.`);
    }
  }

  await ch.send(blocks.join("\n\n"));
}

async function postWatchlist(tickers, channelId) {
  const ch = await client.channels.fetch(channelId);
  const list = (tickers || []).map(normTicker).filter(isTicker).slice(0, 4);

  const quotes = [];
  const errors = [];

  for (const t of list) {
    try {
      const q = await getQuote(t);
      quotes.push(q);
    } catch (e) {
      const poly = e?._poly;
      const extra = poly?.status ? ` (status ${poly.status})` : "";
      errors.push(`⚠️ **$${t}** — Polygon failed${extra}.`);
    }
  }

  if (!quotes.length) {
    await ch.send(errors.join("\n") || "⚠️ Watchlist failed. Check Railway logs.");
    return;
  }

  const post = buildWatchlistPost(quotes);
  await ch.send(post);

  if (errors.length) {
    await ch.send(errors.join("\n"));
  }
}

// ---------------- Commands ----------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("alert")
      .setDescription("Run a Chart Assassin-style quick scan")
      .addStringOption((o) =>
        o.setName("text").setDescription("e.g. SPY or SPY QQQ NVDA TSLA").setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("watchlist")
      .setDescription("Post the morning-plan style watchlist")
      .addStringOption((o) =>
        o.setName("text").setDescription("e.g. SPY QQQ NVDA TSLA").setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("health")
      .setDescription("Health check (Polygon prev)"),

    new SlashCommandBuilder()
      .setName("schedule_add")
      .setDescription("Add a schedule")
      .addStringOption((o) =>
        o.setName("cron").setDescription("Cron example: 0 9 * * 1,3,5").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("tickers").setDescription("Tickers, max 4").setRequired(true)
      )
      .addChannelOption((o) =>
        o.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText).setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName("schedule_list")
      .setDescription("List schedules"),

    new SlashCommandBuilder()
      .setName("schedule_remove")
      .setDescription("Remove schedule by ID")
      .addIntegerOption((o) => o.setName("id").setDescription("Schedule ID").setRequired(true)),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  if (GUILD_ID) {
    console.log("Registering GUILD commands for", GUILD_ID);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("GUILD commands registered.");
  } else {
    console.log("Registering GLOBAL commands…");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("GLOBAL commands registered.");
  }
}

// ---------------- Interaction handlers ----------------
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === "alert") {
      await i.deferReply({ ephemeral: false });

      const text = clean(i.options.getString("text") || "SPY QQQ NVDA TSLA");
      const parts = text
        .replace(/[“”‘’"]/g, "")
        .replace(/\$/g, "")
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/)
        .filter(Boolean);

      const tickers = [...new Set(parts.filter(isTicker))].slice(0, 4);
      const list = tickers.length ? tickers : ["SPY", "QQQ", "NVDA", "TSLA"];

      const lines = [];
      for (const t of list) {
        try {
          const q = await getQuote(t);
          lines.push(buildAlertBlock(q));
        } catch (e) {
          const poly = e?._poly;
          const extra = poly?.status ? ` (status ${poly.status})` : "";
          lines.push(`⚠️ **$${t}** — Polygon failed${extra}.`);
        }
      }

      await i.editReply(lines.join("\n\n"));
      return;
    }

    if (i.commandName === "watchlist") {
      await i.deferReply({ ephemeral: false });

      const text = clean(i.options.getString("text") || "SPY QQQ NVDA TSLA");
      const parts = text
        .replace(/[“”‘’"]/g, "")
        .replace(/\$/g, "")
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/)
        .filter(Boolean);

      const tickers = [...new Set(parts.filter(isTicker))].slice(0, 4);
      const list = tickers.length ? tickers : ["SPY", "QQQ", "NVDA", "TSLA"];

      const quotes = [];
      const errors = [];

      for (const t of list) {
        try {
          const q = await getQuote(t);
          quotes.push(q);
        } catch (e) {
          const poly = e?._poly;
          const extra = poly?.status ? ` (status ${poly.status})` : "";
          errors.push(`⚠️ **$${t}** — Polygon failed${extra}.`);
        }
      }

      if (!quotes.length) {
        await i.editReply(errors.join("\n") || "⚠️ Watchlist failed.");
        return;
      }

      let reply = buildWatchlistPost(quotes);
      if (errors.length) reply += `\n\n${errors.join("\n")}`;

      await i.editReply(reply);
      return;
    }

    if (i.commandName === "health") {
      await i.deferReply({ ephemeral: false });

      try {
        const q = await getQuote("SPY");
        await i.editReply(
          `HEALTH ✅ — ${ts()} ET\nPolygon: OK — SPY ${fmt(q.price)} (${fmt(q.chgPct)}%)`
        );
      } catch (e) {
        const poly = e?._poly;
        await i.editReply(
          `HEALTH ⚠️ — ${ts()} ET\nPolygon failed${poly?.status ? ` (status ${poly.status})` : ""}\nCheck Railway logs.`
        );
      }
      return;
    }

    if (i.commandName === "schedule_add") {
      await i.deferReply({ ephemeral: true });

      const cronStr = i.options.getString("cron");
      const tickStr = clean(i.options.getString("tickers"));
      const chOpt = i.options.getChannel("channel");
      const channelId = chOpt?.id || DEFAULT_CHANNEL_ID || i.channelId;

      if (!cron.validate(cronStr)) {
        await i.editReply(`❌ Invalid cron: ${cronStr}\nExample: 0 9 * * 1,3,5`);
        return;
      }

      const rawTickers = tickStr
        .replace(/[“”‘’"]/g, "")
        .replace(/\$/g, "")
        .toUpperCase()
        .split(/[^A-Z0-9.\-]+/)
        .filter(Boolean)
        .map(normTicker);

      const tickers = [...new Set(rawTickers.filter(isTicker))].slice(0, 4);
      if (!tickers.length) {
        await i.editReply("❌ No valid tickers. Example: SPY QQQ NVDA TSLA");
        return;
      }

      const entry = { id: NEXT_ID++, cron: cronStr, tickers, channelId };
      SCHEDULES.push(entry);
      saveSchedules();
      startJob(entry);

      await i.editReply(
        `✅ Added schedule #${entry.id}\n• ${entry.cron}\n• ${entry.tickers.join(", ")}\n• <#${entry.channelId}>`
      );
      return;
    }

    if (i.commandName === "schedule_list") {
      await i.deferReply({ ephemeral: true });

      if (!SCHEDULES.length) {
        await i.editReply("No schedules yet.");
        return;
      }

      await i.editReply(
        SCHEDULES.map((e) => `#${e.id} — ${e.cron} → [${e.tickers.join(", ")}] → <#${e.channelId}>`).join("\n")
      );
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
      await i.reply({ content: "Error. Check Railway logs.", ephemeral: true });
    } catch {}
  }
});

// ---------------- Startup ----------------
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  loadSchedules();
  restartAllJobs();
  ensureDefaultSchedule();
});

process.on("uncaughtException", (err) => console.error("Uncaught:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

await registerCommands().catch((e) => {
  console.error("Command registration failed:", e?.message || e);
});

client.login(TOKEN).then(() => console.log("Logged in OK")).catch((e) => {
  console.error("Login failed:", e?.message || e);
});

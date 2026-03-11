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

console.log("Boot (Polygon Prev)", {
  TZ: TZSTR,
  GUILD_ID: !!GUILD_ID,
  DEFAULT_CHANNEL_ID: !!DEFAULT_CHANNEL_ID,
  POLY: !!POLY,
});
console.log("POLYGON KEY PREFIX:", (process.env.POLYGON_KEY || "").slice(0, 8));

const http = axios.create({
  timeout: 12000,
  headers: { "User-Agent": "RollGPT/PolygonPrev/1.0" },
});

const ts = () => dayjs().tz(TZSTR).format("MMM D, HH:mm z");
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

// Uses the endpoint you already proved works in browser
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

    return {
      ticker: t,
      price: close,
      chgPct,
      open,
      high,
      low,
      vol,
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

// ---------------- Schedules ----------------
const SFILE = "schedules.json";
let SCHEDULES = [];
const JOBS = new Map();
let NEXT_ID = 1;

// default built-in schedule
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
        await postAlert(entry.tickers, entry.channelId);
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
  console.log("Default M/W/F 9:00 AM schedule created.");
}

// ---------------- Discord ----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function buildLinesFromQuote(q) {
  const pct = (q.chgPct >= 0 ? "+" : "") + fmt(q.chgPct) + "%";
  return [
    `⚡ **$${q.ticker}** — ${fmt(q.price)} (${pct})`,
    `• Open: ${fmt(q.open)} | High: ${fmt(q.high)} | Low: ${fmt(q.low)}`,
    `• Volume: ${q.vol.toLocaleString()}`,
    `• Source: ${q.source} | ${ts()}`,
  ].join("\n");
}

async function postAlert(tickers, channelId) {
  const ch = await client.channels.fetch(channelId);
  const list = (tickers || []).map(normTicker).filter(isTicker).slice(0, 4);

  const blocks = [];
  for (const t of list) {
    try {
      const q = await getQuote(t);
      blocks.push(buildLinesFromQuote(q));
    } catch (e) {
      const poly = e?._poly;
      const extra = poly?.status ? ` (status ${poly.status})` : "";
      blocks.push(`⚠️ **$${t}** — Polygon failed${extra}. Check Railway logs.`);
    }
  }

  await ch.send(blocks.join("\n\n"));
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("alert")
      .setDescription("Run a quick scan")
      .addStringOption((o) =>
        o.setName("text").setDescription("e.g. SPY or SPY QQQ NVDA TSLA").setRequired(false)
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
          lines.push(buildLinesFromQuote(q));
        } catch (e) {
          const poly = e?._poly;
          const extra = poly?.status ? ` (status ${poly.status})` : "";
          lines.push(`⚠️ **$${t}** — Polygon failed${extra}.`);
        }
      }

      await i.editReply(lines.join("\n\n"));
      return;
    }

    if (i.commandName === "health") {
      await i.deferReply({ ephemeral: false });

      try {
        const q = await getQuote("SPY");
        await i.editReply(
          `HEALTH ✅ — ${ts()}\nPolygon: OK — SPY ${fmt(q.price)} (${fmt(q.chgPct)}%)`
        );
      } catch (e) {
        const poly = e?._poly;
        await i.editReply(
          `HEALTH ⚠️ — ${ts()}\nPolygon failed${poly?.status ? ` (status ${poly.status})` : ""}\nCheck Railway logs.`
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

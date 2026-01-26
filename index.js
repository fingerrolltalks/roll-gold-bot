// ================= CHART ASSASSIN BOT (STABLE YAHOO v3) =================
// One-file safe build — fixes Yahoo breaking changes + Discord timeouts
// ======================================================================

import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import yahooFinance from 'yahoo-finance2';
import axios from 'axios';
import dayjs from 'dayjs';

// ---------------- ENV ----------------
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || null;
const DEFAULT_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || null;
const TZ = process.env.TZ || 'America/New_York';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID');
  process.exit(1);
}

console.log('Boot v3.13', {
  TZ,
  GUILD_ID: !!GUILD_ID,
  DEFAULT_CHANNEL_ID: !!DEFAULT_CHANNEL_ID
});

// ---------------- YAHOO HARD PATCH ----------------
yahooFinance.suppressNotices?.(['yahooSurvey']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let YF_LAST = 0;

async function yfSafe(fn, minGap = 900, timeout = 12000) {
  const wait = Math.max(0, (YF_LAST + minGap) - Date.now());
  if (wait) await sleep(wait);
  YF_LAST = Date.now();

  return Promise.race([
    fn(),
    new Promise((_, rej) => setTimeout(() =>
      rej(new Error('Yahoo blocked / rate-limited')), timeout))
  ]);
}

// ---------------- DISCORD ----------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------- HELPERS ----------------
const fmt = (n, d = 2) => Number(n).toFixed(d);
const ts = () => dayjs().format('MMM D, HH:mm');

// ---------------- QUOTES ----------------
async function getQuote(ticker) {
  const q = await yfSafe(() => yahooFinance.quote(ticker));
  const price =
    q?.regularMarketPrice ??
    q?.postMarketPrice ??
    q?.preMarketPrice;

  if (price == null) throw new Error('No price');

  return {
    price: Number(price),
    chg: Number(q?.regularMarketChangePercent ?? 0),
    vol: Number(q?.regularMarketVolume ?? 0)
  };
}

// ---------------- LOW CAP SCAN ----------------
const LOWCAPS = [
  'SNTG','RNXT','KULR','HOLO','TOP','COSM','GROM','SIDU','NVOS','CEI','AITX'
];

async function scanLowcaps() {
  const out = [];
  for (const t of LOWCAPS) {
    try {
      const q = await getQuote(t);
      if (q.price < 0.5 || q.price > 7) continue;
      if (q.vol < 200_000) continue;
      out.push({ t, ...q });
    } catch {}
  }
  return out.slice(0, 4);
}

// ---------------- COMMANDS ----------------
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder()
      .setName('alert')
      .setDescription('Quick price + bias')
      .addStringOption(o =>
        o.setName('ticker').setDescription('Ticker').setRequired(true)),

    new SlashCommandBuilder()
      .setName('scan_lowcap')
      .setDescription('Low-cap momentum scan'),

    new SlashCommandBuilder()
      .setName('health')
      .setDescription('Bot health check')
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: cmds }
    );
  } else {
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: cmds }
    );
  }
}

// ---------------- INTERACTIONS ----------------
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    await i.deferReply();

    if (i.commandName === 'alert') {
      const t = i.options.getString('ticker').toUpperCase();
      const q = await getQuote(t);

      await i.editReply(
        `⚡ **$${t}** ${fmt(q.price)} (${q.chg >= 0 ? '+' : ''}${fmt(q.chg)}%)\nVol: ${fmt(q.vol/1e6,2)}M`
      );
    }

    if (i.commandName === 'scan_lowcap') {
      const res = await scanLowcaps();
      if (!res.length) {
        await i.editReply('No low-cap momentum right now.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('Low-Cap Scanner')
        .setColor(0x00d084)
        .setFooter({ text: ts() });

      for (const r of res) {
        embed.addFields({
          name: `$${r.t}`,
          value: `${fmt(r.price)} (${r.chg>=0?'+':''}${fmt(r.chg)}%) | Vol ${fmt(r.vol/1e6,2)}M`,
          inline: true
        });
      }

      await i.editReply({ embeds: [embed] });
    }

    if (i.commandName === 'health') {
      await i.editReply(`✅ Alive — ${ts()}`);
    }

  } catch (e) {
    console.error('interaction error:', e.message);
    try {
      await i.editReply('❌ Data provider error. Try again in 30–60s.');
    } catch {}
  }
});

// ---------------- START ----------------
(async () => {
  await registerCommands();
  await client.login(TOKEN);
  console.log('Logged in OK');
})();

setInterval(() => {}, 60 * 1000);

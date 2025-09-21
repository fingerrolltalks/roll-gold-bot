import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import cron from 'node-cron';
import fetch from 'node-fetch';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const TZ = process.env.TZ || "America/New_York";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// -------- Slash Commands --------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('alert')
      .setDescription('Get AI-powered trade alerts')
      .addStringOption(opt => opt.setName('text').setDescription('Tickers, e.g. NVDA, AAPL').setRequired(true)),

    new SlashCommandBuilder()
      .setName('deep')
      .setDescription('Deep dive on a ticker')
      .addStringOption(opt => opt.setName('ticker').setDescription('Ticker symbol').setRequired(true)),

    new SlashCommandBuilder()
      .setName('scalp')
      .setDescription('Scalp setup for a symbol')
      .addStringOption(opt => opt.setName('symbol').setDescription('Symbol').setRequired(true)),

    new SlashCommandBuilder()
      .setName('health')
      .setDescription('Check bot health/status'),

    new SlashCommandBuilder()
      .setName('schedule_add')
      .setDescription('Add an auto-post schedule')
      .addStringOption(opt => opt.setName('cron').setDescription('Cron syntax').setRequired(true))
      .addStringOption(opt => opt.setName('tickers').setDescription('Comma-separated tickers').setRequired(true))
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Commands registered");
}

// -------- Handlers --------
client.on('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'alert') {
    const text = i.options.getString('text');
    await i.reply(`⚡ Alert requested for: ${text}`);
  }

  if (i.commandName === 'deep') {
    const ticker = i.options.getString('ticker');
    await i.reply(`📚 Deep dive on: ${ticker}`);
  }

  if (i.commandName === 'scalp') {
    const symbol = i.options.getString('symbol');
    await i.reply(`⚡ Scalp setup for: ${symbol}`);
  }

  if (i.commandName === 'health') {
    await i.reply(`HEALTH ✅ — ${new Date().toLocaleString("en-US", { timeZone: TZ })}`);
  }

  if (i.commandName === 'schedule_add') {
    const cronExp = i.options.getString('cron');
    const tickers = i.options.getString('tickers');
    try {
      cron.schedule(cronExp, async () => {
        const channel = await client.channels.fetch(CHANNEL_ID);
        channel.send(`⏰ Auto alert for: ${tickers}`);
      }, { timezone: TZ });
      await i.reply(`✅ Added schedule\n• Cron: ${cronExp}\n• Tickers: ${tickers}\n• Channel: <#${CHANNEL_ID}>`);
    } catch (err) {
      console.error("Cron error:", err);
      await i.reply(`❌ Invalid cron: ${cronExp}`);
    }
  }
});

// -------- Startup --------
(async () => {
  await registerCommands();
  client.login(TOKEN);
})();

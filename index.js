// ---------- Low-Cap Scanner -----------------------------------------------
import cron from 'node-cron';
import { SlashCommandBuilder, ChannelType } from 'discord.js';

// Universe of low-cap tickers to scan
const LOW_UNIVERSE = [
  'GROM','COSM','CEI','SNTG','HILS','ATHE','RNXT','SNOA','VERB','TTOO','BBIG','SOUN',
  'HUT','CLSK','MARA','RIOT','TLRY','FFIE','NVOS','BEAT','TOP','HOLO','PXMD','BNED',
  'KULR','OTRK','NAOV','AGRX','AMC','GME','CVNA'
];
const LOW_PRICE_MIN = 0.5;
const LOW_PRICE_MAX = 7;
const LOW_TOP_N     = 6;

// Helpers
function fmtK(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e9) return (n/1e9).toFixed(2)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(n|0);
}

async function scanLowCaps() {
  const out = [];
  for (const t of LOW_UNIVERSE) {
    try {
      const q = await getQuote(t);
      const price = Number(q.price);
      const vol   = q?.raw?.preMarketVolume ?? q?.raw?.regularMarketVolume ?? 0;
      if (!Number.isFinite(price) || price < LOW_PRICE_MIN || price > LOW_PRICE_MAX) continue;
      out.push({ t, price, vol, chg: q.chg });
    } catch {}
  }
  out.sort((a,b) => (b.vol - a.vol) || (b.chg - a.chg));
  return out.slice(0, LOW_TOP_N);
}

async function postLowcapScan(channelId) {
  try {
    const picks = await scanLowCaps();
    const ch = await client.channels.fetch(channelId);
    if (!picks.length) {
      await ch.send(`📉 Low-cap scan: none in $${LOW_PRICE_MIN}–$${LOW_PRICE_MAX} range right now.`);
      return;
    }
    const lines = [];
    lines.push(`🧪 **Low-Cap Scanner** — Top ${LOW_TOP_N} by volume ($${LOW_PRICE_MIN}–$${LOW_PRICE_MAX}) — ${ts()}`);
    for (const p of picks) {
      const dir = p.chg >= 0 ? '🟢' : '🔴';
      lines.push(`• $${p.t} ${dir} ${p.price.toFixed(2)} (${p.chg >= 0 ? '+' : ''}${p.chg.toFixed(2)}%) — Vol ${fmtK(p.vol)}`);
    }
    lines.push('⛔ Use risk: low-caps are volatile. Not financial advice.');
    await ch.send(lines.join('\n'));
  } catch (e) {
    console.error('Lowcap scan error:', e?.message || e);
  }
}

// Register new slash command
commands.push(
  new SlashCommandBuilder()
    .setName('lowscan')
    .setDescription('Scan low-caps ($0.50–$7) by highest (pre)market volume')
    .addChannelOption(o =>
      o.setName('channel')
       .setDescription('Where to post (defaults to current channel)')
       .addChannelTypes(ChannelType.GuildText)
       .setRequired(false)
    )
    .toJSON()
);

// Interaction handler
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === 'lowscan') {
    await i.deferReply({ ephemeral: true });
    const chOpt = i.options.getChannel('channel');
    const channelId = chOpt?.id || i.channelId;
    await postLowcapScan(channelId);
    await i.editReply(`✅ Low-cap scan posted to <#${channelId}>`);
  }
});

// Auto jobs @ 7:00 & 8:00 Mon–Fri
if (process.env.DISCORD_CHANNEL_ID) {
  cron.schedule('0 7 * * 1-5', () => postLowcapScan(process.env.DISCORD_CHANNEL_ID), { timezone: TZ });
  cron.schedule('0 8 * * 1-5', () => postLowcapScan(process.env.DISCORD_CHANNEL_ID), { timezone: TZ });
  console.log('Lowcap auto scans scheduled (Mon–Fri @ 7:00 & 8:00 NY).');
}
// register & login
registerCommands()
  .catch(e => console.warn('Command registration threw (continuing):', e?.message || e))
  .finally(() => { client.login(TOKEN).then(() => console.log('Logged in OK')).catch(e => console.error('Login failed:', e?.message || e)); });

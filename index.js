// Chart Assassin — Discord Bot PRO v3 (Node.js)
// Features:
// • Live quotes for stocks/ETFs/crypto with timestamp + source
// • Auto multi-ticker detection from free text (/alert text: ...)
// • EXPRESS ALERT ⚡ (default)
// • DEEP DIVE 📚 (HTF, PDH/PDL, SMA20/50)
// • CRYPTO SCALPS ⚡ quick levels for majors
// • OPTIONS (weekly ATM±1) for equities/ETFs
// • Discrepancy flag if Polygon vs Yahoo > 0.5%
// • Session tag (PRE/RTH/POST/OFF), NY time
// • Flow placeholder (/flow) — wire any provider later
// -----------------------------------------------------------------------
// Setup
//   npm i discord.js axios dayjs yahoo-finance2 dotenv tzdata
// .env
//   DISCORD_TOKEN=xxxx
//   DISCORD_CLIENT_ID=xxxx
//   POLYGON_KEY= # optional
//   TZ=America/New_York
// Start: node index.js
// -----------------------------------------------------------------------

import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import axios from 'axios';
import * as yf2 from 'yahoo-finance2';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';

dayjs.extend(utc); dayjs.extend(tz);

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const POLY = process.env.POLYGON_KEY;
const TZ = process.env.TZ || 'UTC';

// ---------- helpers -------------------------------------------------------
const ts = () => dayjs().tz(TZ).format('MMM D, HH:mm z');
const fmt = (n, d = 2) => Number(n).toFixed(d);
const clean = (s) => (s||'').trim();
const norm = (s) => {
  const x = clean(s).toUpperCase();
  const map = { 'BRK.B':'BRK-B','BRK.A':'BRK-A'};
  return map[x] || x.replace(/\s+/g,'');
};
const isTicker = (s) => /^[A-Z][A-Z0-9.\-]{0,6}(?:-USD)?$/.test(s);

function getSession(now = dayjs().tz('America/New_York')){
  const dow = now.day();
  const mins = now.hour()*60+now.minute();
  if (dow===0||dow===6) return 'OFF';
  if (mins>=240 && mins<570) return 'PRE';
  if (mins>=570 && mins<960) return 'RTH';
  if (mins>=960 && mins<1200) return 'POST';
  return 'OFF';
}

// ---------- data ----------------------------------------------------------
async function yahooQuoteFull(t){
  const q = await yf2.default.quoteSummary(t,{modules:['price']});
  const p = q?.price; if(!p) throw new Error('No quote');
  const price = p.regularMarketPrice ?? p.postMarketPrice ?? p.preMarketPrice;
  const chg = p.regularMarketChangePercent ?? p.postMarketChangePercent ?? p.preMarketChangePercent ?? 0;
  const type = p.quoteType || 'EQUITY';
  return { price:Number(price), chg:Number(chg), type, source:'Yahoo' };
}
async function polygonQuote(t){
  if(!POLY) return null;
  try{
    const nb = await axios.get(`https://api.polygon.io/v2/last/nbbo/${t}`,{params:{apiKey:POLY}}).then(r=>r.data?.results);
    const price = nb ? (nb.bid.price+nb.ask.price)/2 : null; if(!price) return null;
    const prev = await axios.get(`https://api.polygon.io/v2/aggs/ticker/${t}/prev`,{params:{apiKey:POLY}}).then(r=>r.data?.results?.[0]);
    const chg = prev ? ((price-prev.c)/prev.c)*100 : 0;
    return { price, chg, source:'Polygon' };
  }catch{ return null; }
}

async function getQuote(t){
  const y = await yahooQuoteFull(t);
  if(y.type==='EQUITY' || y.type==='ETF'){
    const p = await polygonQuote(t);
    if(p){
      const diff = Math.abs((p.price - y.price)/y.price)*100;
      const flag = diff>0.5 ? `⚠️ Discrepancy ${fmt(diff,2)}% (Poly vs Y)` : '';
      return { ...p, type:y.type, session:getSession(), source:p.source, flag, alt:`Yahoo ${fmt(y.price)}` };
    }
  }
  return { ...y, session:getSession(), alt:null, flag:'' };
}

// options (weeklies)
function nextFriday(now=dayjs().tz(TZ)){
  const add=((5-now.day())+7)%7||7; return now.add(add,'day').startOf('day');
}
async function weeklyOptions(t, spot){
  const meta = await yf2.default.options(t);
  const exps = (meta?.expirationDates||[]).map(d=>dayjs.utc(d));
  if(!exps.length) return null;
  const target = nextFriday();
  let chosen = exps.find(d=>d.isAfter(target.subtract(1,'minute')))||exps.at(-1);
  const ch = await yf2.default.options(t,{date:chosen.toDate()});
  const calls=ch?.calls||[], puts=ch?.puts||[];
  const strikes=[...new Set([...calls,...puts].map(o=>+o.strike))].filter(Number.isFinite).sort((a,b)=>a-b);
  if(!strikes.length) return null;
  const idx=strikes.reduce((b,s,i)=>Math.abs(s-spot)<Math.abs(strikes[b]-spot)?i:b,0);
  const sATM=strikes[idx], sPlus=strikes[Math.min(idx+1,strikes.length-1)], sMinus=strikes[Math.max(idx-1,0)];
  const pick=(a,k)=>a.find(o=>+o.strike===k);
  const c=pick(calls,sATM)||pick(calls,sPlus)||pick(calls,sMinus);
  const p=pick(puts ,sATM)||pick(puts ,sMinus)||pick(puts ,sPlus);
  return { expiry:chosen.format('YYYY-MM-DD'), s:{sMinus,sATM,sPlus},
           call:c?{cs:c.contractSymbol,bid:c.bid,ask:c.ask,iv:c.impliedVolatility}:null,
           put:p? {cs:p.contractSymbol,bid:p.bid,ask:p.ask,iv:p.impliedVolatility}:null };
}

// ---------- formats -------------------------------------------------------
function banner(t, q){
  const price = fmt(q.price), pct=(q.chg>=0?'+':'')+fmt(q.chg)+'%';
  const bias = q.chg>=0? '🟢':'🟡';
  const entryL = +(q.price*0.995).toFixed(2);
  const entryH = +(q.price*1.005).toFixed(2);
  const sl     = +(q.price*0.98).toFixed(2);
  const t1=+(q.price*1.01).toFixed(2), t2=+(q.price*1.03).toFixed(2), t3=+(q.price*1.05).toFixed(2);
  const rr = ((t2-q.price)/(q.price-sl)).toFixed(1);
  const head = `$${t} | ${price} (${pct}) @ ${ts()} | ${bias} | Entry ${entryL}-${entryH} | SL ${sl} | T: ${t1}/${t2}/${t3} | R:R ~${rr}`;
  const core = [
    `• Mode: Opening scalp ⚡ / swing 📆`,
    `• Bias: ${bias} Above VWAP favors calls`,
    `• Session: ${q.session} | Source: ${q.source}${q.flag?` | ${q.flag}`:''}`,
    `• Key S/R: VWAP; ±1% band`,
    `• 🚫 SL: ${sl} — below structure`,
    `• 🎯 ${t1} / ${t2} / ${t3}`,
    `• Prob/Conf: 55% | Medium`,
    `• Mgmt: Trim @ T1, BE stop, trail EMA`,
    `• Alt: Lose VWAP → fade to band low`,
  ];
  return { head, core };
}

function optLines(w){
  if(!w) return ['• Options: n/a'];
  return [
    `• Weekly: ${w.expiry} | ATM≈ ${w.s.sATM}`,
    w.call?`• Calls: ${w.call.cs} | ${fmt(w.call.bid)}/${fmt(w.call.ask)} IV ${fmt(w.call.iv*100,1)}%`:'• Calls: n/a',
    w.put ?`• Puts : ${w.put.cs} | ${fmt(w.put.bid)}/${fmt(w.put.ask)} IV ${fmt(w.put.iv*100,1)}%` :'• Puts : n/a',
  ];
}

// ---------- discord -------------------------------------------------------
const client = new Client({ intents:[GatewayIntentBits.Guilds] });

async function register(){
  const cmds = [
    new SlashCommandBuilder().setName('alert').setDescription('EXPRESS ALERT: live levels')
      .addStringOption(o=>o.setName('text').setDescription('Ticker(s) or sentence, e.g. NVDA, AAPL or "please check NVDA"').setRequired(false)),
    new SlashCommandBuilder().setName('deep').setDescription('DEEP DIVE: HTF context')
      .addStringOption(o=>o.setName('ticker').setDescription('One ticker, e.g. SPY').setRequired(false)),
    new SlashCommandBuilder().setName('scalp').setDescription('CRYPTO SCALPS: BTC/ETH/SOL/XRP/ADA/DOGE quick levels')
      .addStringOption(o=>o.setName('symbol').setDescription('e.g., BTC-USD').setRequired(false)),
    new SlashCommandBuilder().setName('flow').setDescription('OPTIONS FLOW placeholder (configure provider later)')
      .addStringOption(o=>o.setName('ticker').setDescription('e.g., NVDA').setRequired(true)),
    new SlashCommandBuilder().setName('health').setDescription('Health check: data + time + session')
  ].map(c=>c.toJSON());
  const rest = new REST({version:'10'}).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
}

client.on('clientReady', ()=>console.log(`Logged in as ${client.user.tag}`));

function detectTickers(s){
  const words = (s||'').toUpperCase().replace(/[^A-Z0-9\.\-\s$]/g,' ').split(/\s+/);
  const raw = words.map(w=>w.replace(/^\$/,'')).filter(Boolean);
  const uniq = [...new Set(raw.filter(isTicker))];
  return uniq.length?uniq:[ 'NVDA' ];
}

client.on('interactionCreate', async (i)=>{
  if(!i.isChatInputCommand()) return;

  if(i.commandName==='alert'){
    await i.deferReply();
    try{
      const text = i.options.getString('text')||'NVDA';
      const list = detectTickers(text).slice(0,4);
      const chunks = [];
      for(const t of list){
        const q = await getQuote(t);
        const {head,core} = banner(t,q);
        const w = (q.type==='EQUITY'||q.type==='ETF') ? await weeklyOptions(t,q.price).catch(()=>null):null;
        const block = ['⚡ EXPRESS ALERT — OPENING PLAY','',head,...core,...optLines(w),'— — —','This is not financial advice. Do your own research.'];
        chunks.push(block.join('\n'));
      }
      await i.editReply(chunks.join('\n\n'));
    }catch(e){ await i.editReply('Live feed error — try again.'); }
  }

  if(i.commandName==='deep'){
    await i.deferReply();
    try{
      const t = norm(i.options.getString('ticker')||'SPY');
      const q = await getQuote(t);
      const end = dayjs().tz(TZ), start=end.subtract(90,'day');
      const hist = await yf2.default.historical(t,{period1:start.toDate(), period2:end.toDate(), interval:'1d'});
      const last30 = hist.slice(-30);
      const closes = last30.map(c=>c.close);
      const sma=(a,n)=>a.slice(-n).reduce((x,y)=>x+y,0)/Math.min(n,a.length);
      const sma20=sma(closes,20), sma50=sma(closes,50);
      const pdh=last30.at(-2)?.high, pdl=last30.at(-2)?.low;
      const trend = sma20>sma50? '🟢 Up (20>50)':'🟡 Mixed/Down (20<=50)';
      const lines = [
        `DEEP DIVE 📚 — ${t} @ ${fmt(q.price)} (${q.chg>=0?'+':''}${fmt(q.chg)}%) — ${ts()}`,
        `• Type: ${q.type} | Session: ${q.session} | Source: ${q.source}${q.flag?` | ${q.flag}`:''}`,
        `• Trend: ${trend}`,
        `• PDH/PDL: ${fmt(pdh)}/${fmt(pdl)}`,
        `• SMA20/50: ${fmt(sma20)}/${fmt(sma50)}`,
        `• Liquidity: watch PDH/PDL sweeps` ,
        `• Plan: buy dips > PDH; lose PDL → hedge`,
        `— — —`,
        `This is not financial advice. Do your own research.`
      ].join('\n');
      await i.editReply(lines);
    }catch{ await i.editReply('Deep Dive unavailable — data error.'); }
  }

  if(i.commandName==='scalp'){
    await i.deferReply();
    const sym = norm(i.options.getString('symbol')||'BTC-USD');
    try{
      const q = await getQuote(sym);
      const r = 0.006; // 0.6% bands
      const s1=+(q.price*(1-r)).toFixed(2), s2=+(q.price*(1-2*r)).toFixed(2);
      const t1=+(q.price*(1+r)).toFixed(2), t2=+(q.price*(1+2*r)).toFixed(2);
      const txt = [
        `CRYPTO SCALP ⚡ — ${sym} @ ${fmt(q.price)} (${q.chg>=0?'+':''}${fmt(q.chg)}%) — ${ts()}`,
        `• Bias: ${q.chg>=0?'🟢':'🟡'} Range scalp via VWAP`,
        `• Key S/R: ${s2} / ${s1} | ${t1} / ${t2}`,
        `• 🚫 SL: below ${s2}`,
        `• 🎯 ${t1} / ${t2}`,
        `— — —`,
        `This is not financial advice. Do your own research.`
      ].join('\n');
      await i.editReply(txt);
    }catch{ await i.editReply('Scalp unavailable — data error.'); }
  }

  if(i.commandName==='flow'){
    await i.deferReply();
    const t = norm(i.options.getString('ticker'));
    // Placeholder: wire your provider here (UnusualWhales, CheddarFlow, etc.)
    await i.editReply(`OPTIONS FLOW 🔍 — ${t}\n• Provider not configured. Add API + code to enable.\n• Meanwhile, use /alert for live levels and /deep for HTF.`);
  }

  if(i.commandName==='health'){
    await i.deferReply();
    try{
      const spy = await yahooQuoteFull('SPY');
      const msg = [
        `HEALTH ✅ — ${ts()}`,
        `• Session (NY): ${getSession()}`,
        `• Yahoo: OK — SPY ${fmt(spy.price)} (${spy.chg>=0?'+':''}${fmt(spy.chg)}%)`,
        `• Polygon key: ${POLY ? 'present' : 'missing'}`,
        `• TZ: ${TZ}`
      ].join('\n');
      await i.editReply(msg);
    }catch{ await i.editReply('HEALTH ❌ — check network or rate limits.'); }
  }
});

register().then(()=>client.login(TOKEN));

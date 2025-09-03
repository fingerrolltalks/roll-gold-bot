
import os
import discord
from discord import app_commands
from openai import OpenAI

# === Environment Variables ===
DISCORD_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
FULL_PROMPT = os.getenv("FULL_PROMPT")

if not DISCORD_TOKEN or not OPENAI_API_KEY or not FULL_PROMPT:
    raise RuntimeError("Missing one or more environment variables: DISCORD_BOT_TOKEN, OPENAI_API_KEY, FULL_PROMPT")

# OpenAI client
client_oa = OpenAI(api_key=OPENAI_API_KEY)

# Discord client
intents = discord.Intents.default()
intents.message_content = True
bot = discord.Client(intents=intents)
tree = app_commands.CommandTree(bot)

# === Helper to call OpenAI ===
async def gen_reply(user_msg: str) -> str:
    resp = client_oa.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": FULL_PROMPT},
            {"role": "user", "content": user_msg}
        ],
        temperature=0.2,
        max_tokens=600
    )
    return resp.choices[0].message.content.strip()

# === Slash Commands ===
@tree.command(name="ping", description="Check if the bot is alive")
async def ping_cmd(interaction: discord.Interaction):
    await interaction.response.send_message("pong ✅", ephemeral=True)

@tree.command(name="analyze", description="Analyze a ticker, e.g., /analyze TSLA")
@app_commands.describe(ticker="Ticker like TSLA, NVDA, SPY")
async def analyze_cmd(interaction: discord.Interaction, ticker: str):
    await interaction.response.defer(thinking=True, ephemeral=False)
    prompt = f"Analyze {ticker} with full setup: sentiment with emoji, entry, 🚫 stop-loss, 🎯 targets, key patterns and RSI/MA/volume notes."
    answer = await gen_reply(prompt)
    await interaction.followup.send(answer)

@tree.command(name="ask", description="Ask the trading assistant anything")
@app_commands.describe(query="Your question")
async def ask_cmd(interaction: discord.Interaction, query: str):
    await interaction.response.defer(thinking=True, ephemeral=False)
    answer = await gen_reply(query)
    await interaction.followup.send(answer)

@bot.event
async def on_ready():
    await tree.sync()
    print(f"✅ Logged in as {bot.user} | Slash commands synced.")

bot.run(DISCORD_TOKEN)

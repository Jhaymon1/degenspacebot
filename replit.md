# DegenSpace Bot

A Telegram-based virtual trading platform that allows users to trade meme coins (Solana and EVM-compatible chains) using virtual funds. It integrates real-time market data from DexScreener and syncs user profiles/portfolios with the DegenSpace web app.

## Tech Stack

- **Runtime**: Node.js
- **Telegram Framework**: Telegraf v4.16.3
- **Database**: Supabase (`@supabase/supabase-js`)
- **External API**: DexScreener (live token prices, liquidity, volume)
- **Package Manager**: npm

## Project Structure

- `bot.js` — Main bot entry point (all commands, handlers, and DB logic)
- `package.json` — Dependencies and start script

## Running the Bot

The bot runs as a background console workflow with:
```
npm start
```

## Required Secrets

- `BOT_TOKEN` — Telegram bot token from @BotFather
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key

## Features

- Paper trading with virtual USD using live market prices
- Supports Solana and EVM contract addresses
- `/start`, `/help`, `/link`, `/portfolio`, `/balance`, `/history`, `/leaderboard` commands
- Real-time token data via DexScreener API
- User profiles and trade history stored in Supabase

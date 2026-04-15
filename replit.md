# DegenSpace Bot

A Telegram-based virtual trading platform that allows users to trade meme coins (Solana and EVM-compatible chains) using virtual funds. Integrates real-time market data from DexScreener and syncs user profiles/portfolios with the DegenSpace web app (degenspacex.netlify.app).

## Tech Stack

- **Runtime**: Node.js
- **Telegram Framework**: Telegraf v4.16.3
- **Database**: Supabase (`@supabase/supabase-js`)
- **External API**: DexScreener (live token prices, liquidity, volume)
- **HTTP Server**: Express (keep-alive + webhook endpoint in production)

## Project Structure

- `bot.js` — Main bot entry point (all commands, handlers, DB logic, background tasks)
- `package.json` — Dependencies and start script

## Running the Bot

```
npm start
```

**Dev mode**: Runs long-polling with exponential backoff retry (8 attempts, 5s–60s delay).
**Production (deployed VM)**: Automatically switches to webhooks (`REPLIT_DEPLOYMENT=1`) — eliminates 409 conflicts with dev environment.

## Required Secrets

- `BOT_TOKEN` — Telegram bot token from @BotFather
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key

## Required Supabase Tables

Run this SQL in Supabase SQL Editor if tables don't exist:

```sql
CREATE TABLE IF NOT EXISTS limit_orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid, token_address text, token_symbol text, chain_id text,
  order_type text, trigger_price numeric, amount_usd numeric,
  percent numeric, status text DEFAULT 'active', telegram_id text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS price_alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid, token_address text, token_symbol text,
  target_price numeric, direction text, triggered boolean DEFAULT false,
  telegram_id text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS watchlist (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid, token_address text, token_symbol text, token_name text,
  created_at timestamptz DEFAULT now(), UNIQUE(user_id, token_address)
);
CREATE TABLE IF NOT EXISTS user_settings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid UNIQUE, slippage numeric DEFAULT 1.0,
  default_buy_1 numeric DEFAULT 10, default_buy_2 numeric DEFAULT 50,
  default_buy_3 numeric DEFAULT 100
);
CREATE TABLE IF NOT EXISTS referrals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_user_id uuid, referred_telegram_id text,
  created_at timestamptz DEFAULT now()
);
```

## Features

### Trading
- Paste any contract address → live token card with full trade panel
- Buy with $10/$50/$100 (configurable) or custom amount
- Sell 25% / 50% / 75% / 100% of position
- Slippage applied per trade (configurable, default 1%)
- Gas fees applied: Solana $0.001, Ethereum $0.50, others $0.10
- Weighted average price tracking for multi-buy positions

### Orders & Automation (background checker runs every 60s)
- **Limit Buy** — auto-buys when token drops to target price
- **Take Profit** — auto-sells % of position at target price
- **Stop Loss** — auto-sells % of position if price drops below floor
- **Price Alerts** — sends Telegram notification when price crosses target

### Portfolio & Analytics
- `/portfolio` — All holdings with live PnL and multiplier
- `/positions` — Per-token detail cards with inline sell/TP/SL buttons
- `/balance` — Cash + holdings value + overall PnL vs starting balance
- `/history` — Last 10 trades with dates
- `/pnl [SYMBOL]` — Live unrealized PnL cards for all (or one) position
- `/orders` — Active limit orders (with cancel-all button)
- `/alerts` — Active price alerts (with cancel-all button)
- `/watchlist` — Tracked tokens with live price/24H change

### Social & Settings
- `/leaderboard` — Top 10 traders ranked by % gain
- `/referral` — Personal referral link + count
- `/settings` — Slippage %, all 3 buy button amounts
- `/reset` — Reset portfolio to $10,000 (with confirmation)

### Account
- `/link <code>` — Link DegenSpace web app account via 4-digit code
- `/start` — Welcome message with inline menu shortcuts

## Architecture Notes

- **State management**: In-memory Maps (`pendingTrades`, `userState`) for multi-step flows
- **Webhook mode**: `REPLIT_DEPLOYMENT=1` triggers webhook setup on Express server (port 3000)
- **Polling mode**: Dev environment uses long-polling with retry backoff
- **Callback data**: All inline button data kept under 64 bytes (Telegram limit)
- **Referral format**: `https://t.me/degenspacex_bot?start=DS<telegramId>`

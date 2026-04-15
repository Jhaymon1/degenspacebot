# DegenSpace Bot

Telegram bot for virtual meme-coin trading with live DexScreener prices and Supabase-backed portfolios.

## Quick start (clean install)

1. Install dependencies:

```bash
npm ci
```

2. Create env file:

```bash
cp .env.example .env
```

3. Set required values in `.env`:
- `BOT_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Optional:
- `WEBHOOK_URL` (set for webhook mode; leave unset for polling)
- `BOT_USERNAME` (default: `degenspacex_bot`)

4. Verify syntax:

```bash
npm run check
```

5. Start bot:

```bash
npm start
```

> If required environment variables are missing, startup fails fast with a clear error.

## Render deploy

`render.yaml` is configured to use `npm ci` for deterministic installs and starts the bot with `node bot.js`.

## Full setup details

See `replit.md` for full command/features docs and required Supabase SQL tables.

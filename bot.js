const { Telegraf, Markup } = require('telegraf')
const { createClient } = require('@supabase/supabase-js')
const express = require('express')

// ================================
// CONFIG
// ================================
const BOT_TOKEN = process.env.BOT_TOKEN
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

const bot = new Telegraf(BOT_TOKEN)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ================================
// REQUIRED SUPABASE TABLES (run in SQL editor if not created):
//
// CREATE TABLE IF NOT EXISTS limit_orders (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   user_id uuid, token_address text, token_symbol text, chain_id text,
//   order_type text, trigger_price numeric, amount_usd numeric,
//   percent numeric, status text DEFAULT 'active', telegram_id text,
//   created_at timestamptz DEFAULT now()
// );
// CREATE TABLE IF NOT EXISTS price_alerts (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   user_id uuid, token_address text, token_symbol text,
//   target_price numeric, direction text, triggered boolean DEFAULT false,
//   telegram_id text, created_at timestamptz DEFAULT now()
// );
// CREATE TABLE IF NOT EXISTS watchlist (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   user_id uuid, token_address text, token_symbol text, token_name text,
//   created_at timestamptz DEFAULT now(),
//   UNIQUE(user_id, token_address)
// );
// CREATE TABLE IF NOT EXISTS user_settings (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   user_id uuid UNIQUE, slippage numeric DEFAULT 1.0,
//   default_buy_1 numeric DEFAULT 10, default_buy_2 numeric DEFAULT 50,
//   default_buy_3 numeric DEFAULT 100
// );
// CREATE TABLE IF NOT EXISTS referrals (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   referrer_user_id uuid, referred_telegram_id text,
//   created_at timestamptz DEFAULT now()
// );
// ================================

// ================================
// HELPERS
// ================================

function formatPrice(price) {
  if (!price) return 'N/A'
  const p = parseFloat(price)
  if (p >= 1) return `$${p.toFixed(2)}`
  if (p >= 0.01) return `$${p.toFixed(4)}`
  const str = p.toFixed(20)
  const match = str.match(/^0\.(0+)(\d+)/)
  if (match) {
    const zeros = match[1].length
    const sig = match[2].slice(0, 4)
    return `$0.0${zeros}${sig}`
  }
  return `$${p}`
}

function formatNumber(num) {
  if (!num) return 'N/A'
  const n = parseFloat(num)
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function formatChange(pct) {
  if (!pct) return '—'
  const n = parseFloat(pct)
  return n >= 0 ? `🟢 +${n.toFixed(2)}%` : `🔴 ${n.toFixed(2)}%`
}

function pnlEmoji(pnl) { return pnl >= 0 ? '🟢' : '🔴' }

async function fetchTokenData(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`)
    const data = await res.json()
    if (!data.pairs || data.pairs.length === 0) return null
    return data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
  } catch (e) { return null }
}

// ================================
// STATE
// ================================

const pendingTrades = new Map()
const userState = new Map()

// ================================
// DB HELPERS
// ================================

async function getProfile(telegramId) {
  const { data } = await supabase.from('profiles').select('*').eq('telegram_id', telegramId.toString()).single()
  return data
}

async function getPortfolio(userId) {
  const { data } = await supabase.from('portfolios').select('*').eq('user_id', userId).single()
  return data
}

async function getUserSettings(userId) {
  const { data } = await supabase.from('user_settings').select('*').eq('user_id', userId).single()
  return data || { slippage: 1.0, default_buy_1: 10, default_buy_2: 50, default_buy_3: 100 }
}

// ================================
// PNL CARD GENERATOR
// ================================

function generatePnlCard(symbol, name, entryPrice, exitPrice, pnl, pnlPct, tokenAmount, proceeds, percent, unrealized = false) {
  const isWin = pnl >= 0
  const mult = parseFloat(exitPrice) / parseFloat(entryPrice)
  const banner = isWin
    ? '🚀🟢🚀🟢🚀🟢🚀🟢🚀'
    : '💀🔴💀🔴💀🔴💀🔴💀'

  if (unrealized) {
    return `${banner}
📊 *LIVE PnL — ${symbol}*
${banner}

📌 *${name}* (${symbol})
🔓 Position: OPEN

💰 Entry:    ${formatPrice(entryPrice)}
🎯 Current:  ${formatPrice(exitPrice)}
📈 Multiplier: *${mult.toFixed(2)}x*

${isWin ? '🟢' : '🔴'} *Unrealized PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)*
💼 Position Value: $${proceeds.toFixed(2)}

_DegenSpace Paper Trading_`
  }

  return `${banner}
${isWin ? '🏆' : '🪦'} *TRADE CLOSED — ${symbol}*
${banner}

📌 *${name}* (${symbol})
📊 Closed: ${(percent * 100).toFixed(0)}% of position

💰 Entry:  ${formatPrice(entryPrice)}
🎯 Exit:   ${formatPrice(exitPrice)}
📈 Multiplier: *${mult.toFixed(2)}x*

${isWin ? '🟢' : '🔴'} *PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)*
💵 Received: $${proceeds.toFixed(2)}

_DegenSpace Paper Trading_`
}

// ================================
// CORE TRADE FUNCTIONS
// ================================

async function executeBuy(ctx, telegramId, amount) {
  const tokenData = pendingTrades.get(telegramId)
  if (!tokenData) return ctx.reply('❌ Token data expired. Paste the contract address again.')

  const profile = await getProfile(telegramId)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link to connect your DegenSpace account.')

  const portfolio = await getPortfolio(profile.user_id)
  if (!portfolio) return ctx.reply('❌ No portfolio found.')

  if (parseFloat(portfolio.virtual_balance_usd) < amount) {
    return ctx.reply(`❌ Insufficient balance.\n\nYou have $${parseFloat(portfolio.virtual_balance_usd).toFixed(2)} but tried to spend $${amount.toFixed(2)}.`)
  }

  const settings = await getUserSettings(profile.user_id)
  const price = parseFloat(tokenData.priceUsd)
  const slippage = (settings.slippage || 1.0) / 100
  const fee = tokenData.chainId === 'solana' ? 0.001 : tokenData.chainId === 'ethereum' ? 0.50 : 0.10
  const totalCost = amount + fee
  const tokensReceived = (amount * (1 - slippage)) / price

  try {
    await supabase.from('portfolios')
      .update({ virtual_balance_usd: parseFloat(portfolio.virtual_balance_usd) - totalCost })
      .eq('user_id', profile.user_id)

    const { data: existing } = await supabase.from('holdings').select('*')
      .eq('user_id', profile.user_id).eq('token_address', tokenData.address).single()

    if (existing) {
      const newTotal = parseFloat(existing.amount_held) + tokensReceived
      const newAvg = ((parseFloat(existing.amount_held) * parseFloat(existing.avg_buy_price_usd)) + (tokensReceived * price)) / newTotal
      await supabase.from('holdings')
        .update({ amount_held: newTotal, avg_buy_price_usd: newAvg, last_updated: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await supabase.from('holdings').insert({
        user_id: profile.user_id,
        token_address: tokenData.address,
        chain_id: tokenData.chainId,
        token_symbol: tokenData.symbol,
        token_name: tokenData.name,
        amount_held: tokensReceived,
        avg_buy_price_usd: price
      })
    }

    await supabase.from('trades').insert({
      user_id: profile.user_id,
      token_address: tokenData.address,
      chain_id: tokenData.chainId,
      token_symbol: tokenData.symbol,
      token_name: tokenData.name,
      trade_type: 'BUY',
      amount_usd: amount,
      token_amount: tokensReceived,
      price_at_trade: price,
      entry_price: price,
      slippage_applied: slippage,
      fee_applied: fee
    })

    const newBalance = parseFloat(portfolio.virtual_balance_usd) - totalCost
    await ctx.reply(
`✅ *Buy Executed!*

🪙 ${tokenData.symbol}
💵 Spent: $${amount.toFixed(2)}
🎯 Received: ${tokensReceived.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${tokenData.symbol}
📊 Price: ${formatPrice(price)}
🔀 Slippage: ${(slippage * 100).toFixed(1)}%
⛽ Fee: $${fee.toFixed(3)}

💼 New Balance: *$${newBalance.toFixed(2)}*`,
      { parse_mode: 'Markdown' }
    )
  } catch (e) {
    await ctx.reply('❌ Trade failed. Please try again.')
    console.error(e)
  }
}

async function executeSell(ctx, telegramId, tokenAddress, percent) {
  const profile = await getProfile(telegramId)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')

  const { data: holding } = await supabase.from('holdings').select('*')
    .eq('user_id', profile.user_id).eq('token_address', tokenAddress).single()

  if (!holding || parseFloat(holding.amount_held) === 0) {
    return ctx.reply(`❌ You don't hold this token.`)
  }

  const pair = await fetchTokenData(tokenAddress)
  if (!pair) return ctx.reply('❌ Could not fetch current price. Try again.')

  const settings = await getUserSettings(profile.user_id)
  const price = parseFloat(pair.priceUsd)
  const slippage = (settings.slippage || 1.0) / 100
  const fee = holding.chain_id === 'solana' ? 0.001 : holding.chain_id === 'ethereum' ? 0.50 : 0.10
  const sellAmount = parseFloat(holding.amount_held) * percent
  const proceeds = (sellAmount * price * (1 - slippage)) - fee
  const entryPrice = parseFloat(holding.avg_buy_price_usd)
  const pnl = (price - entryPrice) * sellAmount
  const pnlPct = (pnl / (entryPrice * sellAmount) * 100)

  try {
    const portfolio = await getPortfolio(profile.user_id)
    await supabase.from('portfolios')
      .update({ virtual_balance_usd: parseFloat(portfolio.virtual_balance_usd) + proceeds })
      .eq('user_id', profile.user_id)

    if (percent >= 1) {
      await supabase.from('holdings').delete().eq('id', holding.id)
    } else {
      await supabase.from('holdings')
        .update({ amount_held: parseFloat(holding.amount_held) - sellAmount, last_updated: new Date().toISOString() })
        .eq('id', holding.id)
    }

    await supabase.from('trades').insert({
      user_id: profile.user_id,
      token_address: tokenAddress,
      chain_id: holding.chain_id,
      token_symbol: holding.token_symbol,
      token_name: holding.token_name,
      trade_type: 'SELL',
      amount_usd: proceeds,
      token_amount: sellAmount,
      price_at_trade: price,
      entry_price: entryPrice,
      slippage_applied: slippage,
      fee_applied: fee
    })

    const newBalance = parseFloat(portfolio.virtual_balance_usd) + proceeds
    const card = generatePnlCard(holding.token_symbol, holding.token_name, entryPrice, price, pnl, pnlPct, sellAmount, proceeds, percent)
    await ctx.reply(card, { parse_mode: 'Markdown' })
    await ctx.reply(`💼 New Balance: *$${newBalance.toFixed(2)}*`, { parse_mode: 'Markdown' })
  } catch (e) {
    await ctx.reply('❌ Sell failed. Please try again.')
    console.error(e)
  }
}

// ================================
// BOT COMMANDS
// ================================

bot.start(async (ctx) => {
  const name = ctx.from.first_name || 'Trader'

  // Handle referral code
  const startPayload = ctx.startPayload
  if (startPayload && startPayload.startsWith('DS')) {
    const refTelegramId = startPayload.replace('DS', '')
    const profile = await getProfile(ctx.from.id)
    if (profile) {
      const refProfile = await getProfile(refTelegramId)
      if (refProfile && refProfile.user_id !== profile.user_id) {
        await supabase.from('referrals').upsert(
          { referrer_user_id: refProfile.user_id, referred_telegram_id: ctx.from.id.toString() },
          { onConflict: 'referred_telegram_id' }
        )
      }
    }
  }

  await ctx.reply(
`👋 Welcome to *DegenSpace Bot*, ${name}!

Trade meme coins with virtual funds. Real markets, zero risk.

*Quick Start:*
• Paste any *contract address* to get live data and trade
• Use /link to connect your DegenSpace account

*Features:*
• Limit orders & trigger prices
• Take Profit / Stop Loss
• Price alerts
• PnL cards
• Watchlist & settings`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💼 Portfolio', 'cmd_portfolio'), Markup.button.callback('💵 Balance', 'cmd_balance')],
        [Markup.button.callback('📋 Orders', 'cmd_orders'), Markup.button.callback('🔔 Alerts', 'cmd_alerts')],
        [Markup.button.callback('👀 Watchlist', 'cmd_watchlist'), Markup.button.callback('⚙️ Settings', 'cmd_settings')],
        [Markup.button.callback('🏆 Leaderboard', 'cmd_leaderboard'), Markup.button.callback('🎁 Referral', 'cmd_referral')],
      ])
    }
  )
})

bot.command('help', async (ctx) => {
  await ctx.reply(
`*DegenSpace Bot — Commands*

📊 *Trading*
Paste any CA → live data + full trade panel

💼 *Portfolio*
/portfolio — Holdings with live PnL
/positions — Detailed per-token positions
/balance — Cash balance
/history — Last 10 trades
/pnl — Live PnL cards for all positions

📋 *Orders*
/orders — Active limit orders
Set via token card: Limit Buy, TP, SL

🔔 *Alerts*
/alerts — Active price alerts
Set via token card: Price Alert button

👀 *Watchlist*
/watchlist — Tracked tokens with live price

⚙️ *Settings*
/settings — Slippage, default buy amounts

🏆 *Social*
/leaderboard — Top 10 traders
/referral — Your referral link

⚙️ *Account*
/link — Connect DegenSpace account
/reset — Reset portfolio to $10,000
/cancel — Cancel current input`,
    { parse_mode: 'Markdown' }
  )
})

// /link
bot.command('link', async (ctx) => {
  const parts = ctx.message.text.split(' ')
  if (parts.length < 2) {
    return ctx.reply(
`🔗 *Link Your DegenSpace Account*

1. Open *degenspacex.netlify.app*
2. Go to Wallet tab
3. Tap *"Link Telegram"* button
4. You'll get a 4-digit code
5. Send it here as: /link 1234

Your code expires in 10 minutes.`,
      { parse_mode: 'Markdown' }
    )
  }

  const code = parts[1].trim()
  const telegramId = ctx.from.id.toString()
  const username = ctx.from.username || ctx.from.first_name || 'Trader'

  const { data: allRows, error: fetchError } = await supabase
    .from('telegram_link_codes').select('*').eq('code', code)

  const now = new Date().toISOString()
  const linkCode = allRows?.find(r => !r.used && r.expires_at > now)

  if (fetchError || !linkCode) {
    return ctx.reply('❌ Invalid or expired code.\n\nGo back to DegenSpace and generate a new code.\nCodes expire after 10 minutes.')
  }

  await supabase.from('profiles').upsert(
    { id: linkCode.user_id, telegram_id: telegramId, display_name: username },
    { onConflict: 'id' }
  )
  await supabase.from('telegram_link_codes').update({ used: true }).eq('id', linkCode.id)

  await ctx.reply(
`✅ *Account Linked Successfully!*

Welcome to DegenSpace Bot, *${username}*! 🎉

You can now:
• Paste any contract address to trade
• Use /balance to check your portfolio
• Use /leaderboard to see top traders

Try pasting a contract address now! 🚀`,
    { parse_mode: 'Markdown' }
  )
})

// /register (legacy)
bot.command('register', async (ctx) => {
  const parts = ctx.message.text.split(' ')
  if (parts.length < 2) return ctx.reply('Usage: /register your@email.com')
  await ctx.reply(
`✅ To complete registration:

1. Go to degenspacex.netlify.app
2. Sign up with: *${parts[1]}*
3. Come back and use /link to connect

Your Telegram ID: \`${ctx.from.id}\``,
    { parse_mode: 'Markdown' }
  )
})

// /balance
bot.command('balance', async (ctx) => { await runBalance(ctx) })

// /portfolio
bot.command('portfolio', async (ctx) => { await runPortfolio(ctx) })

// /positions
bot.command('positions', async (ctx) => {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')

  const { data: holdings } = await supabase.from('holdings').select('*').eq('user_id', profile.user_id)
  if (!holdings || holdings.length === 0) return ctx.reply('📭 No open positions.')

  for (const h of holdings) {
    try {
      const pair = await fetchTokenData(h.token_address)
      const currentPrice = pair ? parseFloat(pair.priceUsd) : parseFloat(h.avg_buy_price_usd)
      const entryPrice = parseFloat(h.avg_buy_price_usd)
      const currentValue = currentPrice * parseFloat(h.amount_held)
      const costBasis = entryPrice * parseFloat(h.amount_held)
      const pnl = currentValue - costBasis
      const pnlPct = (pnl / costBasis * 100)
      const mult = currentPrice / entryPrice

      const addr = h.token_address

      await ctx.reply(
`📍 *${h.token_name}* (${h.token_symbol})

💰 Entry:     ${formatPrice(entryPrice)}
🎯 Current:   ${formatPrice(currentPrice)}
📊 Mult:      *${mult.toFixed(2)}x*

🪙 Amount: ${parseFloat(h.amount_held).toLocaleString(undefined, { maximumFractionDigits: 2 })}
💵 Cost Basis: $${costBasis.toFixed(2)}
💼 Value:      ${formatNumber(currentValue)}

${pnlEmoji(pnl)} *PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)*

\`${addr}\``,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('🔴 25%', `sell_25_${addr}`),
              Markup.button.callback('🔴 50%', `sell_50_${addr}`),
              Markup.button.callback('🔴 75%', `sell_75_${addr}`),
              Markup.button.callback('🔴 100%', `sell_100_${addr}`),
            ],
            [
              Markup.button.callback('🎯 Take Profit', `set_tp_${addr}`),
              Markup.button.callback('🛡️ Stop Loss', `set_sl_${addr}`),
            ],
            [
              Markup.button.callback('📊 PnL Card', `pnl_card_${addr}`),
            ]
          ])
        }
      )
    } catch (e) {
      await ctx.reply(`*${h.token_symbol}* — error loading position`)
    }
  }
})

// /history
bot.command('history', async (ctx) => {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')

  const { data: trades } = await supabase.from('trades').select('*')
    .eq('user_id', profile.user_id)
    .order('created_at', { ascending: false })
    .limit(10)

  if (!trades || trades.length === 0) return ctx.reply('📭 No trades yet.')

  let message = `🕐 *Last ${trades.length} Trades*\n\n`
  for (const t of trades) {
    const emoji = t.trade_type === 'BUY' ? '💚' : '🔴'
    const date = new Date(t.created_at || t.timestamp).toLocaleDateString()
    message += `${emoji} *${t.trade_type}* ${t.token_symbol}\n`
    message += `  $${parseFloat(t.amount_usd).toFixed(2)} @ ${formatPrice(t.price_at_trade)}\n`
    message += `  ${date}\n\n`
  }

  await ctx.reply(message, { parse_mode: 'Markdown' })
})

// /leaderboard
bot.command('leaderboard', async (ctx) => { await runLeaderboard(ctx) })

// /pnl - show live PnL card for all open positions
bot.command('pnl', async (ctx) => {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')

  const parts = ctx.message.text.split(' ')
  const symbol = parts[1]?.toUpperCase()

  const { data: holdings } = await supabase.from('holdings').select('*').eq('user_id', profile.user_id)
  if (!holdings || holdings.length === 0) return ctx.reply('📭 No open positions.')

  const filtered = symbol ? holdings.filter(h => h.token_symbol.toUpperCase() === symbol) : holdings
  if (filtered.length === 0) return ctx.reply(`❌ No position for ${symbol}.`)

  for (const h of filtered) {
    const pair = await fetchTokenData(h.token_address)
    const currentPrice = pair ? parseFloat(pair.priceUsd) : parseFloat(h.avg_buy_price_usd)
    const amount = parseFloat(h.amount_held)
    const proceeds = amount * currentPrice
    const pnl = (currentPrice - parseFloat(h.avg_buy_price_usd)) * amount
    const pnlPct = (pnl / (parseFloat(h.avg_buy_price_usd) * amount) * 100)
    const card = generatePnlCard(h.token_symbol, h.token_name, h.avg_buy_price_usd, currentPrice, pnl, pnlPct, amount, proceeds, 1, true)
    await ctx.reply(card, { parse_mode: 'Markdown' })
  }
})

// /orders
bot.command('orders', async (ctx) => { await runOrders(ctx) })

// /alerts
bot.command('alerts', async (ctx) => { await runAlerts(ctx) })

// /watchlist
bot.command('watchlist', async (ctx) => { await runWatchlist(ctx) })

// /settings
bot.command('settings', async (ctx) => { await runSettings(ctx) })

// /referral
bot.command('referral', async (ctx) => { await runReferral(ctx) })

// /reset
bot.command('reset', async (ctx) => {
  await ctx.reply(
`⚠️ *Reset Portfolio?*

This will:
• Restore your cash to $10,000
• Clear all holdings
• Keep your trade history

Are you sure?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Reset', 'confirm_reset'), Markup.button.callback('❌ Cancel', 'cancel_reset')]
      ])
    }
  )
})

// /cancel
bot.command('cancel', async (ctx) => {
  const telegramId = ctx.from.id
  const pending = pendingTrades.get(telegramId)
  const state = userState.get(telegramId)
  if (pending?.waitingForAmount || state) {
    if (pending) pendingTrades.set(telegramId, { ...pending, waitingForAmount: false })
    userState.delete(telegramId)
    return ctx.reply('❌ Action cancelled.')
  }
  return ctx.reply('Nothing to cancel.')
})

// ================================
// CONTRACT ADDRESS HANDLER
// ================================

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  if (text.startsWith('/')) return

  const telegramId = ctx.from.id
  const pendingData = pendingTrades.get(telegramId)
  const state = userState.get(telegramId)

  // Multi-step input flow
  if (state) return handleUserState(ctx, telegramId, text, state)

  // Custom buy amount
  if (pendingData?.waitingForAmount) {
    const amount = parseFloat(text.replace(/[^0-9.]/g, ''))
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Invalid amount. Enter a number like `250` or /cancel.', { parse_mode: 'Markdown' })
    }
    pendingTrades.set(telegramId, { ...pendingData, waitingForAmount: false })
    return executeBuy(ctx, telegramId, amount)
  }

  // Detect contract address
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)
  const isEVM = /^0x[a-fA-F0-9]{40}$/.test(text)

  if (!isSolana && !isEVM) {
    return ctx.reply('👋 Paste a contract address to get live data and trade!\n\nOr use /help for all commands.')
  }

  await ctx.reply('🔍 Fetching token data...')
  const pair = await fetchTokenData(text)
  if (!pair) return ctx.reply('❌ Token not found on DexScreener.\n\nCheck the contract address and ensure it has a liquidity pool.')

  const name = pair.baseToken?.name || 'Unknown'
  const symbol = pair.baseToken?.symbol || '???'
  const chain = pair.chainId || 'unknown'
  const dex = pair.dexId || 'unknown'

  pendingTrades.set(telegramId, {
    address: text, symbol, name, chainId: chain, dexId: dex, priceUsd: pair.priceUsd, pairData: pair
  })

  // Check existing holding
  const profile = await getProfile(telegramId)
  let holdingInfo = ''
  if (profile) {
    const { data: holding } = await supabase.from('holdings').select('*')
      .eq('user_id', profile.user_id).eq('token_address', text).single()
    if (holding) {
      const cp = parseFloat(pair.priceUsd)
      const ep = parseFloat(holding.avg_buy_price_usd)
      const pnl = (cp - ep) * parseFloat(holding.amount_held)
      const pnlPct = ((cp - ep) / ep * 100)
      holdingInfo = `\n📍 *Your Position:*\n  Avg Entry: ${formatPrice(ep)}\n  ${pnlEmoji(pnl)} PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\n`
    }
  }

  const settings = profile ? await getUserSettings(profile.user_id) : { default_buy_1: 10, default_buy_2: 50, default_buy_3: 100 }
  const b1 = settings.default_buy_1 || 10
  const b2 = settings.default_buy_2 || 50
  const b3 = settings.default_buy_3 || 100

  const message =
`🪙 *${name}* (${symbol})
🔗 ${chain.toUpperCase()} › ${dex}

💵 Price: *${formatPrice(pair.priceUsd)}*
📈 5M: ${formatChange(pair.priceChange?.m5)}
📈 1H: ${formatChange(pair.priceChange?.h1)}
📈 24H: ${formatChange(pair.priceChange?.h24)}

💧 Liquidity: ${formatNumber(pair.liquidity?.usd)}
📦 Volume 24H: ${formatNumber(pair.volume?.h24)}
🏦 Market Cap: ${formatNumber(pair.marketCap)}
💎 FDV: ${formatNumber(pair.fdv)}
⚡ Txns 24H: ${(pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)} (${pair.txns?.h24?.buys || 0}B / ${pair.txns?.h24?.sells || 0}S)
${holdingInfo}
*Select an action:*`

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(`💚 Buy $${b1}`, `buy_${b1}`),
        Markup.button.callback(`💚 Buy $${b2}`, `buy_${b2}`),
        Markup.button.callback(`💚 Buy $${b3}`, `buy_${b3}`),
      ],
      [
        Markup.button.callback('✏️ Custom Buy', 'buy_custom'),
        Markup.button.callback('📈 Limit Buy', `lbuy_${text}`),
      ],
      [
        Markup.button.callback('🔴 Sell 25%', `sell_25_${text}`),
        Markup.button.callback('🔴 Sell 50%', `sell_50_${text}`),
      ],
      [
        Markup.button.callback('🔴 Sell 75%', `sell_75_${text}`),
        Markup.button.callback('🔴 Sell 100%', `sell_100_${text}`),
      ],
      [
        Markup.button.callback('🎯 Take Profit', `set_tp_${text}`),
        Markup.button.callback('🛡️ Stop Loss', `set_sl_${text}`),
      ],
      [
        Markup.button.callback('🔔 Price Alert', `set_alert_${text}`),
        Markup.button.callback('👀 Watch', `watch_${text}`),
      ],
      [
        Markup.button.callback('📊 PnL Card', `pnl_card_${text}`),
        Markup.button.callback('🔄 Refresh', `refresh_${text}`),
      ]
    ])
  })
})

// ================================
// MULTI-STEP STATE HANDLER
// ================================

async function handleUserState(ctx, telegramId, text, state) {
  const value = parseFloat(text.replace(/[^0-9.]/g, ''))

  switch (state.action) {
    case 'set_alert': {
      if (isNaN(value) || value <= 0) return ctx.reply('❌ Invalid price. Enter a number or /cancel.')
      const profile = await getProfile(telegramId)
      if (!profile) return ctx.reply('❌ Account not linked.')
      const tokenData = pendingTrades.get(telegramId)
      const direction = value > parseFloat(tokenData?.priceUsd || 0) ? 'above' : 'below'
      await supabase.from('price_alerts').insert({
        user_id: profile.user_id,
        token_address: state.tokenAddress,
        token_symbol: state.symbol,
        target_price: value,
        direction,
        triggered: false,
        telegram_id: telegramId.toString()
      })
      userState.delete(telegramId)
      return ctx.reply(`🔔 Alert set! You'll be notified when *${state.symbol}* goes ${direction} ${formatPrice(value)}`, { parse_mode: 'Markdown' })
    }

    case 'set_limit_buy': {
      if (isNaN(value) || value <= 0) return ctx.reply('❌ Invalid price. /cancel to abort.')
      userState.set(telegramId, { ...state, action: 'set_limit_buy_amount', triggerPrice: value })
      return ctx.reply(`💚 Limit buy at *${formatPrice(value)}*\n\nNow enter the *USD amount* to buy:`, { parse_mode: 'Markdown' })
    }

    case 'set_limit_buy_amount': {
      if (isNaN(value) || value <= 0) return ctx.reply('❌ Invalid amount. /cancel to abort.')
      const profile = await getProfile(telegramId)
      if (!profile) return ctx.reply('❌ Not linked.')
      await supabase.from('limit_orders').insert({
        user_id: profile.user_id,
        token_address: state.tokenAddress,
        token_symbol: state.symbol,
        chain_id: state.chainId,
        order_type: 'LIMIT_BUY',
        trigger_price: state.triggerPrice,
        amount_usd: value,
        status: 'active',
        telegram_id: telegramId.toString()
      })
      userState.delete(telegramId)
      return ctx.reply(`✅ *Limit Buy Set!*\n\nWill buy *$${value.toFixed(2)}* of ${state.symbol} when price hits ${formatPrice(state.triggerPrice)}`, { parse_mode: 'Markdown' })
    }

    case 'set_tp': {
      if (isNaN(value) || value <= 0) return ctx.reply('❌ Invalid price. /cancel to abort.')
      userState.set(telegramId, { ...state, action: 'set_tp_percent', triggerPrice: value })
      return ctx.reply(`🎯 Take profit at *${formatPrice(value)}*\n\nWhat % of your position to sell? (e.g. \`100\` for all)`, { parse_mode: 'Markdown' })
    }

    case 'set_tp_percent': {
      const pct = Math.min(100, Math.max(1, value))
      const profile = await getProfile(telegramId)
      if (!profile) return ctx.reply('❌ Not linked.')
      await supabase.from('limit_orders').insert({
        user_id: profile.user_id,
        token_address: state.tokenAddress,
        token_symbol: state.symbol,
        chain_id: state.chainId,
        order_type: 'TAKE_PROFIT',
        trigger_price: state.triggerPrice,
        percent: pct / 100,
        status: 'active',
        telegram_id: telegramId.toString()
      })
      userState.delete(telegramId)
      return ctx.reply(`✅ *Take Profit Set!*\n\nWill sell *${pct.toFixed(0)}%* of ${state.symbol} at ${formatPrice(state.triggerPrice)}`, { parse_mode: 'Markdown' })
    }

    case 'set_sl': {
      if (isNaN(value) || value <= 0) return ctx.reply('❌ Invalid price. /cancel to abort.')
      userState.set(telegramId, { ...state, action: 'set_sl_percent', triggerPrice: value })
      return ctx.reply(`🛡️ Stop loss at *${formatPrice(value)}*\n\nWhat % of your position to sell? (e.g. \`100\` for all)`, { parse_mode: 'Markdown' })
    }

    case 'set_sl_percent': {
      const pct = Math.min(100, Math.max(1, value))
      const profile = await getProfile(telegramId)
      if (!profile) return ctx.reply('❌ Not linked.')
      await supabase.from('limit_orders').insert({
        user_id: profile.user_id,
        token_address: state.tokenAddress,
        token_symbol: state.symbol,
        chain_id: state.chainId,
        order_type: 'STOP_LOSS',
        trigger_price: state.triggerPrice,
        percent: pct / 100,
        status: 'active',
        telegram_id: telegramId.toString()
      })
      userState.delete(telegramId)
      return ctx.reply(`✅ *Stop Loss Set!*\n\nWill sell *${pct.toFixed(0)}%* of ${state.symbol} at ${formatPrice(state.triggerPrice)}`, { parse_mode: 'Markdown' })
    }

    case 'settings_slippage': {
      if (isNaN(value) || value < 0.1 || value > 50) return ctx.reply('❌ Enter a value between 0.1 and 50.')
      const profile = await getProfile(telegramId)
      await supabase.from('user_settings').upsert({ user_id: profile.user_id, slippage: value }, { onConflict: 'user_id' })
      userState.delete(telegramId)
      return ctx.reply(`✅ Slippage set to *${value}%*`, { parse_mode: 'Markdown' })
    }

    case 'settings_buy1':
    case 'settings_buy2':
    case 'settings_buy3': {
      if (isNaN(value) || value <= 0) return ctx.reply('❌ Invalid amount.')
      const profile = await getProfile(telegramId)
      const col = state.action === 'settings_buy1' ? 'default_buy_1' : state.action === 'settings_buy2' ? 'default_buy_2' : 'default_buy_3'
      await supabase.from('user_settings').upsert({ user_id: profile.user_id, [col]: value }, { onConflict: 'user_id' })
      userState.delete(telegramId)
      return ctx.reply(`✅ Buy button updated to *$${value.toFixed(2)}*`, { parse_mode: 'Markdown' })
    }

    default:
      userState.delete(telegramId)
      return ctx.reply('❌ Unknown action. Please try again.')
  }
}

// ================================
// INLINE BUTTON HANDLERS
// ================================

// Start menu shortcuts
bot.action('cmd_portfolio', async (ctx) => { await ctx.answerCbQuery(); await runPortfolio(ctx) })
bot.action('cmd_balance', async (ctx) => { await ctx.answerCbQuery(); await runBalance(ctx) })
bot.action('cmd_orders', async (ctx) => { await ctx.answerCbQuery(); await runOrders(ctx) })
bot.action('cmd_alerts', async (ctx) => { await ctx.answerCbQuery(); await runAlerts(ctx) })
bot.action('cmd_watchlist', async (ctx) => { await ctx.answerCbQuery(); await runWatchlist(ctx) })
bot.action('cmd_settings', async (ctx) => { await ctx.answerCbQuery(); await runSettings(ctx) })
bot.action('cmd_leaderboard', async (ctx) => { await ctx.answerCbQuery(); await runLeaderboard(ctx) })
bot.action('cmd_referral', async (ctx) => { await ctx.answerCbQuery(); await runReferral(ctx) })

// Custom buy
bot.action('buy_custom', async (ctx) => {
  await ctx.answerCbQuery()
  const tokenData = pendingTrades.get(ctx.from.id)
  if (!tokenData) return ctx.reply('❌ Token data expired. Paste the contract address again.')
  pendingTrades.set(ctx.from.id, { ...tokenData, waitingForAmount: true })
  await ctx.reply(
`✏️ *Custom Buy — ${tokenData.symbol}*

Enter the USD amount to spend:

Example: \`250\` or \`1500\`

/cancel to abort.`,
    { parse_mode: 'Markdown' }
  )
})

// Fixed amount buy
bot.action(/^buy_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  await executeBuy(ctx, ctx.from.id, parseInt(ctx.match[1]))
})

// Sell — sell_25_<address>
bot.action(/^sell_(\d+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  await executeSell(ctx, ctx.from.id, ctx.match[2], parseInt(ctx.match[1]) / 100)
})

// Limit buy — lbuy_<address>
bot.action(/^lbuy_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const tokenAddress = ctx.match[1]
  const tokenData = pendingTrades.get(ctx.from.id)
  userState.set(ctx.from.id, { action: 'set_limit_buy', tokenAddress, symbol: tokenData?.symbol || '???', chainId: tokenData?.chainId })
  await ctx.reply(
`📈 *Limit Buy — ${tokenData?.symbol || '???'}*

Current price: ${formatPrice(tokenData?.priceUsd)}

Enter the *trigger price* (will buy when price drops to this):`,
    { parse_mode: 'Markdown' }
  )
})

// Take profit — set_tp_<address>
bot.action(/^set_tp_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const tokenAddress = ctx.match[1]
  const tokenData = pendingTrades.get(ctx.from.id)
  let symbol = tokenData?.symbol || '???'
  let chainId = tokenData?.chainId || 'unknown'
  if (!tokenData || tokenData.address !== tokenAddress) {
    const profile = await getProfile(ctx.from.id)
    if (profile) {
      const { data: h } = await supabase.from('holdings').select('token_symbol, chain_id').eq('user_id', profile.user_id).eq('token_address', tokenAddress).single()
      if (h) { symbol = h.token_symbol; chainId = h.chain_id }
    }
  }
  userState.set(ctx.from.id, { action: 'set_tp', tokenAddress, symbol, chainId })
  await ctx.reply(
`🎯 *Take Profit — ${symbol}*

Enter the *target price* to sell at:`,
    { parse_mode: 'Markdown' }
  )
})

// Stop loss — set_sl_<address>
bot.action(/^set_sl_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const tokenAddress = ctx.match[1]
  const tokenData = pendingTrades.get(ctx.from.id)
  let symbol = tokenData?.symbol || '???'
  let chainId = tokenData?.chainId || 'unknown'
  if (!tokenData || tokenData.address !== tokenAddress) {
    const profile = await getProfile(ctx.from.id)
    if (profile) {
      const { data: h } = await supabase.from('holdings').select('token_symbol, chain_id').eq('user_id', profile.user_id).eq('token_address', tokenAddress).single()
      if (h) { symbol = h.token_symbol; chainId = h.chain_id }
    }
  }
  userState.set(ctx.from.id, { action: 'set_sl', tokenAddress, symbol, chainId })
  await ctx.reply(
`🛡️ *Stop Loss — ${symbol}*

Enter the *stop price* (will sell if price drops to this):`,
    { parse_mode: 'Markdown' }
  )
})

// Price alert — set_alert_<address>
bot.action(/^set_alert_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const tokenAddress = ctx.match[1]
  const tokenData = pendingTrades.get(ctx.from.id)
  userState.set(ctx.from.id, { action: 'set_alert', tokenAddress, symbol: tokenData?.symbol || '???' })
  await ctx.reply(
`🔔 *Price Alert — ${tokenData?.symbol || '???'}*

Current price: ${formatPrice(tokenData?.priceUsd)}

Enter the *alert price*:`,
    { parse_mode: 'Markdown' }
  )
})

// Watch token — watch_<address>
bot.action(/^watch_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const tokenAddress = ctx.match[1]
  const tokenData = pendingTrades.get(ctx.from.id)
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')

  await supabase.from('watchlist').upsert(
    { user_id: profile.user_id, token_address: tokenAddress, token_symbol: tokenData?.symbol || '???', token_name: tokenData?.name || '???' },
    { onConflict: 'user_id,token_address' }
  )
  await ctx.reply(`👀 *${tokenData?.symbol}* added to your watchlist!\n\nUse /watchlist to see all watched tokens.`, { parse_mode: 'Markdown' })
})

// PnL card — pnl_card_<address>
bot.action(/^pnl_card_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const tokenAddress = ctx.match[1]
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked.')

  const { data: holding } = await supabase.from('holdings').select('*')
    .eq('user_id', profile.user_id).eq('token_address', tokenAddress).single()

  if (!holding) return ctx.reply(`❌ You don't hold this token.`)

  const pair = await fetchTokenData(tokenAddress)
  const currentPrice = pair ? parseFloat(pair.priceUsd) : parseFloat(holding.avg_buy_price_usd)
  const amount = parseFloat(holding.amount_held)
  const proceeds = amount * currentPrice
  const pnl = (currentPrice - parseFloat(holding.avg_buy_price_usd)) * amount
  const pnlPct = (pnl / (parseFloat(holding.avg_buy_price_usd) * amount) * 100)
  const card = generatePnlCard(holding.token_symbol, holding.token_name, holding.avg_buy_price_usd, currentPrice, pnl, pnlPct, amount, proceeds, 1, true)
  await ctx.reply(card, { parse_mode: 'Markdown' })
})

// Refresh — refresh_<address>
bot.action(/^refresh_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Refreshing...')
  const address = ctx.match[1]
  const pair = await fetchTokenData(address)
  if (!pair) return ctx.reply('❌ Failed to refresh.')

  const tokenData = pendingTrades.get(ctx.from.id)
  if (tokenData) pendingTrades.set(ctx.from.id, { ...tokenData, priceUsd: pair.priceUsd })

  await ctx.reply(
`🔄 *${pair.baseToken?.symbol}* Refreshed

💵 Price: *${formatPrice(pair.priceUsd)}*
📈 5M:  ${formatChange(pair.priceChange?.m5)}
📈 1H:  ${formatChange(pair.priceChange?.h1)}
📈 24H: ${formatChange(pair.priceChange?.h24)}`,
    { parse_mode: 'Markdown' }
  )
})

// Portfolio inline
bot.action('show_portfolio', async (ctx) => { await ctx.answerCbQuery(); await runPortfolio(ctx) })

// Cancel all orders
bot.action('cancel_all_orders', async (ctx) => {
  await ctx.answerCbQuery()
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Not linked.')
  await supabase.from('limit_orders').update({ status: 'cancelled' }).eq('user_id', profile.user_id).eq('status', 'active')
  await ctx.reply('✅ All active orders cancelled.')
})

// Cancel all alerts
bot.action('cancel_all_alerts', async (ctx) => {
  await ctx.answerCbQuery()
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Not linked.')
  await supabase.from('price_alerts').update({ triggered: true }).eq('user_id', profile.user_id).eq('triggered', false)
  await ctx.reply('✅ All alerts cancelled.')
})

// Reset
bot.action('confirm_reset', async (ctx) => {
  await ctx.answerCbQuery()
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Not linked.')
  await supabase.from('portfolios').update({ virtual_balance_usd: 10000 }).eq('user_id', profile.user_id)
  await supabase.from('holdings').delete().eq('user_id', profile.user_id)
  await ctx.reply('✅ *Portfolio Reset!*\n\nBalance restored to $10,000. Fresh start! 🚀', { parse_mode: 'Markdown' })
})

bot.action('cancel_reset', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('❌ Reset cancelled.') })

// Settings buttons
bot.action('settings_set_slippage', async (ctx) => {
  await ctx.answerCbQuery()
  userState.set(ctx.from.id, { action: 'settings_slippage' })
  await ctx.reply('📊 Enter new slippage % (e.g. `1.5`):', { parse_mode: 'Markdown' })
})
bot.action('settings_set_buy1', async (ctx) => { await ctx.answerCbQuery(); userState.set(ctx.from.id, { action: 'settings_buy1' }); await ctx.reply('💰 Enter new amount for Buy Button 1 (USD):') })
bot.action('settings_set_buy2', async (ctx) => { await ctx.answerCbQuery(); userState.set(ctx.from.id, { action: 'settings_buy2' }); await ctx.reply('💰 Enter new amount for Buy Button 2 (USD):') })
bot.action('settings_set_buy3', async (ctx) => { await ctx.answerCbQuery(); userState.set(ctx.from.id, { action: 'settings_buy3' }); await ctx.reply('💰 Enter new amount for Buy Button 3 (USD):') })

// ================================
// SHARED RUNNERS
// ================================

async function runBalance(ctx) {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')
  const portfolio = await getPortfolio(profile.user_id)
  if (!portfolio) return ctx.reply('❌ No portfolio found.')

  const { data: holdings } = await supabase.from('holdings').select('*').eq('user_id', profile.user_id)
  let holdingsValue = 0
  if (holdings && holdings.length > 0) {
    for (const h of holdings) {
      try {
        const pair = await fetchTokenData(h.token_address)
        const cp = pair ? parseFloat(pair.priceUsd) : parseFloat(h.avg_buy_price_usd)
        holdingsValue += cp * parseFloat(h.amount_held)
      } catch { holdingsValue += parseFloat(h.avg_buy_price_usd) * parseFloat(h.amount_held) }
    }
  }

  const cash = parseFloat(portfolio.virtual_balance_usd)
  const startBal = parseFloat(portfolio.starting_balance) || 10000
  const totalValue = cash + holdingsValue
  const pnl = totalValue - startBal
  const pnlPct = (pnl / startBal * 100).toFixed(2)

  await ctx.reply(
`💼 *${profile.display_name || 'Your'} Balance*

💵 Cash:     *$${cash.toFixed(2)}*
📦 Holdings: *$${holdingsValue.toFixed(2)}*
━━━━━━━━━━━
💼 Total:    *$${totalValue.toFixed(2)}*

🏁 Started: $${startBal.toFixed(2)}
${pnlEmoji(pnl)} Overall PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct}%)

Use /portfolio for full holdings breakdown`,
    { parse_mode: 'Markdown' }
  )
}

async function runPortfolio(ctx) {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')
  const portfolio = await getPortfolio(profile.user_id)
  const { data: holdings } = await supabase.from('holdings').select('*').eq('user_id', profile.user_id)

  if (!holdings || holdings.length === 0) return ctx.reply('📭 No holdings yet.\n\nPaste a contract address to start trading!')

  let message = `📊 *Portfolio — ${profile.display_name || 'Trader'}*\n\n`
  let totalHoldingsValue = 0

  for (const h of holdings) {
    try {
      const pair = await fetchTokenData(h.token_address)
      const cp = pair ? parseFloat(pair.priceUsd) : parseFloat(h.avg_buy_price_usd)
      const ep = parseFloat(h.avg_buy_price_usd)
      const val = cp * parseFloat(h.amount_held)
      const pnl = val - (ep * parseFloat(h.amount_held))
      const pnlPct = (pnl / (ep * parseFloat(h.amount_held)) * 100).toFixed(1)
      const mult = (cp / ep).toFixed(2)
      totalHoldingsValue += val
      message += `*${h.token_symbol}* — ${formatNumber(val)} ${pnlEmoji(pnl)} ${pnl >= 0 ? '+' : ''}${pnlPct}% (${mult}x)\n`
    } catch (e) {
      message += `*${h.token_symbol}* — price unavailable\n`
    }
  }

  const cash = parseFloat(portfolio?.virtual_balance_usd || 0)
  const totalValue = totalHoldingsValue + cash
  const totalPnl = totalValue - parseFloat(portfolio?.starting_balance || 10000)

  message += `\n━━━━━━━━━━━━━━━\n`
  message += `💵 Cash: $${cash.toFixed(2)}\n`
  message += `📦 Holdings: ${formatNumber(totalHoldingsValue)}\n`
  message += `💼 Total: *${formatNumber(totalValue)}*\n`
  message += `${pnlEmoji(totalPnl)} Overall: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`

  await ctx.reply(message, { parse_mode: 'Markdown' })
}

async function runOrders(ctx) {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')
  const { data: orders } = await supabase.from('limit_orders').select('*')
    .eq('user_id', profile.user_id).eq('status', 'active').order('created_at', { ascending: false })

  if (!orders || orders.length === 0) {
    return ctx.reply(`📋 *Active Orders*\n\nNo active orders.\n\nSet from any token card via Limit Buy, Take Profit, or Stop Loss.`, { parse_mode: 'Markdown' })
  }

  let message = `📋 *Active Orders (${orders.length})*\n\n`
  for (const o of orders) {
    const e = o.order_type === 'LIMIT_BUY' ? '💚' : o.order_type === 'TAKE_PROFIT' ? '🎯' : '🛡️'
    message += `${e} *${o.order_type.replace(/_/g, ' ')}* — ${o.token_symbol}\n`
    message += `  Trigger: ${formatPrice(o.trigger_price)}`
    if (o.amount_usd) message += ` | Buy $${parseFloat(o.amount_usd).toFixed(2)}`
    if (o.percent) message += ` | Sell ${(o.percent * 100).toFixed(0)}%`
    message += `\n\n`
  }

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🗑️ Cancel All Orders', 'cancel_all_orders')]])
  })
}

async function runAlerts(ctx) {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')
  const { data: alerts } = await supabase.from('price_alerts').select('*')
    .eq('user_id', profile.user_id).eq('triggered', false).order('created_at', { ascending: false })

  if (!alerts || alerts.length === 0) {
    return ctx.reply(`🔔 *Price Alerts*\n\nNo active alerts.\n\nSet from any token card via the Price Alert button.`, { parse_mode: 'Markdown' })
  }

  let message = `🔔 *Active Alerts (${alerts.length})*\n\n`
  for (const a of alerts) {
    message += `${a.direction === 'above' ? '⬆️' : '⬇️'} *${a.token_symbol}* — ${a.direction} ${formatPrice(a.target_price)}\n`
  }

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('🗑️ Cancel All Alerts', 'cancel_all_alerts')]])
  })
}

async function runWatchlist(ctx) {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')
  const { data: watchlist } = await supabase.from('watchlist').select('*').eq('user_id', profile.user_id)

  if (!watchlist || watchlist.length === 0) {
    return ctx.reply(`👀 *Watchlist*\n\nNothing being watched.\n\nAdd tokens from any token card via the Watch button.`, { parse_mode: 'Markdown' })
  }

  let message = `👀 *Your Watchlist*\n\n`
  for (const w of watchlist) {
    try {
      const pair = await fetchTokenData(w.token_address)
      const p = pair ? formatPrice(pair.priceUsd) : 'N/A'
      const c = pair ? formatChange(pair.priceChange?.h24) : '—'
      message += `*${w.token_symbol}* — ${p} (24H: ${c})\n`
    } catch {
      message += `*${w.token_symbol}* — unavailable\n`
    }
  }
  await ctx.reply(message, { parse_mode: 'Markdown' })
}

async function runSettings(ctx) {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')
  const s = await getUserSettings(profile.user_id)
  await ctx.reply(
`⚙️ *Settings*

📊 Slippage: *${s.slippage || 1.0}%*
💰 Buy Button 1: *$${s.default_buy_1 || 10}*
💰 Buy Button 2: *$${s.default_buy_2 || 50}*
💰 Buy Button 3: *$${s.default_buy_3 || 100}*

Tap to change:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Set Slippage', 'settings_set_slippage')],
        [
          Markup.button.callback('💰 Buy 1', 'settings_set_buy1'),
          Markup.button.callback('💰 Buy 2', 'settings_set_buy2'),
          Markup.button.callback('💰 Buy 3', 'settings_set_buy3'),
        ]
      ])
    }
  )
}

async function runLeaderboard(ctx) {
  const { data: portfolios } = await supabase.from('portfolios').select('user_id, starting_balance, virtual_balance_usd')
  if (!portfolios || portfolios.length === 0) return ctx.reply('🏆 Leaderboard is empty!')

  const ranked = []
  for (const p of portfolios) {
    const { data: profile } = await supabase.from('profiles').select('display_name').eq('user_id', p.user_id).single()
    const gain = ((p.virtual_balance_usd - p.starting_balance) / p.starting_balance * 100)
    ranked.push({ name: profile?.display_name || 'Anonymous', gain, value: p.virtual_balance_usd })
  }
  ranked.sort((a, b) => b.gain - a.gain)

  const medals = ['🥇', '🥈', '🥉']
  let message = `🏆 *Top Traders — DegenSpace*\n\n`
  ranked.slice(0, 10).forEach((t, i) => {
    message += `${medals[i] || `${i + 1}.`} *${t.name}* — ${t.gain >= 0 ? '+' : ''}${t.gain.toFixed(1)}%\n`
    message += `   💼 ${formatNumber(t.value)}\n\n`
  })
  await ctx.reply(message, { parse_mode: 'Markdown' })
}

async function runReferral(ctx) {
  const profile = await getProfile(ctx.from.id)
  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')
  const refCode = `DS${ctx.from.id}`
  const { data: refs } = await supabase.from('referrals').select('*').eq('referrer_user_id', profile.user_id)
  await ctx.reply(
`🎁 *Your Referral Link*

Share this with friends:
👉 \`https://t.me/degenspacex_bot?start=${refCode}\`

👥 Total referrals: *${refs?.length || 0}*

Earn bonus virtual funds for every friend who joins!`,
    { parse_mode: 'Markdown' }
  )
}

// ================================
// BACKGROUND TASKS
// ================================

async function checkLimitOrders() {
  try {
    const { data: orders } = await supabase.from('limit_orders').select('*').eq('status', 'active')
    if (!orders || orders.length === 0) return

    for (const order of orders) {
      try {
        const pair = await fetchTokenData(order.token_address)
        if (!pair) continue
        const currentPrice = parseFloat(pair.priceUsd)
        const triggerPrice = parseFloat(order.trigger_price)

        let triggered = false
        if (order.order_type === 'LIMIT_BUY' && currentPrice <= triggerPrice) triggered = true
        if (order.order_type === 'TAKE_PROFIT' && currentPrice >= triggerPrice) triggered = true
        if (order.order_type === 'STOP_LOSS' && currentPrice <= triggerPrice) triggered = true

        if (!triggered) continue

        await supabase.from('limit_orders').update({ status: 'triggered' }).eq('id', order.id)

        const fakeCtx = {
          from: { id: parseInt(order.telegram_id) },
          reply: (msg, opts) => bot.telegram.sendMessage(order.telegram_id, msg, opts)
        }

        if (order.order_type === 'LIMIT_BUY' && order.amount_usd) {
          pendingTrades.set(parseInt(order.telegram_id), {
            address: order.token_address, symbol: order.token_symbol,
            name: order.token_symbol, chainId: order.chain_id, priceUsd: pair.priceUsd
          })
          await bot.telegram.sendMessage(order.telegram_id,
            `🤖 *Limit Buy Triggered!*\n\n${order.token_symbol} hit ${formatPrice(triggerPrice)}\nExecuting buy of $${parseFloat(order.amount_usd).toFixed(2)}...`,
            { parse_mode: 'Markdown' }
          )
          await executeBuy(fakeCtx, parseInt(order.telegram_id), parseFloat(order.amount_usd))
        } else if ((order.order_type === 'TAKE_PROFIT' || order.order_type === 'STOP_LOSS') && order.percent) {
          const label = order.order_type === 'TAKE_PROFIT' ? '🎯 Take Profit' : '🛡️ Stop Loss'
          await bot.telegram.sendMessage(order.telegram_id,
            `🤖 *${label} Triggered!*\n\n${order.token_symbol} hit ${formatPrice(triggerPrice)}\nExecuting sell of ${(order.percent * 100).toFixed(0)}%...`,
            { parse_mode: 'Markdown' }
          )
          await executeSell(fakeCtx, parseInt(order.telegram_id), order.token_address, parseFloat(order.percent))
        }
      } catch (e) { console.error('Order exec error:', e.message) }
    }
  } catch (e) { console.error('checkLimitOrders error:', e.message) }
}

async function checkPriceAlerts() {
  try {
    const { data: alerts } = await supabase.from('price_alerts').select('*').eq('triggered', false)
    if (!alerts || alerts.length === 0) return

    for (const alert of alerts) {
      try {
        const pair = await fetchTokenData(alert.token_address)
        if (!pair) continue
        const currentPrice = parseFloat(pair.priceUsd)
        const targetPrice = parseFloat(alert.target_price)
        const triggered = alert.direction === 'above' ? currentPrice >= targetPrice : currentPrice <= targetPrice
        if (!triggered) continue

        await supabase.from('price_alerts').update({ triggered: true }).eq('id', alert.id)
        await bot.telegram.sendMessage(
          alert.telegram_id,
`🔔 *Price Alert Triggered!*

*${alert.token_symbol}* is now ${formatPrice(currentPrice)}
Your target: ${alert.direction} ${formatPrice(targetPrice)} ✅

Paste the contract address to trade!`,
          { parse_mode: 'Markdown' }
        )
      } catch (e) { console.error('Alert trigger error:', e.message) }
    }
  } catch (e) { console.error('checkPriceAlerts error:', e.message) }
}

setInterval(checkLimitOrders, 60000)
setInterval(checkPriceAlerts, 60000)

// ================================
// EXPRESS SERVER + LAUNCH
// ================================
const PORT = process.env.PORT || 3000
const WEBHOOK_URL = process.env.WEBHOOK_URL  // e.g. https://your-service.onrender.com

const app = express()
app.use(express.json())

app.get('/', (req, res) => res.json({ status: 'ok', bot: 'DegenSpace Bot', mode: WEBHOOK_URL ? 'webhook' : 'polling' }))
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }))

if (WEBHOOK_URL) {
  // ── Webhook mode (production on Render / any cloud) ──────────────
  const webhookPath = '/webhook'
  const fullWebhookUrl = `${WEBHOOK_URL.replace(/\/$/, '')}${webhookPath}`

  app.use(bot.webhookCallback(webhookPath))

  app.listen(PORT, async () => {
    console.log(`🌐 Server running on port ${PORT} (webhook mode)`)
    try {
      await bot.telegram.setWebhook(fullWebhookUrl, { drop_pending_updates: true })
      console.log(`✅ Webhook registered: ${fullWebhookUrl}`)
      console.log('🤖 DegenSpace Bot is running (webhook)...')
    } catch (e) {
      console.error('❌ Failed to set webhook:', e.message)
      process.exit(1)
    }
  })
} else {
  // ── Polling mode (local development) ─────────────────────────────
  app.listen(PORT, () => console.log(`🌐 Server running on port ${PORT} (polling mode)`))

  async function launchWithRetry(retries = 8, delay = 5000) {
    for (let i = 0; i < retries; i++) {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true })
        await bot.launch()
        console.log('🤖 DegenSpace Bot is running (polling)...')
        return
      } catch (e) {
        if (e.response?.error_code === 409 && i < retries - 1) {
          console.log(`⚠️ 409 conflict — retrying in ${delay / 1000}s (attempt ${i + 1}/${retries})`)
          await new Promise(r => setTimeout(r, delay))
          delay = Math.min(delay * 2, 60000)
        } else {
          console.error('❌ Failed to launch bot:', e.message)
          throw e
        }
      }
    }
  }

  launchWithRetry()
}

process.once('SIGINT', () => { console.log('Shutting down...'); bot.stop('SIGINT'); process.exit(0) })
process.once('SIGTERM', () => { console.log('Shutting down...'); bot.stop('SIGTERM'); process.exit(0) })

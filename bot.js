const { Telegraf, Markup } = require('telegraf')
const { createClient } = require('@supabase/supabase-js')

// ================================
// CONFIG
// ================================
const BOT_TOKEN = process.env.BOT_TOKEN
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY

const bot = new Telegraf(BOT_TOKEN)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ================================
// HELPERS
// ================================

// Format price with subscript zeros
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
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function formatChange(pct) {
  if (!pct) return '—'
  const n = parseFloat(pct)
  return n >= 0 ? `🟢 +${n.toFixed(2)}%` : `🔴 ${n.toFixed(2)}%`
}

// Fetch token data from DexScreener by contract address
async function fetchTokenData(address) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`
    )
    const data = await res.json()
    if (!data.pairs || data.pairs.length === 0) return null
    // Return the pair with highest liquidity
    return data.pairs.sort((a, b) => 
      (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0]
  } catch (e) {
    return null
  }
}

// Get or create user portfolio in Supabase
async function getOrCreatePortfolio(telegramId, username) {
  // Check if profile exists
  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId.toString())
    .single()

  if (!profile) {
    return null // User needs to link account
  }

  let { data: portfolio } = await supabase
    .from('portfolios')
    .select('*')
    .eq('user_id', profile.user_id)
    .single()

  return { profile, portfolio }
}

// Store pending trade in memory (for confirmation flow)
const pendingTrades = new Map()

// ================================
// BOT COMMANDS
// ================================

// /start
bot.start(async (ctx) => {
  const name = ctx.from.first_name || 'Trader'
  await ctx.reply(
`👋 Welcome to *DegenSpace Bot*, ${name}!

Trade meme coins with virtual funds. Real markets. Zero risk.

*How to use:*
• Paste any *contract address* to get live data + trade
• Use /link to connect your DegenSpace account
• Use /portfolio to see your holdings
• Use /leaderboard to see top traders

*Quick commands:*
/start — This menu
/link — Link your DegenSpace account  
/portfolio — Your virtual portfolio
/balance — Check virtual cash balance
/leaderboard — Top 10 traders
/help — All commands

Paste a contract address to begin! 🚀`,
    { parse_mode: 'Markdown' }
  )
})

// /help
bot.command('help', async (ctx) => {
  await ctx.reply(
`*DegenSpace Bot Commands*

📊 *Market*
Paste any contract address → get price + trade buttons

💼 *Portfolio*
/portfolio — All your holdings with live PnL
/balance — Current virtual cash
/history — Last 10 trades

🏆 *Social*
/leaderboard — Top 10 traders by % gain

⚙️ *Account*
/link — Connect your DegenSpace web account
/reset — Reset portfolio (fresh start)

*Example:*
Paste: \`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\`
Bot shows live USDC data with trade options`,
    { parse_mode: 'Markdown' }
  )
})

// /link — Connect Telegram to DegenSpace account
bot.command('link', async (ctx) => {
  await ctx.reply(
`🔗 *Link Your DegenSpace Account*

To link your account:
1. Go to *degenspacex.netlify.app*
2. Login to your account
3. Go to Wallet tab → Settings
4. Copy your *Link Code*
5. Send it here as: /verify YOUR_CODE

Or register a new account:
/register your@email.com`,
    { parse_mode: 'Markdown' }
  )
})

// /register - create account via bot
bot.command('register', async (ctx) => {
  const parts = ctx.message.text.split(' ')
  if (parts.length < 2) {
    return ctx.reply('Usage: /register your@email.com')
  }
  const email = parts[1]
  
  await ctx.reply(
`✅ To complete registration:

1. Go to degenspacex.netlify.app
2. Sign up with: *${email}*
3. Come back and use /link to connect

Your Telegram ID: \`${ctx.from.id}\`
Give this to the web app when prompted.`,
    { parse_mode: 'Markdown' }
  )
})

// /balance
bot.command('balance', async (ctx) => {
  const telegramId = ctx.from.id.toString()
  
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .single()

  if (!profile) {
    return ctx.reply(
      '❌ Account not linked. Use /link to connect your PaperDex account.'
    )
  }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('*')
    .eq('user_id', profile.user_id)
    .single()

  if (!portfolio) {
    return ctx.reply('❌ No portfolio found. Visit paperdex.lovable.app first.')
  }

  const pnl = portfolio.virtual_balance_usd - portfolio.starting_balance
  const pnlPct = (pnl / portfolio.starting_balance * 100).toFixed(2)
  const emoji = pnl >= 0 ? '🚀' : '💀'

  await ctx.reply(
`💼 *${profile.display_name || 'Your'} Portfolio*

💵 Cash Balance: *$${parseFloat(portfolio.virtual_balance_usd).toFixed(2)}*
🏁 Started With: $${parseFloat(portfolio.starting_balance).toFixed(2)}
${emoji} PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPct}%)

Use /portfolio to see your holdings`,
    { parse_mode: 'Markdown' }
  )
})

// /portfolio
bot.command('portfolio', async (ctx) => {
  const telegramId = ctx.from.id.toString()

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .single()

  if (!profile) {
    return ctx.reply('❌ Account not linked. Use /link first.')
  }

  const { data: holdings } = await supabase
    .from('holdings')
    .select('*')
    .eq('user_id', profile.user_id)

  if (!holdings || holdings.length === 0) {
    return ctx.reply(
      '📭 No holdings yet.\n\nPaste a contract address to start trading!'
    )
  }

  let message = `📊 *Your Holdings*\n\n`
  let totalValue = 0

  for (const h of holdings) {
    try {
      const pair = await fetchTokenData(h.token_address)
      const currentPrice = pair ? parseFloat(pair.priceUsd) : h.avg_buy_price_usd
      const currentValue = currentPrice * parseFloat(h.amount_held)
      const pnl = currentValue - (parseFloat(h.avg_buy_price_usd) * parseFloat(h.amount_held))
      const pnlPct = (pnl / (parseFloat(h.avg_buy_price_usd) * parseFloat(h.amount_held)) * 100).toFixed(1)
      totalValue += currentValue

      message += `*${h.token_symbol}*\n`
      message += `  Amount: ${parseFloat(h.amount_held).toLocaleString()}\n`
      message += `  Value: ${formatNumber(currentValue)}\n`
      message += `  PnL: ${pnl >= 0 ? '🟢' : '🔴'} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)\n\n`
    } catch(e) {
      message += `*${h.token_symbol}* — price unavailable\n\n`
    }
  }

  message += `💼 *Holdings Value: ${formatNumber(totalValue)}*`

  await ctx.reply(message, { parse_mode: 'Markdown' })
})

// /history
bot.command('history', async (ctx) => {
  const telegramId = ctx.from.id.toString()

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .single()

  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')

  const { data: trades } = await supabase
    .from('trades')
    .select('*')
    .eq('user_id', profile.user_id)
    .order('timestamp', { ascending: false })
    .limit(10)

  if (!trades || trades.length === 0) {
    return ctx.reply('📭 No trades yet.')
  }

  let message = `🕐 *Last ${trades.length} Trades*\n\n`

  for (const t of trades) {
    const emoji = t.trade_type === 'BUY' ? '💚' : '🔴'
    const date = new Date(t.timestamp).toLocaleDateString()
    message += `${emoji} *${t.trade_type}* ${t.token_symbol}\n`
    message += `  $${parseFloat(t.amount_usd).toFixed(2)} @ ${formatPrice(t.price_at_trade)}\n`
    message += `  ${date}\n\n`
  }

  await ctx.reply(message, { parse_mode: 'Markdown' })
})

// /leaderboard
bot.command('leaderboard', async (ctx) => {
  const { data: portfolios } = await supabase
    .from('portfolios')
    .select('user_id, starting_balance, virtual_balance_usd')

  if (!portfolios || portfolios.length === 0) {
    return ctx.reply('🏆 Leaderboard is empty — be the first trader!')
  }

  // Fetch display names
  const ranked = []
  for (const p of portfolios) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('user_id', p.user_id)
      .single()

    const gain = ((p.virtual_balance_usd - p.starting_balance) / p.starting_balance * 100)
    ranked.push({
      name: profile?.display_name || 'Anonymous',
      gain,
      value: p.virtual_balance_usd
    })
  }

  ranked.sort((a, b) => b.gain - a.gain)
  const top10 = ranked.slice(0, 10)

  const medals = ['🥇', '🥈', '🥉']
  let message = `🏆 *Top Traders*\n\n`

  top10.forEach((t, i) => {
    const medal = medals[i] || `${i + 1}.`
    const gainStr = t.gain >= 0 ? `+${t.gain.toFixed(1)}%` : `${t.gain.toFixed(1)}%`
    message += `${medal} *${t.name}* — ${gainStr}\n`
    message += `   Portfolio: ${formatNumber(t.value)}\n\n`
  })

  await ctx.reply(message, { parse_mode: 'Markdown' })
})

// ================================
// CONTRACT ADDRESS HANDLER
// Detects when user pastes a contract address
// ================================

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()

  // Skip commands
  if (text.startsWith('/')) return

  // Detect contract address patterns
  // Solana: 32-44 base58 chars
  // EVM: 0x + 40 hex chars
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)
  const isEVM = /^0x[a-fA-F0-9]{40}$/.test(text)

  if (!isSolana && !isEVM) {
    return ctx.reply(
      '👋 Paste a contract address to get live token data and trade!\n\nOr use /help to see all commands.'
    )
  }

  // Fetch token data
  await ctx.reply('🔍 Fetching token data...')

  const pair = await fetchTokenData(text)

  if (!pair) {
    return ctx.reply(
      '❌ Token not found on DexScreener.\n\nMake sure the contract address is correct and the token has a liquidity pool.'
    )
  }

  const name = pair.baseToken?.name || 'Unknown'
  const symbol = pair.baseToken?.symbol || '???'
  const chain = pair.chainId || 'unknown'
  const dex = pair.dexId || 'unknown'
  const price = formatPrice(pair.priceUsd)
  const change1h = formatChange(pair.priceChange?.h1)
  const change24h = formatChange(pair.priceChange?.h24)
  const liquidity = formatNumber(pair.liquidity?.usd)
  const volume = formatNumber(pair.volume?.h24)
  const mcap = formatNumber(pair.marketCap)
  const buys = pair.txns?.h24?.buys || 0
  const sells = pair.txns?.h24?.sells || 0

  // Store token in pending context for this user
  pendingTrades.set(ctx.from.id, {
    address: text,
    symbol,
    name,
    chainId: chain,
    dexId: dex,
    priceUsd: pair.priceUsd,
    pairData: pair
  })

  const message = 
`🪙 *${name}* (${symbol})
🔗 ${chain.toUpperCase()} › ${dex}

💵 Price: *${price}*
📈 1H: ${change1h}
📈 24H: ${change24h}

💧 Liquidity: ${liquidity}
📦 Volume 24H: ${volume}
🏦 Market Cap: ${mcap}
⚡ Txns 24H: ${buys + sells} (${buys}B / ${sells}S)

*Select an action:*`

  await ctx.reply(message, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('💚 Buy $10', `buy_10`),
        Markup.button.callback('💚 Buy $50', `buy_50`),
        Markup.button.callback('💚 Buy $100', `buy_100`),
      ],
      [
        Markup.button.callback('🔴 Sell 50%', `sell_50`),
        Markup.button.callback('🔴 Sell 100%', `sell_100`),
      ],
      [
        Markup.button.callback('📊 Portfolio', `show_portfolio`),
        Markup.button.callback('🔄 Refresh', `refresh_${text}`),
      ]
    ])
  })
})

// ================================
// INLINE BUTTON HANDLERS
// ================================

// Buy handler
bot.action(/^buy_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const amount = parseInt(ctx.match[1])
  const telegramId = ctx.from.id

  const tokenData = pendingTrades.get(telegramId)
  if (!tokenData) {
    return ctx.reply('❌ Token data expired. Paste the contract address again.')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId.toString())
    .single()

  if (!profile) {
    return ctx.reply('❌ Account not linked. Use /link to connect your PaperDex account.')
  }

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('*')
    .eq('user_id', profile.user_id)
    .single()

  if (!portfolio) {
    return ctx.reply('❌ No portfolio found.')
  }

  if (parseFloat(portfolio.virtual_balance_usd) < amount) {
    return ctx.reply(
      `❌ Insufficient balance.\n\nYou have $${parseFloat(portfolio.virtual_balance_usd).toFixed(2)} but tried to spend $${amount}.`
    )
  }

  const price = parseFloat(tokenData.priceUsd)
  const slippage = (Math.random() * 2 + 0.5) / 100
  const fee = tokenData.chainId === 'solana' ? 0.001 : 
              tokenData.chainId === 'ethereum' ? 0.50 : 0.10
  const totalCost = amount + fee
  const tokensReceived = (amount * (1 - slippage)) / price

  // Execute trade in Supabase
  try {
    // Deduct from portfolio
    await supabase
      .from('portfolios')
      .update({ 
        virtual_balance_usd: parseFloat(portfolio.virtual_balance_usd) - totalCost 
      })
      .eq('user_id', profile.user_id)

    // Upsert holding
    const { data: existing } = await supabase
      .from('holdings')
      .select('*')
      .eq('user_id', profile.user_id)
      .eq('token_address', tokenData.address)
      .single()

    if (existing) {
      const newTotal = parseFloat(existing.amount_held) + tokensReceived
      const newAvg = (
        (parseFloat(existing.amount_held) * parseFloat(existing.avg_buy_price_usd)) +
        (tokensReceived * price)
      ) / newTotal

      await supabase
        .from('holdings')
        .update({ 
          amount_held: newTotal, 
          avg_buy_price_usd: newAvg,
          last_updated: new Date().toISOString()
        })
        .eq('id', existing.id)
    } else {
      await supabase
        .from('holdings')
        .insert({
          user_id: profile.user_id,
          token_address: tokenData.address,
          chain_id: tokenData.chainId,
          token_symbol: tokenData.symbol,
          token_name: tokenData.name,
          amount_held: tokensReceived,
          avg_buy_price_usd: price
        })
    }

    // Log trade
    await supabase
      .from('trades')
      .insert({
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
🎯 Received: ${tokensReceived.toLocaleString(undefined, {maximumFractionDigits: 0})} ${tokenData.symbol}
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
})

// Sell handler
bot.action(/^sell_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery()
  const percent = parseInt(ctx.match[1]) / 100
  const telegramId = ctx.from.id

  const tokenData = pendingTrades.get(telegramId)
  if (!tokenData) {
    return ctx.reply('❌ Token data expired. Paste the contract address again.')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId.toString())
    .single()

  if (!profile) return ctx.reply('❌ Account not linked. Use /link first.')

  const { data: holding } = await supabase
    .from('holdings')
    .select('*')
    .eq('user_id', profile.user_id)
    .eq('token_address', tokenData.address)
    .single()

  if (!holding || parseFloat(holding.amount_held) === 0) {
    return ctx.reply(`❌ You don't hold any ${tokenData.symbol}.`)
  }

  const price = parseFloat(tokenData.priceUsd)
  const slippage = (Math.random() * 2 + 0.5) / 100
  const fee = tokenData.chainId === 'solana' ? 0.001 : 
              tokenData.chainId === 'ethereum' ? 0.50 : 0.10
  const sellAmount = parseFloat(holding.amount_held) * percent
  const proceeds = (sellAmount * price * (1 - slippage)) - fee
  const entryPrice = parseFloat(holding.avg_buy_price_usd)
  const pnl = (price - entryPrice) * sellAmount

  try {
    // Update portfolio balance
    const { data: portfolio } = await supabase
      .from('portfolios')
      .select('virtual_balance_usd')
      .eq('user_id', profile.user_id)
      .single()

    await supabase
      .from('portfolios')
      .update({ 
        virtual_balance_usd: parseFloat(portfolio.virtual_balance_usd) + proceeds 
      })
      .eq('user_id', profile.user_id)

    // Update or delete holding
    if (percent === 1) {
      await supabase
        .from('holdings')
        .delete()
        .eq('id', holding.id)
    } else {
      await supabase
        .from('holdings')
        .update({ 
          amount_held: parseFloat(holding.amount_held) - sellAmount,
          last_updated: new Date().toISOString()
        })
        .eq('id', holding.id)
    }

    // Log trade
    await supabase
      .from('trades')
      .insert({
        user_id: profile.user_id,
        token_address: tokenData.address,
        chain_id: tokenData.chainId,
        token_symbol: tokenData.symbol,
        token_name: tokenData.name,
        trade_type: 'SELL',
        amount_usd: proceeds,
        token_amount: sellAmount,
        price_at_trade: price,
        entry_price: entryPrice,
        slippage_applied: slippage,
        fee_applied: fee
      })

    const newBalance = parseFloat(portfolio.virtual_balance_usd) + proceeds

    await ctx.reply(
`${pnl >= 0 ? '🚀' : '💀'} *Sell Executed!*

🪙 ${tokenData.symbol} (${(percent * 100).toFixed(0)}% sold)
💵 Received: $${proceeds.toFixed(2)}
📊 Sell Price: ${formatPrice(price)}
🎯 Entry Price: ${formatPrice(entryPrice)}
${pnl >= 0 ? '🟢' : '🔴'} Realized PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
⛽ Fee: $${fee.toFixed(3)}

💼 New Balance: *$${newBalance.toFixed(2)}*`,
      { parse_mode: 'Markdown' }
    )
  } catch (e) {
    await ctx.reply('❌ Sell failed. Please try again.')
    console.error(e)
  }
})

// Portfolio inline button
bot.action('show_portfolio', async (ctx) => {
  await ctx.answerCbQuery()
  ctx.message = { text: '/portfolio', ...ctx.message }
  // Trigger portfolio command
  const telegramId = ctx.from.id.toString()
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramId)
    .single()

  if (!profile) return ctx.reply('❌ Use /link to connect your account.')

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('*')
    .eq('user_id', profile.user_id)
    .single()

  const pnl = portfolio.virtual_balance_usd - portfolio.starting_balance
  await ctx.reply(
`💼 *Portfolio Summary*

💵 Cash: $${parseFloat(portfolio.virtual_balance_usd).toFixed(2)}
${pnl >= 0 ? '🚀' : '💀'} PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}

Use /portfolio for full holdings breakdown`,
    { parse_mode: 'Markdown' }
  )
})

// ================================
// LAUNCH BOT
// ================================
bot.launch()
console.log('🤖 DegenSpace Bot is running...')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

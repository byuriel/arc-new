// Arc'teryx Stock Monitor - FINAL FIXED VERSION
// Based on actual __NEXT_DATA__ structure from arcteryx.com
// 
// Key data paths:
// - Colors: product.colourOptions.options (value = colorId, label = colorName)
// - Stock: product.variants (colourId + stockStatus)

const axios = require('axios');
const cheerio = require('cheerio');

// ===== CONFIGURATION =====
const CONFIG = {
  PRODUCT_URL: process.env.PRODUCT_URL || 'https://arcteryx.com/us/en/shop/bird-head-toque',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL_HERE',
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID || '',
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ENABLE_COMMANDS: process.env.ENABLE_COMMANDS === 'true'
};

// ===== STATE =====
let previousStock = { inStock: [], outOfStock: [] };
let checkCount = 0;
let monitorStats = {
  totalChecks: 0,
  totalRestocks: 0,
  errors: 0,
  startTime: new Date()
};

// ===== DISCORD =====
async function sendDiscordNotification(title, description, color, fields = []) {
  if (!CONFIG.DISCORD_WEBHOOK_URL || CONFIG.DISCORD_WEBHOOK_URL === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.log('⚠️  Webhook not configured');
    return;
  }
  
  try {
    await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
      embeds: [{
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: "Arc'teryx Stock Monitor" }
      }]
    });
    console.log('✅ Discord notification sent');
  } catch (error) {
    console.error('❌ Discord error:', error.message);
  }
}

async function sendRestockAlert(colors) {
  const fields = colors.map(c => ({
    name: `🟢 ${c.label}`,
    value: `**IN STOCK!**\n[Buy Now](${CONFIG.PRODUCT_URL})`,
    inline: true
  }));

  await sendDiscordNotification(
    '🎉 RESTOCK ALERT - Bird Head Toque',
    `**${colors.length}** color${colors.length > 1 ? 's' : ''} just restocked! 🔥`,
    3066993,
    fields
  );
}

async function sendInventorySnapshot(inStock, outOfStock) {
  const inStockList = inStock.length > 0
    ? inStock.map(c => `✅ ${c.label}`).join('\n')
    : '❌ None currently';

  const outOfStockList = outOfStock.length > 0
    ? outOfStock.map(c => `🔴 ${c.label}`).join('\n')
    : '✅ All colors available!';

  await sendDiscordNotification(
    '📊 Complete Inventory Snapshot',
    'Current status of all Bird Head Toque colors',
    3447003,
    [
      { name: `🟢 In Stock (${inStock.length})`, value: inStockList.substring(0, 1024), inline: false },
      { name: `⭕ Out of Stock (${outOfStock.length})`, value: outOfStockList.substring(0, 1024), inline: false },
      { name: '🔍 Total Colors', value: `${inStock.length + outOfStock.length} variants tracked`, inline: true },
      { name: '⏰ Last Updated', value: new Date().toLocaleString(), inline: true }
    ]
  );
}

// ===== STOCK CHECKING =====
async function checkStock() {
  checkCount++;
  monitorStats.totalChecks++;
  
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🔍 Check #${checkCount} - ${new Date().toLocaleString()}`);
  console.log('═'.repeat(50));
  
  try {
    // Fetch page
    const response = await axios.get(CONFIG.PRODUCT_URL, {
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache',
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const nextDataScript = $('script#__NEXT_DATA__').html();
    
    if (!nextDataScript) {
      throw new Error('__NEXT_DATA__ not found');
    }
    
    const nextData = JSON.parse(nextDataScript);
    const product = nextData?.props?.pageProps?.product;
    
    if (!product) {
      throw new Error('Product data not found');
    }
    
    // Get color options
    const colorOptions = product.colourOptions?.options || [];
    
    // Get variants with stock status
    const variants = product.variants || [];
    
    console.log(`📦 Product: ${product.name || 'Bird Head Toque'}`);
    console.log(`🎨 Colors: ${colorOptions.length}`);
    console.log(`📊 Variants: ${variants.length}`);
    
    // Build stock map from variants
    // variants array has: { colourId, stockStatus: "InStock" | "OutOfStock" }
    const stockMap = new Map();
    variants.forEach(v => {
      stockMap.set(v.colourId, v.stockStatus);
    });
    
    // Categorize colors
    const currentStock = { inStock: [], outOfStock: [] };
    
    colorOptions.forEach(color => {
      const colorId = color.value;
      const stockStatus = stockMap.get(colorId);
      
      const colorInfo = {
        colorId,
        label: color.label,
        primaryColour: color.primaryColour,
        hexCode: color.hexCode
      };
      
      if (stockStatus === 'InStock') {
        currentStock.inStock.push(colorInfo);
        console.log(`  ✅ ${color.label} - IN STOCK`);
      } else {
        currentStock.outOfStock.push(colorInfo);
        console.log(`  ❌ ${color.label} - Out of Stock`);
      }
    });
    
    // Summary
    console.log(`\n📊 Summary: ${currentStock.inStock.length} in stock, ${currentStock.outOfStock.length} out of stock`);
    
    // Detect restocks (skip first run)
    if (previousStock.outOfStock.length > 0 || previousStock.inStock.length > 0) {
      const newlyAvailable = currentStock.inStock.filter(color =>
        previousStock.outOfStock.some(prev => prev.colorId === color.colorId)
      );
      
      if (newlyAvailable.length > 0) {
        console.log(`\n🎉🎉🎉 RESTOCK DETECTED! 🎉🎉🎉`);
        newlyAvailable.forEach(c => console.log(`  🔥 ${c.label}`));
        monitorStats.totalRestocks += newlyAvailable.length;
        await sendRestockAlert(newlyAvailable);
      }
    }
    
    // Periodic snapshot every hour (12 checks at 5 min interval)
    if (checkCount % 12 === 0) {
      console.log('\n📊 Sending hourly snapshot...');
      await sendInventorySnapshot(currentStock.inStock, currentStock.outOfStock);
    }
    
    previousStock = currentStock;
    console.log(`\n⏰ Next check in ${CONFIG.CHECK_INTERVAL} minutes`);
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    monitorStats.errors++;
    
    await sendDiscordNotification(
      '⚠️ Monitor Error',
      `Error: ${error.message}`,
      15158332,
      [{ name: 'Time', value: new Date().toLocaleString(), inline: false }]
    );
  }
}

// ===== DISCORD BOT (optional) =====
async function setupDiscordBot() {
  if (!CONFIG.DISCORD_BOT_TOKEN || !CONFIG.ENABLE_COMMANDS) {
    console.log('ℹ️  Discord commands disabled');
    return;
  }
  
  try {
    const { Client, GatewayIntentBits } = require('discord.js');
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });
    
    client.on('ready', () => console.log(`✅ Bot: ${client.user.tag}`));
    
    client.on('messageCreate', async (message) => {
      if (message.author.bot || !message.content.startsWith('!')) return;
      if (CONFIG.DISCORD_CHANNEL_ID && message.channel.id !== CONFIG.DISCORD_CHANNEL_ID) return;
      
      const cmd = message.content.toLowerCase().trim();
      
      if (cmd === '!status') {
        const uptime = Math.floor((Date.now() - monitorStats.startTime) / 1000 / 60);
        await sendDiscordNotification('📊 Status', 'Running', 5814783, [
          { name: 'Uptime', value: `${Math.floor(uptime/60)}h ${uptime%60}m`, inline: true },
          { name: 'Checks', value: `${monitorStats.totalChecks}`, inline: true },
          { name: 'Restocks', value: `${monitorStats.totalRestocks}`, inline: true }
        ]);
      } else if (cmd === '!list' || cmd === '!snapshot') {
        await sendInventorySnapshot(previousStock.inStock, previousStock.outOfStock);
      } else if (cmd === '!check') {
        await sendDiscordNotification('🔄 Manual Check', 'Running...', 5814783, []);
        await checkStock();
      } else if (cmd === '!help') {
        await sendDiscordNotification('💡 Commands', '', 5814783, [
          { name: '!status', value: 'Monitor status', inline: false },
          { name: '!list', value: 'Current stock', inline: false },
          { name: '!check', value: 'Force check', inline: false }
        ]);
      }
    });
    
    await client.login(CONFIG.DISCORD_BOT_TOKEN);
  } catch (error) {
    console.error('Bot error:', error.message);
  }
}

// ===== MAIN =====
async function main() {
  console.log('\n' + '═'.repeat(50));
  console.log("🏔️  ARC'TERYX STOCK MONITOR - BIRD HEAD TOQUE");
  console.log('═'.repeat(50));
  console.log(`📍 URL: ${CONFIG.PRODUCT_URL}`);
  console.log(`⏰ Interval: ${CONFIG.CHECK_INTERVAL} min`);
  console.log(`🔔 Webhook: ${CONFIG.DISCORD_WEBHOOK_URL !== 'YOUR_DISCORD_WEBHOOK_URL_HERE' ? '✅' : '❌'}`);
  console.log('═'.repeat(50) + '\n');
  
  await setupDiscordBot();
  
  // Initial check
  await checkStock();
  
  // Start loop
  setInterval(checkStock, CONFIG.CHECK_INTERVAL * 60 * 1000);
  
  console.log('\n✅ Monitor running. Ctrl+C to stop.\n');
}

// Shutdown handlers
process.on('SIGTERM', async () => {
  console.log('\n⚠️ Shutting down...');
  await sendDiscordNotification('🔴 Monitor Stopped', 'Shutdown signal', 15158332, []);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n⚠️ Shutting down...');
  await sendDiscordNotification('🔴 Monitor Stopped', 'Manual shutdown', 15158332, []);
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// Arc'teryx Stock Monitor - COMPREHENSIVE FIX
// 
// KEY CHANGES FROM ORIGINAL:
// 1. Multiple fallback paths for finding color options in __NEXT_DATA__
// 2. Better debugging to see exactly what's being parsed
// 3. Direct stock check from initial page data when available
// 4. Improved URL construction for variant checking
// 5. More robust "in stock" vs "out of stock" detection

const axios = require('axios');
const cheerio = require('cheerio');

// ===== CONFIGURATION =====
const CONFIG = {
  PRODUCT_URL: process.env.PRODUCT_URL || 'https://arcteryx.com/us/en/shop/bird-head-toque',
  PRODUCT_ID: process.env.PRODUCT_ID || 'X000006756', // Extracted from image URLs
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL_HERE',
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID || '',
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ENABLE_COMMANDS: process.env.ENABLE_COMMANDS === 'true',
  DEBUG: process.env.DEBUG === 'true' || true // Enable debug mode
};

// ===== STATE MANAGEMENT =====
let previousStock = { inStock: [], outOfStock: [] };
let checkCount = 0;
let allKnownColors = new Map();
let discordClient = null;
let lastCheckTime = null;
let monitorStats = {
  totalChecks: 0,
  totalRestocks: 0,
  errors: 0,
  startTime: new Date()
};

// ===== LOGGING =====
function log(message) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function debug(message, data = null) {
  if (CONFIG.DEBUG) {
    console.log(`[DEBUG] ${message}`);
    if (data !== null) {
      if (typeof data === 'object') {
        console.log(JSON.stringify(data, null, 2).substring(0, 1000));
      } else {
        console.log(data);
      }
    }
  }
}

// ===== DISCORD FUNCTIONS =====
async function sendDiscordNotification(title, description, color, fields = []) {
  if (!CONFIG.DISCORD_WEBHOOK_URL || CONFIG.DISCORD_WEBHOOK_URL === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    log('⚠️  Discord webhook not configured');
    return;
  }
  
  try {
    const embed = {
      title,
      description,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: "Arc'teryx Stock Monitor" }
    };
    await axios.post(CONFIG.DISCORD_WEBHOOK_URL, { embeds: [embed] });
    log('✅ Discord notification sent');
  } catch (error) {
    log(`❌ Discord error: ${error.message}`);
  }
}

async function sendRestockAlert(newColors) {
  const fields = newColors.map(color => ({
    name: `🟢 ${color.label}`,
    value: `**IN STOCK!**\n[Buy Now](${CONFIG.PRODUCT_URL}?color=${encodeURIComponent(color.variantId)})`,
    inline: true
  }));

  await sendDiscordNotification(
    '🎉 RESTOCK ALERT - Bird Head Toque',
    `**${newColors.length}** color${newColors.length > 1 ? 's' : ''} just restocked! 🔥`,
    3066993, // Green
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
    `Current status of Bird Head Toque`,
    3447003, // Blue
    [
      { name: `🟢 In Stock (${inStock.length})`, value: inStockList.substring(0, 1024), inline: false },
      { name: `⭕ Out of Stock (${outOfStock.length})`, value: outOfStockList.substring(0, 1024), inline: false },
      { name: '🔍 Total Colors', value: `${allKnownColors.size} variants tracked`, inline: true },
      { name: '⏰ Last Updated', value: new Date().toLocaleString(), inline: true }
    ]
  );
}

async function sendErrorAlert(error) {
  monitorStats.errors++;
  await sendDiscordNotification(
    '⚠️ Monitor Error',
    `Error: ${error}`,
    15158332, // Red
    [{ name: 'Time', value: new Date().toLocaleString(), inline: false }]
  );
}

// ===== DEEP OBJECT SEARCH =====
// Recursively searches an object for a key and returns the value
function findInObject(obj, targetKey, maxDepth = 10, currentDepth = 0) {
  if (currentDepth > maxDepth || !obj || typeof obj !== 'object') {
    return null;
  }
  
  if (obj[targetKey] !== undefined) {
    return obj[targetKey];
  }
  
  for (const key of Object.keys(obj)) {
    const result = findInObject(obj[key], targetKey, maxDepth, currentDepth + 1);
    if (result !== null) {
      return result;
    }
  }
  
  return null;
}

// ===== MAIN STOCK CHECKING FUNCTIONS =====
async function fetchAndParseProduct() {
  log('📡 Fetching product page...');
  
  const response = await axios.get(CONFIG.PRODUCT_URL, {
    headers: {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Cache-Control': 'no-cache',
    },
    timeout: 30000
  });
  
  const html = response.data;
  const $ = cheerio.load(html);
  
  log(`📄 Page loaded (${Math.round(html.length / 1024)}KB)`);
  
  // Find __NEXT_DATA__
  const nextDataScript = $('script#__NEXT_DATA__').html();
  
  if (!nextDataScript) {
    throw new Error('__NEXT_DATA__ not found - page structure may have changed');
  }
  
  const nextData = JSON.parse(nextDataScript);
  debug('Found __NEXT_DATA__, parsing...');
  
  // Try multiple paths to find product data
  const pageProps = nextData?.props?.pageProps;
  
  if (!pageProps) {
    throw new Error('pageProps not found in __NEXT_DATA__');
  }
  
  debug('pageProps keys:', Object.keys(pageProps));
  
  // Look for product in various locations
  let product = pageProps.product;
  
  // If not directly on pageProps, check dehydratedState (React Query)
  if (!product && pageProps.dehydratedState?.queries) {
    debug('Checking dehydratedState queries...');
    for (const query of pageProps.dehydratedState.queries) {
      if (query.state?.data?.product) {
        product = query.state.data.product;
        debug('Found product in dehydratedState');
        break;
      }
      // Sometimes product data is directly in query.state.data
      if (query.state?.data?.colourOptions || query.state?.data?.colorOptions) {
        product = query.state.data;
        debug('Found product data in dehydratedState');
        break;
      }
    }
  }
  
  // Check initialData
  if (!product && pageProps.initialData?.product) {
    product = pageProps.initialData.product;
    debug('Found product in initialData');
  }
  
  if (!product) {
    debug('Full pageProps structure:', pageProps);
    throw new Error('Product data not found in any expected location');
  }
  
  debug('Product keys:', Object.keys(product));
  
  // Extract color options - try multiple paths
  let colorOptions = null;
  
  const colorPaths = [
    product.colourOptions?.options,
    product.colorOptions?.options,
    product.colourOptions,
    product.colorOptions,
    product.variations?.color?.values,
    product.variationAttributes?.find(v => v.id === 'color')?.values,
    findInObject(product, 'colourOptions'),
    findInObject(product, 'colorOptions'),
  ];
  
  for (const path of colorPaths) {
    if (Array.isArray(path) && path.length > 0) {
      colorOptions = path;
      debug(`Found ${colorOptions.length} color options`);
      break;
    }
    // Handle case where colourOptions is an object with options inside
    if (path && typeof path === 'object' && path.options) {
      colorOptions = path.options;
      debug(`Found ${colorOptions.length} color options (nested)`);
      break;
    }
  }
  
  if (!colorOptions || colorOptions.length === 0) {
    debug('Product structure:', product);
    throw new Error('No color options found in product data');
  }
  
  // Parse each color variant
  const variants = colorOptions.map(opt => {
    // Extract variant info - field names can vary
    const variant = {
      variantId: opt.value || opt.id || opt.colourCode || opt.code,
      label: opt.label || opt.displayValue || opt.name || opt.colourName || 'Unknown',
      primaryColour: opt.primaryColour || opt.color || opt.colourCode,
      hexCode: opt.hexCode || opt.hex,
      // Try to get availability from initial data
      available: opt.available ?? opt.inStock ?? opt.ATC ?? null
    };
    
    debug(`Parsed variant: ${variant.label} (${variant.variantId}) - available: ${variant.available}`);
    return variant;
  });
  
  // Get selected color's stock status
  const selectedColour = product.selectedColour || product.selectedColor;
  const globalATC = product.ATC;
  
  debug(`Selected colour:`, selectedColour?.label);
  debug(`Global ATC:`, globalATC);
  
  return {
    variants,
    selectedColour,
    globalATC,
    productName: product.analyticsName || product.name || 'Bird Head Toque'
  };
}

// Check stock for a specific variant by loading its page
async function checkVariantStock(variantId, label) {
  try {
    // Construct URL with color parameter
    const variantUrl = `${CONFIG.PRODUCT_URL}?color=${encodeURIComponent(variantId)}`;
    debug(`Checking: ${variantUrl}`);
    
    const response = await axios.get(variantUrl, {
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000
    });
    
    const $ = cheerio.load(response.data);
    
    // Method 1: Parse __NEXT_DATA__ for this variant
    const nextDataScript = $('script#__NEXT_DATA__').html();
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript);
        const product = nextData?.props?.pageProps?.product;
        
        // Check ATC (Add To Cart) flag
        if (product?.ATC === true) {
          debug(`  ATC = true`);
          return true;
        }
        if (product?.ATC === false) {
          debug(`  ATC = false`);
          return false;
        }
        
        // Check available flag
        if (product?.available === true) return true;
        if (product?.available === false) return false;
        
        // Check selectedColour
        const selected = product?.selectedColour || product?.selectedColor;
        if (selected?.available === true) return true;
        if (selected?.available === false) return false;
        if (selected?.ATC === true) return true;
        if (selected?.ATC === false) return false;
        
      } catch (e) {
        debug(`  JSON parse error: ${e.message}`);
      }
    }
    
    // Method 2: Look for "Notify me" button (out of stock indicator)
    const pageText = response.data.toLowerCase();
    
    if (pageText.includes('notify me') || pageText.includes('notify-me')) {
      debug(`  Found "Notify me" - OUT OF STOCK`);
      return false;
    }
    
    // Method 3: Look for "Add to Cart" or "Shop Now"
    if (pageText.includes('add to cart') || pageText.includes('add to bag') || 
        pageText.includes('shop now') || pageText.includes('"atc"')) {
      // But make sure it's not disabled
      if (!pageText.includes('disabled') && !pageText.includes('out of stock')) {
        debug(`  Found add to cart - IN STOCK`);
        return true;
      }
    }
    
    // Method 4: Check for explicit out of stock text
    if (pageText.includes('out of stock') || pageText.includes('sold out')) {
      debug(`  Found "out of stock" text`);
      return false;
    }
    
    debug(`  Could not determine stock status`);
    return null;
    
  } catch (error) {
    debug(`  Error checking variant: ${error.message}`);
    return null;
  }
}

// Main check function
async function checkStock() {
  checkCount++;
  monitorStats.totalChecks++;
  
  console.log('\n' + '═'.repeat(60));
  log(`🔍 Check #${checkCount}`);
  console.log('═'.repeat(60));
  
  try {
    // Fetch and parse product data
    const productData = await fetchAndParseProduct();
    
    log(`📦 Product: ${productData.productName}`);
    log(`🎨 Found ${productData.variants.length} color variants`);
    
    // Update known colors
    productData.variants.forEach(v => {
      allKnownColors.set(v.variantId, v);
    });
    
    // Determine stock status for each variant
    const currentStock = { inStock: [], outOfStock: [] };
    
    for (const variant of productData.variants) {
      console.log(`  Checking ${variant.label}...`);
      
      let isAvailable = variant.available;
      
      // If not determined from initial data, check the variant page
      if (isAvailable === null) {
        isAvailable = await checkVariantStock(variant.variantId, variant.label);
        // Add delay between requests
        await new Promise(r => setTimeout(r, 1500));
      }
      
      if (isAvailable === true) {
        currentStock.inStock.push(variant);
        console.log(`    ✅ IN STOCK`);
      } else {
        currentStock.outOfStock.push(variant);
        console.log(`    ❌ OUT OF STOCK`);
      }
    }
    
    // Summary
    console.log('\n' + '─'.repeat(40));
    log('📊 SUMMARY');
    console.log('─'.repeat(40));
    console.log(`✅ In Stock: ${currentStock.inStock.length}`);
    currentStock.inStock.forEach(c => console.log(`   • ${c.label}`));
    console.log(`❌ Out of Stock: ${currentStock.outOfStock.length}`);
    currentStock.outOfStock.forEach(c => console.log(`   • ${c.label}`));
    
    // Detect restocks (skip on first run)
    if (previousStock.outOfStock.length > 0 || previousStock.inStock.length > 0) {
      const newlyAvailable = currentStock.inStock.filter(color =>
        previousStock.outOfStock.some(prev => prev.variantId === color.variantId)
      );
      
      if (newlyAvailable.length > 0) {
        console.log('\n🎉🎉🎉 RESTOCK DETECTED! 🎉🎉🎉');
        newlyAvailable.forEach(c => console.log(`  🔥 ${c.label}`));
        monitorStats.totalRestocks += newlyAvailable.length;
        await sendRestockAlert(newlyAvailable);
      }
    }
    
    // Periodic snapshot (every 12 checks = ~1 hour at 5min interval)
    if (checkCount % 12 === 0) {
      log('📊 Sending periodic snapshot...');
      await sendInventorySnapshot(currentStock.inStock, currentStock.outOfStock);
    }
    
    previousStock = currentStock;
    lastCheckTime = new Date();
    
    log(`⏰ Next check in ${CONFIG.CHECK_INTERVAL} minutes`);
    
  } catch (error) {
    console.error(`\n❌ ERROR: ${error.message}`);
    console.error(error.stack);
    await sendErrorAlert(error.message);
  }
}

// ===== DISCORD BOT =====
async function setupDiscordBot() {
  if (!CONFIG.DISCORD_BOT_TOKEN || !CONFIG.ENABLE_COMMANDS) {
    log('ℹ️  Discord commands disabled');
    return;
  }
  
  try {
    const { Client, GatewayIntentBits } = require('discord.js');
    discordClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });
    
    discordClient.on('ready', () => log(`✅ Bot: ${discordClient.user.tag}`));
    
    discordClient.on('messageCreate', async (message) => {
      if (message.author.bot || !message.content.startsWith('!')) return;
      if (CONFIG.DISCORD_CHANNEL_ID && message.channel.id !== CONFIG.DISCORD_CHANNEL_ID) return;
      
      const cmd = message.content.toLowerCase().trim();
      
      if (cmd === '!status') {
        const uptime = Math.floor((Date.now() - monitorStats.startTime) / 1000 / 60);
        await sendDiscordNotification('📊 Status', 'Running', 5814783, [
          { name: 'Uptime', value: `${Math.floor(uptime/60)}h ${uptime%60}m`, inline: true },
          { name: 'Checks', value: `${monitorStats.totalChecks}`, inline: true },
          { name: 'Colors', value: `${allKnownColors.size}`, inline: true }
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
    
    await discordClient.login(CONFIG.DISCORD_BOT_TOKEN);
  } catch (error) {
    log(`❌ Bot setup failed: ${error.message}`);
  }
}

// ===== MAIN =====
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log("🏔️  ARC'TERYX STOCK MONITOR");
  console.log('═'.repeat(60));
  console.log(`📍 Product: ${CONFIG.PRODUCT_URL}`);
  console.log(`⏰ Interval: ${CONFIG.CHECK_INTERVAL} minutes`);
  console.log(`🔔 Webhook: ${CONFIG.DISCORD_WEBHOOK_URL !== 'YOUR_DISCORD_WEBHOOK_URL_HERE' ? '✅' : '❌'}`);
  console.log(`🐛 Debug: ${CONFIG.DEBUG ? '✅' : '❌'}`);
  console.log('═'.repeat(60) + '\n');
  
  await setupDiscordBot();
  
  // Initial check
  log('🔄 Running initial check...');
  await checkStock();
  
  // Start loop
  setInterval(checkStock, CONFIG.CHECK_INTERVAL * 60 * 1000);
  
  log('✅ Monitor running. Ctrl+C to stop.\n');
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('⚠️  Shutting down...');
  await sendDiscordNotification('🔴 Monitor Stopped', 'Shutdown signal', 15158332, []);
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('⚠️  Shutting down (Ctrl+C)...');
  await sendDiscordNotification('🔴 Monitor Stopped', 'Manual shutdown', 15158332, []);
  process.exit(0);
});

main().catch(error => {
  console.error('Fatal:', error);
  process.exit(1);
});

// Arc'teryx Stock Monitor - FIXED VERSION
// Key fixes:
// 1. Extract actual product ID from page data
// 2. Properly construct variant URLs
// 3. Better stock detection logic

const axios = require('axios');
const cheerio = require('cheerio');

// ===== CONFIGURATION =====
const CONFIG = {
  PRODUCT_URL: 'https://arcteryx.com/us/en/shop/bird-head-toque',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL_HERE',
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID || '',
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ENABLE_COMMANDS: process.env.ENABLE_COMMANDS === 'true'
};

// ===== STATE MANAGEMENT =====
let previousStock = {};
let checkCount = 0;
let allKnownColors = new Map();
let discordClient = null;
let lastCheckTime = null;
let productId = null; // FIX: Store the actual product ID
let monitorStats = {
  totalChecks: 0,
  totalRestocks: 0,
  errors: 0,
  startTime: new Date()
};

// ===== DISCORD WEBHOOK FUNCTIONS =====
async function sendDiscordNotification(title, description, color, fields = []) {
  try {
    const embed = {
      title: title,
      description: description,
      color: color,
      fields: fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Arc\'teryx Stock Monitor' },
      thumbnail: { url: 'https://arcteryx.com/on/demandware.static/-/Library-Sites-ArcteryxSharedLibrary/default/dw0c0b0f0e/images/brand-logo/Arc-teryx-logo.png' }
    };

    await axios.post(CONFIG.DISCORD_WEBHOOK_URL, { embeds: [embed] });
    console.log('✅ Discord notification sent');
  } catch (error) {
    console.error('❌ Failed to send Discord notification:', error.message);
  }
}

async function sendRestockAlert(newColors) {
  const fields = newColors.map(color => ({
    name: `${color.label}`,
    value: `✅ **Back in Stock!**\nVariant ID: ${color.variantId}\nColor: ${color.primaryColour}\n[View Product](${CONFIG.PRODUCT_URL})`,
    inline: true
  }));

  await sendDiscordNotification(
    '🎉 RESTOCK ALERT - Bird Head Toque',
    `**${newColors.length}** color${newColors.length > 1 ? 's' : ''} just came back in stock! 🔥`,
    3066993,
    fields
  );
}

async function sendInventorySnapshot(inStock, outOfStock) {
  const inStockList = inStock.length > 0 
    ? inStock.map(c => `✅ **${c.label}**`).join('\n')
    : '❌ None currently';
  
  const outOfStockList = outOfStock.length > 0
    ? outOfStock.map(c => `🔴 **${c.label}**`).join('\n')
    : '✅ All colors available!';

  await sendDiscordNotification(
    '📊 Complete Inventory Snapshot',
    `Current status of all Bird Head Toque colors`,
    3447003,
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
    `Failed to check stock: ${error}`,
    15158332,
    [
      { name: 'Error Details', value: error.toString().substring(0, 1024), inline: false },
      { name: 'Time', value: new Date().toLocaleString(), inline: false }
    ]
  );
}

async function sendCommandResponse(title, description, fields = []) {
  await sendDiscordNotification(title, description, 5814783, fields);
}

async function handleStatusCommand() {
  const uptime = Math.floor((Date.now() - monitorStats.startTime) / 1000 / 60);
  const uptimeHours = Math.floor(uptime / 60);
  const uptimeMinutes = uptime % 60;
  
  await sendCommandResponse(
    '📊 Monitor Status',
    'Current status of the stock monitor',
    [
      { name: '🟢 Status', value: 'Running', inline: true },
      { name: '⏱️ Uptime', value: `${uptimeHours}h ${uptimeMinutes}m`, inline: true },
      { name: '🔍 Total Checks', value: `${monitorStats.totalChecks}`, inline: true },
      { name: '🎉 Restocks Found', value: `${monitorStats.totalRestocks}`, inline: true },
      { name: '❌ Errors', value: `${monitorStats.errors}`, inline: true },
      { name: '⏰ Check Interval', value: `${CONFIG.CHECK_INTERVAL} min`, inline: true },
      { name: '🕐 Last Check', value: lastCheckTime ? lastCheckTime.toLocaleTimeString() : 'Not yet', inline: false },
      { name: '🎨 Colors Tracked', value: `${allKnownColors.size} variants`, inline: false }
    ]
  );
}

async function handleListCommand() {
  if (!previousStock.inStock && !previousStock.outOfStock) {
    await sendCommandResponse('⏳ No Data Yet', 'The monitor hasn\'t completed its first check yet!', []);
    return;
  }

  await sendInventorySnapshot(previousStock.inStock || [], previousStock.outOfStock || []);
}

async function handleHelpCommand() {
  await sendCommandResponse(
    '💡 Available Commands',
    'Send these commands in Discord:',
    [
      { name: '`!status`', value: 'Show monitor status', inline: false },
      { name: '`!list`', value: 'List all colors and availability', inline: false },
      { name: '`!check`', value: 'Force immediate stock check', inline: false },
      { name: '`!snapshot`', value: 'Get inventory snapshot', inline: false },
      { name: '`!help`', value: 'Show this message', inline: false }
    ]
  );
}

async function handleCheckCommand() {
  await sendCommandResponse('🔄 Manual Check Triggered', 'Running stock check...', []);
  await checkStock();
}

async function handleSnapshotCommand() {
  if (!previousStock.inStock && !previousStock.outOfStock) {
    await sendCommandResponse('⏳ No Data Yet', 'Monitor hasn\'t completed first check!', []);
    return;
  }
  await sendInventorySnapshot(previousStock.inStock || [], previousStock.outOfStock || []);
}

// ===== STOCK CHECKING FUNCTIONS =====
async function fetchProductData() {
  try {
    // Try API endpoint first
    const apiUrl = 'https://arcteryx.com/api/graphql';
    const query = {
      operationName: 'Product',
      variables: {
        slug: 'bird-head-toque',
        locale: 'en-US'
      },
      query: `query Product($slug: String!, $locale: String!) {
        product(slug: $slug, locale: $locale) {
          id
          name
          analyticsName
          variants {
            id
            color
            available
            label
          }
          colourOptions {
            options {
              value
              label
              primaryColour
              hexCode
              available
            }
          }
        }
      }`
    };

    console.log('Trying GraphQL API...');
    const apiResponse = await axios.post(apiUrl, query, {
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000
    });

    if (apiResponse.data?.data?.product) {
      console.log('✅ Got data from GraphQL API');
      return apiResponse.data.data.product;
    }

    throw new Error('GraphQL API returned no product data');
  } catch (apiError) {
    console.log('GraphQL failed, trying HTML scraping:', apiError.message);
    
    // Fallback to HTML scraping
    const response = await axios.get(CONFIG.PRODUCT_URL, {
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
      },
      timeout: 30000
    });
    
    return response.data;
  }
}

function parseStockData(data) {
  const stockData = {
    inStock: [],
    outOfStock: [],
    productName: 'Bird Head Toque',
    allVariants: []
  };

  try {
    // Check if data is already a product object (from API)
    if (data && typeof data === 'object' && !data.includes) {
      console.log('Parsing API response...');
      const product = data;
      
      productId = product.id || 'X000006756';
      stockData.productName = product.analyticsName || product.name || 'Bird Head Toque';
      
      const colorOptions = product.colourOptions?.options || product.variants || [];
      
      console.log(`📦 Found ${colorOptions.length} color variants in API data`);

      colorOptions.forEach(option => {
        const variantInfo = {
          variantId: option.value || option.id || option.color,
          label: option.label || option.color,
          primaryColour: option.primaryColour || option.color,
          hexCode: option.hexCode,
          available: option.available,
          badges: option.badges || [],
        };

        allKnownColors.set(variantInfo.variantId, variantInfo);
        stockData.allVariants.push(variantInfo);
        
        // If API provides availability, sort immediately
        if (typeof option.available === 'boolean') {
          if (option.available) {
            stockData.inStock.push(variantInfo);
          } else {
            stockData.outOfStock.push(variantInfo);
          }
        }
      });

      return stockData;
    }

    // Otherwise try HTML parsing
    console.log('Parsing HTML response...');
    const $ = cheerio.load(data);
    
    let nextDataScript = $('#__NEXT_DATA__').html();
    
    if (!nextDataScript) {
      $('script[type="application/json"]').each((i, elem) => {
        const content = $(elem).html();
        if (content && content.includes('pageProps')) {
          nextDataScript = content;
        }
      });
    }
    
    if (!nextDataScript) {
      console.error('Could not find __NEXT_DATA__ - HTML length:', data.length);
      throw new Error('Could not find product data in HTML');
    }

    const nextData = JSON.parse(nextDataScript);
    const product = nextData?.props?.pageProps?.product;

    if (!product) {
      throw new Error('Product data not found in __NEXT_DATA__');
    }

    productId = product.id || product.productId || product.masterProductId || 'X000006756';
    stockData.productName = product.analyticsName || product.name || 'Bird Head Toque';
    
    const colorOptions = product.colourOptions?.options || 
                        product.colorOptions?.options ||
                        product.variations?.color?.values ||
                        [];
    
    console.log(`📦 Found ${colorOptions.length} color variants in HTML data`);

    colorOptions.forEach(option => {
      const variantInfo = {
        variantId: option.value || option.id,
        label: option.label || option.displayValue,
        primaryColour: option.primaryColour || option.color,
        hexCode: option.hexCode,
        badges: option.badges || [],
        imageUrl: option.image?.url
      };

      allKnownColors.set(variantInfo.variantId, variantInfo);
      stockData.allVariants.push(variantInfo);
    });

    console.log(`📊 Total variants tracked: ${stockData.allVariants.length}`);

  } catch (error) {
    console.error('Error parsing stock data:', error.message);
    throw error;
  }

  return stockData;
}

// FIX: Improved stock checking with correct URL construction
async function checkVariantStock(variantId, variantInfo) {
  try {
    // If we already know availability from API, use that
    if (typeof variantInfo.available === 'boolean') {
      return variantInfo.available;
    }

    // Otherwise check the product page for this variant
    if (!productId) {
      console.error('⚠️ Product ID not set!');
      return null;
    }

    const variantUrl = `${CONFIG.PRODUCT_URL}?dwvar_${productId}_color=${variantId}`;
    console.log(`    Checking URL: ${variantUrl}`);
    
    const response = await axios.get(variantUrl, {
      headers: { 
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml',
      },
      timeout: 15000
    });
    
    const $ = cheerio.load(response.data);
    
    // Multiple ways to detect stock status
    const notifyMeButton = $('button:contains("Notify me"), button:contains("Notify Me")').length > 0;
    const addToCartButton = $('button:contains("Add to"), button:contains("Shop now"), button[data-testid*="add-to"]').length > 0;
    const outOfStockText = $('*:contains("Out of stock")').length > 0;
    
    // Try to find stock info in the page data
    const nextDataScript = $('#__NEXT_DATA__').html();
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript);
        const product = nextData?.props?.pageProps?.product;
        
        // Check if this specific variant is available
        if (product?.variants) {
          const variant = product.variants.find(v => v.id === variantId || v.variationValues?.color === variantId);
          if (variant && variant.hasOwnProperty('available')) {
            console.log(`    Found variant data: available=${variant.available}`);
            return variant.available;
          }
        }
        
        // Check ATC (Add To Cart) status
        if (product?.ATC === false || product?.available === false) {
          return false;
        }
      } catch (e) {
        console.log(`    Could not parse variant data: ${e.message}`);
      }
    }
    
    // Fallback to button detection
    if (outOfStockText || notifyMeButton) {
      return false;
    }
    if (addToCartButton) {
      return true;
    }
    
    return null; // Unknown status
  } catch (error) {
    console.error(`    Error checking variant ${variantId}:`, error.message);
    return null;
  }
}

async function checkAllVariantStocks() {
  console.log('\n🔍 Checking stock status for all variants...');
  
  const stockData = {
    inStock: [],
    outOfStock: [],
    unknown: []
  };

  for (const [variantId, variantInfo] of allKnownColors.entries()) {
    console.log(`  Checking ${variantInfo.label}...`);
    
    const isAvailable = await checkVariantStock(variantId);
    
    if (isAvailable === true) {
      stockData.inStock.push(variantInfo);
      console.log(`    ✅ IN STOCK`);
    } else if (isAvailable === false) {
      stockData.outOfStock.push(variantInfo);
      console.log(`    ❌ OUT OF STOCK`);
    } else {
      stockData.unknown.push(variantInfo);
      console.log(`    ❓ UNKNOWN`);
    }
    
    // Delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return stockData;
}

function detectRestocks(currentStock) {
  const newlyAvailable = [];

  currentStock.inStock.forEach(color => {
    const wasOutOfStock = previousStock.outOfStock?.some(
      prev => prev.variantId === color.variantId
    );

    if (wasOutOfStock && Object.keys(previousStock).length > 0) {
      newlyAvailable.push(color);
    }
  });

  return newlyAvailable;
}

async function checkStock() {
  checkCount++;
  monitorStats.totalChecks++;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🔍 Check #${checkCount} - ${new Date().toLocaleString()}`);
  console.log(`📍 URL: ${CONFIG.PRODUCT_URL}`);
  console.log(`${'='.repeat(70)}`);

  try {
    const html = await fetchProductPage();
    const pageData = parseStockData(html);

    console.log(`\n📦 Product: ${pageData.productName}`);
    console.log(`🎨 Total Color Variants: ${allKnownColors.size}`);

    const currentStock = await checkAllVariantStocks();

    console.log(`\n📊 Stock Summary:`);
    console.log(`  ✅ In Stock: ${currentStock.inStock.length} colors`);
    console.log(`  ❌ Out of Stock: ${currentStock.outOfStock.length} colors`);
    console.log(`  ❓ Unknown: ${currentStock.unknown.length} colors`);

    if (currentStock.inStock.length > 0) {
      console.log(`\n🟢 Available Colors:`);
      currentStock.inStock.forEach(c => console.log(`  ✓ ${c.label}`));
    }

    if (currentStock.outOfStock.length > 0) {
      console.log(`\n🔴 Out of Stock:`);
      currentStock.outOfStock.forEach(c => console.log(`  ✗ ${c.label}`));
    }

    const newlyAvailable = detectRestocks(currentStock);

    if (newlyAvailable.length > 0) {
      console.log(`\n🎉 🎉 🎉 RESTOCK DETECTED! 🎉 🎉 🎉`);
      console.log(`${newlyAvailable.length} color(s) restocked:`);
      newlyAvailable.forEach(c => console.log(`  🔥 ${c.label}`));
      monitorStats.totalRestocks += newlyAvailable.length;
      await sendRestockAlert(newlyAvailable);
    } else {
      console.log(`\nℹ️  No new restocks detected`);
    }

    if (checkCount % 12 === 0) {
      console.log(`\n📊 Sending periodic snapshot...`);
      await sendInventorySnapshot(currentStock.inStock, currentStock.outOfStock);
    }

    previousStock = currentStock;
    lastCheckTime = new Date();

    console.log(`\n⏰ Next check in ${CONFIG.CHECK_INTERVAL} minutes...`);

  } catch (error) {
    console.error(`\n❌ ERROR:`, error.message);
    console.error(error.stack);
    monitorStats.errors++;
    await sendErrorAlert(error.message);
  }
}

// ===== DISCORD BOT SETUP =====
async function setupDiscordBot() {
  if (!CONFIG.DISCORD_BOT_TOKEN || !CONFIG.ENABLE_COMMANDS) {
    console.log('ℹ️  Discord commands disabled');
    return;
  }

  try {
    const { Client, GatewayIntentBits } = require('discord.js');
    discordClient = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });

    discordClient.on('ready', () => {
      console.log(`✅ Bot logged in as ${discordClient.user.tag}`);
      console.log('💬 Commands enabled!\n');
    });

    discordClient.on('messageCreate', async (message) => {
      if (message.author.bot || !message.content.startsWith('!')) return;
      if (CONFIG.DISCORD_CHANNEL_ID && message.channel.id !== CONFIG.DISCORD_CHANNEL_ID) return;

      const command = message.content.toLowerCase().trim();
      try {
        switch(command) {
          case '!status': await handleStatusCommand(); break;
          case '!list': await handleListCommand(); break;
          case '!check': await handleCheckCommand(); break;
          case '!help': await handleHelpCommand(); break;
          case '!snapshot': await handleSnapshotCommand(); break;
        }
      } catch (error) {
        console.error('Error handling command:', error);
      }
    });

    await discordClient.login(CONFIG.DISCORD_BOT_TOKEN);
  } catch (error) {
    console.error('❌ Failed to setup bot:', error.message);
  }
}

// ===== MAIN =====
async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 ARC\'TERYX STOCK MONITOR - BIRD HEAD TOQUE');
  console.log('='.repeat(70));
  console.log(`⏰ Check Interval: ${CONFIG.CHECK_INTERVAL} minutes`);
  console.log(`🔗 Webhook: ${CONFIG.DISCORD_WEBHOOK_URL !== 'YOUR_DISCORD_WEBHOOK_URL_HERE' ? '✅' : '❌'}`);
  console.log(`🤖 Commands: ${CONFIG.ENABLE_COMMANDS ? '✅' : '❌'}`);
  console.log('='.repeat(70) + '\n');

  if (!CONFIG.DISCORD_WEBHOOK_URL || CONFIG.DISCORD_WEBHOOK_URL === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.error('❌ Discord webhook not configured!\n');
    process.exit(1);
  }

  await setupDiscordBot();

  const commandsInfo = CONFIG.ENABLE_COMMANDS 
    ? '\n\n💬 Commands enabled! Type `!help`'
    : '\n\n💡 Enable commands with ENABLE_COMMANDS=true';

  // Startup notification removed - only send restock alerts

  console.log('🔄 Initial check...\n');
  await checkStock();

  setInterval(async () => {
    await checkStock();
  }, CONFIG.CHECK_INTERVAL * 60 * 1000);

  console.log('\n✅ Monitor running...\n');
}

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Shutting down...');
  await sendDiscordNotification('🔴 Monitor Stopped', 'Stock monitor shut down', 15158332, []);
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n⚠️  Shutting down (Ctrl+C)...');
  await sendDiscordNotification('🔴 Monitor Stopped', 'Manual shutdown', 15158332, []);
  process.exit(0);
});

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

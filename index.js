// Arc'teryx Stock Monitor - Bird Head Toque
// Only alerts when tracked colors come IN STOCK

const axios = require('axios');
const cheerio = require('cheerio');

// ===== CONFIGURATION =====
const CONFIG = {
  PRODUCT_URL: 'https://arcteryx.com/us/en/shop/bird-head-toque',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL_HERE',
  CHECK_INTERVAL: 5, // minutes
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Colors to track (excluding 24K Black)
const TRACKED_COLORS = [
  { colorId: '16284', label: 'Euphoria / Olive Moss' },
  { colorId: '16305', label: 'Bliss / Arctic Silk' },
  { colorId: '1820', label: 'Orca' },
  { colorId: '16252', label: 'Blaze / Copper Sky' },
  { colorId: '16262', label: 'Solitude / Arctic Silk' },
  { colorId: '16258', label: 'Nightscape / Glacial' },
  { colorId: '16280', label: 'Aster / Blaze' },
  { colorId: '16238', label: 'Mars / Dynasty' }
];

const TRACKED_COLOR_IDS = new Set(TRACKED_COLORS.map(c => c.colorId));

// ===== STATE =====
let previousStockStatus = new Map(); // colorId -> "InStock" | "OutOfStock"
let checkCount = 0;

// ===== DISCORD =====
async function sendRestockAlert(colors) {
  if (!CONFIG.DISCORD_WEBHOOK_URL || CONFIG.DISCORD_WEBHOOK_URL === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.log('⚠️  Webhook not configured');
    return;
  }
  
  const fields = colors.map(c => ({
    name: `🟢 ${c.label}`,
    value: `**IN STOCK NOW!**\n[BUY NOW](${CONFIG.PRODUCT_URL})`,
    inline: true
  }));

  try {
    await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
      content: '@everyone 🚨 RESTOCK ALERT!', // Pings everyone
      embeds: [{
        title: '🎉 BIRD HEAD TOQUE RESTOCK!',
        description: `**${colors.length}** color${colors.length > 1 ? 's' : ''} just came back in stock! GO GO GO! 🔥`,
        color: 3066993, // Green
        fields,
        timestamp: new Date().toISOString(),
        footer: { text: "Arc'teryx Stock Monitor" }
      }]
    });
    console.log('🔔 RESTOCK ALERT SENT!');
  } catch (error) {
    console.error('❌ Discord error:', error.message);
  }
}

// ===== STOCK CHECKING =====
async function checkStock() {
  checkCount++;
  
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`🔍 Check #${checkCount} - ${new Date().toLocaleString()}`);
  console.log('─'.repeat(50));
  
  try {
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
    
    const variants = product.variants || [];
    
    // Build current stock status for tracked colors only
    const currentStockStatus = new Map();
    const newlyInStock = [];
    
    variants.forEach(v => {
      const colorId = v.colourId;
      
      // Only process colors we care about
      if (!TRACKED_COLOR_IDS.has(colorId)) return;
      
      const stockStatus = v.stockStatus;
      currentStockStatus.set(colorId, stockStatus);
      
      // Find label
      const colorInfo = TRACKED_COLORS.find(c => c.colorId === colorId);
      const label = colorInfo?.label || colorId;
      
      // Log status
      if (stockStatus === 'InStock') {
        console.log(`  ✅ ${label} - IN STOCK`);
      } else {
        console.log(`  ❌ ${label} - Out of Stock`);
      }
      
      // Check if this is a restock (was OOS, now in stock)
      const previousStatus = previousStockStatus.get(colorId);
      if (previousStatus === 'OutOfStock' && stockStatus === 'InStock') {
        newlyInStock.push({ colorId, label });
      }
    });
    
    // Send alert if any tracked colors just restocked
    if (newlyInStock.length > 0) {
      console.log(`\n🎉🎉🎉 RESTOCK DETECTED! 🎉🎉🎉`);
      newlyInStock.forEach(c => console.log(`  🔥 ${c.label}`));
      await sendRestockAlert(newlyInStock);
    } else {
      console.log(`\n✓ No restocks detected`);
    }
    
    // Update state
    previousStockStatus = currentStockStatus;
    
    console.log(`\n⏰ Next check in ${CONFIG.CHECK_INTERVAL} minutes`);
    
  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
  }
}

// ===== MAIN =====
async function main() {
  console.log('\n' + '═'.repeat(50));
  console.log("🏔️  ARC'TERYX BIRD HEAD TOQUE MONITOR");
  console.log('═'.repeat(50));
  console.log(`⏰ Checking every ${CONFIG.CHECK_INTERVAL} minutes`);
  console.log(`🎨 Tracking ${TRACKED_COLORS.length} colors`);
  console.log('═'.repeat(50));
  
  // First check - establishes baseline
  await checkStock();
  
  // TEST: Simulate a restock by pretending Orca was out of stock
  console.log('\n🧪 TEST MODE: Simulating Orca restock...');
  previousStockStatus.set('1820', 'OutOfStock'); // Fake that Orca was OOS
  
  // Second check - will detect "restock" and send alert
  await checkStock();
  
  console.log('\n🧪 TEST COMPLETE - Check Discord for alert!');
  process.exit(0);
}
  
  // Initial check
  await checkStock();
  
  // Start loop
  setInterval(checkStock, CONFIG.CHECK_INTERVAL * 60 * 1000);
  
  console.log('\n✅ Monitor running. Ctrl+C to stop.\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

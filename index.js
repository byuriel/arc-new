// Arc'teryx Structure Diagnostic
// This will dump the actual JSON structure to Discord so we can find the color data

const axios = require('axios');
const cheerio = require('cheerio');

const CONFIG = {
  PRODUCT_URL: process.env.PRODUCT_URL || 'https://arcteryx.com/us/en/shop/bird-head-toque',
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || 'YOUR_DISCORD_WEBHOOK_URL_HERE',
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

async function sendToDiscord(title, content) {
  if (!CONFIG.DISCORD_WEBHOOK_URL || CONFIG.DISCORD_WEBHOOK_URL === 'YOUR_DISCORD_WEBHOOK_URL_HERE') {
    console.log('No webhook configured');
    return;
  }
  
  // Discord has 4096 char limit for embed description, so split if needed
  const chunks = [];
  for (let i = 0; i < content.length; i += 3900) {
    chunks.push(content.substring(i, i + 3900));
  }
  
  for (let i = 0; i < chunks.length; i++) {
    await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
      embeds: [{
        title: chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title,
        description: '```json\n' + chunks[i] + '\n```',
        color: 5814783
      }]
    });
    await new Promise(r => setTimeout(r, 1000)); // Rate limit
  }
}

async function diagnose() {
  console.log('🔍 Running diagnostic...\n');
  
  try {
    const response = await axios.get(CONFIG.PRODUCT_URL, {
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 30000
    });
    
    const $ = cheerio.load(response.data);
    const nextDataScript = $('script#__NEXT_DATA__').html();
    
    if (!nextDataScript) {
      await sendToDiscord('❌ ERROR', '__NEXT_DATA__ script tag not found!');
      return;
    }
    
    const nextData = JSON.parse(nextDataScript);
    const pageProps = nextData?.props?.pageProps;
    
    if (!pageProps) {
      await sendToDiscord('❌ ERROR', 'pageProps not found');
      return;
    }
    
    // Send pageProps keys
    await sendToDiscord('📊 pageProps keys', JSON.stringify(Object.keys(pageProps), null, 2));
    
    // Check for product
    if (pageProps.product) {
      const product = pageProps.product;
      await sendToDiscord('📊 product keys', JSON.stringify(Object.keys(product), null, 2));
      
      // Check specific color-related keys
      const colorKeys = ['colourOptions', 'colorOptions', 'colours', 'colors', 'variations', 'variants', 'options'];
      
      for (const key of colorKeys) {
        if (product[key]) {
          const data = product[key];
          const preview = JSON.stringify(data, null, 2).substring(0, 3800);
          await sendToDiscord(`✅ Found product.${key}`, preview);
        }
      }
      
      // Also check selectedColour
      if (product.selectedColour) {
        await sendToDiscord('✅ product.selectedColour', JSON.stringify(product.selectedColour, null, 2).substring(0, 3800));
      }
      
      // Dump first 3800 chars of full product for reference
      await sendToDiscord('📦 Full product (truncated)', JSON.stringify(product, null, 2).substring(0, 3800));
      
    } else {
      await sendToDiscord('⚠️ No product in pageProps', 'Checking other locations...');
      
      // Check dehydratedState
      if (pageProps.dehydratedState?.queries) {
        await sendToDiscord('📊 dehydratedState queries', 
          JSON.stringify(pageProps.dehydratedState.queries.map((q, i) => ({
            index: i,
            queryKey: q.queryKey,
            dataKeys: q.state?.data ? Object.keys(q.state.data) : null
          })), null, 2)
        );
        
        // Dump first query's data
        if (pageProps.dehydratedState.queries[0]?.state?.data) {
          await sendToDiscord('📊 First query data', 
            JSON.stringify(pageProps.dehydratedState.queries[0].state.data, null, 2).substring(0, 3800)
          );
        }
      }
      
      // Check initialData
      if (pageProps.initialData) {
        await sendToDiscord('📊 initialData keys', JSON.stringify(Object.keys(pageProps.initialData), null, 2));
      }
    }
    
    await sendToDiscord('✅ Diagnostic Complete', 'Check the messages above to find where color data is located');
    console.log('✅ Diagnostic sent to Discord');
    
  } catch (error) {
    console.error('Error:', error.message);
    await sendToDiscord('❌ ERROR', error.message);
  }
}

diagnose();

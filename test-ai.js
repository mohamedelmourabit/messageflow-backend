require('dotenv').config({ path: '.env.local' });
const AIService = require('./services/AIService');

const aiService = new AIService(process.env.ANTHROPIC_API_KEY);

async function testAI() {
  console.log('\n🧪 TESTING AI SERVICE LOCALLY\n');

  try {
    // Test 1: Detect Intent
    console.log('Test 1: Detect Intent');
    const intent = await aiService.detectIntent('Can I book a table for 4 people tomorrow at 7pm?');
    console.log('Intent:', intent);
    console.log('✅ PASS\n');

    // Test 2: Extract Booking Details
    console.log('Test 2: Extract Booking Details');
    const details = await aiService.extractBookingDetails('4 people tomorrow at 7pm under the name John');
    console.log('Details:', details);
    console.log('✅ PASS\n');

    // Test 3: Generate Response
    console.log('Test 3: Generate Response');
    const response = await aiService.generateResponse('BOOKING', 'Can I book a table?', { businessName: 'Restaurant XYZ' });
    console.log('Response:', response);
    console.log('✅ PASS\n');

    // Test 4: FAQ Intent
    console.log('Test 4: FAQ Intent');
    const faqIntent = await aiService.detectIntent('What time are you open?');
    console.log('Intent:', faqIntent);
    console.log('✅ PASS\n');

    console.log('✅ ALL TESTS PASSED!\n');
  } catch (err) {
    console.error('❌ TEST FAILED:', err.message);
  }
}

testAI();

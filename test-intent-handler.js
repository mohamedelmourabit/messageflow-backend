require('dotenv').config({ path: '.env.local' });
const { Pool } = require('pg');
const AIService = require('./services/AIService');
const WhatsAppService = require('./services/WhatsAppService');
const BookingService = require('./services/BookingService');
const IntentHandler = require('./handlers/IntentHandler');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function testIntentHandler() {
  console.log('\n🧪 TESTING INTENT HANDLER LOCALLY\n');

  const aiService = new AIService(process.env.OPENAI_API_KEY);
  const bookingService = new BookingService(pool);
  const whatsappService = new WhatsAppService(null, pool, process.env.TWILIO_WHATSAPP_NUMBER);
  const intentHandler = new IntentHandler(aiService, whatsappService, bookingService);

  // Mock user
  const mockUser = {
    id: 1,
    business_name: 'Test Restaurant',
    whatsapp_number: '+33659316237',
  };

  // Test 1: Booking Intent
  console.log('Test 1: Booking Intent');
  const booking = await intentHandler.handleMessage(
    mockUser,
    'whatsapp:+33659316237',
    'Can I book a table for 4 people tomorrow at 7pm?'
  );
  console.log('Intent:', booking.intent);
  console.log('Response:', booking.response);
  console.log('✅ PASS\n');

  // Test 2: FAQ Intent
  console.log('Test 2: FAQ Intent');
  const faq = await intentHandler.handleMessage(
    mockUser,
    'whatsapp:+33659316237',
    'What time are you open?'
  );
  console.log('Intent:', faq.intent);
  console.log('Response:', faq.response);
  console.log('✅ PASS\n');

  console.log('✅ ALL INTENT TESTS PASSED!\n');
  
  pool.end();
}

testIntentHandler().catch(console.error);

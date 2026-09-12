// ============================================
// MESSAGEFLOW BACKEND - OOP REFACTORED
// ============================================

// STEP 1: Load dotenv
// Load dotenv from .env.local in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: '.env.local' });
}

// STEP 2: Require all modules
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');

// STEP 3: Import services and handlers
const AIService = require('./services/AIService');
const WhatsAppService = require('./services/WhatsAppService');
const BookingService = require('./services/BookingService');
const IntentHandler = require('./handlers/IntentHandler');

// ============================================
// ENVIRONMENT VARIABLES
// ============================================
const DB_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUM = process.env.TWILIO_WHATSAPP_NUMBER;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// ============================================
// DEBUG LOGGING
// ============================================
console.log('\n🔍 ENVIRONMENT VARIABLES CHECK:');
console.log('DATABASE_URL:', DB_URL ? '✅ LOADED' : '❌ MISSING');
console.log('JWT_SECRET:', JWT_SECRET ? '✅ LOADED' : '❌ MISSING');
console.log('STRIPE_SECRET_KEY:', STRIPE_KEY ? '✅ LOADED' : '❌ MISSING');
console.log('TWILIO_ACCOUNT_SID:', TWILIO_SID ? '✅ LOADED' : '❌ MISSING');
console.log('ANTHROPIC_API_KEY:', ANTHROPIC_KEY ? '✅ LOADED' : '❌ MISSING');
console.log('');

// ============================================
// STRIPE SETUP
// ============================================
let stripe;
try {
  if (STRIPE_KEY) {
    stripe = require('stripe')(STRIPE_KEY);
    console.log('✅ Stripe: Initialized with real key');
  } else {
    console.warn('⚠️ Stripe: Using mock (real payments disabled)');
    stripe = {
      customers: {
        create: async (obj) => ({ id: 'cus_test_' + Date.now() }),
      },
      subscriptions: {
        create: async (obj) => ({ id: 'sub_test_' + Date.now() }),
        list: async (obj) => ({ data: [] }),
        cancel: async (id) => ({ id }),
      },
    };
  }
} catch (err) {
  console.error('Stripe initialization error:', err.message);
  stripe = {
    customers: {
      create: async (obj) => ({ id: 'cus_test_' + Date.now() }),
    },
    subscriptions: {
      create: async (obj) => ({ id: 'sub_test_' + Date.now() }),
      list: async (obj) => ({ data: [] }),
      cancel: async (id) => ({ id }),
    },
  };
}

// ============================================
// EXPRESS SETUP
// ============================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ============================================
// DATABASE SETUP
// ============================================
const pool = new Pool({
  connectionString: DB_URL,
});

console.log('✅ Database: Pool created');

// ============================================
// TWILIO SETUP
// ============================================
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
console.log('✅ Twilio: Initialized');

// ============================================
// INITIALIZE SERVICES
// ============================================
const aiService = new AIService(ANTHROPIC_KEY);
const whatsappService = new WhatsAppService(twilioClient, pool, TWILIO_NUM);
const bookingService = new BookingService(pool);
const intentHandler = new IntentHandler(
  aiService,
  whatsappService,
  bookingService,
);

console.log('✅ Services: Initialized');
console.log('');

// ============================================
// MIDDLEWARE
// ============================================
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================
// INITIALIZE DATABASE
// ============================================
// ============================================
// INITIALIZE DATABASE
// ============================================
const initDb = async () => {
  try {
    // ==========================================
    // USERS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        business_name VARCHAR(255),
        business_type VARCHAR(50),

        -- Legacy field, kept temporarily
        whatsapp_number VARCHAR(50),

        -- Business location / timezone
        business_country VARCHAR(100),
        business_timezone VARCHAR(100) DEFAULT 'Asia/Dubai',

        stripe_customer_id VARCHAR(255),
        subscription_status VARCHAR(50) DEFAULT 'free_trial',
        subscription_plan VARCHAR(50),
        subscription_end_date TIMESTAMP,
        trial_end_date TIMESTAMP,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ==========================================
    // BUSINESS SETTINGS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS business_settings (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        reservation_mode VARCHAR(30) DEFAULT 'TABLES',

        max_booking_advance_days INTEGER DEFAULT 30,
        min_booking_notice_minutes INTEGER DEFAULT 120,

        default_booking_duration_minutes INTEGER DEFAULT 90,

        allow_table_combination BOOLEAN DEFAULT false,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT business_settings_user_unique
          UNIQUE (user_id)
      );
    `);

    // ==========================================
    // OPENING HOURS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS opening_hours (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        day_of_week INTEGER NOT NULL,

        is_open BOOLEAN DEFAULT true,

        open_time TIME,
        close_time TIME,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT opening_hours_user_day_unique
          UNIQUE (user_id, day_of_week)
      );
    `);

    // ==========================================
    // TABLE TYPES - RESTAURANTS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS table_types (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        name VARCHAR(100) NOT NULL,

        capacity INTEGER NOT NULL,

        quantity INTEGER NOT NULL DEFAULT 1,

        zone VARCHAR(100),

        active BOOLEAN DEFAULT true,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT table_types_capacity_positive
          CHECK (capacity > 0),

        CONSTRAINT table_types_quantity_positive
          CHECK (quantity > 0)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_table_types_user_id
        ON table_types(user_id);
    `);

    // ==========================================
    // SERVICES - SALONS / GENERIC SERVICES
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        name VARCHAR(255) NOT NULL,

        description TEXT,

        duration_minutes INTEGER NOT NULL DEFAULT 60,

        price NUMERIC(10,2),

        active BOOLEAN DEFAULT true,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT services_duration_positive
          CHECK (duration_minutes > 0)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_services_user_id
        ON services(user_id);
    `);

    // ==========================================
    // STAFF - SALONS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        name VARCHAR(255) NOT NULL,

        active BOOLEAN DEFAULT true,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_staff_user_id
        ON staff(user_id);
    `);

    // ==========================================
    // BOOKINGS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        customer_phone VARCHAR(50),

        customer_name VARCHAR(255) NOT NULL,

        people INTEGER,

        service_id INTEGER
          REFERENCES services(id)
          ON DELETE SET NULL,

        staff_id INTEGER
          REFERENCES staff(id)
          ON DELETE SET NULL,

        table_type_id INTEGER
          REFERENCES table_types(id)
          ON DELETE SET NULL,

        booking_date DATE,

        booking_time TIME,

        start_time TIME,

        end_time TIME,

        status VARCHAR(50) DEFAULT 'confirmed',

        special_request TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ==========================================
    // MIGRATIONS FOR EXISTING BOOKINGS TABLE
    // ==========================================
    await pool.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS people INTEGER;
    `);

    await pool.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS service_id INTEGER
      REFERENCES services(id)
      ON DELETE SET NULL;
    `);

    await pool.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS staff_id INTEGER
      REFERENCES staff(id)
      ON DELETE SET NULL;
    `);

    await pool.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS table_type_id INTEGER
      REFERENCES table_types(id)
      ON DELETE SET NULL;
    `);

    await pool.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS start_time TIME;
    `);

    await pool.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS end_time TIME;
    `);

    await pool.query(`
      ALTER TABLE bookings
      ADD COLUMN IF NOT EXISTS special_request TEXT;
    `);

    // ==========================================
    // MESSAGES
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,

        user_id INTEGER
          REFERENCES users(id)
          ON DELETE CASCADE,

        phone VARCHAR(50),

        message_text TEXT,

        direction VARCHAR(20),

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ==========================================
    // TEMPLATES
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,

        user_id INTEGER
          REFERENCES users(id)
          ON DELETE CASCADE,

        template_name VARCHAR(255),

        template_text TEXT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ==========================================
    // STRIPE EVENTS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        id SERIAL PRIMARY KEY,

        event_id VARCHAR(255) UNIQUE,

        event_type VARCHAR(255),

        data JSONB,

        processed BOOLEAN DEFAULT false,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ==========================================
    // WHATSAPP ACCOUNTS
    // ==========================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_accounts (
        id SERIAL PRIMARY KEY,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        phone_number VARCHAR(50) NOT NULL,

        waba_id VARCHAR(255),

        phone_number_id VARCHAR(255),

        sender_id VARCHAR(255),

        twilio_subaccount_sid VARCHAR(255),

        status VARCHAR(50) DEFAULT 'pending',

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT whatsapp_accounts_phone_unique
          UNIQUE (phone_number),

        CONSTRAINT whatsapp_accounts_user_phone_unique
          UNIQUE (user_id, phone_number)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_user_id
        ON whatsapp_accounts(user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone_number
        ON whatsapp_accounts(phone_number);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_waba_id
        ON whatsapp_accounts(waba_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_phone_number_id
        ON whatsapp_accounts(phone_number_id);
    `);

    // ==========================================
    // DEFAULT BUSINESS SETTINGS
    // ==========================================
    await pool.query(`
      INSERT INTO business_settings (user_id)
      SELECT id
      FROM users
      WHERE NOT EXISTS (
        SELECT 1
        FROM business_settings bs
        WHERE bs.user_id = users.id
      );
    `);

    // ==========================================
    // MIGRATE LEGACY WHATSAPP NUMBERS
    // ==========================================
    await pool.query(`
      INSERT INTO whatsapp_accounts (
        user_id,
        phone_number,
        status
      )
      SELECT
        id,
        REPLACE(whatsapp_number, 'whatsapp:', ''),
        'connected'
      FROM users
      WHERE whatsapp_number IS NOT NULL
        AND whatsapp_number <> ''
      ON CONFLICT (phone_number) DO NOTHING;
    `);

    console.log('✅ Database: Tables initialized');
    console.log('✅ Database: Reservation architecture ready');
  } catch (err) {
    console.error('❌ DB Error:', err.message);
  }
};

initDb();

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: '✅ OK', timestamp: new Date() });
});

// ============================================
// AUTH ROUTES
// ============================================

app.post('/auth/signup', async (req, res) => {
  const { email, password, businessName, businessType, whatsappNumber } =
    req.body;

  try {
    console.log('1. Received data:', { email, businessName });

    if (!email || !password || !businessName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    console.log('2. Data validated');

    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('3. Password hashed');

    const customer = await stripe.customers.create({
      email,
      metadata: { businessName, businessType },
    });
    console.log('4. Stripe customer created:', customer.id);

    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 30);
    console.log('5. Trial date calculated');

    const result = await pool.query(
      `INSERT INTO users 
       (email, password, business_name, business_type, whatsapp_number, stripe_customer_id, subscription_status, trial_end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, email, business_name`,
      [
        email,
        hashedPassword,
        businessName,
        businessType,
        whatsappNumber,
        customer.id,
        'free_trial',
        trialEndDate,
      ],
    );
    console.log('6. User created in DB');

    const userId = result.rows[0].id;
    const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });
    console.log('7. JWT token created');

    res.json({
      token,
      user: result.rows[0],
      message: '✅ Account created! 30-day free trial activated',
    });
  } catch (err) {
    console.error('❌ Signup error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [
      email,
    ]);
    if (!result.rows[0]) {
      return res.status(400).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        business_name: user.business_name,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DASHBOARD
// ============================================
app.get('/api/dashboard', authMiddleware, async (req, res) => {
  try {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [
      req.userId,
    ]);
    const bookings = await pool.query(
      'SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId],
    );
    const messages = await pool.query(
      'SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.userId],
    );

    res.json({
      user: user.rows[0],
      bookings: bookings.rows,
      messages: messages.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// STRIPE ROUTES
// ============================================

app.get('/api/pricing', (req, res) => {
  res.json({
    plans: [
      {
        id: 'starter',
        name: 'Starter',
        price: 1900,
        currency: 'usd',
        interval: 'month',
        features: [
          '1 WhatsApp account',
          '5 templates',
          '100 bookings/month',
          'Email support',
        ],
      },
      {
        id: 'professional',
        name: 'Professional',
        price: 4900,
        currency: 'usd',
        interval: 'month',
        features: [
          '3 WhatsApp accounts',
          'Unlimited templates',
          'Unlimited bookings',
          'SMS reminders',
          'Priority support',
        ],
      },
      {
        id: 'business',
        name: 'Business',
        price: 9900,
        currency: 'usd',
        interval: 'month',
        features: [
          'Unlimited accounts',
          'Everything + API',
          'Team members',
          'Advanced analytics',
        ],
      },
    ],
  });
});

app.post('/api/subscribe', authMiddleware, async (req, res) => {
  const { planId, paymentMethodId } = req.body;

  try {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [
      req.userId,
    ]);
    const customer = user.rows[0];

    const priceMap = {
      starter: process.env.STRIPE_STARTER_PRICE_ID || 'price_1234567890',
      professional:
        process.env.STRIPE_PROFESSIONAL_PRICE_ID || 'price_0987654321',
      business: process.env.STRIPE_BUSINESS_PRICE_ID || 'price_5555555555',
    };

    const subscription = await stripe.subscriptions.create({
      customer: customer.stripe_customer_id,
      items: [{ price: priceMap[planId] }],
      payment_method: paymentMethodId,
      default_payment_method: paymentMethodId,
      off_session: true,
    });

    await pool.query(
      'UPDATE users SET subscription_status = $1, subscription_plan = $2 WHERE id = $3',
      ['active', planId, req.userId],
    );

    res.json({ success: true, subscription });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cancel-subscription', authMiddleware, async (req, res) => {
  try {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [
      req.userId,
    ]);
    const customer = user.rows[0];

    const subscriptions = await stripe.subscriptions.list({
      customer: customer.stripe_customer_id,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length > 0) {
      await stripe.subscriptions.cancel(subscriptions.data[0].id);
    }

    await pool.query(
      'UPDATE users SET subscription_status = $1 WHERE id = $2',
      ['canceled', req.userId],
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// WHATSAPP WEBHOOK - USING SERVICES & HANDLERS
// ============================================
app.post('/whatsapp/webhook', async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  const messageBody = req.body.Body;

  console.log(`\n📱 Message from ${from} → ${to}: ${messageBody}`);

  try {
    // Numéro du restaurant
    const businessPhone = to?.replace('whatsapp:', '');

    if (!businessPhone) {
      console.log('❌ Missing business WhatsApp number');
      return res.send('OK');
    }

    // Trouver le business grâce au numéro qui reçoit le message
    const user =
      await whatsappService.getBusinessByWhatsAppNumber(businessPhone);

    if (!user) {
      console.log('❌ No business connected to:', businessPhone);

      return res.send('OK');
    }

    console.log(`✅ Business found: ${user.business_name} (ID: ${user.id})`);

    // Message entrant
    await whatsappService.storeMessage(user.id, from, messageBody, 'incoming');

    // IA
    const { intent, response } = await intentHandler.handleMessage(
      user,
      from,
      messageBody,
    );

    // Réponse depuis LE NUMÉRO DU RESTAURANT
    const sent = await whatsappService.sendMessage(
      user.phone_number,
      from,
      response,
    );

    // Historique
    if (sent.success) {
      await whatsappService.storeMessage(user.id, from, response, 'outgoing');
    }

    res.send('OK');
  } catch (err) {
    console.error('WhatsApp webhook error:', err.message);

    res.send('OK');
  }
});

// ============================================
// TEMPLATES
// ============================================
app.get('/api/templates', authMiddleware, async (req, res) => {
  try {
    const templates = await pool.query(
      'SELECT * FROM templates WHERE user_id = $1',
      [req.userId],
    );
    res.json(templates.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/templates', authMiddleware, async (req, res) => {
  const { templateName, templateText } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO templates (user_id, template_name, template_text) VALUES ($1, $2, $3) RETURNING *',
      [req.userId, templateName, templateText],
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// BOOKINGS
// ============================================
app.get('/api/bookings', authMiddleware, async (req, res) => {
  try {
    const bookings = await bookingService.getBookings(req.userId);
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', authMiddleware, async (req, res) => {
  const { customerName, customerPhone, bookingDate, bookingTime } = req.body;

  try {
    const booking = await bookingService.createBooking(
      req.userId,
      customerName,
      customerPhone,
      bookingDate,
      bookingTime,
    );
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 MessageFlow Backend Running      ║
║   OOP Architecture                     
║   Port: ${PORT}                            
║   Environment: ${process.env.NODE_ENV || 'development'}                  
║   Database: ${DB_URL ? 'Connected' : 'MISSING'}                        
║   Stripe: ${STRIPE_KEY ? 'Ready' : 'MISSING'}                        
║   Twilio: ${TWILIO_SID ? 'Ready' : 'MISSING'}                        
║   Anthropic: ${ANTHROPIC_KEY ? 'Ready' : 'MISSING'}                       
╚════════════════════════════════════════╝
  `);
});

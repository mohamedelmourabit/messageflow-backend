// ============================================
// MESSAGEFLOW BACKEND
// ============================================

require('dotenv').config();

// ============================================
// IMPORTS
// ============================================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');

// ============================================
// ENVIRONMENT VARIABLES
// ============================================

const DB_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLIC_KEY = process.env.STRIPE_PUBLIC_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUM = process.env.TWILIO_WHATSAPP_NUMBER;

// ============================================
// CHECK ENV
// ============================================

const requiredVars = {
  DATABASE_URL: DB_URL,
  JWT_SECRET: JWT_SECRET,
  STRIPE_SECRET_KEY: STRIPE_KEY,
  TWILIO_ACCOUNT_SID: TWILIO_SID,
  TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
  TWILIO_WHATSAPP_NUMBER: TWILIO_NUM,
};

const missingVars = Object.entries(requiredVars)
  .filter(([name, value]) => !value)
  .map(([name]) => name);

if (missingVars.length > 0) {
  console.error(' Missing environment variables:');

  missingVars.forEach((name) => {
    console.error(`   - ${name}`);
  });

  process.exit(1);
}

console.log('✅ Environment variables loaded');
console.log('   DATABASE_URL: ✅');
console.log('   JWT_SECRET: ✅');
console.log('   STRIPE_SECRET_KEY: ✅');
console.log('   STRIPE_PUBLIC_KEY:', STRIPE_PUBLIC_KEY ? '✅' : '⚠️');
console.log('   STRIPE_WEBHOOK_SECRET:', STRIPE_WEBHOOK_SECRET ? '✅' : '⚠️');
console.log('   TWILIO_ACCOUNT_SID: ✅');
console.log('   TWILIO_AUTH_TOKEN: ✅');
console.log('   TWILIO_WHATSAPP_NUMBER: ✅');

// ============================================
// STRIPE SETUP
// ============================================
let stripe;
try {
  if (STRIPE_KEY) {
    stripe = require('stripe')(STRIPE_KEY);
    console.log('✅ Stripe: Initialized with real key');
  } else {
    console.warn('⚠️ Stripe: MISSING KEY - Using mock');
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
let pool;
if (DB_URL) {
  pool = new Pool({
    connectionString: DB_URL,
  });
  console.log('✅ Database: Pool created');
} else {
  console.error('❌ Database: URL missing - DB operations will fail!');
  // Create dummy pool to prevent crashes
  pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'dummy',
  });
}

// ============================================
// TWILIO SETUP
// ============================================
let twilioClient;
if (TWILIO_SID && TWILIO_TOKEN) {
  twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  console.log('✅ Twilio: Initialized');
} else {
  console.error('❌ Twilio: Missing SID or TOKEN - WhatsApp will not work!');
  // Create dummy client
  twilioClient = {
    messages: {
      create: async (obj) => {
        console.warn('⚠️ Twilio dummy - message not sent:', obj);
        return { sid: 'dummy_' + Date.now() };
      },
    },
  };
}

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
const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        business_name VARCHAR(255),
        business_type VARCHAR(50),
        whatsapp_number VARCHAR(50),
        stripe_customer_id VARCHAR(255),
        subscription_status VARCHAR(50) DEFAULT 'free_trial',
        subscription_plan VARCHAR(50),
        subscription_end_date TIMESTAMP,
        trial_end_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        customer_phone VARCHAR(50),
        customer_name VARCHAR(255),
        booking_date DATE,
        booking_time TIME,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        phone VARCHAR(50),
        message_text TEXT,
        direction VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        template_name VARCHAR(255),
        template_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS stripe_events (
        id SERIAL PRIMARY KEY,
        event_id VARCHAR(255) UNIQUE,
        event_type VARCHAR(255),
        data JSONB,
        processed BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database: Tables initialized');
  } catch (err) {
    console.error('DB Error:', err.message);
  }
};

if (DB_URL) {
  initDb();
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: '✅ OK', timestamp: new Date() });
});

// ============================================
// AUTH ROUTES
// ============================================

// SIGNUP
app.post('/auth/signup', async (req, res) => {
  const { email, password, businessName, businessType, whatsappNumber } =
    req.body;

  try {
    console.log('1. Received data:', { email, businessName });

    // Validate input
    if (!email || !password || !businessName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    console.log('2. Data validated');

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    console.log('3. Password hashed');

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email,
      metadata: { businessName, businessType },
    });
    console.log('4. Stripe customer created:', customer.id);

    // Calculate trial end date (30 days)
    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 30);
    console.log('5. Trial date calculated');

    // Create user
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

    // Create JWT token
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

// LOGIN
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

// GET PRICING
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

// CREATE SUBSCRIPTION
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

// CANCEL SUBSCRIPTION
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
// WHATSAPP WEBHOOK
// ============================================
app.post('/whatsapp/webhook', async (req, res) => {
  const incoming = req.body;
  const from = incoming.From;
  const messageBody = incoming.Body;

  console.log(`📱 Message from ${from}: ${messageBody}`);

  // Store message
  try {
    const user = await pool.query(
      'SELECT id FROM users WHERE whatsapp_number LIKE $1',
      [`%${from.slice(-10)}%`],
    );

    if (user.rows[0]) {
      await pool.query(
        'INSERT INTO messages (user_id, phone, message_text, direction) VALUES ($1, $2, $3, $4)',
        [user.rows[0].id, from, messageBody, 'incoming'],
      );

      // Get template and send auto-reply
      const templates = await pool.query(
        'SELECT template_text FROM templates WHERE user_id = $1 LIMIT 1',
        [user.rows[0].id],
      );

      if (templates.rows[0]) {
        await twilioClient.messages.create({
          from: TWILIO_NUM,
          to: from,
          body: templates.rows[0].template_text,
        });

        console.log(`✅ Auto-reply sent to ${from}`);
      } else {
        console.log(`ℹ️ No template for user ${user.rows[0].id}`);
      }
    } else {
      console.log(`ℹ️ No user found for ${from}`);
    }
  } catch (err) {
    console.error('WhatsApp error:', err.message);
  }

  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml').send(twiml.toString());
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
    const bookings = await pool.query(
      'SELECT * FROM bookings WHERE user_id = $1 ORDER BY booking_date DESC',
      [req.userId],
    );
    res.json(bookings.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', authMiddleware, async (req, res) => {
  const { customerName, customerPhone, bookingDate, bookingTime } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO bookings (user_id, customer_name, customer_phone, booking_date, booking_time)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.userId, customerName, customerPhone, bookingDate, bookingTime],
    );
    res.json(result.rows[0]);
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
║   Port: ${PORT}                            
║   Environment: ${process.env.NODE_ENV || 'development'}                  
║   Database: ${DB_URL ? 'Connected' : 'MISSING'}                        
║   Stripe: ${STRIPE_KEY ? 'Ready' : 'MISSING'}                        
║   Twilio: ${TWILIO_SID ? 'Ready' : 'MISSING'}                        
╚════════════════════════════════════════╝
  `);
});

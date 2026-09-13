// services/WhatsAppService.js

class WhatsAppService {
  constructor(twilioClient, pool, twilioNumber) {
    this.twilio = twilioClient;
    this.db = pool;
    this.twilioNumber = twilioNumber;
  }

  async getBusinessByWhatsAppNumber(phone) {
    try {
      const normalizedPhone = phone.replace('whatsapp:', '');

      const result = await this.db.query(
        `SELECT
          u.*,
          wa.id AS whatsapp_account_id,
          wa.phone_number,
          wa.waba_id,
          wa.phone_number_id,
          wa.sender_id,
          wa.twilio_subaccount_sid,
          wa.status AS whatsapp_status
       FROM whatsapp_accounts wa
       JOIN users u ON u.id = wa.user_id
       WHERE wa.phone_number = $1
       LIMIT 1`,
        [normalizedPhone],
      );

      return result.rows[0] || null;
    } catch (err) {
      console.error('Get business by WhatsApp number error:', err.message);
      return null;
    }
  }

  async storeMessage(userId, phone, messageText, direction = 'incoming') {
    try {
      const result = await this.db.query(
        `INSERT INTO messages (user_id, phone, message_text, direction)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [userId, phone, messageText, direction],
      );
      return result.rows[0];
    } catch (err) {
      console.error('Store message error:', err.message);
      return null;
    }
  }

  async sendInteractiveList(fromBusinessNumber, toPhone, options = {}) {
    try {
      const { body, button, items, language = 'en' } = options;

      if (!body || !button || !Array.isArray(items) || !items.length) {
        throw new Error('Invalid interactive list payload');
      }

      const from = fromBusinessNumber.startsWith('whatsapp:')
        ? fromBusinessNumber
        : `whatsapp:${fromBusinessNumber}`;

      const to = toPhone.startsWith('whatsapp:')
        ? toPhone
        : `whatsapp:${toPhone}`;

      // twilio/list-picker supports up to 10 items and is available
      // for replies inside the 24-hour WhatsApp customer session.
      const content = await this.twilio.content.v1.contents.create({
        friendlyName: `messageflow_list_${Date.now()}`,
        language,
        types: {
          'twilio/list-picker': {
            body: String(body).substring(0, 1024),
            button: String(button).substring(0, 20),
            items: items.slice(0, 10).map((item) => ({
              id: String(item.id).substring(0, 200),
              item: String(item.item).substring(0, 24),
              description: String(item.description || '').substring(0, 72),
            })),
          },
        },
      });

      const message = await this.twilio.messages.create({
        from,
        to,
        contentSid: content.sid,
      });

      console.log(`✅ Interactive list sent ${from} → ${to}: ${message.sid}`);

      return {
        success: true,
        sid: message.sid,
        contentSid: content.sid,
      };
    } catch (err) {
      console.error('Send interactive list error:', err.message);
      return {
        success: false,
        error: err.message,
      };
    }
  }

  async sendMessage(fromBusinessNumber, toPhone, body) {
    try {
      const from = fromBusinessNumber.startsWith('whatsapp:')
        ? fromBusinessNumber
        : `whatsapp:${fromBusinessNumber}`;

      const to = toPhone.startsWith('whatsapp:')
        ? toPhone
        : `whatsapp:${toPhone}`;

      console.log(`📤 Sending WhatsApp: ${from} → ${to}`);

      const message = await this.twilio.messages.create({
        from,
        to,
        body: body.substring(0, 1000),
      });

      console.log(`✅ Message sent ${from} → ${to}: ${message.sid}`);

      return {
        success: true,
        sid: message.sid,
      };
    } catch (err) {
      console.error('Send message error:', err.message);

      return {
        success: false,
        error: err.message,
      };
    }
  }

  async getConversationHistory(userId, limit = 10) {
    try {
      const result = await this.db.query(
        `SELECT * FROM messages 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT $2`,
        [userId, limit],
      );
      return result.rows.reverse(); // Oldest first
    } catch (err) {
      console.error('Get conversation history error:', err.message);
      return [];
    }
  }

  async getTemplates(userId) {
    try {
      const result = await this.db.query(
        `SELECT * FROM templates WHERE user_id = $1`,
        [userId],
      );
      return result.rows;
    } catch (err) {
      console.error('Get templates error:', err.message);
      return [];
    }
  }
}

module.exports = WhatsAppService;

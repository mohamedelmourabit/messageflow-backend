// services/WhatsAppService.js

class WhatsAppService {
  constructor(twilioClient, pool, twilioNumber) {
    this.twilio = twilioClient;
    this.db = pool;
    this.twilioNumber = twilioNumber;
  }

  async getUserByPhone(phone) {
    try {
      const result = await this.db.query(
        `SELECT * FROM users WHERE whatsapp_number LIKE $1`,
        [`%${phone.slice(-10)}%`],
      );
      return result.rows[0] || null;
    } catch (err) {
      console.error('Get user by phone error:', err.message);
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

  async sendMessage(toPhone, body) {
    try {
      const message = await this.twilio.messages.create({
        from: this.twilioNumber,
        to: toPhone,
        body: body.substring(0, 1000), // WhatsApp max 1000 chars
      });

      console.log(`✅ Message sent to ${toPhone}: ${message.sid}`);
      return { success: true, sid: message.sid };
    } catch (err) {
      console.error('Send message error:', err.message);
      return { success: false, error: err.message };
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

// services/AIService.js

const Anthropic = require('@anthropic-ai/sdk');

class AIService {
  constructor(apiKey) {
    console.log(
      '🔑 AIService initialized with key:',
      apiKey ? '✅ LOADED' : '❌ MISSING',
    );
    this.anthropic = new Anthropic({ apiKey });
  }

  async detectIntent(message) {
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [
          {
            role: 'user',
            content: `Respond with ONLY ONE: BOOKING, FAQ, CANCEL, MODIFY, or HUMAN

${message}`,
          },
        ],
      });

      return response.content[0].text.trim().toUpperCase();
    } catch (err) {
      console.error('AI Intent detection error:', err.message);
      return 'HUMAN';
    }
  }

  async generateResponse(intent, message, context = {}) {
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `You are a restaurant booking assistant. Keep response to 1-2 sentences.
            
Customer: ${message}`,
          },
        ],
      });

      return response.content[0].text;
    } catch (err) {
      console.error('AI Response error:', err.message);
      return 'Sorry, I could not process your request.';
    }
  }
  async extractBookingDetails(message) {
    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Extract booking details. Return ONLY valid JSON:
{
  "people": number or null,
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" or null,
  "name": "name" or null,
  "phone": "phone" or null
}

Message: "${message}"`,
          },
        ],
      });

      const content = response.content[0].text.trim();

      // Strip markdown code blocks if present
      const jsonStr = content
        .replace(/^```json\n?/, '')
        .replace(/\n?```$/, '')
        .trim();

      return JSON.parse(jsonStr);
    } catch (err) {
      console.error('Booking details extraction error:', err.message);
      return { people: null, date: null, time: null, name: null, phone: null };
    }
  }
}

module.exports = AIService;

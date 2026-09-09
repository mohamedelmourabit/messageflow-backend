// services/AIService.js

const OpenAI = require('openai');

class AIService {
  constructor(apiKey) {
    this.openai = new OpenAI({ apiKey });
  }

  async detectIntent(message) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: `You are a restaurant booking assistant. Analyze the customer message and determine the intent.

Respond with ONLY ONE of these intents:
- BOOKING: if customer wants to book a table, make a reservation, or check availability
- FAQ: if customer asks about hours, menu, location, phone, pricing, policies
- CANCEL: if customer wants to cancel a booking
- MODIFY: if customer wants to change a booking
- HUMAN: if customer is angry, needs complex help, or asks for a human

Respond with ONLY the intent word, nothing else.`,
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 0.3,
      });

      return response.choices[0].message.content.trim().toUpperCase();
    } catch (err) {
      console.error('AI Intent detection error:', err.message);
      return 'HUMAN'; // Default to human on error
    }
  }

  async generateResponse(intent, message, context = {}) {
    try {
      const systemPrompt = this.getSystemPrompt(intent, context);

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        temperature: 0.7,
        max_tokens: 150,
      });

      return response.choices[0].message.content;
    } catch (err) {
      console.error('AI Response generation error:', err.message);
      return 'Sorry, I could not process your request. Please try again or contact support.';
    }
  }

  getSystemPrompt(intent, context) {
    const businessName = context.businessName || 'our restaurant';

    const prompts = {
      BOOKING: `You are a helpful restaurant booking assistant for ${businessName}. 
        Help the customer book a table. Ask for:
        1. Number of people
        2. Date
        3. Time
        Keep responses short (1-2 sentences). Be friendly and professional.`,

      FAQ: `You are a helpful restaurant assistant for ${businessName}.
        Answer the customer's question about the restaurant.
        Available info: Hours (11am-11pm), accepts reservations on WhatsApp.
        Keep responses short (1-2 sentences). Be friendly.`,

      BOOKING_CONFIRM: `You are confirming a restaurant booking.
        Create a brief confirmation with booking details.
        Keep it short (1 sentence). Include booking number suggestion.`,

      HUMAN: `You are transferring the customer to a human representative.
        Thank them and let them know someone will help shortly.
        Keep it very short (1 sentence).`,
    };

    return prompts[intent] || prompts.FAQ;
  }

  async extractBookingDetails(message) {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [
          {
            role: 'system',
            content: `Extract booking details from the customer message. Return JSON only:
{
  "people": number or null,
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" (24h) or null,
  "name": "customer name" or null,
  "phone": "phone number" or null
}

If info is missing, use null. Be strict with the format.`,
          },
          { role: 'user', content: message },
        ],
        temperature: 0.2,
      });

      const content = response.choices[0].message.content;
      return JSON.parse(content);
    } catch (err) {
      console.error('Booking details extraction error:', err.message);
      return { people: null, date: null, time: null, name: null, phone: null };
    }
  }
}

module.exports = AIService;

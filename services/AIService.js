const Anthropic = require('@anthropic-ai/sdk');

class AIService {
  constructor(apiKey) {
    this.client = new Anthropic({
      apiKey,
    });

    this.model = 'claude-haiku-4-5-20251001';
  }

  /**
   * Analyse complète d'un message WhatsApp en UN seul appel IA.
   *
   * L'IA comprend :
   * - English
   * - Arabic
   * - Gulf Arabic / UAE
   * - Moroccan Darija
   * - French
   * - messages multilingues
   */
  async analyzeMessage(message, context = {}) {
    try {
      const currentDate =
        context.currentDate || new Date().toISOString().split('T')[0];

      const timezone = context.timezone || 'Asia/Dubai';

      const businessName = context.businessName || 'the business';

      const prompt = `
You are the multilingual WhatsApp AI assistant for "${businessName}".

Your job is to UNDERSTAND the customer's message, not to guess or invent information.

IMPORTANT:
- Customers may speak English, Arabic, Gulf Arabic, UAE Arabic, Moroccan Darija, French, or mixed languages.
- Understand natural language semantically.
- Do NOT rely on keyword dictionaries.
- Understand different ways people express dates, times, quantities and requests.
- Arabic dialects can be very different. Moroccan Darija and Gulf/UAE Arabic are both valid.
- If the customer mixes Arabic and English, understand the complete meaning.
- Never invent a date, time, number of people, name or phone number.
- If something is not provided or cannot be understood with confidence, return null.
- "tomorrow", "next Friday", Arabic date expressions, Gulf expressions, Darija expressions, etc. should be understood naturally by the AI.
- Return date_reference as a semantic reference when the customer uses a relative date.
- Return an exact date only when it is explicitly clear from the message and current date.

CURRENT DATE:
${currentDate}

BUSINESS TIMEZONE:
${timezone}

CUSTOMER MESSAGE:
${message}

Return ONLY valid JSON.

Use exactly this structure:

{
  "language": "en|ar|fr|mixed|other",
  "intent": "BOOKING|FAQ|CANCEL|MODIFY|HUMAN|GREETING|OTHER",
  "confidence": 0.0,
  "entities": {
    "people": null,
    "date": null,
    "date_reference": null,
    "time": null,
    "time_reference": null,
    "name": null,
    "phone": null
  },
  "special_request": null,
  "question": null
}

RULES:

language:
- "en" for English
- "ar" for Arabic, including Gulf Arabic and Moroccan Darija
- "fr" for French
- "mixed" when languages are genuinely mixed
- "other" otherwise

intent:
BOOKING:
Customer wants to make a reservation.

FAQ:
Customer asks a question about the business, for example:
opening hours, location, parking, menu, prices, services, availability information, etc.

CANCEL:
Customer wants to cancel an existing reservation.

MODIFY:
Customer wants to change an existing reservation.

HUMAN:
Customer explicitly wants to talk to a human/person/staff member.

GREETING:
Simple greeting without another request.

OTHER:
Anything else.

entities.people:
Number of people if clearly provided.
Otherwise null.

entities.date:
Use YYYY-MM-DD only when the exact date is clearly known.

entities.date_reference:
Use a short semantic reference when the customer expresses a relative or natural-language date.

Examples:
"tomorrow" -> "tomorrow"
"next Friday" -> "next Friday"

For Arabic/Darija/Gulf Arabic, translate the semantic meaning into English rather than returning the original phrase.

If there is no date -> null.

entities.time:
Return HH:MM when the exact time is clear.

Examples:
"7pm" -> "19:00"
"8:30 PM" -> "20:30"

If only a vague period is given, keep time null and use time_reference.

entities.time_reference:
Examples:
"morning"
"afternoon"
"evening"
"night"
"around 8"
Use null if unnecessary.

entities.name:
Customer name only if clearly provided.
Otherwise null.

entities.phone:
Phone number only if clearly provided.
Otherwise null.

special_request:
Anything additional requested by the customer.

Examples:
"table near the window"
"outdoor table"
"quiet table"
"high chair for baby"

question:
For FAQ messages, describe what the customer is asking in a short semantic form.

Examples:
"opening_hours"
"location"
"parking"
"menu"
"price"
"services"

Do not invent values.
`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const text = response.content
        ?.filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
        .trim();

      if (!text) {
        throw new Error('Empty AI response');
      }

      // Remove possible markdown fences
      const cleaned = text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

      const analysis = JSON.parse(cleaned);

      return this.normalizeAnalysis(analysis);
    } catch (error) {
      console.error('AI analyzeMessage error:', error.message);

      return {
        language: 'en',
        intent: 'OTHER',
        confidence: 0,
        entities: {
          people: null,
          date: null,
          date_reference: null,
          time: null,
          time_reference: null,
          name: null,
          phone: null,
        },
        special_request: null,
        question: null,
      };
    }
  }

  /**
   * Sécurise et normalise la réponse IA.
   */
  normalizeAnalysis(data) {
    const validIntents = [
      'BOOKING',
      'FAQ',
      'CANCEL',
      'MODIFY',
      'HUMAN',
      'GREETING',
      'OTHER',
    ];

    const validLanguages = ['en', 'ar', 'fr', 'mixed', 'other'];

    const entities = data.entities || {};

    return {
      language: validLanguages.includes(data.language) ? data.language : 'en',

      intent: validIntents.includes(data.intent) ? data.intent : 'OTHER',

      confidence:
        typeof data.confidence === 'number'
          ? Math.max(0, Math.min(1, data.confidence))
          : 0,

      entities: {
        people:
          Number.isInteger(entities.people) && entities.people > 0
            ? entities.people
            : null,

        date:
          typeof entities.date === 'string' && entities.date.length > 0
            ? entities.date
            : null,

        date_reference:
          typeof entities.date_reference === 'string' &&
          entities.date_reference.length > 0
            ? entities.date_reference
            : null,

        time:
          typeof entities.time === 'string' &&
          /^\d{2}:\d{2}$/.test(entities.time)
            ? entities.time
            : null,

        time_reference:
          typeof entities.time_reference === 'string' &&
          entities.time_reference.length > 0
            ? entities.time_reference
            : null,

        name:
          typeof entities.name === 'string' && entities.name.length > 0
            ? entities.name
            : null,

        phone:
          typeof entities.phone === 'string' && entities.phone.length > 0
            ? entities.phone
            : null,
      },

      special_request:
        typeof data.special_request === 'string' &&
        data.special_request.length > 0
          ? data.special_request
          : null,

      question:
        typeof data.question === 'string' && data.question.length > 0
          ? data.question
          : null,
    };
  }

  /**
   * Génère une réponse dans la langue du client.
   */
  async generateResponse(message, analysis, businessInfo = {}) {
    try {
      const language = analysis?.language || 'en';

      const businessName = businessInfo.businessName || 'the business';

      const prompt = `
You are the WhatsApp customer assistant for "${businessName}".

Reply naturally to the customer.

CUSTOMER LANGUAGE:
${language}

CUSTOMER MESSAGE:
${message}

CUSTOMER ANALYSIS:
${JSON.stringify(analysis)}

IMPORTANT:
- Reply in the customer's language.
- If Arabic, use natural Arabic appropriate for the customer's dialect/style.
- For UAE customers, Gulf/UAE-style Arabic is acceptable.
- For Moroccan customers, Moroccan Darija is acceptable when appropriate.
- If the customer uses English, reply in English.
- If the customer uses French, reply in French.
- If the message mixes languages, reply naturally in the dominant language.
- Be concise and friendly.
- Usually 1-3 short sentences.
- Never invent business information.
- Never invent opening hours, prices, availability or policies.
- Never claim that a booking is confirmed unless the backend explicitly confirms it.
- Do not mention AI.
`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const text = response.content
        ?.filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('')
        .trim();

      return text || null;
    } catch (error) {
      console.error('AI generateResponse error:', error.message);

      return null;
    }
  }
}

module.exports = AIService;

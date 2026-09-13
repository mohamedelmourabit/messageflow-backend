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
      const businessType = context.businessType || 'business';

      const conversationState = context.conversationState || {};

      const availableServices = Array.isArray(context.availableServices)
        ? context.availableServices
        : [];

      const availableStaff = Array.isArray(context.availableStaff)
        ? context.availableStaff
        : [];

      const prompt = `
You are the multilingual WhatsApp AI assistant for "${businessName}".

BUSINESS TYPE:
${businessType}

Your job is to UNDERSTAND the customer's message semantically.

IMPORTANT:
- Customers may speak English, Arabic, Gulf Arabic, UAE Arabic, Moroccan Darija, French, or mixed languages.
- Understand natural language semantically.
- Do NOT rely on keyword dictionaries.
- Understand natural ways people express services, dates, times, quantities and requests.
- Never invent information.
- Never invent a service or staff member that is not provided in the business data.
- If something is not provided or cannot be understood with confidence, return null.

CURRENT DATE:
${currentDate}

BUSINESS TIMEZONE:
${timezone}

AVAILABLE SERVICES:
${JSON.stringify(availableServices)}

AVAILABLE STAFF:
${JSON.stringify(availableStaff)}

CURRENT CONVERSATION STATE:
${JSON.stringify(conversationState)}

CUSTOMER MESSAGE:
${message}

VERY IMPORTANT CONVERSATION RULE:

If CURRENT CONVERSATION STATE contains an active booking/reservation,
the customer is continuing that booking unless they clearly say they want to:
- cancel it
- modify an existing confirmed booking
- speak to a human
- ask an unrelated FAQ

Short follow-up messages such as:
- "Monday"
- "6pm"
- "4 people"
- "my name is Ahmed"
- "I told you Monday"
- "yes"
- "first booking"
- "for me"
must be interpreted using the existing conversation state.

DO NOT reset or erase information already present in CURRENT CONVERSATION STATE.

Extract only NEW information from the current message.

If the customer provides a missing booking field while a booking is active,
intent MUST normally remain BOOKING.

DATE RULES:

If the customer clearly refers to a specific calendar date or weekday:
- Resolve it using CURRENT DATE and BUSINESS TIMEZONE.
- Return the resolved date as YYYY-MM-DD when possible.
- Example: if today is Thursday and customer says "Monday", return the next Monday.
- Example: "tomorrow" should be resolved to the actual YYYY-MM-DD date.
- Example: "next Friday" should be resolved to the appropriate YYYY-MM-DD date.
- date_reference may still contain the semantic meaning.

TIME RULES:
- "7pm" -> "19:00"
- "8:30 PM" -> "20:30"
- "around 8" -> time_reference = "around 8", time = null
- Never invent an exact time.

SERVICE RULE:
If the customer wants a service, identify the matching service from AVAILABLE SERVICES.
Return the canonical service name exactly as provided in AVAILABLE SERVICES.

STAFF RULE:
If the customer explicitly requests a staff member, identify the matching staff member from AVAILABLE STAFF.
Return the canonical staff name exactly as provided in AVAILABLE STAFF.

BOOKING RULE:
For a salon:
- service is normally required
- date is required
- time is required
- customer name is required

For a restaurant:
- people is normally required
- date is required
- time is required
- customer name is required

PHONE:
The customer's WhatsApp phone is already known by the backend.
Do not ask for it.
Only return phone if the customer explicitly provides another phone number.

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
    "phone": null,
    "service": null,
    "staff": null
  },
  "special_request": null,
  "question": null
}

LANGUAGE:
- "en" = English
- "ar" = Arabic, Gulf Arabic, UAE Arabic or Moroccan Darija
- "fr" = French
- "mixed" = genuinely mixed languages
- "other" = otherwise

INTENT:

BOOKING:
Customer wants to make a reservation or appointment,
or is clearly continuing an active booking conversation.

FAQ:
Customer asks about the business, services, prices, opening hours,
location, parking, etc.

CANCEL:
Customer wants to cancel an existing reservation.

MODIFY:
Customer wants to modify an EXISTING CONFIRMED reservation.

HUMAN:
Customer explicitly wants a human/person/staff member.

GREETING:
Simple greeting without another request.

OTHER:
Anything else.

Do not confuse a booking follow-up with MODIFY.

For example:
Current state:
{
  "intent": "BOOKING",
  "date": null
}

Customer:
"Monday"

Correct:
{
  "intent": "BOOKING",
  "entities": {
    "date": "2026-09-14"
  }
}

NOT MODIFY.

Another example:

Current state:
{
  "intent": "BOOKING",
  "service": "Manicure",
  "date": null
}

Customer:
"6pm"

Correct:
BOOKING with time = "18:00".

NOT MODIFY.
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
          service: null,
          staff: null,
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

        service:
          typeof entities.service === 'string' && entities.service.length > 0
            ? entities.service
            : null,

        staff:
          typeof entities.staff === 'string' && entities.staff.length > 0
            ? entities.staff
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

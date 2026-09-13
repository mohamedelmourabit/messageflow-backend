const OpenAI = require('openai');

class AIService {
  constructor(apiKey, model = process.env.OPENAI_MODEL || 'gpt-4o-mini') {
    this.openai = new OpenAI({ apiKey });
    this.model = model;
  }

  async analyzeMessage(message, context = {}) {
    const today = this.dateInTimezone(context.timezone || 'Asia/Dubai');
    const catalog = (context.availableServices || []).map(({ id, name, description }) => ({ id, name, description: description || null }));
    const staff = (context.availableStaff || []).map(({ id, name }) => ({ id, name }));
    const prompt = `You interpret a WhatsApp message for a ${context.businessType || 'business'} booking system. Today in the business timezone (${context.timezone || 'Asia/Dubai'}) is ${today}.
Return JSON only, matching this schema exactly:
{"intent":"BOOKING|FAQ|CANCEL|MODIFY|HUMAN|GREETING|OTHER","entities":{"name":null,"people":null,"service":null,"staff":null,"date":null,"time":null,"date_reference":null,"date_range":{"from":null,"to":null},"special_request":null},"faq_topic":null}
Interpret meaning in English, French, Arabic, Gulf Arabic, Moroccan Darija, and mixed language. Do not use keyword matching; infer meaning. Use YYYY-MM-DD only for a specific requested day. For “next week”, “this weekend”, “later this month”, or any period, leave date null and return its inclusive real calendar range in date_range. Never turn a range into an arbitrary single day. Extract only fields stated or changed in this message; never invent services, staff, prices, facts, dates, times, or availability.
Services actually configured: ${JSON.stringify(catalog)}
Staff actually configured: ${JSON.stringify(staff)}
Current conversation state: ${JSON.stringify(context.conversationState || {})}`;
    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: String(message || '') }],
      });
      return this.normalizeAnalysis(JSON.parse(response.choices[0].message.content));
    } catch (error) {
      console.error('AI analysis error:', error.message);
      return { intent: 'HUMAN', entities: {}, faq_topic: null };
    }
  }

  // Natural-language wording only; the handler supplies all business facts.
  async generateResponse(message, analysis = {}, context = {}) {
    const safeContext = {
      businessName: context.businessName || null,
      businessType: context.businessType || null,
      missing_information: analysis.missing_information || [],
      booking_available: analysis.booking_available,
      booking_confirmed: analysis.booking_confirmed,
      availability_reason: analysis.availability_reason || null,
      booking: analysis.booking || null,
      faq_answer: analysis.faq_answer || null,
      staff_not_found: analysis.staff_not_found || null,
    };
    const prompt = `Write one short WhatsApp response in the customer's language when possible. Use only the facts in CONTEXT. Do not invent services, prices, opening hours, staff, availability, booking confirmation, or business information. If faq_answer is null, say that information is not available and offer human help. CONTEXT: ${JSON.stringify(safeContext)}`;
    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        max_tokens: 160,
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: String(message || '') }],
      });
      return response.choices[0].message.content?.trim();
    } catch (error) {
      console.error('AI response error:', error.message);
      return 'Sorry, I could not process that right now. Please try again.';
    }
  }

  normalizeAnalysis(value) {
    const allowed = new Set(['BOOKING', 'FAQ', 'CANCEL', 'MODIFY', 'HUMAN', 'GREETING', 'OTHER']);
    const entities = value?.entities && typeof value.entities === 'object' ? value.entities : {};
    const range = entities.date_range && typeof entities.date_range === 'object' ? entities.date_range : null;
    return {
      intent: allowed.has(String(value?.intent || '').toUpperCase()) ? String(value.intent).toUpperCase() : 'OTHER',
      entities: {
        ...entities,
        date: this.validDate(entities.date) ? entities.date : null,
        time: this.validTime(entities.time) ? entities.time : null,
        date_range: range && this.validDate(range.from) && this.validDate(range.to) && range.from <= range.to ? { from: range.from, to: range.to } : null,
      },
      faq_topic: value?.faq_topic || null,
    };
  }

  validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
  validTime(value) { return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value); }

  dateInTimezone(timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
}

module.exports = AIService;

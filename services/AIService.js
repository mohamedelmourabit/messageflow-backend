const Anthropic = require('@anthropic-ai/sdk');

class AIService {
  constructor(apiKey, model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async analyzeMessage(message, context = {}) {
    const today = this.dateInTimezone(context.timezone || 'Asia/Dubai');
    const services = (context.availableServices || []).map(({ id, name, description }) => ({ id, name, description: description || null }));
    const staff = (context.availableStaff || []).map(({ id, name }) => ({ id, name }));
    const system = `Interpret WhatsApp messages for a ${context.businessType || 'business'} booking system. Today in ${context.timezone || 'Asia/Dubai'} is ${today}.
Return ONLY valid JSON with this shape:
{"intent":"BOOKING|FAQ|CANCEL|MODIFY|HUMAN|GREETING|OTHER","entities":{"name":null,"people":null,"service":null,"staff":null,"date":null,"time":null,"date_reference":null,"date_range":{"from":null,"to":null},"special_request":null},"faq_topic":null}
Understand English, French, Arabic, Gulf Arabic, Moroccan Darija, and mixed language semantically. Do not use keyword matching. Use YYYY-MM-DD only for a specific day. For a period such as next week, leave date null and return an inclusive date_range; never choose an arbitrary day. Extract only information stated or changed in this message. Never invent services, staff, prices, facts, dates, times, or availability.
Configured services: ${JSON.stringify(services)}
Configured staff: ${JSON.stringify(staff)}
Conversation state: ${JSON.stringify(context.conversationState || {})}`;
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: String(message || '') }],
      });
      return this.normalizeAnalysis(JSON.parse(this.text(response)));
    } catch (error) {
      console.error('AI analysis error:', error.message);
      return { intent: 'HUMAN', entities: {}, faq_topic: null };
    }
  }

  // Claude writes wording only. The handler supplies every business fact.
  async generateResponse(message, analysis = {}, context = {}) {
    const facts = {
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
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 160,
        temperature: 0.2,
        system: `Write one short WhatsApp response in the customer's language when possible. Use only FACTS. Never invent services, prices, opening hours, staff, availability, confirmation, or business information. If faq_answer is null, say the information is unavailable and offer human help. FACTS: ${JSON.stringify(facts)}`,
        messages: [{ role: 'user', content: String(message || '') }],
      });
      return this.text(response) || 'Sorry, I could not process that right now. Please try again.';
    } catch (error) {
      console.error('AI response error:', error.message);
      return 'Sorry, I could not process that right now. Please try again.';
    }
  }

  text(response) {
    return (response.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('').trim().replace(/^```json\s*|\s*```$/g, '');
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

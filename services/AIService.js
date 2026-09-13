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
{"intent":"BOOKING|FAQ|CANCEL|MODIFY|HUMAN|GREETING|OTHER","booking_follow_up":false,"entities":{"name":null,"people":null,"service":null,"staff":null,"date":null,"time":null,"date_reference":null,"date_range":{"from":null,"to":null},"special_request":null},"faq_topic":null}
Understand English, French, Arabic, Gulf Arabic, Moroccan Darija, and mixed language semantically. Do not use keyword matching. Use YYYY-MM-DD only for a specific day. For a period such as next week, leave date null and return an inclusive date_range; never choose an arbitrary day. Extract only information stated or changed in this message. Never invent services, staff, prices, facts, dates, times, or availability.
Configured services: ${JSON.stringify(services)}
Configured staff: ${JSON.stringify(staff)}
Conversation state: ${JSON.stringify(context.conversationState || {})}
Set booking_follow_up to true only when the message semantically continues an active booking. If the conversation state is an active booking (especially WAITING_FOR_SLOT), a request for available times, another slot, another date, or a short ambiguous reply to the last booking message is BOOKING, not FAQ. Preserve the existing booking fields and extract only changed fields.`;
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
  // Only the facts relevant to the actual outcome are sent - a stray
  // "faq_answer is null" instruction must never be in scope to contradict
  // a real booking_confirmed:true and tell a customer their booking failed.
  async generateResponse(message, analysis = {}, context = {}) {
    const facts = {
      businessName: context.businessName || null,
      businessType: context.businessType || null,
    };

    let outcome;
    if (analysis.booking_confirmed === true) {
      outcome = 'BOOKING_CONFIRMED';
      facts.booking = analysis.booking || null;
    } else if (analysis.staff_not_found) {
      outcome = 'STAFF_NOT_FOUND';
      facts.staff_not_found = analysis.staff_not_found;
    } else if (analysis.missing_information?.length) {
      outcome = 'MISSING_INFORMATION';
      facts.missing_information = analysis.missing_information;
    } else if (analysis.booking_available === false) {
      outcome = 'BOOKING_UNAVAILABLE';
      facts.availability_reason = analysis.availability_reason || null;
    } else {
      outcome = 'FAQ';
      facts.faq_answer = analysis.faq_answer ?? null;
    }

    try {
      // The customer message is given only as a language/tone sample, never
      // as something to answer directly - the outcome below is already
      // final. Putting it in the user turn as a live question let the model
      // ignore FACTS and improvise its own answer to it instead.
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 160,
        temperature: 0,
        system: `You write exactly one short WhatsApp reply for a business. The backend has already decided the OUTCOME below - your only job is to phrase it. Do not ask a clarifying question, do not re-interpret the request, do not add or omit any fact, do not invent services, prices, opening hours, staff, availability, confirmation, or business information.
Rules per OUTCOME value:
- BOOKING_CONFIRMED: confirm the booking using only the fields in FACTS.booking. Never say it is unavailable, never ask for more information, never suggest contacting the business.
- STAFF_NOT_FOUND: say that staff member is not available and ask the customer to choose someone else.
- MISSING_INFORMATION: ask only for the field(s) listed in FACTS.missing_information.
- BOOKING_UNAVAILABLE: politely say the requested time is not available, mentioning FACTS.availability_reason if present.
- FAQ: answer using only FACTS.faq_answer if it has data; otherwise say the information is unavailable and offer human help.
Reply in the same language as the customer sample below. Output only the reply text.
OUTCOME: ${outcome}
FACTS: ${JSON.stringify(facts)}`,
        messages: [
          {
            role: 'user',
            content: `Customer message (for language/tone matching only - already handled, do not answer it): ${JSON.stringify(String(message || ''))}`,
          },
        ],
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
      booking_follow_up: value?.booking_follow_up === true,
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

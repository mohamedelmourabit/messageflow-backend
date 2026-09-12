// handlers/IntentHandler.js

class IntentHandler {
  constructor(aiService, whatsappService, bookingService) {
    this.ai = aiService;
    this.whatsapp = whatsappService;
    this.booking = bookingService;
  }

  async handleMessage(user, phoneNumber, messageText) {
    try {
      console.log(`\n📱 Processing message from ${phoneNumber}`);
      console.log(`   Message: "${messageText}"`);

      // ============================================================
      // 1. AI ANALYSIS - ONE AI CALL
      // ============================================================

      const timezone = user.business_timezone || 'Asia/Dubai';

      const currentDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      const analysis = await this.ai.analyzeMessage(messageText, {
        businessName: user.business_name,
        timezone,
        currentDate,
      });

      console.log(`🤖 AI Analysis:`);
      console.log(JSON.stringify(analysis, null, 2));

      const intent = analysis.intent;

      // ============================================================
      // 2. ROUTE BY INTENT
      // ============================================================

      let response;
      let bookingData = null;

      switch (intent) {
        case 'BOOKING':
          const bookingResult = await this.handleBookingIntent(
            user,
            phoneNumber,
            messageText,
            analysis,
            timezone,
            currentDate,
          );

          response = bookingResult.response;
          bookingData = bookingResult.bookingData;
          break;

        case 'FAQ':
          response = await this.handleFAQIntent(user, messageText, analysis);
          break;

        case 'CANCEL':
          response = await this.handleCancelIntent(user, messageText, analysis);
          break;

        case 'MODIFY':
          response = await this.handleModifyIntent(user, messageText, analysis);
          break;

        case 'HUMAN':
          response = await this.handleHumanIntent(user, messageText, analysis);
          break;

        case 'GREETING':
          response = await this.handleGreetingIntent(
            user,
            messageText,
            analysis,
          );
          break;

        default:
          response = await this.generateAIResponse(user, messageText, analysis);
      }

      console.log(`✅ Response: "${response}"`);

      return {
        intent,
        response,
        bookingData,
        analysis,
      };
    } catch (err) {
      console.error('Handle message error:', err.message);

      return {
        intent: 'ERROR',
        response: 'Sorry, I encountered an error. Please try again.',
        bookingData: null,
        analysis: null,
      };
    }
  }

  // ================================================================
  // BOOKING
  // ================================================================

  async handleBookingIntent(
    user,
    phoneNumber,
    message,
    analysis,
    timezone,
    currentDate,
  ) {
    try {
      const entities = analysis.entities || {};

      let date = entities.date;
      const dateReference = entities.date_reference;

      const people = entities.people;
      const time = entities.time;
      const name = entities.name || 'Guest';
      const phone = entities.phone || phoneNumber;

      console.log(`📅 Booking entities:`);
      console.log(`   People: ${people}`);
      console.log(`   Date: ${date}`);
      console.log(`   Date reference: ${dateReference}`);
      console.log(`   Time: ${time}`);
      console.log(`   Name: ${name}`);
      console.log(`   Phone: ${phone}`);
      console.log(`   Special request: ${analysis.special_request}`);

      // ============================================================
      // Resolve semantic date reference
      // ============================================================

      if (!date && dateReference) {
        date = this.resolveDateReference(dateReference, currentDate);

        console.log(`📅 Resolved date: ${date}`);
      }

      // ============================================================
      // Check missing information
      // ============================================================

      const missingFields = [];

      if (!people) {
        missingFields.push('number of people');
      }

      if (!date) {
        missingFields.push('date');
      }

      if (!time) {
        missingFields.push('time');
      }

      if (missingFields.length > 0) {
        return {
          response: await this.generateMissingBookingResponse(
            user,
            message,
            analysis,
            missingFields,
          ),
          bookingData: null,
        };
      }

      // ============================================================
      // CHECK AVAILABILITY
      // ============================================================

      const isAvailable = await this.booking.checkAvailability(date, time);

      if (!isAvailable) {
        return {
          response: await this.generateAIResponse(user, message, {
            ...analysis,
            booking_status: 'UNAVAILABLE',
            booking_date: date,
            booking_time: time,
          }),
          bookingData: null,
        };
      }

      // ============================================================
      // CREATE BOOKING
      // ============================================================

      const booking = await this.booking.createBooking(
        user.id,
        name,
        phone,
        date,
        time,
      );

      if (!booking) {
        return {
          response: await this.generateAIResponse(user, message, {
            ...analysis,
            booking_status: 'FAILED',
          }),
          bookingData: null,
        };
      }

      console.log(`✅ Booking created: #${booking.id}`);

      // ============================================================
      // BOOKING CONFIRMED
      // ============================================================

      const bookingData = {
        id: booking.id,
        people,
        date,
        time,
        name,
        phone,
        special_request: analysis.special_request,
      };

      const response = await this.generateAIResponse(user, message, {
        ...analysis,
        booking_status: 'CONFIRMED',
        booking: bookingData,
      });

      return {
        response,
        bookingData,
      };
    } catch (err) {
      console.error('Booking intent error:', err.message);

      return {
        response: await this.generateAIResponse(user, message, {
          ...analysis,
          booking_status: 'ERROR',
        }),
        bookingData: null,
      };
    }
  }

  // ================================================================
  // FAQ
  // ================================================================

  async handleFAQIntent(user, message, analysis) {
    return await this.generateAIResponse(user, message, analysis);
  }

  // ================================================================
  // CANCEL
  // ================================================================

  async handleCancelIntent(user, message, analysis) {
    return await this.generateAIResponse(user, message, analysis);
  }

  // ================================================================
  // MODIFY
  // ================================================================

  async handleModifyIntent(user, message, analysis) {
    return await this.generateAIResponse(user, message, analysis);
  }

  // ================================================================
  // HUMAN
  // ================================================================

  async handleHumanIntent(user, message, analysis) {
    return await this.generateAIResponse(user, message, analysis);
  }

  // ================================================================
  // GREETING
  // ================================================================

  async handleGreetingIntent(user, message, analysis) {
    return await this.generateAIResponse(user, message, analysis);
  }

  // ================================================================
  // GENERIC AI RESPONSE
  // ================================================================

  async generateAIResponse(user, message, analysis) {
    const response = await this.ai.generateResponse(message, analysis, {
      businessName: user.business_name,
      businessType: user.business_type,
      timezone: user.business_timezone || 'Asia/Dubai',
    });

    return (
      response || 'Sorry, I could not process your request. Please try again.'
    );
  }

  // ================================================================
  // MISSING BOOKING INFORMATION
  // ================================================================

  async generateMissingBookingResponse(user, message, analysis, missingFields) {
    return await this.generateAIResponse(user, message, {
      ...analysis,
      booking_status: 'MISSING_INFORMATION',
      missing_fields: missingFields,
    });
  }

  // ================================================================
  // DATE RESOLUTION
  //
  // IMPORTANT:
  // AI understands the customer's language.
  // This function only performs deterministic date calculation.
  // It does NOT translate Arabic/Darija/French.
  //
  // The AI already converts semantic references to English:
  // "غدا", "بكرة", "tomorrow", "demain"
  //                    ↓
  //              "tomorrow"
  // ================================================================

  resolveDateReference(reference, currentDate) {
    if (!reference || !currentDate) {
      return null;
    }

    const ref = reference.toLowerCase().trim();

    // Parse current date as local calendar date
    const [year, month, day] = currentDate.split('-').map(Number);

    const baseDate = new Date(Date.UTC(year, month - 1, day));

    // Today
    if (ref === 'today' || ref === 'this day') {
      return this.formatDate(baseDate);
    }

    // Tomorrow
    if (ref === 'tomorrow' || ref === 'next day') {
      baseDate.setUTCDate(baseDate.getUTCDate() + 1);

      return this.formatDate(baseDate);
    }

    // Day after tomorrow
    if (ref === 'day after tomorrow') {
      baseDate.setUTCDate(baseDate.getUTCDate() + 2);

      return this.formatDate(baseDate);
    }

    // Yesterday
    if (ref === 'yesterday') {
      baseDate.setUTCDate(baseDate.getUTCDate() - 1);

      return this.formatDate(baseDate);
    }

    // Next weekday
    const weekdays = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };

    const match = ref.match(
      /^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
    );

    if (match) {
      const targetDay = weekdays[match[1]];
      const currentDay = baseDate.getUTCDay();

      let diff = targetDay - currentDay;

      if (diff <= 0) {
        diff += 7;
      }

      baseDate.setUTCDate(baseDate.getUTCDate() + diff);

      return this.formatDate(baseDate);
    }

    return null;
  }

  formatDate(date) {
    return date.toISOString().split('T')[0];
  }
}

module.exports = IntentHandler;

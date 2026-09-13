// ============================================
// MESSAGEFLOW - INTENT HANDLER
// Conversation state + AI + Booking
// ============================================

class IntentHandler {
  constructor(services) {
    this.ai = services.ai;
    this.whatsapp = services.whatsapp;
    this.booking = services.booking;
    this.db = services.db;
  }

  // ==========================================
  // CONVERSATION STATE
  // ==========================================

  async getConversationState(userId, phoneNumber) {
    try {
      const result = await this.db.query(
        `
        SELECT state
        FROM conversation_states
        WHERE user_id = $1
          AND customer_phone = $2
        LIMIT 1
        `,
        [userId, phoneNumber],
      );

      return result.rows[0]?.state || null;
    } catch (err) {
      console.error('Get conversation state error:', err.message);

      return null;
    }
  }

  async saveConversationState(userId, phoneNumber, state) {
    try {
      await this.db.query(
        `
        INSERT INTO conversation_states (
          user_id,
          customer_phone,
          state,
          updated_at
        )
        VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)

        ON CONFLICT (user_id, customer_phone)
        DO UPDATE SET
          state = EXCLUDED.state,
          updated_at = CURRENT_TIMESTAMP
        `,
        [userId, phoneNumber, JSON.stringify(state)],
      );

      console.log('💾 Conversation state saved');
    } catch (err) {
      console.error('Save conversation state error:', err.message);
    }
  }

  async clearConversationState(userId, phoneNumber) {
    try {
      await this.db.query(
        `
        DELETE FROM conversation_states
        WHERE user_id = $1
          AND customer_phone = $2
        `,
        [userId, phoneNumber],
      );

      console.log('🧹 Conversation state cleared');
    } catch (err) {
      console.error('Clear conversation state error:', err.message);
    }
  }

  // ==========================================
  // MAIN HANDLER
  // ==========================================

  async handleMessage(user, phoneNumber, message) {
    try {
      console.log('🧠 Analyzing message...');

      // 1. Load previous conversation state
      const conversationState = await this.getConversationState(
        user.id,
        phoneNumber,
      );

      console.log(
        '🗂️ Previous state:',
        JSON.stringify(conversationState, null, 2),
      );

      // 2. AI context
      const context = {
        businessName: user.business_name,
        businessType: user.business_type,
        timezone: user.business_timezone || 'Asia/Dubai',

        conversationState: conversationState || {},
      };

      // 3. ONE AI analysis
      const analysis = await this.ai.analyzeMessage(message, context);

      console.log('🧠 AI analysis:', JSON.stringify(analysis, null, 2));

      // 4. Route intent
      switch (analysis.intent) {
        case 'BOOKING':
          return await this.handleBooking(
            user,
            phoneNumber,
            message,
            analysis,
            conversationState,
          );

        case 'CANCEL':
          return await this.handleCancel(user, phoneNumber, analysis);

        case 'MODIFY':
          return await this.handleModify(user, phoneNumber, analysis);

        case 'FAQ':
          return await this.handleFAQ(user, phoneNumber, message, analysis);

        case 'HUMAN':
          return {
            intent: 'HUMAN',
            response:
              'Of course. I will connect you with someone from our team.',
          };

        case 'GREETING':
          return {
            intent: 'GREETING',
            response: `Welcome to ${user.business_name || 'our business'}! How can I help you today?`,
          };

        default:
          return {
            intent: 'OTHER',
            response: await this.ai.generateResponse(message, analysis, {
              businessName: user.business_name,
              businessType: user.business_type,
            }),
          };
      }
    } catch (err) {
      console.error('IntentHandler error:', err.message);

      return {
        intent: 'OTHER',
        response: 'Sorry, I was unable to process your request right now.',
      };
    }
  }

  // ==========================================
  // BOOKING
  // ==========================================

  async handleBooking(user, phoneNumber, message, analysis, previousState) {
    const entities = analysis.entities || {};

    const previousBooking = previousState?.booking || {};

    // ------------------------------------------
    // MERGE OLD + NEW INFORMATION
    // ------------------------------------------

    const customerName =
      entities.name ||
      entities.customer_name ||
      previousBooking.customerName ||
      null;

    const people =
      this.toNumber(
        entities.people || entities.guests || entities.party_size,
      ) ||
      previousBooking.people ||
      null;

    let bookingDate = entities.date || previousBooking.date || null;

    let bookingTime =
      entities.time || entities.time_reference || previousBooking.time || null;

    const service =
      entities.service ||
      entities.service_name ||
      entities.serviceName ||
      previousBooking.service ||
      null;

    const staff =
      entities.staff ||
      entities.staff_name ||
      entities.staffName ||
      previousBooking.staff ||
      null;

    const specialRequest =
      analysis.special_request ||
      entities.special_request ||
      previousBooking.specialRequest ||
      null;

    // ------------------------------------------
    // DATE RESOLUTION
    // ------------------------------------------

    if (!bookingDate) {
      const dateReference =
        entities.date_reference || entities.dateReference || null;

      if (dateReference) {
        bookingDate = this.resolveDateReference(
          dateReference,
          user.business_timezone || 'Asia/Dubai',
        );
      }
    }

    // ------------------------------------------
    // CURRENT STATE
    // ------------------------------------------

    const currentBooking = {
      customerName,
      people,
      date: bookingDate,
      time: bookingTime,
      service,
      staff,
      specialRequest,
    };

    console.log(
      '📋 Current booking state:',
      JSON.stringify(currentBooking, null, 2),
    );

    // ------------------------------------------
    // SALON
    // ------------------------------------------

    if (String(user.business_type || '').toLowerCase() === 'salon') {
      return await this.handleSalonBooking(
        user,
        phoneNumber,
        analysis,
        currentBooking,
      );
    }

    // ------------------------------------------
    // RESTAURANT
    // ------------------------------------------

    if (String(user.business_type || '').toLowerCase() === 'restaurant') {
      return await this.handleRestaurantBooking(
        user,
        phoneNumber,
        analysis,
        currentBooking,
      );
    }

    // ------------------------------------------
    // GENERIC
    // ------------------------------------------

    return await this.handleGenericBooking(
      user,
      phoneNumber,
      analysis,
      currentBooking,
    );
  }

  // ==========================================
  // SALON BOOKING
  // ==========================================

  async handleSalonBooking(user, phoneNumber, analysis, booking) {
    // Save incomplete state first
    if (!booking.customerName) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'Sure! May I have your name?',
      };
    }

    if (!booking.date) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'What day would you like your appointment?',
      };
    }

    if (!booking.time) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'What time would you prefer?',
      };
    }

    // ------------------------------------------
    // FIND SERVICE + STAFF AVAILABILITY
    // ------------------------------------------

    const serviceId = await this.findServiceId(user.id, booking.service);

    const staffId = await this.findStaffId(user.id, booking.staff);

    const availability = await this.booking.findBestSalonAvailability(
      user.id,
      booking.date,
      booking.time,
      serviceId,
      staffId,
    );

    if (!availability?.available) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response:
          'I’m sorry, but I don’t have availability at that time. Would you like another time?',
      };
    }

    // ------------------------------------------
    // CREATE BOOKING
    // ------------------------------------------

    const result = await this.booking.createBooking(
      user.id,
      booking.customerName,
      phoneNumber,
      null,
      booking.date,
      booking.time,
      {
        serviceId: availability.serviceId || serviceId || null,

        staffId: availability.staffId || staffId || null,

        specialRequest: booking.specialRequest || null,

        endTime: availability.endTime || null,
      },
    );

    if (!result?.success) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response:
          'Sorry, I couldn’t complete the booking. Would you like to try another time?',
      };
    }

    // ------------------------------------------
    // SUCCESS
    // ------------------------------------------

    await this.clearConversationState(user.id, phoneNumber);

    return {
      intent: 'BOOKING',
      response: `✅ Your appointment is confirmed for ${booking.date} at ${booking.time}. We look forward to seeing you!`,
      booking: result,
    };
  }

  // ==========================================
  // RESTAURANT BOOKING
  // ==========================================

  async handleRestaurantBooking(user, phoneNumber, analysis, booking) {
    if (!booking.customerName) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'Sure! May I have your name?',
      };
    }

    if (!booking.people) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'How many people will the reservation be for?',
      };
    }

    if (!booking.date) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'What day would you like to book?',
      };
    }

    if (!booking.time) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'What time would you prefer?',
      };
    }

    const availability = await this.booking.checkRestaurantAvailability(
      user.id,
      booking.date,
      booking.time,
      booking.people,
    );

    if (!availability?.available) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response:
          'Sorry, we don’t have a table available at that time. Would you like another time?',
      };
    }

    const result = await this.booking.createBooking(
      user.id,
      booking.customerName,
      phoneNumber,
      booking.people,
      booking.date,
      booking.time,
      {
        tableTypeId: availability.tableTypeId || null,

        specialRequest: booking.specialRequest || null,

        endTime: availability.endTime || null,
      },
    );

    if (!result?.success) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response:
          'Sorry, I couldn’t complete the reservation. Would you like another time?',
      };
    }

    await this.clearConversationState(user.id, phoneNumber);

    return {
      intent: 'BOOKING',
      response: `✅ Your table is confirmed for ${booking.date} at ${booking.time} for ${booking.people} people. See you soon!`,
      booking: result,
    };
  }

  // ==========================================
  // GENERIC BOOKING
  // ==========================================

  async handleGenericBooking(user, phoneNumber, analysis, booking) {
    if (!booking.customerName) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'May I have your name?',
      };
    }

    if (!booking.date) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'What day would you like to book?',
      };
    }

    if (!booking.time) {
      await this.saveConversationState(user.id, phoneNumber, {
        status: 'collecting',
        booking,
      });

      return {
        intent: 'BOOKING',
        response: 'What time would you prefer?',
      };
    }

    const result = await this.booking.createBooking(
      user.id,
      booking.customerName,
      phoneNumber,
      null,
      booking.date,
      booking.time,
      {
        specialRequest: booking.specialRequest || null,
      },
    );

    if (!result?.success) {
      return {
        intent: 'BOOKING',
        response: 'Sorry, I couldn’t complete the booking.',
      };
    }

    await this.clearConversationState(user.id, phoneNumber);

    return {
      intent: 'BOOKING',
      response: `✅ Your appointment is confirmed for ${booking.date} at ${booking.time}.`,
      booking: result,
    };
  }

  // ==========================================
  // SERVICE LOOKUP
  // ==========================================

  async findServiceId(userId, serviceName) {
    if (!serviceName) return null;

    const services = await this.booking.getServices(userId);

    const normalized = String(serviceName).trim().toLowerCase();

    const match =
      services.find(
        (service) => String(service.name).trim().toLowerCase() === normalized,
      ) ||
      services.find(
        (service) =>
          String(service.name).toLowerCase().includes(normalized) ||
          normalized.includes(String(service.name).toLowerCase()),
      );

    return match?.id || null;
  }

  // ==========================================
  // STAFF LOOKUP
  // ==========================================

  async findStaffId(userId, staffName) {
    if (!staffName) return null;

    const staff = await this.booking.getStaff(userId);

    const normalized = String(staffName).trim().toLowerCase();

    const match =
      staff.find(
        (person) => String(person.name).trim().toLowerCase() === normalized,
      ) ||
      staff.find(
        (person) =>
          String(person.name).toLowerCase().includes(normalized) ||
          normalized.includes(String(person.name).toLowerCase()),
      );

    return match?.id || null;
  }

  // ==========================================
  // DATE RESOLVER
  // ==========================================

  resolveDateReference(reference, timezone = 'Asia/Dubai') {
    if (!reference) return null;

    const now = new Date();

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const today = formatter.format(now);

    const base = new Date(`${today}T12:00:00`);

    const normalized = String(reference).trim().toLowerCase();

    if (normalized === 'today') {
      return today;
    }

    if (normalized === 'tomorrow') {
      base.setDate(base.getDate() + 1);

      return this.formatDate(base);
    }

    if (normalized === 'day after tomorrow') {
      base.setDate(base.getDate() + 2);

      return this.formatDate(base);
    }

    return null;
  }

  formatDate(date) {
    return date.toISOString().split('T')[0];
  }

  // ==========================================
  // NUMBER
  // ==========================================

  toNumber(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
  }

  // ==========================================
  // CANCEL
  // ==========================================

  async handleCancel(user, phoneNumber, analysis) {
    await this.clearConversationState(user.id, phoneNumber);

    return {
      intent: 'CANCEL',
      response:
        'Sure. I can help you cancel your appointment. Please provide the appointment details.',
    };
  }

  // ==========================================
  // MODIFY
  // ==========================================

  async handleModify(user, phoneNumber, analysis) {
    const state = await this.getConversationState(user.id, phoneNumber);

    if (state?.booking) {
      return {
        intent: 'BOOKING',
        response: 'Sure. What would you like to change about your appointment?',
      };
    }

    return {
      intent: 'MODIFY',
      response: 'Sure. What would you like to change about your appointment?',
    };
  }

  // ==========================================
  // FAQ
  // ==========================================

  async handleFAQ(user, phoneNumber, message, analysis) {
    return {
      intent: 'FAQ',
      response: await this.ai.generateResponse(message, analysis, {
        businessName: user.business_name,
        businessType: user.business_type,
      }),
    };
  }
}

module.exports = IntentHandler;

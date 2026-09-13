const AIService = require('../services/AIService');

class IntentHandler {
  constructor(services) {
    this.ai = services.ai;
    this.booking = services.booking;
    this.whatsapp = services.whatsapp;
    this.db = services.db;
  }

  // =========================================================
  // MAIN MESSAGE HANDLER
  // =========================================================

  async handleMessage(user, phoneNumber, message, interaction = {}) {
    try {
      console.log('\n🧠 Analyzing message...');
      console.log(`📩 ${message}`);

      // A WhatsApp list/quick-reply click is deterministic.
      // Do not waste an AI call: use the payload + saved state.
      const buttonPayload = interaction.buttonPayload || null;
      if (buttonPayload) {
        const selectedResult = await this.handleInteractiveSelection(
          user,
          phoneNumber,
          message,
          buttonPayload,
        );

        if (selectedResult) {
          return selectedResult;
        }
      }

      const conversationState = await this.getConversationState(
        user.id,
        phoneNumber,
      );

      const availableServices = await this.booking.getServices(user.id);
      const availableStaff = await this.booking.getStaff(user.id);

      const context = {
        businessName: user.business_name,
        businessType: user.business_type,
        timezone: user.business_timezone || 'Asia/Dubai',
        conversationState,
        availableServices,
        availableStaff,
      };

      // -----------------------------------------------------
      // ONE AI CALL
      // -----------------------------------------------------

      const analysis = await this.ai.analyzeMessage(message, context);

      console.log('🧠 AI analysis:', JSON.stringify(analysis, null, 2));

      const mergedState = this.mergeConversationState(
        conversationState,
        analysis,
      );

      await this.saveConversationState(user.id, phoneNumber, mergedState);

      const intent = analysis.intent;

      // -----------------------------------------------------
      // ROUTE INTENT
      // -----------------------------------------------------

      switch (intent) {
        case 'BOOKING':
          return await this.handleBooking(user, phoneNumber, message, analysis);

        case 'FAQ':
          return await this.handleFAQ(user, phoneNumber, message, analysis);

        case 'CANCEL':
          return await this.handleCancel(user, phoneNumber, message, analysis);

        case 'MODIFY':
          return await this.handleModify(user, phoneNumber, message, analysis);

        case 'HUMAN':
          return await this.handleHuman(user, phoneNumber, message, analysis);

        case 'GREETING':
          return await this.handleGreeting(
            user,
            phoneNumber,
            message,
            analysis,
          );

        default:
          return await this.generateAIResponse(
            user,
            phoneNumber,
            message,
            analysis,
          );
      }
    } catch (err) {
      console.error('IntentHandler error:', err.message);

      return {
        intent: 'OTHER',
        response: 'Sorry, something went wrong. Please try again.',
      };
    }
  }

  // =========================================================
  // BOOKING
  // =========================================================

  async handleBooking(user, phoneNumber, message, analysis) {
    try {
      const entities = analysis.entities || {};
      const conversationState = await this.getConversationState(user.id, phoneNumber);

      // -----------------------------------------------------
      // BASIC DATA
      // -----------------------------------------------------

      const businessType = String(user.business_type || '').toLowerCase();

      const customerName =
        entities.name || entities.customer_name || conversationState.name || null;

      // IMPORTANT:
      // Phone ALWAYS comes from WhatsApp.
      const customerPhone = phoneNumber;

      const people = this.toNumber(
        entities.people || entities.guests || entities.party_size || conversationState.people,
      );

      let bookingDate = entities.date || conversationState.date || null;

      const dateReference =
        entities.date_reference || entities.dateReference || null;

      const bookingTime =
        entities.time ||
        entities.time_reference ||
        entities.timeReference ||
        conversationState.time ||
        null;

      const specialRequest =
        entities.special_request || analysis.special_request || null;

      // -----------------------------------------------------
      // RESOLVE DATE
      // -----------------------------------------------------

      if (!bookingDate && dateReference) {
        bookingDate = this.resolveDateReference(
          dateReference,
          user.business_timezone || 'Asia/Dubai',
        );
      }

      // -----------------------------------------------------
      // REQUIRED: DATE
      // -----------------------------------------------------

      if (!bookingDate) {
        return {
          intent: 'BOOKING',
          response: await this.generateAIResponse(user, phoneNumber, message, {
            ...analysis,
            missing_information: ['date'],
          }),
        };
      }

      // -----------------------------------------------------
      // REQUIRED: TIME
      // -----------------------------------------------------

      if (!bookingTime) {
        return {
          intent: 'BOOKING',
          response: await this.generateAIResponse(user, phoneNumber, message, {
            ...analysis,
            missing_information: ['time'],
          }),
        };
      }

      // =====================================================
      // RESTAURANT
      // =====================================================

      if (
        businessType.includes('restaurant') ||
        businessType.includes('resto')
      ) {
        return await this.handleRestaurantBooking(
          user,
          phoneNumber,
          message,
          analysis,
          {
            customerName,
            customerPhone,
            people,
            bookingDate,
            bookingTime,
            specialRequest,
          },
        );
      }

      // =====================================================
      // SALON
      // =====================================================

      if (
        businessType.includes('salon') ||
        businessType.includes('hair') ||
        businessType.includes('beauty') ||
        businessType.includes('barber')
      ) {
        return await this.handleSalonBooking(
          user,
          phoneNumber,
          message,
          analysis,
          {
            customerName,
            customerPhone,
            bookingDate,
            bookingTime,
            specialRequest,
          },
        );
      }

      // =====================================================
      // GENERIC SERVICE / SLOT
      // =====================================================

      return await this.handleGenericBooking(
        user,
        phoneNumber,
        message,
        analysis,
        {
          customerName,
          customerPhone,
          people,
          bookingDate,
          bookingTime,
          specialRequest,
        },
      );
    } catch (err) {
      console.error('Handle booking error:', err.message);

      return {
        intent: 'BOOKING',
        response: 'Sorry, I could not process your booking right now.',
      };
    }
  }

  // =========================================================
  // RESTAURANT BOOKING
  // =========================================================

  async handleRestaurantBooking(user, phoneNumber, message, analysis, data) {
    const {
      customerName,
      customerPhone,
      people,
      bookingDate,
      bookingTime,
      specialRequest,
    } = data;

    // -----------------------------------------------------
    // CUSTOMER NAME
    // -----------------------------------------------------

    if (!customerName) {
      await this.saveConversationState(user.id, phoneNumber, {
        ...(await this.getConversationState(user.id, phoneNumber)),
        status: 'WAITING_FOR_NAME',
        date: bookingDate,
        time: bookingTime,
      });

      return {
        intent: 'BOOKING',
        response: 'What name should I use for the booking?',
      };
    }

    // -----------------------------------------------------
    // RESTAURANT REQUIRES NUMBER OF PEOPLE
    // -----------------------------------------------------

    if (!people) {
      return {
        intent: 'BOOKING',
        response: await this.generateAIResponse(user, phoneNumber, message, {
          ...analysis,
          missing_information: ['people'],
        }),
      };
    }

    // -----------------------------------------------------
    // GET BUSINESS SETTINGS
    // -----------------------------------------------------

    const settings = await this.booking.getBusinessSettings(user.id);

    const duration = Number(settings.default_booking_duration_minutes || 90);

    const endTime = this.booking.calculateEndTime(bookingTime, duration);

    // -----------------------------------------------------
    // OPTIONAL ZONE
    // -----------------------------------------------------

    const requestedZone = this.extractZone(analysis);

    // -----------------------------------------------------
    // CHECK TABLE
    // -----------------------------------------------------

    const availability = await this.booking.checkRestaurantAvailability(
      user.id,
      bookingDate,
      bookingTime,
      endTime,
      people,
      requestedZone,
    );

    if (!availability.available) {
      return {
        intent: 'BOOKING',
        response: await this.generateAIResponse(user, phoneNumber, message, {
          ...analysis,
          booking_available: false,
          availability_reason: availability.reason,
        }),
      };
    }

    // -----------------------------------------------------
    // CREATE BOOKING
    // -----------------------------------------------------

    const result = await this.booking.createBooking(
      user.id,
      customerName,
      customerPhone,
      people,
      bookingDate,
      bookingTime,
      {
        endTime,
        tableTypeId: availability.tableType?.id || null,
        specialRequest,
      },
    );

    if (!result.success) {
      return {
        intent: 'BOOKING',
        response: 'Sorry, I could not confirm your booking.',
      };
    }

    // -----------------------------------------------------
    // CONFIRMED
    // -----------------------------------------------------

    return {
      intent: 'BOOKING',
      response: await this.generateAIResponse(user, phoneNumber, message, {
        ...analysis,
        booking_available: true,
        booking_confirmed: true,
        booking: {
          id: result.booking.id,
          date: bookingDate,
          time: bookingTime,
          end_time: endTime,
          people,
          table_type: availability.tableType?.name || null,
        },
      }),
      booking: result.booking,
    };
  }

  // =========================================================
  // SALON BOOKING
  // =========================================================

  async handleSalonBooking(user, phoneNumber, message, analysis, data) {
    const {
      customerName,
      customerPhone,
      bookingDate,
      bookingTime,
      specialRequest,
    } = data;

    const entities = analysis.entities || {};

    // -----------------------------------------------------
    // SERVICE
    // -----------------------------------------------------

    const requestedService =
      entities.service ||
      entities.service_name ||
      entities.serviceName ||
      (await this.getConversationState(user.id, phoneNumber)).service ||
      null;

    // -----------------------------------------------------
    // SERVICE IS REQUIRED FOR A SALON
    // Never auto-select a random service.
    // -----------------------------------------------------
    if (!requestedService) {
      const services = await this.booking.getServices(user.id);

      if (!services.length) {
        return {
          intent: 'BOOKING',
          response: 'Sorry, this business has no services configured yet.',
        };
      }

      await this.saveConversationState(user.id, phoneNumber, {
        ...(await this.getConversationState(user.id, phoneNumber)),
        status: 'WAITING_FOR_SERVICE',
      });

      return {
        intent: 'BOOKING',
        response: 'Please choose one of our available services.',
        interactive: {
          type: 'list',
          body: 'Please choose one of our available services.',
          button: 'Choose a service',
          items: services.slice(0, 10).map((service) => ({
            id: `service:${service.id}`,
            item: service.name,
            description: `${service.duration_minutes} min${service.price != null ? ` • ${service.price}` : ''}`,
          })),
        },
      };
    }

    // -----------------------------------------------------
    // STAFF
    // -----------------------------------------------------

    const currentState = await this.getConversationState(user.id, phoneNumber);
    const requestedStaff =
      entities.staff || entities.staff_name || entities.staffName || currentState.staff || null;

    // -----------------------------------------------------
    // RESOLVE SERVICE ID
    //
    // If AI understood the requested service,
    // find the actual DB service.
    //
    // If no service was mentioned:
    // serviceId remains null.
    // findBestSalonAvailability() will try
    // configured services automatically.
    // -----------------------------------------------------

    let serviceId = null;

    if (requestedService) {
      serviceId = await this.findServiceId(user.id, requestedService);

      // AI mentioned a service but DB doesn't contain it.
      if (!serviceId) {
        const services = await this.booking.getServices(user.id);

        await this.saveConversationState(user.id, phoneNumber, {
          ...mergedState,
          status: 'WAITING_FOR_SERVICE',
          requested_service: requestedService,
          service: null,
          service_id: null,
        });

        if (!services.length) {
          return {
            intent: 'BOOKING',
            response: 'Sorry, this business has no services configured yet.',
          };
        }

        return {
          intent: 'BOOKING',
          response: `I don't currently offer ${requestedService}. Please choose one of our available services.`,
          interactive: {
            type: 'list',
            body: `I don't currently offer ${requestedService}. Please choose one of our available services.`,
            button: 'Choose a service',
            items: services.slice(0, 10).map((service) => ({
              id: `service:${service.id}`,
              item: service.name,
              description: `${service.duration_minutes} min${service.price != null ? ` • ${service.price}` : ''}`,
            })),
          },
        };
      }
    }

    // -----------------------------------------------------
    // RESOLVE STAFF ID
    // -----------------------------------------------------

    let staffId = null;

    if (requestedStaff) {
      staffId = await this.findStaffId(user.id, requestedStaff);

      if (!staffId) {
        return {
          intent: 'BOOKING',
          response: await this.generateAIResponse(user, phoneNumber, message, {
            ...analysis,
            staff_not_found: requestedStaff,
          }),
        };
      }
    }

    // -----------------------------------------------------
    // AUTOMATIC SERVICE + STAFF SELECTION
    //
    // This is the important part.
    //
    // Example:
    //
    // "I want an appointment tomorrow at 18h"
    //
    // serviceId = null
    // staffId   = null
    //
    // BookingService searches:
    //
    // service 1 → staff 1 ❌
    // service 1 → staff 2 ❌
    // service 2 → staff 1 ✅
    //
    // -----------------------------------------------------

    const availability = await this.booking.findBestSalonAvailability(
      user.id,
      bookingDate,
      bookingTime,
      serviceId,
      staffId,
    );

    if (!availability.available) {
      const alternatives = await this.booking.findAlternativeSalonSlots(
        user.id,
        bookingDate,
        bookingTime,
        serviceId,
        staffId,
        5,
      );

      await this.saveConversationState(user.id, phoneNumber, {
        ...mergedState,
        status: 'WAITING_FOR_SLOT',
        service: requestedService || null,
        service_id: serviceId,
        staff_id: staffId,
        date: bookingDate,
        time: bookingTime,
      });

      if (alternatives.length) {
        return {
          intent: 'BOOKING',
          response: `The requested time ${bookingTime} is not available. Please choose another time.`,
          interactive: {
            type: 'list',
            body: `The requested time ${bookingTime} is not available. Please choose another time.`,
            button: 'Choose a time',
            items: alternatives.map((slot) => ({
              id: `slot:${slot.startTime}`,
              item: slot.startTime,
              description: slot.endTime ? `Available until ${slot.endTime}` : 'Available',
            })),
          },
        };
      }

      return {
        intent: 'BOOKING',
        response: await this.generateAIResponse(user, phoneNumber, message, {
          ...analysis,
          booking_available: false,
          availability_reason: availability.reason,
        }),
      };
    }

    const selectedService = availability.service;

    const selectedStaff = availability.staff;

    const endTime = availability.endTime;

    if (!customerName) {
      await this.saveConversationState(user.id, phoneNumber, {
        ...(await this.getConversationState(user.id, phoneNumber)),
        status: 'WAITING_FOR_NAME',
        service: selectedService?.name || requestedService,
        service_id: selectedService?.id || serviceId,
        staff_id: selectedStaff?.id || staffId,
        date: bookingDate,
        time: bookingTime,
      });

      return {
        intent: 'BOOKING',
        response: `Your ${selectedService?.name || requestedService} is available at ${bookingTime}. What name should I use for the booking?`,
      };
    }

    // -----------------------------------------------------
    // CREATE BOOKING
    // -----------------------------------------------------

    const result = await this.booking.createBooking(
      user.id,
      customerName,
      customerPhone,
      1,
      bookingDate,
      bookingTime,
      {
        endTime,
        serviceId: selectedService?.id || null,
        staffId: selectedStaff?.id || null,
        specialRequest,
      },
    );

    if (!result.success) {
      return {
        intent: 'BOOKING',
        response: 'Sorry, I could not confirm your appointment.',
      };
    }

    // -----------------------------------------------------
    // CONFIRMED
    // -----------------------------------------------------

    await this.clearConversationState(user.id, phoneNumber);

    return {
      intent: 'BOOKING',
      response: await this.generateAIResponse(user, phoneNumber, message, {
        ...analysis,
        booking_available: true,
        booking_confirmed: true,
        booking: {
          id: result.booking.id,
          date: bookingDate,
          time: bookingTime,
          end_time: endTime,
          service: selectedService?.name || null,
          staff: selectedStaff?.name || null,
        },
      }),
      booking: result.booking,
    };
  }

  // =========================================================
  // GENERIC SERVICE / SLOT
  // =========================================================

  async handleGenericBooking(user, phoneNumber, message, analysis, data) {
    const {
      customerName,
      customerPhone,
      people,
      bookingDate,
      bookingTime,
      specialRequest,
    } = data;

    const settings = await this.booking.getBusinessSettings(user.id);

    const duration = Number(settings.default_booking_duration_minutes || 60);

    const endTime = this.booking.calculateEndTime(bookingTime, duration);

    const availability = await this.booking.checkSlotAvailability(
      user.id,
      bookingDate,
      bookingTime,
      endTime,
    );

    if (!availability.available) {
      return {
        intent: 'BOOKING',
        response: await this.generateAIResponse(user, phoneNumber, message, {
          ...analysis,
          booking_available: false,
          availability_reason: 'NO_SLOT_AVAILABLE',
        }),
      };
    }

    const result = await this.booking.createBooking(
      user.id,
      customerName,
      customerPhone,
      people || 1,
      bookingDate,
      bookingTime,
      {
        endTime,
        specialRequest,
      },
    );

    if (!result.success) {
      return {
        intent: 'BOOKING',
        response: 'Sorry, I could not confirm your booking.',
      };
    }

    return {
      intent: 'BOOKING',
      response: await this.generateAIResponse(user, phoneNumber, message, {
        ...analysis,
        booking_available: true,
        booking_confirmed: true,
        booking: {
          id: result.booking.id,
          date: bookingDate,
          time: bookingTime,
          end_time: endTime,
        },
      }),
      booking: result.booking,
    };
  }

  // =========================================================
  // CONVERSATION STATE
  // =========================================================

  async getConversationState(userId, phoneNumber) {
    if (!this.db) return {};

    try {
      const result = await this.db.query(
        `SELECT state FROM conversation_states
         WHERE user_id = $1 AND customer_phone = $2
         LIMIT 1`,
        [userId, phoneNumber],
      );

      return result.rows[0]?.state || {};
    } catch (err) {
      console.error('Get conversation state error:', err.message);
      return {};
    }
  }

  async saveConversationState(userId, phoneNumber, state) {
    if (!this.db) return;

    try {
      await this.db.query(
        `INSERT INTO conversation_states
           (user_id, customer_phone, state, updated_at)
         VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, customer_phone)
         DO UPDATE SET
           state = EXCLUDED.state,
           updated_at = CURRENT_TIMESTAMP`,
        [userId, phoneNumber, JSON.stringify(state || {})],
      );
    } catch (err) {
      console.error('Save conversation state error:', err.message);
    }
  }

  async clearConversationState(userId, phoneNumber) {
    if (!this.db) return;

    try {
      await this.db.query(
        `DELETE FROM conversation_states
         WHERE user_id = $1 AND customer_phone = $2`,
        [userId, phoneNumber],
      );
    } catch (err) {
      console.error('Clear conversation state error:', err.message);
    }
  }

  mergeConversationState(previous, analysis) {
    const entities = analysis?.entities || {};
    const next = { ...(previous || {}) };

    const values = {
      name: entities.name || entities.customer_name,
      people: entities.people || entities.guests || entities.party_size,
      service: entities.service || entities.service_name || entities.serviceName,
      service_id: entities.service_id || entities.serviceId,
      staff: entities.staff || entities.staff_name || entities.staffName,
      staff_id: entities.staff_id || entities.staffId,
      date: entities.date,
      time: entities.time || entities.time_reference || entities.timeReference,
      special_request: entities.special_request || analysis?.special_request,
    };

    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && value !== '') {
        next[key] = value;
      }
    }

    next.intent = analysis?.intent || next.intent;
    return next;
  }

  async handleInteractiveSelection(user, phoneNumber, message, payload) {
    const state = await this.getConversationState(user.id, phoneNumber);

    if (payload.startsWith('service:')) {
      const serviceId = Number(payload.slice('service:'.length));
      if (!Number.isInteger(serviceId)) return null;

      const services = await this.booking.getServices(user.id);
      const service = services.find((item) => Number(item.id) === serviceId);
      if (!service) return null;

      const bookingDate = state.date || null;
      const bookingTime = state.time || null;

      const nextState = {
        ...state,
        status: 'SERVICE_SELECTED',
        service: service.name,
        service_id: service.id,
      };

      await this.saveConversationState(user.id, phoneNumber, nextState);

      if (!bookingDate || !bookingTime) {
        return {
          intent: 'BOOKING',
          response: `Great, ${service.name} selected. What date and time would you prefer?`,
        };
      }

      return await this.processSalonAvailabilityAfterSelection(
        user,
        phoneNumber,
        message,
        nextState,
      );
    }

    if (payload.startsWith('slot:')) {
      const selectedTime = payload.slice('slot:'.length);
      if (!/^\d{2}:\d{2}$/.test(selectedTime)) return null;

      const nextState = {
        ...state,
        status: 'SLOT_SELECTED',
        time: selectedTime,
      };

      await this.saveConversationState(user.id, phoneNumber, nextState);

      return await this.processSalonAvailabilityAfterSelection(
        user,
        phoneNumber,
        message,
        nextState,
      );
    }

    return null;
  }

  async processSalonAvailabilityAfterSelection(
    user,
    phoneNumber,
    message,
    state,
  ) {
    if (!state.service_id || !state.date || !state.time) {
      return {
        intent: 'BOOKING',
        response: 'Please provide the date and time for the appointment.',
      };
    }

    const staffId = state.staff_id || null;
    const availability = await this.booking.findBestSalonAvailability(
      user.id,
      state.date,
      state.time,
      state.service_id,
      staffId,
    );

    if (!availability.available) {
      const alternatives = await this.booking.findAlternativeSalonSlots(
        user.id,
        state.date,
        state.time,
        state.service_id,
        staffId,
        5,
      );

      if (!alternatives.length) {
        return {
          intent: 'BOOKING',
          response: 'That time is no longer available. Please choose another time.',
        };
      }

      return {
        intent: 'BOOKING',
        response: 'That time is no longer available. Please choose another time.',
        interactive: {
          type: 'list',
          body: 'That time is no longer available. Please choose another time.',
          button: 'Choose a time',
          items: alternatives.map((slot) => ({
            id: `slot:${slot.startTime}`,
            item: slot.startTime,
            description: slot.endTime ? `Available until ${slot.endTime}` : 'Available',
          })),
        },
      };
    }

    const customerName = state.name || null;
    if (!customerName) {
      return {
        intent: 'BOOKING',
        response: 'Great. What name should I use for the booking?',
      };
    }

    const result = await this.booking.createBooking(
      user.id,
      customerName,
      phoneNumber,
      1,
      state.date,
      state.time,
      {
        endTime: availability.endTime,
        serviceId: availability.service?.id || state.service_id,
        staffId: availability.staff?.id || staffId,
        specialRequest: state.special_request || null,
      },
    );

    if (!result.success) {
      return {
        intent: 'BOOKING',
        response: 'Sorry, I could not confirm your appointment. Please choose another time.',
      };
    }

    await this.clearConversationState(user.id, phoneNumber);

    return {
      intent: 'BOOKING',
      response: `Perfect. Your ${availability.service?.name || state.service} appointment is confirmed for ${state.date} at ${state.time}.`,
      booking: result.booking,
    };
  }

  // =========================================================
  // FIND SERVICE
  // =========================================================

  async findServiceId(userId, serviceName) {
    try {
      const services = await this.booking.getServices(userId);

      if (!serviceName) {
        return null;
      }

      const wanted = String(serviceName).trim().toLowerCase();

      // Exact match first
      const exact = services.find(
        (service) => String(service.name).trim().toLowerCase() === wanted,
      );

      if (exact) {
        return exact.id;
      }

      // Then substring match
      const partial = services.find((service) => {
        const name = String(service.name).trim().toLowerCase();

        return name.includes(wanted) || wanted.includes(name);
      });

      return partial?.id || null;
    } catch (err) {
      console.error('Find service error:', err.message);

      return null;
    }
  }

  // =========================================================
  // FIND STAFF
  // =========================================================

  async findStaffId(userId, staffName) {
    try {
      const staff = await this.booking.getStaff(userId);

      if (!staffName) {
        return null;
      }

      const wanted = String(staffName).trim().toLowerCase();

      const exact = staff.find(
        (employee) => String(employee.name).trim().toLowerCase() === wanted,
      );

      if (exact) {
        return exact.id;
      }

      const partial = staff.find((employee) => {
        const name = String(employee.name).trim().toLowerCase();

        return name.includes(wanted) || wanted.includes(name);
      });

      return partial?.id || null;
    } catch (err) {
      console.error('Find staff error:', err.message);

      return null;
    }
  }

  // =========================================================
  // ZONE
  // =========================================================

  extractZone(analysis) {
    const entities = analysis.entities || {};

    return entities.zone || entities.requested_zone || entities.area || null;
  }

  // =========================================================
  // FAQ
  // =========================================================

  async handleFAQ(user, phoneNumber, message, analysis) {
    return {
      intent: 'FAQ',
      response: await this.generateAIResponse(
        user,
        phoneNumber,
        message,
        analysis,
      ),
    };
  }

  // =========================================================
  // CANCEL
  // =========================================================

  async handleCancel(user, phoneNumber, message, analysis) {
    return {
      intent: 'CANCEL',
      response: await this.generateAIResponse(
        user,
        phoneNumber,
        message,
        analysis,
      ),
    };
  }

  // =========================================================
  // MODIFY
  // =========================================================

  async handleModify(user, phoneNumber, message, analysis) {
    return {
      intent: 'MODIFY',
      response: await this.generateAIResponse(
        user,
        phoneNumber,
        message,
        analysis,
      ),
    };
  }

  // =========================================================
  // HUMAN
  // =========================================================

  async handleHuman(user, phoneNumber, message, analysis) {
    return {
      intent: 'HUMAN',
      response: await this.generateAIResponse(
        user,
        phoneNumber,
        message,
        analysis,
      ),
    };
  }

  // =========================================================
  // GREETING
  // =========================================================

  async handleGreeting(user, phoneNumber, message, analysis) {
    return {
      intent: 'GREETING',
      response: await this.generateAIResponse(
        user,
        phoneNumber,
        message,
        analysis,
      ),
    };
  }

  // =========================================================
  // AI RESPONSE
  // =========================================================

  async generateAIResponse(user, phoneNumber, message, analysis) {
    try {
      return await this.ai.generateResponse(message, analysis, {
        businessName: user.business_name,

        businessType: user.business_type,

        timezone: user.business_timezone || 'Asia/Dubai',
      });
    } catch (err) {
      console.error('Generate AI response error:', err.message);

      return 'Sorry, I could not process your request.';
    }
  }

  // =========================================================
  // NUMBER HELPER
  // =========================================================

  toNumber(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
  }

  // =========================================================
  // DATE RESOLUTION
  // =========================================================

  resolveDateReference(reference, timezone = 'Asia/Dubai') {
    if (!reference) {
      return null;
    }

    const ref = String(reference).trim().toLowerCase();

    // -----------------------------------------------------
    // Current date in business timezone
    // -----------------------------------------------------

    const now = new Date();

    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const todayString = dateFormatter.format(now);

    const today = new Date(`${todayString}T12:00:00`);

    // -----------------------------------------------------
    // Semantic references normalized by AI
    // -----------------------------------------------------

    if (ref === 'today' || ref === 'same day') {
      return this.formatDate(today);
    }

    if (ref === 'tomorrow' || ref === 'next day') {
      const date = new Date(today);
      date.setDate(date.getDate() + 1);

      return this.formatDate(date);
    }

    if (ref === 'day after tomorrow') {
      const date = new Date(today);
      date.setDate(date.getDate() + 2);

      return this.formatDate(date);
    }

    if (ref === 'yesterday') {
      const date = new Date(today);
      date.setDate(date.getDate() - 1);

      return this.formatDate(date);
    }

    // -----------------------------------------------------
    // "next monday", "next friday", etc.
    //
    // AI should normalize Arabic / Darija / French /
    // Gulf Arabic into this semantic representation.
    // -----------------------------------------------------

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
      /^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
    );

    if (match) {
      const target = weekdays[match[1]];

      const current = today.getDay();

      let diff = (target - current + 7) % 7;

      if (diff === 0) {
        diff = 7;
      }

      const date = new Date(today);

      date.setDate(date.getDate() + diff);

      return this.formatDate(date);
    }

    // -----------------------------------------------------
    // Already normalized YYYY-MM-DD
    // -----------------------------------------------------

    if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) {
      return ref;
    }

    return null;
  }

  // =========================================================
  // FORMAT DATE
  // =========================================================

  formatDate(date) {
    const year = date.getFullYear();

    const month = String(date.getMonth() + 1).padStart(2, '0');

    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  }
}

module.exports = IntentHandler;

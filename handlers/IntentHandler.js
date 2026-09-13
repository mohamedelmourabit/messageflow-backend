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

      // -----------------------------------------------------
      // INTERACTIVE WHATSAPP SELECTION
      // -----------------------------------------------------

      const interactivePayload = this.extractInteractivePayload(interaction);

      if (interactivePayload) {
        console.log(`🎯 Interactive payload detected: ${interactivePayload}`);

        const selectedResult = await this.handleInteractiveSelection(
          user,
          phoneNumber,
          message,
          interactivePayload,
        );

        if (selectedResult) {
          return selectedResult;
        }
      }

      // -----------------------------------------------------
      // LOAD CONVERSATION STATE
      // -----------------------------------------------------

      const conversationState = await this.getConversationState(
        user.id,
        phoneNumber,
      );
      // -----------------------------------------------------
      // ACTIVE ALTERNATIVE-SLOT FOLLOW-UP
      // -----------------------------------------------------
      if (
        conversationState.status === 'WAITING_FOR_SLOT' &&
        conversationState.date
      ) {
        const alternativeResult = await this.handleAlternativeSlotFollowUp(
          user,
          phoneNumber,
          message,
          conversationState,
        );

        if (alternativeResult) {
          return alternativeResult;
        }
      }
      // -----------------------------------------------------
      // HANDLE WAITING STATES WITHOUT AI
      // -----------------------------------------------------

      if (conversationState.status === 'WAITING_FOR_SERVICE') {
        const serviceResult = await this.handleServiceTextSelection(
          user,
          phoneNumber,
          message,
          conversationState,
        );

        if (serviceResult) {
          return serviceResult;
        }
      }

      if (conversationState.status === 'WAITING_FOR_SLOT') {
        const slotResult = await this.handleSlotTextSelection(
          user,
          phoneNumber,
          message,
          conversationState,
        );

        if (slotResult) {
          return slotResult;
        }
      }

      // -----------------------------------------------------
      // LOAD BUSINESS DATA
      // -----------------------------------------------------

      const availableServices = await this.booking.getServices(user.id);

      const availableStaff = await this.booking.getStaff(user.id);

      // -----------------------------------------------------
      // AI CONTEXT
      // -----------------------------------------------------

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

      console.log('🧠 Calling AI...');

      const analysis = await this.ai.analyzeMessage(message, context);

      // An active slot-selection flow has stronger business meaning than a
      // generic FAQ label. This decision uses Claude's own structured
      // semantic output (the follow-up flag, or a concretely extracted date/
      // date_range), never a customer-message keyword or topic string. The
      // follow-up flag alone is not reliable turn-to-turn - a customer
      // supplying the exact date the bot just asked for is booking
      // follow-up regardless of how that flag came out.
      if (
        conversationState.status === 'WAITING_FOR_SLOT' &&
        (conversationState.date || conversationState.date_range) &&
        analysis.intent === 'FAQ' &&
        (analysis.booking_follow_up === true ||
          analysis.entities?.date ||
          analysis.entities?.date_range)
      ) {
        analysis.intent = 'BOOKING';
        // Reclassifying to BOOKING here IS the follow-up determination.
        // Downstream state merging keys off this flag to decide whether to
        // keep the in-progress booking context (name, staff, prior date) or
        // wipe it for a fresh booking - it must not be wiped here.
        analysis.booking_follow_up = true;
      }

      // A short semantic follow-up after an unsuccessful range search has no
      // new date to search yet. Keep it in booking and ask only for the next
      // booking choice; do not fall through to an unrelated FAQ response.
      // Staff-only salon MVP bookings have no service_id, so this must not
      // require one - conversationState.date_range is the validity signal.
      if (
        conversationState.status === 'WAITING_FOR_SLOT' &&
        conversationState.date_range &&
        analysis.booking_follow_up === true &&
        !analysis.entities?.date &&
        !analysis.entities?.date_range &&
        !analysis.entities?.dateRange
      ) {
        const serviceLabel = conversationState.service
          ? `available ${conversationState.service} appointment`
          : 'available appointment';

        return {
          intent: 'BOOKING',
          response: `I still do not have an ${serviceLabel} from ${conversationState.date_range.from} to ${conversationState.date_range.to}. Please send another date or period you would prefer.`,
        };
      }

      console.log('🧠 AI analysis:', JSON.stringify(analysis, null, 2));

      // -----------------------------------------------------
      // MERGE STATE
      // -----------------------------------------------------

      // A semantically new booking must not inherit a service, name, or slot
      // from an unfinished earlier booking. Only explicit follow-ups retain
      // that state.
      const stateToMerge =
        analysis.intent === 'BOOKING' && analysis.booking_follow_up !== true
          ? {}
          : conversationState;
      const mergedState = this.mergeConversationState(stateToMerge, analysis);

      await this.saveConversationState(user.id, phoneNumber, mergedState);

      // -----------------------------------------------------
      // ROUTE INTENT
      // -----------------------------------------------------

      switch (analysis.intent) {
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
      console.error('❌ IntentHandler error:', err.message);

      return {
        intent: 'OTHER',
        response: 'Sorry, something went wrong. Please try again.',
      };
    }
  }

  // =========================================================
  // INTERACTIVE PAYLOAD EXTRACTION
  // =========================================================

  extractInteractivePayload(interaction = {}) {
    const directPayloads = [
      interaction.buttonPayload,
      interaction.listId,
      interaction.payload,
    ];

    for (const value of directPayloads) {
      if (
        typeof value === 'string' &&
        (value.startsWith('service:') ||
          value.startsWith('slot:') ||
          value.startsWith('rslot:'))
      ) {
        return value;
      }
    }

    // -----------------------------------------------------
    // InteractiveData can be JSON or an object
    // -----------------------------------------------------

    let data = interaction.interactiveData;

    if (!data) {
      return null;
    }

    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return null;
      }
    }

    return this.findInteractivePayload(data);
  }

  findInteractivePayload(value) {
    if (!value) {
      return null;
    }

    if (typeof value === 'string') {
      if (
        value.startsWith('service:') ||
        value.startsWith('slot:') ||
        value.startsWith('rslot:')
      ) {
        return value;
      }

      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.findInteractivePayload(item);

        if (result) {
          return result;
        }
      }

      return null;
    }

    if (typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const result = this.findInteractivePayload(value[key]);

        if (result) {
          return result;
        }
      }
    }

    return null;
  }

  // =========================================================
  // BOOKING
  // =========================================================

  async handleBooking(user, phoneNumber, message, analysis) {
    try {
      const entities = analysis.entities || {};

      const conversationState = await this.getConversationState(
        user.id,
        phoneNumber,
      );

      const businessType = String(user.business_type || '').toLowerCase();

      // -----------------------------------------------------
      // CUSTOMER NAME
      // -----------------------------------------------------

      const customerName =
        entities.name ||
        entities.customer_name ||
        conversationState.name ||
        null;

      // -----------------------------------------------------
      // PHONE ALWAYS COMES FROM WHATSAPP
      // -----------------------------------------------------

      const customerPhone = phoneNumber;

      // -----------------------------------------------------
      // PEOPLE
      // -----------------------------------------------------

      const people = this.toNumber(
        entities.people ||
          entities.guests ||
          entities.party_size ||
          conversationState.people,
      );

      // -----------------------------------------------------
      // DATE
      // -----------------------------------------------------

      const dateRange = entities.date_range || entities.dateRange || null;

      // A semantic period replaces an old exact-date constraint. Do not turn
      // it into a made-up Monday or retain the prior date from state.
      if (dateRange?.from && dateRange?.to) {
        return await this.handleBookingDateRange(
          user,
          phoneNumber,
          message,
          analysis,
          conversationState,
          dateRange,
        );
      }

      let bookingDate = entities.date || conversationState.date || null;

      const dateReference =
        entities.date_reference || entities.dateReference || null;

      if (!bookingDate && dateReference) {
        bookingDate = this.resolveDateReference(
          dateReference,
          user.business_timezone || 'Asia/Dubai',
        );
      }

      // -----------------------------------------------------
      // TIME
      // -----------------------------------------------------

      const bookingTime = entities.time || conversationState.time || null;

      // -----------------------------------------------------
      // SPECIAL REQUEST
      // -----------------------------------------------------

      const specialRequest =
        entities.special_request ||
        analysis.special_request ||
        conversationState.special_request ||
        null;

      // -----------------------------------------------------
      // DATE REQUIRED
      // -----------------------------------------------------

      if (!bookingDate) {
        await this.saveConversationState(user.id, phoneNumber, {
          ...conversationState,
          intent: 'BOOKING',
          status: 'WAITING_FOR_DATE',
        });

        return {
          intent: 'BOOKING',
          response: await this.generateAIResponse(user, phoneNumber, message, {
            ...analysis,
            missing_information: ['date'],
          }),
        };
      }

      // -----------------------------------------------------
      // TIME REQUIRED
      // -----------------------------------------------------

      if (!bookingTime) {
        await this.saveConversationState(user.id, phoneNumber, {
          ...conversationState,
          intent: 'BOOKING',
          status: 'WAITING_FOR_TIME',
          date: bookingDate,
        });

        return {
          intent: 'BOOKING',
          response: await this.generateAIResponse(user, phoneNumber, message, {
            ...analysis,
            missing_information: ['time'],
          }),
        };
      }

      // -----------------------------------------------------
      // RESTAURANT
      // -----------------------------------------------------

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

      // -----------------------------------------------------
      // SALON
      // -----------------------------------------------------

      const [configuredServices, configuredStaff] = await Promise.all([
        this.booking.getServices(user.id),
        this.booking.getStaff(user.id),
      ]);
      const isSalonBusiness =
        businessType.includes('salon') ||
        businessType.includes('hair') ||
        businessType.includes('beauty') ||
        businessType.includes('barber') ||
        configuredServices.length > 0 ||
        configuredStaff.length > 0;

      // Active service or staff records are a reliable business configuration
      // signal. This protects the salon flow (with its staff-aware alternative
      // slot search) when a legacy business_type is blank, uses a label the
      // routing code does not know, or the salon runs in staff-only MVP mode
      // with no services configured yet.
      if (isSalonBusiness) {
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

      // -----------------------------------------------------
      // GENERIC
      // -----------------------------------------------------

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
      console.error('❌ Handle booking error:', err.message);

      return {
        intent: 'BOOKING',
        response: 'Sorry, I could not process your booking right now.',
      };
    }
  }

  // =========================================================
  // SALON BOOKING
  // =========================================================

  async handleSalonBooking(user, phoneNumber, message, analysis, data) {
    return this.handleSalonAvailabilityMvp(
      user,
      phoneNumber,
      message,
      analysis,
      data,
    );

    /* Legacy service-based flow retained below temporarily for migration. */
    const {
      customerName,
      customerPhone,
      bookingDate,
      bookingTime,
      specialRequest,
    } = data;

    const entities = analysis.entities || {};

    const currentState = await this.getConversationState(user.id, phoneNumber);

    // -----------------------------------------------------
    // SERVICE FROM AI OR STATE
    // -----------------------------------------------------

    const requestedService =
      entities.service ||
      entities.service_name ||
      entities.serviceName ||
      currentState.service ||
      null;

    // =====================================================
    // SERVICE IS REQUIRED
    // =====================================================

    if (!requestedService) {
      return await this.showAvailableServices(user, phoneNumber, currentState);
    }

    // =====================================================
    // FIND REAL SERVICE IN DB
    // =====================================================

    const serviceId = await this.findServiceId(user.id, requestedService);

    // -----------------------------------------------------
    // SERVICE DOES NOT EXIST
    // -----------------------------------------------------

    if (!serviceId) {
      const services = await this.booking.getServices(user.id);

      const nextState = {
        ...currentState,
        intent: 'BOOKING',
        status: 'WAITING_FOR_SERVICE',

        // Keep original requested value
        // only as context.
        requested_service: requestedService,

        service: null,
        service_id: null,

        date: bookingDate,
        time: bookingTime,
      };

      await this.saveConversationState(user.id, phoneNumber, nextState);

      if (!services.length) {
        return {
          intent: 'BOOKING',
          response: 'Sorry, this business has no services configured yet.',
        };
      }

      const response = this.formatServiceList(
        services,
        `I don't currently offer ${requestedService}.\n\nPlease choose one of our available services:`,
      );

      return {
        intent: 'BOOKING',
        response,

        interactive: {
          type: 'list',

          body: `I don't currently offer ${requestedService}.\n\nPlease choose one of our available services:`,

          button: 'Choose a service',

          items: services.slice(0, 10).map((service) => ({
            id: `service:${service.id}`,

            item: service.name,

            description: this.formatServiceDescription(service),
          })),
        },
      };
    }

    // =====================================================
    // STAFF
    // =====================================================

    const requestedStaff =
      entities.staff ||
      entities.staff_name ||
      entities.staffName ||
      currentState.staff ||
      null;

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

    // =====================================================
    // CHECK EXACT AVAILABILITY
    // =====================================================

    const availability = await this.booking.findBestSalonAvailability(
      user.id,
      bookingDate,
      bookingTime,
      serviceId,
      staffId,
    );

    // =====================================================
    // NOT AVAILABLE
    // =====================================================

    if (!availability.available) {
      return await this.handleUnavailableSalonSlot(
        user,
        phoneNumber,
        message,
        analysis,
        {
          bookingDate,
          bookingTime,
          serviceId,
          staffId,
          requestedService,
        },
      );
    }

    // =====================================================
    // AVAILABLE
    // =====================================================

    const selectedService = availability.service;

    const selectedStaff = availability.staff;

    const endTime = availability.endTime;

    // -----------------------------------------------------
    // SAVE SERVICE + DATE + TIME
    // -----------------------------------------------------

    await this.saveConversationState(user.id, phoneNumber, {
      ...currentState,

      intent: 'BOOKING',
      status: 'WAITING_FOR_NAME',

      service: selectedService?.name || requestedService,

      service_id: selectedService?.id || serviceId,

      staff: selectedStaff?.name || requestedStaff || null,

      staff_id: selectedStaff?.id || staffId || null,

      date: bookingDate,

      time: bookingTime,

      special_request: specialRequest,
    });

    // =====================================================
    // CUSTOMER NAME
    // =====================================================

    if (!customerName) {
      return {
        intent: 'BOOKING',

        response: `Your ${
          selectedService?.name || requestedService
        } is available at ${bookingTime}. What name should I use for the booking?`,
      };
    }

    // =====================================================
    // CREATE BOOKING
    // =====================================================

    const result = await this.booking.createBooking(
      user.id,
      customerName,
      customerPhone,
      1,
      bookingDate,
      bookingTime,
      {
        endTime,

        serviceId: selectedService?.id || serviceId,

        staffId: selectedStaff?.id || staffId || null,

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
    // CLEAR STATE
    // -----------------------------------------------------

    await this.clearConversationState(user.id, phoneNumber);

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

          service: selectedService?.name || requestedService,

          staff: selectedStaff?.name || null,
        },
      }),

      booking: result.booking,
    };
  }

  // =========================================================
  // SALON MVP - AVAILABILITY ONLY
  // =========================================================

  async handleSalonAvailabilityMvp(user, phoneNumber, message, analysis, data) {
    const { customerName, customerPhone, bookingDate, bookingTime, specialRequest } = data;
    const entities = analysis.entities || {};
    const currentState = await this.getConversationState(user.id, phoneNumber);
    const requestedStaff = entities.staff || entities.staff_name || entities.staffName || currentState.staff || null;
    let staffId = null;
    if (requestedStaff) {
      staffId = await this.findStaffId(user.id, requestedStaff);
      if (!staffId) {
        return { intent: 'BOOKING', response: 'That staff member is not available. Please choose another time.' };
      }
    }

    const availability = await this.booking.findSalonSlotAvailability(
      user.id, bookingDate, bookingTime, staffId,
    );
    if (!availability.available) {
      return this.handleUnavailableSalonSlot(user, phoneNumber, message, analysis, {
        bookingDate, bookingTime, serviceId: null, staffId, requestedService: null,
      });
    }

    const nextState = {
      ...currentState,
      intent: 'BOOKING',
      status: 'WAITING_FOR_NAME',
      service: null,
      service_id: null,
      staff: availability.staff?.name || requestedStaff || null,
      staff_id: availability.staff?.id || staffId || null,
      date: bookingDate,
      time: bookingTime,
      special_request: specialRequest,
    };
    await this.saveConversationState(user.id, phoneNumber, nextState);

    if (!customerName) {
      return { intent: 'BOOKING', response: `That time is available. What name should I use for the booking?` };
    }

    const result = await this.booking.createBooking(
      user.id, customerName, customerPhone, 1, bookingDate, bookingTime,
      { endTime: availability.endTime, staffId: availability.staff?.id || staffId || null, specialRequest },
    );
    if (!result.success) {
      return { intent: 'BOOKING', response: 'Sorry, I could not confirm your appointment.' };
    }
    await this.clearConversationState(user.id, phoneNumber);
    return {
      intent: 'BOOKING',
      response: await this.generateAIResponse(user, phoneNumber, message, {
        ...analysis,
        booking_available: true,
        booking_confirmed: true,
        booking: { id: result.booking.id, date: bookingDate, time: bookingTime, end_time: availability.endTime, staff: availability.staff?.name || null },
      }),
      booking: result.booking,
    };
  }

  // =========================================================
  // SALON - SEMANTIC DATE RANGE AVAILABILITY
  // =========================================================

  async handleBookingDateRange(user, phoneNumber, message, analysis, state, range) {
    const businessType = String(user.business_type || '').toLowerCase();
    const isSalon = ['salon', 'hair', 'beauty', 'barber'].some((type) => businessType.includes(type));
    if (!isSalon) {
      await this.saveConversationState(user.id, phoneNumber, {
        ...state, intent: 'BOOKING', status: 'WAITING_FOR_DATE_RANGE', date_range: range,
      });
      return { intent: 'BOOKING', response: 'Please choose a specific date and time within that period.' };
    }

    const staffName = analysis.entities?.staff || state.staff;
    const staffId = state.staff_id || (staffName ? await this.findStaffId(user.id, staffName) : null);
    const slots = await this.booking.findSalonAvailabilityInRange(
      user.id, range.from, range.to, staffId, 5,
    );
    await this.saveConversationState(user.id, phoneNumber, {
      ...state,
      intent: 'BOOKING',
      status: 'WAITING_FOR_SLOT',
      service: null,
      service_id: null,
      staff: staffName || null,
      staff_id: staffId,
      date_range: range,
      alternative_slots: slots.map((slot) => ({ date: slot.date, time: slot.startTime })),
    });
    if (!slots.length) {
      return { intent: 'BOOKING', response: `I could not find an available appointment between ${range.from} and ${range.to}. Would you like another period?` };
    }
    return {
      intent: 'BOOKING',
      response: `Here are available appointments from ${range.from} to ${range.to}:\n\n${slots.map((slot) => `${slot.date} at ${slot.startTime}`).join('\n')}\n\nPlease choose one.`,
      interactive: {
        type: 'list', body: 'Available appointments:', button: 'Choose a time',
        items: slots.map((slot) => ({
          id: `slot:${slot.date}:${slot.startTime}`,
          item: `${slot.date} at ${slot.startTime}`,
          description: slot.endTime ? `Available until ${slot.endTime}` : 'Available',
        })),
      },
    };
  }

  // =========================================================
  // SHOW AVAILABLE SERVICES
  // =========================================================

  async showAvailableServices(user, phoneNumber, currentState = {}) {
    const services = await this.booking.getServices(user.id);

    if (!services.length) {
      return {
        intent: 'BOOKING',
        response: 'Sorry, this business has no services configured yet.',
      };
    }

    // -----------------------------------------------------
    // IMPORTANT
    //
    // Preserve date/time/name already collected.
    // -----------------------------------------------------

    await this.saveConversationState(user.id, phoneNumber, {
      ...currentState,

      intent: 'BOOKING',

      status: 'WAITING_FOR_SERVICE',
    });

    const response = this.formatServiceList(
      services,
      'Please choose one of our available services:',
    );

    return {
      intent: 'BOOKING',

      // This is what the frontend receives.
      response,

      // This is what WhatsApp receives.
      interactive: {
        type: 'list',

        body: 'Please choose one of our available services:',

        button: 'Choose a service',

        items: services.slice(0, 10).map((service) => ({
          id: `service:${service.id}`,

          item: service.name,

          description: this.formatServiceDescription(service),
        })),
      },
    };
  }

  // =========================================================
  // FORMAT SERVICE LIST
  // =========================================================

  formatServiceList(
    services,
    intro = 'Please choose one of our available services:',
  ) {
    const lines = services.slice(0, 10).map((service, index) => {
      const duration = service.duration_minutes
        ? `${service.duration_minutes} min`
        : null;

      const price =
        service.price !== null && service.price !== undefined
          ? `${service.price}`
          : null;

      const details = [duration, price].filter(Boolean).join(' — ');

      return `${index + 1}. ${service.name}` + (details ? ` — ${details}` : '');
    });

    return `${intro}\n\n` + lines.join('\n');
  }

  // =========================================================
  // SERVICE DESCRIPTION
  // =========================================================

  formatServiceDescription(service) {
    const parts = [];

    if (service.duration_minutes) {
      parts.push(`${service.duration_minutes} min`);
    }

    if (service.price !== null && service.price !== undefined) {
      parts.push(`${service.price}`);
    }

    return parts.join(' • ');
  }

  // =========================================================
  // SERVICE TEXT SELECTION
  // =========================================================

  async handleServiceTextSelection(user, phoneNumber, message, state) {
    if (!message) {
      return null;
    }

    const text = String(message).trim().toLowerCase();

    // -----------------------------------------------------
    // Ignore ambiguous messages
    // -----------------------------------------------------

    if (
      !text ||
      text === '?' ||
      text === '??' ||
      text === 'which?' ||
      text === 'which one?' ||
      text === 'what?' ||
      text === 'what services?'
    ) {
      return await this.showAvailableServices(user, phoneNumber, state);
    }

    const services = await this.booking.getServices(user.id);

    // -----------------------------------------------------
    // Exact visible service name
    // -----------------------------------------------------

    let selected = services.find(
      (service) => String(service.name).trim().toLowerCase() === text,
    );

    // -----------------------------------------------------
    // Number selection
    // -----------------------------------------------------

    if (!selected) {
      const number = Number(text);

      if (
        Number.isInteger(number) &&
        number >= 1 &&
        number <= services.length
      ) {
        selected = services[number - 1];
      }
    }

    // -----------------------------------------------------
    // Partial match
    // -----------------------------------------------------

    if (!selected) {
      selected = services.find((service) => {
        const name = String(service.name).trim().toLowerCase();

        return name.includes(text) || text.includes(name);
      });
    }

    // -----------------------------------------------------
    // Not a service
    // -----------------------------------------------------

    if (!selected) {
      return null;
    }

    const nextState = {
      ...state,

      intent: 'BOOKING',

      status: 'SERVICE_SELECTED',

      service: selected.name,

      service_id: selected.id,
    };

    await this.saveConversationState(user.id, phoneNumber, nextState);

    // -----------------------------------------------------
    // DATE / TIME NOT YET KNOWN
    // -----------------------------------------------------

    if (!nextState.date || !nextState.time) {
      return {
        intent: 'BOOKING',
        response: `Great, ${selected.name} selected. What date and time would you prefer?`,
      };
    }

    // -----------------------------------------------------
    // CHECK AVAILABILITY
    // -----------------------------------------------------

    return await this.processSalonAvailabilityAfterSelection(
      user,
      phoneNumber,
      message,
      nextState,
    );
  }

  // =========================================================
  // ALTERNATIVE SLOT FOLLOW-UP
  // =========================================================

  async handleAlternativeSlotFollowUp(user, phoneNumber, message, state) {
    const text = String(message || '').trim();

    if (!text) {
      return null;
    }

    // Customer directly gives a time:
    // "14:00", "2pm", "2 PM", "14h30", etc.
    const parsedTime = this.parseTimeInput(text);

    if (parsedTime) {
      const nextState = {
        ...state,
        status: 'SLOT_SELECTED',
        time: parsedTime,
      };

      await this.saveConversationState(user.id, phoneNumber, nextState);

      return await this.processSalonAvailabilityAfterSelection(
        user,
        phoneNumber,
        message,
        nextState,
      );
    }

    // Any natural-language follow-up goes through the semantic interpreter.
    // This intentionally avoids maintaining multilingual keyword dictionaries.
    return null;
  }

  // =========================================================
  // PARSE TIME INPUT
  // =========================================================

  parseTimeInput(value) {
    const text = String(value || '')
      .trim()
      .toLowerCase();

    // Examples:
    // 14:30
    // 14h30
    // 2:30pm
    // 2h30 pm
    let match = text.match(/^(\d{1,2})(?::|h)(\d{2})\s*(am|pm)?$/i);

    if (match) {
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      const meridiem = match[3]?.toLowerCase();

      if (minute > 59) {
        return null;
      }

      if (meridiem === 'pm' && hour < 12) {
        hour += 12;
      }

      if (meridiem === 'am' && hour === 12) {
        hour = 0;
      }

      if (hour > 23) {
        return null;
      }

      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(
        2,
        '0',
      )}`;
    }

    // Examples:
    // 2pm
    // 7 PM
    match = text.match(/^(\d{1,2})\s*(am|pm)$/i);

    if (match) {
      let hour = Number(match[1]);
      const meridiem = match[2].toLowerCase();

      if (hour < 1 || hour > 12) {
        return null;
      }

      if (meridiem === 'pm' && hour < 12) {
        hour += 12;
      }

      if (meridiem === 'am' && hour === 12) {
        hour = 0;
      }

      return `${String(hour).padStart(2, '0')}:00`;
    }

    // Example:
    // 14:00
    match = text.match(/^(\d{1,2}):(\d{2})$/);

    if (match) {
      const hour = Number(match[1]);
      const minute = Number(match[2]);

      if (hour > 23 || minute > 59) {
        return null;
      }

      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(
        2,
        '0',
      )}`;
    }

    return null;
  }

  // =========================================================
  // INTERACTIVE SELECTION
  // =========================================================

  async handleInteractiveSelection(user, phoneNumber, message, payload) {
    if (!payload) {
      return null;
    }

    const state = await this.getConversationState(user.id, phoneNumber);

    // =====================================================
    // SERVICE
    // =====================================================

    if (payload.startsWith('service:')) {
      const serviceId = Number(payload.substring('service:'.length));

      if (!Number.isInteger(serviceId)) {
        return null;
      }

      const services = await this.booking.getServices(user.id);

      const service = services.find((item) => Number(item.id) === serviceId);

      // -----------------------------------------------------
      // NEVER TRUST PAYLOAD ALONE
      // -----------------------------------------------------

      if (!service) {
        return {
          intent: 'BOOKING',
          response:
            'That service is no longer available. Please choose another service.',
          interactive: await this.buildServiceInteractive(user.id),
        };
      }

      const nextState = {
        ...state,

        intent: 'BOOKING',

        status: 'SERVICE_SELECTED',

        service: service.name,

        service_id: service.id,
      };

      await this.saveConversationState(user.id, phoneNumber, nextState);

      // -----------------------------------------------------
      // DATE/TIME MISSING
      // -----------------------------------------------------

      if (!nextState.date || !nextState.time) {
        return {
          intent: 'BOOKING',
          response: `Great, ${service.name} selected. What date and time would you prefer?`,
        };
      }

      // -----------------------------------------------------
      // CHECK AVAILABILITY
      // -----------------------------------------------------

      return await this.processSalonAvailabilityAfterSelection(
        user,
        phoneNumber,
        message,
        nextState,
      );
    }

    // =====================================================
    // SLOT
    // =====================================================

    if (payload.startsWith('slot:')) {
      const selectedTime = payload.substring('slot:'.length);
      const datedSlot = selectedTime.match(/^(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/);
      if (!datedSlot && !/^\d{2}:\d{2}$/.test(selectedTime)) {
        return null;
      }

      const nextState = {
        ...state,

        intent: 'BOOKING',

        status: 'SLOT_SELECTED',

        date: datedSlot ? datedSlot[1] : state.date,
        time: datedSlot ? datedSlot[2] : selectedTime,
        date_range: datedSlot ? undefined : state.date_range,
      };

      await this.saveConversationState(user.id, phoneNumber, nextState);

      return await this.processSalonAvailabilityAfterSelection(
        user,
        phoneNumber,
        message,
        nextState,
      );
    }

    // =====================================================
    // RESTAURANT SLOT
    // =====================================================

    if (payload.startsWith('rslot:')) {
      const selectedTime = payload.substring('rslot:'.length);
      if (!/^\d{2}:\d{2}$/.test(selectedTime)) {
        return null;
      }

      return await this.handleRestaurantBooking(
        user,
        phoneNumber,
        message,
        { entities: {} },
        {
          customerName: state.name || null,
          customerPhone: phoneNumber,
          people: state.people || null,
          bookingDate: state.date,
          bookingTime: selectedTime,
          specialRequest: state.special_request || null,
        },
      );
    }

    return null;
  }

  // =========================================================
  // BUILD SERVICE INTERACTIVE
  // =========================================================

  async buildServiceInteractive(userId) {
    const services = await this.booking.getServices(userId);

    return {
      type: 'list',

      body: 'Please choose one of our available services:',

      button: 'Choose a service',

      items: services.slice(0, 10).map((service) => ({
        id: `service:${service.id}`,

        item: service.name,

        description: this.formatServiceDescription(service),
      })),
    };
  }

  // =========================================================
  // SLOT TEXT SELECTION
  // =========================================================

  async handleSlotTextSelection(user, phoneNumber, message, state) {
    if (!message) {
      return null;
    }

    const text = String(message).trim();

    if (!/^\d{1,2}:\d{2}$/.test(text)) {
      return null;
    }

    const parts = text.split(':');

    const hour = String(Number(parts[0])).padStart(2, '0');

    const minute = String(Number(parts[1])).padStart(2, '0');

    const selectedTime = `${hour}:${minute}`;

    const nextState = {
      ...state,

      intent: 'BOOKING',

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

  // =========================================================
  // SALON AVAILABILITY AFTER SELECTION
  // =========================================================

  async processSalonAvailabilityAfterSelection(
    user,
    phoneNumber,
    message,
    state,
  ) {
    // Handles legacy interactive slot payloads after the MVP switched away
    // from service selection.
    return this.handleSalonAvailabilityMvp(
      user,
      phoneNumber,
      message,
      { entities: {} },
      {
        customerName: state.name || null,
        customerPhone: phoneNumber,
        bookingDate: state.date,
        bookingTime: state.time,
        specialRequest: state.special_request || null,
      },
    );

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

    // -----------------------------------------------------
    // NOT AVAILABLE
    // -----------------------------------------------------

    if (!availability.available) {
      const alternatives = await this.booking.findAlternativeSalonSlots(
        user.id,
        state.date,
        state.time,
        state.service_id,
        staffId,
        5,
      );

      await this.saveConversationState(user.id, phoneNumber, {
        ...state,

        status: 'WAITING_FOR_SLOT',
      });

      if (!alternatives.length) {
        return {
          intent: 'BOOKING',
          response:
            'That time is no longer available. Please choose another time.',
        };
      }

      const listBody = `That time is not available. Available times: ${alternatives
        .map((slot) => slot.startTime)
        .join(', ')}. Reply with the time you prefer.`;

      return {
        intent: 'BOOKING',

        response: listBody,

        interactive: {
          type: 'list',

          body: listBody,

          button: 'Choose a time',

          items: alternatives.map((slot) => ({
            id: `slot:${slot.startTime}`,

            item: slot.startTime,

            description: slot.endTime
              ? `Available until ${slot.endTime}`
              : 'Available',
          })),
        },
      };
    }

    // =====================================================
    // AVAILABLE
    // =====================================================

    const selectedService = availability.service;

    const selectedStaff = availability.staff;

    const endTime = availability.endTime;

    // -----------------------------------------------------
    // CUSTOMER NAME
    // -----------------------------------------------------

    const customerName = state.name || null;

    if (!customerName) {
      await this.saveConversationState(user.id, phoneNumber, {
        ...state,

        status: 'WAITING_FOR_NAME',

        service: selectedService?.name || state.service,

        service_id: selectedService?.id || state.service_id,

        staff: selectedStaff?.name || state.staff || null,

        staff_id: selectedStaff?.id || state.staff_id || null,

        date: state.date,

        time: state.time,
      });

      return {
        intent: 'BOOKING',

        response: `Great. ${selectedService?.name || state.service} is available at ${state.time}. What name should I use for the booking?`,
      };
    }

    // =====================================================
    // CREATE BOOKING
    // =====================================================

    const result = await this.booking.createBooking(
      user.id,
      customerName,
      phoneNumber,
      1,
      state.date,
      state.time,
      {
        endTime,

        serviceId: selectedService?.id || state.service_id,

        staffId: selectedStaff?.id || state.staff_id || null,

        specialRequest: state.special_request || null,
      },
    );

    if (!result.success) {
      return {
        intent: 'BOOKING',

        response:
          'Sorry, I could not confirm your appointment. Please choose another time.',
      };
    }

    // -----------------------------------------------------
    // CLEAR STATE
    // -----------------------------------------------------

    await this.clearConversationState(user.id, phoneNumber);

    return {
      intent: 'BOOKING',

      response: `Perfect. Your ${selectedService?.name || state.service} appointment is confirmed for ${state.date} at ${state.time}.`,

      booking: result.booking,
    };
  }

  // =========================================================
  // UNAVAILABLE SALON SLOT
  // =========================================================

  async handleUnavailableSalonSlot(user, phoneNumber, message, analysis, data) {
    const { bookingDate, bookingTime, serviceId, staffId, requestedService } =
      data;

    const alternatives = await this.booking.findAlternativeSalonSlots(
      user.id,
      bookingDate,
      bookingTime,
      serviceId,
      staffId,
      5,
    );

    const state = await this.getConversationState(user.id, phoneNumber);

    await this.saveConversationState(user.id, phoneNumber, {
      ...state,

      intent: 'BOOKING',

      status: 'WAITING_FOR_SLOT',

      service: requestedService,

      service_id: serviceId,

      staff_id: staffId,

      date: bookingDate,

      time: bookingTime,
    });

    if (!alternatives.length) {
      return {
        intent: 'BOOKING',
        // This is a real availability result, so wording is deterministic.
        // Do not let AI manufacture an escalation or business instructions.
        response:
          'That time is not available, and I could not find another available time on that date. Please send another date or time you prefer.',
      };
    }

    const listBody = `The requested time ${bookingTime} is not available. Available times: ${alternatives
      .map((slot) => slot.startTime)
      .join(', ')}. Reply with the time you prefer.`;

    return {
      intent: 'BOOKING',

      // The plain text always spells out every time, not just the
      // interactive list - a sandbox WhatsApp number or a client that can't
      // render twilio/list-picker must not leave the customer with no
      // usable options.
      response: listBody,

      interactive: {
        type: 'list',

        body: listBody,

        button: 'Choose a time',

        items: alternatives.map((slot) => ({
          id: `slot:${slot.startTime}`,

          item: slot.startTime,

          description: slot.endTime
            ? `Available until ${slot.endTime}`
            : 'Available',
        })),
      },
    };
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
    // NAME
    // -----------------------------------------------------

    if (!customerName) {
      const state = await this.getConversationState(user.id, phoneNumber);

      await this.saveConversationState(user.id, phoneNumber, {
        ...state,

        intent: 'BOOKING',

        status: 'WAITING_FOR_NAME',

        date: bookingDate,

        time: bookingTime,

        people,
      });

      return {
        intent: 'BOOKING',

        response: 'What name should I use for the booking?',
      };
    }

    // -----------------------------------------------------
    // PEOPLE
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
    // SETTINGS
    // -----------------------------------------------------

    const settings = await this.booking.getBusinessSettings(user.id);

    const duration = Number(settings.default_booking_duration_minutes || 90);

    const endTime = this.booking.calculateEndTime(bookingTime, duration);

    // -----------------------------------------------------
    // ZONE
    // -----------------------------------------------------

    const requestedZone = this.extractZone(analysis);

    // -----------------------------------------------------
    // AVAILABILITY
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
      return await this.handleUnavailableRestaurantSlot(
        user,
        phoneNumber,
        message,
        analysis,
        {
          bookingDate,
          bookingTime,
          people,
          requestedZone,
          customerName,
          specialRequest,
          reason: availability.reason,
        },
      );
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
  // UNAVAILABLE RESTAURANT SLOT
  // =========================================================

  async handleUnavailableRestaurantSlot(
    user,
    phoneNumber,
    message,
    analysis,
    data,
  ) {
    const {
      bookingDate,
      bookingTime,
      people,
      requestedZone,
      customerName,
      specialRequest,
      reason,
    } = data;

    const state = await this.getConversationState(user.id, phoneNumber);

    await this.saveConversationState(user.id, phoneNumber, {
      ...state,
      intent: 'BOOKING',
      status: 'WAITING_FOR_SLOT',
      name: customerName || state.name || null,
      people,
      date: bookingDate,
      time: bookingTime,
      special_request: specialRequest,
    });

    // A date-level constraint (too far ahead, too soon before the notice
    // window) applies to the whole day, not just this time. No alternative
    // time on the same date can fix it, so let the AI explain the rule
    // instead of searching for one.
    if (
      reason !== 'NO_TABLE_AVAILABLE' &&
      reason !== 'RESTAURANT_CAPACITY_REACHED'
    ) {
      return {
        intent: 'BOOKING',
        response: await this.generateAIResponse(user, phoneNumber, message, {
          ...analysis,
          booking_available: false,
          availability_reason: reason,
        }),
      };
    }

    const alternatives = await this.booking.findAlternativeRestaurantSlots(
      user.id,
      bookingDate,
      bookingTime,
      people,
      requestedZone,
      5,
    );

    if (!alternatives.length) {
      return {
        intent: 'BOOKING',
        // This is a real availability result, so wording is deterministic.
        // Do not let AI manufacture an escalation or business instructions.
        response:
          'That time is not available, and I could not find another available time on that date. Please send another date or time you prefer.',
      };
    }

    const listBody = `The requested time ${bookingTime} is not available. Available times: ${alternatives
      .map((slot) => slot.startTime)
      .join(', ')}. Reply with the time you prefer.`;

    return {
      intent: 'BOOKING',

      // The plain text always spells out every time, not just the
      // interactive list - a sandbox WhatsApp number or a client that can't
      // render twilio/list-picker must not leave the customer with no
      // usable options.
      response: listBody,

      interactive: {
        type: 'list',

        body: listBody,

        button: 'Choose a time',

        items: alternatives.map((slot) => ({
          id: `rslot:${slot.startTime}`,

          item: slot.startTime,

          description: slot.endTime
            ? `Available until ${slot.endTime}`
            : 'Available',
        })),
      },
    };
  }

  // =========================================================
  // GENERIC BOOKING
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

    if (!customerName) {
      return {
        intent: 'BOOKING',

        response: 'What name should I use for the booking?',
      };
    }

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
    if (!this.db) {
      return {};
    }

    try {
      const result = await this.db.query(
        `SELECT state
           FROM conversation_states
           WHERE user_id = $1
           AND customer_phone = $2
           LIMIT 1`,
        [userId, phoneNumber],
      );

      return result.rows[0]?.state || {};
    } catch (err) {
      console.error('Get conversation state error:', err.message);

      return {};
    }
  }

  // =========================================================
  // SAVE STATE
  // =========================================================

  async saveConversationState(userId, phoneNumber, state) {
    if (!this.db) {
      return;
    }

    try {
      await this.db.query(
        `INSERT INTO conversation_states
          (
            user_id,
            customer_phone,
            state,
            updated_at
          )
         VALUES
          (
            $1,
            $2,
            $3::jsonb,
            CURRENT_TIMESTAMP
          )
         ON CONFLICT
          (
            user_id,
            customer_phone
          )
         DO UPDATE SET
           state = EXCLUDED.state,
           updated_at = CURRENT_TIMESTAMP`,
        [userId, phoneNumber, JSON.stringify(state || {})],
      );
    } catch (err) {
      console.error('Save conversation state error:', err.message);
    }
  }

  // =========================================================
  // CLEAR STATE
  // =========================================================

  async clearConversationState(userId, phoneNumber) {
    if (!this.db) {
      return;
    }

    try {
      await this.db.query(
        `DELETE FROM conversation_states
         WHERE user_id = $1
         AND customer_phone = $2`,
        [userId, phoneNumber],
      );
    } catch (err) {
      console.error('Clear conversation state error:', err.message);
    }
  }

  // =========================================================
  // MERGE STATE
  // =========================================================

  mergeConversationState(previous, analysis) {
    const entities = analysis?.entities || {};

    const next = {
      ...(previous || {}),
    };

    const values = {
      name: entities.name || entities.customer_name,

      people: entities.people || entities.guests || entities.party_size,

      service:
        entities.service || entities.service_name || entities.serviceName,

      service_id: entities.service_id || entities.serviceId,

      staff: entities.staff || entities.staff_name || entities.staffName,

      staff_id: entities.staff_id || entities.staffId,

      date: entities.date,

      time: entities.time,

      special_request: entities.special_request || analysis?.special_request,
    };

    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined && value !== null && value !== '') {
        next[key] = value;
      }
    }

    const dateRange = entities.date_range || entities.dateRange;
    if (dateRange?.from && dateRange?.to) {
      next.date_range = { from: dateRange.from, to: dateRange.to };
      delete next.date;
      delete next.time;
    } else if (entities.date) {
      delete next.date_range;
    }

    next.intent = analysis?.intent || next.intent;

    return next;
  }

  // =========================================================
  // FIND SERVICE
  // =========================================================

  async findServiceId(userId, serviceName) {
    try {
      if (!serviceName) {
        return null;
      }

      const services = await this.booking.getServices(userId);

      const wanted = String(serviceName).trim().toLowerCase();

      // -----------------------------------------------------
      // EXACT MATCH
      // -----------------------------------------------------

      const exact = services.find(
        (service) => String(service.name).trim().toLowerCase() === wanted,
      );

      if (exact) {
        return exact.id;
      }

      // -----------------------------------------------------
      // PARTIAL MATCH
      // -----------------------------------------------------

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
      if (!staffName) {
        return null;
      }

      const staff = await this.booking.getStaff(userId);

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
    const facts = await this.booking.getBusinessFacts(user.id);
    return {
      intent: 'FAQ',

      response: await this.generateAIResponse(
        user,
        phoneNumber,
        message,
        {
          ...analysis,
          // The response model receives this database-derived object only;
          // absent facts must never be filled with plausible defaults.
          faq_answer: facts,
        },
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
      const response = await this.ai.generateResponse(message, analysis, {
        businessName: user.business_name,

        businessType: user.business_type,

        timezone: user.business_timezone || 'Asia/Dubai',
      });

      return response || 'Sorry, I could not process your request.';
    } catch (err) {
      console.error('Generate AI response error:', err.message);

      return 'Sorry, I could not process your request.';
    }
  }

  // =========================================================
  // NUMBER
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
    // TODAY
    // -----------------------------------------------------

    if (ref === 'today' || ref === 'same day') {
      return this.formatDate(today);
    }

    // -----------------------------------------------------
    // TOMORROW
    // -----------------------------------------------------

    if (ref === 'tomorrow' || ref === 'next day') {
      const date = new Date(today);

      date.setDate(date.getDate() + 1);

      return this.formatDate(date);
    }

    // -----------------------------------------------------
    // DAY AFTER TOMORROW
    // -----------------------------------------------------

    if (ref === 'day after tomorrow') {
      const date = new Date(today);

      date.setDate(date.getDate() + 2);

      return this.formatDate(date);
    }

    // -----------------------------------------------------
    // YESTERDAY
    // -----------------------------------------------------

    if (ref === 'yesterday') {
      const date = new Date(today);

      date.setDate(date.getDate() - 1);

      return this.formatDate(date);
    }

    // -----------------------------------------------------
    // WEEKDAY
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
    // ALREADY YYYY-MM-DD
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

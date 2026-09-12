const AIService = require('../services/AIService');

class IntentHandler {
  constructor(services) {
    this.ai = services.ai;
    this.booking = services.booking;
  }

  // =========================================================
  // MAIN MESSAGE HANDLER
  // =========================================================

  async handleMessage(user, phoneNumber, message) {
    try {
      console.log('\n🧠 Analyzing message...');
      console.log(`📩 ${message}`);

      const context = {
        businessName: user.business_name,
        businessType: user.business_type,
        timezone: user.business_timezone || 'Asia/Dubai',
      };

      // -----------------------------------------------------
      // ONE AI CALL
      // -----------------------------------------------------

      const analysis = await this.ai.analyzeMessage(message, context);

      console.log('🧠 AI analysis:', JSON.stringify(analysis, null, 2));

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

      // -----------------------------------------------------
      // BASIC DATA
      // -----------------------------------------------------

      const businessType = String(user.business_type || '').toLowerCase();

      const customerName = entities.name || entities.customer_name || null;

      // IMPORTANT:
      // Phone ALWAYS comes from WhatsApp.
      const customerPhone = phoneNumber;

      const people = this.toNumber(
        entities.people || entities.guests || entities.party_size,
      );

      let bookingDate = entities.date || null;

      const dateReference =
        entities.date_reference || entities.dateReference || null;

      const bookingTime =
        entities.time ||
        entities.time_reference ||
        entities.timeReference ||
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

      // -----------------------------------------------------
      // CUSTOMER NAME
      // -----------------------------------------------------

      if (!customerName) {
        return {
          intent: 'BOOKING',
          response: await this.generateAIResponse(user, phoneNumber, message, {
            ...analysis,
            missing_information: ['name'],
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
      entities.service || entities.service_name || entities.serviceName || null;

    // -----------------------------------------------------
    // STAFF
    // -----------------------------------------------------

    const requestedStaff =
      entities.staff || entities.staff_name || entities.staffName || null;

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
        return {
          intent: 'BOOKING',
          response: await this.generateAIResponse(user, phoneNumber, message, {
            ...analysis,
            missing_information: ['service'],
            service_not_found: requestedService,
          }),
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

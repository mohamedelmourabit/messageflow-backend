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

      // 1. DETECT INTENT
      const intent = await this.ai.detectIntent(messageText);
      console.log(`🤖 Intent detected: ${intent}`);

      // 2. ROUTE BY INTENT
      let response;
      let bookingData = null;

      switch (intent) {
        case 'BOOKING':
          response = await this.handleBookingIntent(user, messageText);
          break;

        case 'FAQ':
          response = await this.handleFAQIntent(user, messageText);
          break;

        case 'CANCEL':
          response = await this.handleCancelIntent(user, messageText);
          break;

        case 'MODIFY':
          response = await this.handleModifyIntent(user, messageText);
          break;

        case 'HUMAN':
          response = await this.handleHumanIntent(user, messageText);
          break;

        default:
          response = await this.ai.generateResponse('FAQ', messageText, {
            businessName: user.business_name,
          });
      }

      console.log(`✅ Response: "${response.substring(0, 50)}..."`);

      return { intent, response, bookingData };
    } catch (err) {
      console.error('Handle message error:', err.message);
      return {
        intent: 'ERROR',
        response: 'Sorry, I encountered an error. Please try again.',
        bookingData: null,
      };
    }
  }

  async handleBookingIntent(user, message) {
    try {
      // Extract booking details from message
      const details = await this.ai.extractBookingDetails(message);
      console.log(`📅 Extracted details:`, details);

      // If we have all details, create booking
      if (details.date && details.time && details.people) {
        const isAvailable = await this.booking.checkAvailability(
          details.date,
          details.time,
        );

        if (isAvailable) {
          const booking = await this.booking.createBooking(
            user.id,
            details.name || 'Guest',
            details.phone || '',
            details.date,
            details.time,
          );

          if (booking) {
            return `Great! I've reserved a table for ${details.people} people on ${details.date} at ${details.time}. Confirmation #${booking.id}. See you soon! 🎉`;
          }
        } else {
          return `Sorry, that time slot is full. Would you like a different date or time?`;
        }
      }

      // If missing details, ask for them
      const missingFields = [];
      if (!details.people) missingFields.push('number of people');
      if (!details.date) missingFields.push('date');
      if (!details.time) missingFields.push('time');

      return `Got it! Please also tell me the ${missingFields.join(', ')} for your booking.`;
    } catch (err) {
      console.error('Booking intent error:', err.message);
      return 'I had trouble processing your booking. Could you please provide: number of people, date, and time?';
    }
  }

  async handleFAQIntent(user, message) {
    try {
      const response = await this.ai.generateResponse('FAQ', message, {
        businessName: user.business_name,
      });
      return response;
    } catch (err) {
      console.error('FAQ intent error:', err.message);
      return `We're open 11am-11pm daily. You can make reservations on WhatsApp. What else can I help with?`;
    }
  }

  async handleCancelIntent(user, message) {
    try {
      const bookings = await this.booking.getBookings(user.id);
      const upcomingBookings = bookings.filter((b) => b.status !== 'cancelled');

      if (upcomingBookings.length === 0) {
        return 'You have no upcoming bookings to cancel.';
      }

      // Cancel the most recent booking
      const booking = upcomingBookings[0];
      await this.booking.cancelBooking(booking.id);

      return `Your booking for ${booking.booking_date} at ${booking.booking_time} has been cancelled. Hope to see you another time!`;
    } catch (err) {
      console.error('Cancel intent error:', err.message);
      return 'I had trouble cancelling your booking. Please contact support.';
    }
  }

  async handleModifyIntent(user, message) {
    try {
      const response = await this.ai.generateResponse('FAQ', message, {
        businessName: user.business_name,
      });
      return response + '\n\nTo modify a booking, please cancel the current one and make a new reservation.';
    } catch (err) {
      console.error('Modify intent error:', err.message);
      return 'To modify your booking, please cancel it and make a new reservation with your preferred date and time.';
    }
  }

  async handleHumanIntent(user, message) {
    try {
      return `I've escalated your request. A team member from ${user.business_name} will contact you shortly. Thank you for your patience! 👋`;
    } catch (err) {
      console.error('Human intent error:', err.message);
      return 'Thank you for contacting us. A team member will help you shortly.';
    }
  }
}

module.exports = IntentHandler;

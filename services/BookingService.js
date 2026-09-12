// services/BookingService.js

class BookingService {
  constructor(pool) {
    this.db = pool;
  }

  // ============================================================
  // CREATE BOOKING
  // ============================================================

  async createBooking(
    userId,
    customerName,
    customerPhone,
    bookingDate,
    bookingTime,
  ) {
    try {
      const result = await this.db.query(
        `INSERT INTO bookings (
          user_id,
          customer_name,
          customer_phone,
          booking_date,
          booking_time,
          status
        )
        VALUES ($1, $2, $3, $4, $5, 'confirmed')
        RETURNING *`,
        [userId, customerName, customerPhone, bookingDate, bookingTime],
      );

      return result.rows[0];
    } catch (err) {
      console.error('Create booking error:', err.message);

      return null;
    }
  }

  // ============================================================
  // CHECK AVAILABILITY
  // IMPORTANT:
  // Availability must be checked PER BUSINESS.
  // ============================================================

  async checkAvailability(userId, bookingDate, bookingTime, maxPerSlot = 10) {
    try {
      const result = await this.db.query(
        `SELECT COUNT(*) AS count
         FROM bookings
         WHERE user_id = $1
         AND booking_date = $2
         AND booking_time = $3
         AND status != 'cancelled'`,
        [userId, bookingDate, bookingTime],
      );

      const currentCount = parseInt(result.rows[0].count, 10);

      console.log(
        `📊 Availability for business ${userId}: ${currentCount}/${maxPerSlot}`,
      );

      return currentCount < maxPerSlot;
    } catch (err) {
      console.error('Check availability error:', err.message);

      return false;
    }
  }

  // ============================================================
  // GET BOOKINGS
  // ============================================================

  async getBookings(userId) {
    try {
      const result = await this.db.query(
        `SELECT *
         FROM bookings
         WHERE user_id = $1
         ORDER BY booking_date DESC, booking_time DESC`,
        [userId],
      );

      return result.rows;
    } catch (err) {
      console.error('Get bookings error:', err.message);

      return [];
    }
  }

  // ============================================================
  // CONFIRM BOOKING
  // ============================================================

  async confirmBooking(userId, bookingId) {
    try {
      const result = await this.db.query(
        `UPDATE bookings
         SET status = 'confirmed'
         WHERE id = $1
         AND user_id = $2
         RETURNING *`,
        [bookingId, userId],
      );

      return result.rows[0] || null;
    } catch (err) {
      console.error('Confirm booking error:', err.message);

      return null;
    }
  }

  // ============================================================
  // CANCEL BOOKING
  // ============================================================

  async cancelBooking(userId, bookingId) {
    try {
      const result = await this.db.query(
        `UPDATE bookings
         SET status = 'cancelled'
         WHERE id = $1
         AND user_id = $2
         RETURNING *`,
        [bookingId, userId],
      );

      return result.rows[0] || null;
    } catch (err) {
      console.error('Cancel booking error:', err.message);

      return null;
    }
  }

  // ============================================================
  // UPCOMING BOOKINGS
  // ============================================================

  async getUpcomingBookings(userId, daysAhead = 30) {
    try {
      const result = await this.db.query(
        `SELECT *
         FROM bookings
         WHERE user_id = $1
         AND booking_date >= CURRENT_DATE
         AND booking_date <= CURRENT_DATE + ($2 * INTERVAL '1 day')
         AND status != 'cancelled'
         ORDER BY booking_date, booking_time`,
        [userId, daysAhead],
      );

      return result.rows;
    } catch (err) {
      console.error('Get upcoming bookings error:', err.message);

      return [];
    }
  }
}

module.exports = BookingService;

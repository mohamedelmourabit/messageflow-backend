// services/BookingService.js

class BookingService {
  constructor(pool) {
    this.db = pool;
  }

  async createBooking(userId, customerName, customerPhone, bookingDate, bookingTime) {
    try {
      const result = await this.db.query(
        `INSERT INTO bookings (user_id, customer_name, customer_phone, booking_date, booking_time, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [userId, customerName, customerPhone, bookingDate, bookingTime],
      );
      return result.rows[0];
    } catch (err) {
      console.error('Create booking error:', err.message);
      return null;
    }
  }

  async checkAvailability(bookingDate, bookingTime, maxPerSlot = 10) {
    try {
      const result = await this.db.query(
        `SELECT COUNT(*) as count FROM bookings 
         WHERE booking_date = $1 
         AND booking_time = $2 
         AND status != 'cancelled'`,
        [bookingDate, bookingTime],
      );
      
      const currentCount = parseInt(result.rows[0].count);
      return currentCount < maxPerSlot;
    } catch (err) {
      console.error('Check availability error:', err.message);
      return false;
    }
  }

  async getBookings(userId) {
    try {
      const result = await this.db.query(
        `SELECT * FROM bookings 
         WHERE user_id = $1 
         ORDER BY booking_date DESC`,
        [userId],
      );
      return result.rows;
    } catch (err) {
      console.error('Get bookings error:', err.message);
      return [];
    }
  }

  async confirmBooking(bookingId) {
    try {
      const result = await this.db.query(
        `UPDATE bookings 
         SET status = 'confirmed' 
         WHERE id = $1 
         RETURNING *`,
        [bookingId],
      );
      return result.rows[0];
    } catch (err) {
      console.error('Confirm booking error:', err.message);
      return null;
    }
  }

  async cancelBooking(bookingId) {
    try {
      const result = await this.db.query(
        `UPDATE bookings 
         SET status = 'cancelled' 
         WHERE id = $1 
         RETURNING *`,
        [bookingId],
      );
      return result.rows[0];
    } catch (err) {
      console.error('Cancel booking error:', err.message);
      return null;
    }
  }

  async getUpcomingBookings(userId, daysAhead = 30) {
    try {
      const result = await this.db.query(
        `SELECT * FROM bookings 
         WHERE user_id = $1 
         AND booking_date >= CURRENT_DATE
         AND booking_date <= CURRENT_DATE + INTERVAL '${daysAhead} days'
         AND status != 'cancelled'
         ORDER BY booking_date, booking_time`,
        [userId],
      );
      return result.rows;
    } catch (err) {
      console.error('Get upcoming bookings error:', err.message);
      return [];
    }
  }
}

module.exports = BookingService;

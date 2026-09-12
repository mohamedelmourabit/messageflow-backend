class BookingService {
  constructor(db) {
    this.db = db;
  }

  // =========================================================
  // BUSINESS SETTINGS
  // =========================================================

  async getBusinessSettings(userId) {
    const result = await this.db.query(
      `
      SELECT *
      FROM business_settings
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId],
    );

    return (
      result.rows[0] || {
        reservation_mode: 'SLOTS',
        max_booking_advance_days: 30,
        min_booking_notice_minutes: 60,
        default_booking_duration_minutes: 60,
        allow_table_combination: false,
        max_bookings_per_slot: 1,
      }
    );
  }

  // =========================================================
  // TABLE TYPES - RESTAURANT
  // =========================================================

  async getTableTypes(userId) {
    const result = await this.db.query(
      `
      SELECT *
      FROM table_types
      WHERE user_id = $1
      ORDER BY capacity ASC, id ASC
      `,
      [userId],
    );

    return result.rows;
  }

  // =========================================================
  // SERVICES - SALON / SERVICE BUSINESS
  // =========================================================

  async getServices(userId) {
    const result = await this.db.query(
      `
      SELECT *
      FROM services
      WHERE user_id = $1
        AND COALESCE(active, true) = true
      ORDER BY name ASC, id ASC
      `,
      [userId],
    );

    return result.rows;
  }

  // =========================================================
  // STAFF
  // =========================================================

  async getStaff(userId) {
    const result = await this.db.query(
      `
      SELECT *
      FROM staff
      WHERE user_id = $1
        AND COALESCE(active, true) = true
      ORDER BY name ASC, id ASC
      `,
      [userId],
    );

    return result.rows;
  }

  // =========================================================
  // CREATE BOOKING
  // =========================================================

  async createBooking(
    userId,
    customerName,
    customerPhone,
    people,
    bookingDate,
    bookingTime,
    options = {},
  ) {
    try {
      const {
        endTime = null,
        serviceId = null,
        staffId = null,
        tableTypeId = null,
        specialRequest = null,
      } = options;

      const result = await this.db.query(
        `
        INSERT INTO bookings (
          user_id,
          customer_name,
          customer_phone,
          people,
          booking_date,
          booking_time,
          start_time,
          end_time,
          service_id,
          staff_id,
          table_type_id,
          special_request,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          'confirmed'
        )
        RETURNING *
        `,
        [
          userId,
          customerName,
          customerPhone,
          people || 1,
          bookingDate,
          bookingTime,
          endTime || bookingTime,
          serviceId,
          staffId,
          tableTypeId,
          specialRequest,
        ],
      );

      return {
        success: true,
        booking: result.rows[0],
      };
    } catch (err) {
      console.error('Create booking error:', err.message);

      return {
        success: false,
        error: err.message,
      };
    }
  }

  // =========================================================
  // RESTAURANT
  // =========================================================

  async findAvailableTable(
    userId,
    bookingDate,
    startTime,
    endTime,
    people,
    requestedZone = null,
  ) {
    try {
      const params = [userId, bookingDate, people, startTime, endTime];

      let zoneCondition = '';
      let zoneParam = null;

      if (requestedZone) {
        zoneParam = params.length + 1;
        params.push(requestedZone);

        zoneCondition = `
          AND (
            tt.zone IS NULL
            OR LOWER(tt.zone) = LOWER($${zoneParam})
          )
        `;
      }

      const result = await this.db.query(
        `
        SELECT
          tt.*
        FROM table_types tt
        WHERE tt.user_id = $1
          AND tt.capacity >= $3
          AND COALESCE(tt.quantity, 0) > 0
          ${zoneCondition}
        ORDER BY
          tt.capacity ASC,
          tt.id ASC
        `,
        params,
      );

      for (const tableType of result.rows) {
        const occupied = await this.db.query(
          `
          SELECT COUNT(*)::int AS count
          FROM bookings
          WHERE user_id = $1
            AND booking_date = $2
            AND table_type_id = $3
            AND status != 'cancelled'
            AND start_time < $5
            AND end_time > $4
          `,
          [userId, bookingDate, tableType.id, startTime, endTime],
        );

        const used = occupied.rows[0].count || 0;
        const quantity = Number(tableType.quantity || 0);

        if (used < quantity) {
          return {
            available: true,
            tableType,
          };
        }
      }

      return {
        available: false,
        tableType: null,
      };
    } catch (err) {
      console.error('Find available table error:', err.message);

      return {
        available: false,
        tableType: null,
        error: err.message,
      };
    }
  }

  async checkRestaurantAvailability(
    userId,
    bookingDate,
    startTime,
    endTime,
    people,
    requestedZone = null,
  ) {
    try {
      const settings = await this.getBusinessSettings(userId);

      // -----------------------------------------------------
      // Advance booking limit
      // -----------------------------------------------------

      const advanceDays = Number(settings.max_booking_advance_days || 30);

      const dateCheck = await this.db.query(
        `
        SELECT
          ($1::date <= CURRENT_DATE + $2::integer) AS valid
        `,
        [bookingDate, advanceDays],
      );

      if (!dateCheck.rows[0].valid) {
        return {
          available: false,
          reason: 'TOO_FAR_IN_ADVANCE',
        };
      }

      // -----------------------------------------------------
      // Minimum notice
      // -----------------------------------------------------

      const noticeMinutes = Number(settings.min_booking_notice_minutes || 0);

      if (noticeMinutes > 0) {
        const noticeCheck = await this.db.query(
          `
          SELECT
            (
              ($1::date + $2::time)
              >= NOW() + ($3::integer * INTERVAL '1 minute')
            ) AS valid
          `,
          [bookingDate, startTime, noticeMinutes],
        );

        if (!noticeCheck.rows[0].valid) {
          return {
            available: false,
            reason: 'TOO_SOON',
          };
        }
      }

      // -----------------------------------------------------
      // Find table
      // -----------------------------------------------------

      const table = await this.findAvailableTable(
        userId,
        bookingDate,
        startTime,
        endTime,
        people,
        requestedZone,
      );

      if (!table.available) {
        return {
          available: false,
          reason: 'NO_TABLE_AVAILABLE',
        };
      }

      return {
        available: true,
        tableType: table.tableType,
      };
    } catch (err) {
      console.error('Check restaurant availability error:', err.message);

      return {
        available: false,
        reason: 'SYSTEM_ERROR',
        error: err.message,
      };
    }
  }

  // =========================================================
  // SALON - CHECK STAFF
  // =========================================================

  async isStaffAvailable(userId, staffId, bookingDate, startTime, endTime) {
    const result = await this.db.query(
      `
      SELECT COUNT(*)::int AS count
      FROM bookings
      WHERE user_id = $1
        AND staff_id = $2
        AND booking_date = $3
        AND status != 'cancelled'
        AND start_time < $5
        AND end_time > $4
      `,
      [userId, staffId, bookingDate, startTime, endTime],
    );

    return result.rows[0].count === 0;
  }

  // =========================================================
  // SALON - CHECK SERVICE + STAFF
  // =========================================================

  async checkSalonAvailability(
    userId,
    bookingDate,
    startTime,
    endTime,
    serviceId = null,
    requestedStaffId = null,
  ) {
    try {
      let staff = [];

      // -----------------------------------------------------
      // If customer requested a specific staff member
      // -----------------------------------------------------

      if (requestedStaffId) {
        const staffResult = await this.db.query(
          `
          SELECT *
          FROM staff
          WHERE id = $1
            AND user_id = $2
            AND COALESCE(active, true) = true
          LIMIT 1
          `,
          [requestedStaffId, userId],
        );

        staff = staffResult.rows;
      } else {
        // ---------------------------------------------------
        // Otherwise all active staff
        // ---------------------------------------------------

        const staffResult = await this.db.query(
          `
          SELECT *
          FROM staff
          WHERE user_id = $1
            AND COALESCE(active, true) = true
          ORDER BY id ASC
          `,
          [userId],
        );

        staff = staffResult.rows;
      }

      // -----------------------------------------------------
      // Try every staff member
      // -----------------------------------------------------

      for (const employee of staff) {
        const available = await this.isStaffAvailable(
          userId,
          employee.id,
          bookingDate,
          startTime,
          endTime,
        );

        if (available) {
          return {
            available: true,
            staff: employee,
            serviceId,
          };
        }
      }

      return {
        available: false,
        staff: null,
        serviceId,
        reason: 'NO_STAFF_AVAILABLE',
      };
    } catch (err) {
      console.error('Check salon availability error:', err.message);

      return {
        available: false,
        staff: null,
        serviceId,
        reason: 'SYSTEM_ERROR',
        error: err.message,
      };
    }
  }

  // =========================================================
  // SALON - AUTOMATIC SERVICE + STAFF
  //
  // Used when customer says:
  //
  // "I want an appointment tomorrow at 6pm"
  //
  // but doesn't specify the service.
  // =========================================================

  async findBestSalonAvailability(
    userId,
    bookingDate,
    startTime,
    requestedServiceId = null,
    requestedStaffId = null,
  ) {
    try {
      const services = await this.getServices(userId);

      if (!services.length) {
        return {
          available: false,
          reason: 'NO_SERVICES_CONFIGURED',
        };
      }

      // -----------------------------------------------------
      // If service requested, only try that service.
      // -----------------------------------------------------

      let servicesToTry = services;

      if (requestedServiceId) {
        servicesToTry = services.filter(
          (service) => Number(service.id) === Number(requestedServiceId),
        );
      }

      // -----------------------------------------------------
      // Try each service.
      // First valid service + staff wins.
      // -----------------------------------------------------

      for (const service of servicesToTry) {
        const duration = Number(
          service.duration_minutes || service.duration || 60,
        );

        const endTime = this.calculateEndTime(startTime, duration);

        const availability = await this.checkSalonAvailability(
          userId,
          bookingDate,
          startTime,
          endTime,
          service.id,
          requestedStaffId,
        );

        if (availability.available) {
          return {
            available: true,
            service,
            staff: availability.staff,
            startTime,
            endTime,
          };
        }
      }

      return {
        available: false,
        reason: 'NO_SERVICE_STAFF_AVAILABLE',
      };
    } catch (err) {
      console.error('Find best salon availability error:', err.message);

      return {
        available: false,
        reason: 'SYSTEM_ERROR',
        error: err.message,
      };
    }
  }

  // =========================================================
  // GENERIC SLOT MODE
  // =========================================================

  async checkSlotAvailability(userId, bookingDate, startTime, endTime) {
    try {
      const settings = await this.getBusinessSettings(userId);

      const maxBookings = Number(settings.max_bookings_per_slot || 1);

      const result = await this.db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM bookings
        WHERE user_id = $1
          AND booking_date = $2
          AND status != 'cancelled'
          AND start_time < $4
          AND end_time > $3
        `,
        [userId, bookingDate, startTime, endTime],
      );

      const currentBookings = result.rows[0].count || 0;

      return {
        available: currentBookings < maxBookings,
        currentBookings,
        maxBookings,
      };
    } catch (err) {
      console.error('Check slot availability error:', err.message);

      return {
        available: false,
        error: err.message,
      };
    }
  }

  // =========================================================
  // CALCULATE END TIME
  // =========================================================

  calculateEndTime(startTime, durationMinutes) {
    const [hours, minutes] = String(startTime).split(':').map(Number);

    const totalMinutes = hours * 60 + minutes + Number(durationMinutes || 60);

    const endHours = Math.floor(totalMinutes / 60) % 24;

    const endMinutes = totalMinutes % 60;

    return `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(
      2,
      '0',
    )}`;
  }

  // =========================================================
  // GET BOOKINGS
  // =========================================================

  async getBookings(userId, options = {}) {
    try {
      const { status = null, fromDate = null, toDate = null } = options;

      const conditions = ['b.user_id = $1'];
      const params = [userId];

      if (status) {
        params.push(status);
        conditions.push(`b.status = $${params.length}`);
      }

      if (fromDate) {
        params.push(fromDate);
        conditions.push(`b.booking_date >= $${params.length}`);
      }

      if (toDate) {
        params.push(toDate);
        conditions.push(`b.booking_date <= $${params.length}`);
      }

      const result = await this.db.query(
        `
        SELECT
          b.*,
          s.name AS service_name,
          s.duration_minutes AS service_duration,
          st.name AS staff_name,
          tt.name AS table_type_name,
          tt.capacity AS table_capacity,
          tt.zone AS table_zone
        FROM bookings b
        LEFT JOIN services s
          ON s.id = b.service_id
        LEFT JOIN staff st
          ON st.id = b.staff_id
        LEFT JOIN table_types tt
          ON tt.id = b.table_type_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY
          b.booking_date ASC,
          b.start_time ASC,
          b.id ASC
        `,
        params,
      );

      return result.rows;
    } catch (err) {
      console.error('Get bookings error:', err.message);

      return [];
    }
  }

  // =========================================================
  // CONFIRM BOOKING
  // =========================================================

  async confirmBooking(userId, bookingId) {
    try {
      const result = await this.db.query(
        `
        UPDATE bookings
        SET status = 'confirmed'
        WHERE id = $1
          AND user_id = $2
        RETURNING *
        `,
        [bookingId, userId],
      );

      return result.rows[0] || null;
    } catch (err) {
      console.error('Confirm booking error:', err.message);

      return null;
    }
  }

  // =========================================================
  // CANCEL BOOKING
  // =========================================================

  async cancelBooking(userId, bookingId) {
    try {
      const result = await this.db.query(
        `
        UPDATE bookings
        SET status = 'cancelled'
        WHERE id = $1
          AND user_id = $2
        RETURNING *
        `,
        [bookingId, userId],
      );

      return result.rows[0] || null;
    } catch (err) {
      console.error('Cancel booking error:', err.message);

      return null;
    }
  }

  // =========================================================
  // UPCOMING BOOKINGS
  // =========================================================

  async getUpcomingBookings(userId) {
    try {
      const result = await this.db.query(
        `
        SELECT
          b.*,
          s.name AS service_name,
          st.name AS staff_name,
          tt.name AS table_type_name,
          tt.zone AS table_zone
        FROM bookings b
        LEFT JOIN services s
          ON s.id = b.service_id
        LEFT JOIN staff st
          ON st.id = b.staff_id
        LEFT JOIN table_types tt
          ON tt.id = b.table_type_id
        WHERE b.user_id = $1
          AND b.status != 'cancelled'
          AND (
            b.booking_date > CURRENT_DATE
            OR (
              b.booking_date = CURRENT_DATE
              AND b.start_time >= CURRENT_TIME
            )
          )
        ORDER BY
          b.booking_date ASC,
          b.start_time ASC
        `,
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

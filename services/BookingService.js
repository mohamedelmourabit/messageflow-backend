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
  // OPENING HOURS
  // =========================================================

  async getOpeningHours(userId) {
    const result = await this.db.query(
      `SELECT day_of_week, is_open, open_time, close_time
       FROM opening_hours
       WHERE user_id = $1
       ORDER BY day_of_week ASC`,
      [userId],
    );

    // Always return one row per day (0=Sunday..6=Saturday) so the caller
    // (frontend, or an availability check) never has to guess what an
    // absent day means - a day the business never configured is closed.
    const byDay = new Map(result.rows.map((row) => [row.day_of_week, row]));

    return Array.from({ length: 7 }, (_, day) => byDay.get(day) || {
      day_of_week: day,
      is_open: false,
      open_time: null,
      close_time: null,
    });
  }

  async setOpeningHours(userId, hours) {
    const days = (hours || []).filter(
      (h) => Number.isInteger(h?.day_of_week) && h.day_of_week >= 0 && h.day_of_week <= 6,
    );

    for (const day of days) {
      await this.db.query(
        `INSERT INTO opening_hours (user_id, day_of_week, is_open, open_time, close_time)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, day_of_week)
         DO UPDATE SET is_open = EXCLUDED.is_open,
                       open_time = EXCLUDED.open_time,
                       close_time = EXCLUDED.close_time`,
        [
          userId,
          day.day_of_week,
          day.is_open === true,
          day.is_open === true ? day.open_time || null : null,
          day.is_open === true ? day.close_time || null : null,
        ],
      );
    }

    return this.getOpeningHours(userId);
  }

  async getOpeningHoursForDate(userId, date) {
    const result = await this.db.query(
      `SELECT is_open, open_time, close_time
       FROM opening_hours
       WHERE user_id = $1
         AND day_of_week = EXTRACT(DOW FROM $2::date)::int
       LIMIT 1`,
      [userId, date],
    );

    return result.rows[0] || null;
  }

  // =========================================================
  // HOLIDAYS / CLOSED DATES
  // =========================================================

  async getHolidays(userId) {
    // holiday_date is formatted server-side to a plain YYYY-MM-DD string -
    // the pg driver otherwise hands back a DATE column as a JS Date built
    // in the Node process's local timezone, which can serialize a day off
    // from what was actually stored once it round-trips through JSON.
    const result = await this.db.query(
      `SELECT id, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date, reason
       FROM holidays
       WHERE user_id = $1
       ORDER BY holiday_date ASC`,
      [userId],
    );

    return result.rows;
  }

  async addHoliday(userId, date, reason = null) {
    const result = await this.db.query(
      `INSERT INTO holidays (user_id, holiday_date, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, holiday_date)
       DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id, TO_CHAR(holiday_date, 'YYYY-MM-DD') AS holiday_date, reason`,
      [userId, date, reason],
    );

    return result.rows[0];
  }

  async deleteHoliday(userId, holidayId) {
    const result = await this.db.query(
      `DELETE FROM holidays WHERE id = $1 AND user_id = $2`,
      [holidayId, userId],
    );

    return result.rowCount > 0;
  }

  async isHoliday(userId, date) {
    const result = await this.db.query(
      `SELECT 1 FROM holidays WHERE user_id = $1 AND holiday_date = $2 LIMIT 1`,
      [userId, date],
    );

    return result.rows.length > 0;
  }

  // Single source of truth for "is this business open at all on this date":
  // a configured weekly closed day, a day never configured, or a holiday
  // all mean the same thing - never invent business hours either way.
  async isBusinessOpenOnDate(userId, date) {
    const [hours, holiday] = await Promise.all([
      this.getOpeningHoursForDate(userId, date),
      this.isHoliday(userId, date),
    ]);

    if (holiday) return false;
    if (!hours || hours.is_open !== true || !hours.open_time || !hours.close_time) return false;

    return true;
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

  async getBusinessFacts(userId) {
    const [services, hours] = await Promise.all([
      this.getServices(userId),
      this.db.query(
        `SELECT day_of_week, is_open, open_time, close_time
         FROM opening_hours WHERE user_id = $1 ORDER BY day_of_week ASC`,
        [userId],
      ),
    ]);
    return {
      services: services.map(({ name, description, duration_minutes, price }) => ({ name, description, duration_minutes, price })),
      opening_hours: hours.rows,
    };
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
      // Business open on this date/time
      // -----------------------------------------------------

      if (!(await this.isBusinessOpenOnDate(userId, bookingDate))) {
        return {
          available: false,
          reason: 'CLOSED',
        };
      }

      const hours = await this.getOpeningHoursForDate(userId, bookingDate);
      const openMinutes = this.timeToMinutes(hours.open_time);
      const closeMinutes = this.timeToMinutes(hours.close_time);
      const requestStart = this.timeToMinutes(startTime);
      const requestEnd = this.timeToMinutes(endTime);

      if (
        requestStart === null ||
        requestEnd === null ||
        requestStart < openMinutes ||
        requestEnd > closeMinutes
      ) {
        return {
          available: false,
          reason: 'OUTSIDE_OPENING_HOURS',
        };
      }

      // Restaurants can start with a single, explicit guest capacity instead
      // of configuring table types. This is the authoritative capacity check.
      const capacity = Number(settings.restaurant_capacity || 0);
      if (capacity > 0) {
        const occupied = await this.db.query(
          `SELECT COALESCE(SUM(people), 0)::int AS people
           FROM bookings
           WHERE user_id = $1
             AND booking_date = $2
             AND status != 'cancelled'
             AND start_time < $4
             AND end_time > $3`,
          [userId, bookingDate, startTime, endTime],
        );
        const used = Number(occupied.rows[0]?.people || 0);
        if (used + Number(people) > capacity) {
          return { available: false, reason: 'RESTAURANT_CAPACITY_REACHED' };
        }
        return { available: true, tableType: null, capacity, occupied: used };
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
  // RESTAURANT - ALTERNATIVE TIME SLOTS
  // =========================================================

  async findAlternativeRestaurantSlots(
    userId,
    bookingDate,
    requestedTime,
    people,
    requestedZone = null,
    limit = 5,
  ) {
    try {
      if (!bookingDate || !requestedTime) return [];

      const settings = await this.getBusinessSettings(userId);
      const duration = Number(settings.default_booking_duration_minutes || 90);

      // Respect configured opening hours and holidays - never propose a
      // time on a day the business is closed.
      if (!(await this.isBusinessOpenOnDate(userId, bookingDate))) {
        return [];
      }
      const opening = await this.getOpeningHoursForDate(userId, bookingDate);
      const openingMinutes = this.timeToMinutes(opening.open_time);
      const closingMinutes = this.timeToMinutes(opening.close_time);

      const requestedMinutes = this.timeToMinutes(requestedTime);
      if (requestedMinutes === null) return [];

      const noticeMinutes = Number(settings.min_booking_notice_minutes || 0);
      const advanceDays = Number(settings.max_booking_advance_days || 30);

      // Never propose outside the business advance window.
      const dateCheck = await this.db.query(
        `SELECT ($1::date <= CURRENT_DATE + $2::integer) AS valid`,
        [bookingDate, advanceDays],
      );
      if (!dateCheck.rows[0]?.valid) return [];

      const candidates = [];
      const seen = new Set();

      // Search closest first: -30, +30, -60, +60, ...
      for (let distance = 30; distance <= 12 * 60 && candidates.length < limit; distance += 30) {
        for (const candidateMinutes of [requestedMinutes - distance, requestedMinutes + distance]) {
          if (candidateMinutes < 0 || candidateMinutes >= 24 * 60) continue;
          if (seen.has(candidateMinutes)) continue;
          seen.add(candidateMinutes);

          const endMinutes = candidateMinutes + duration;
          if (openingMinutes !== null && candidateMinutes < openingMinutes) continue;
          if (closingMinutes !== null && endMinutes > closingMinutes) continue;

          const startTime = this.minutesToTime(candidateMinutes);
          const endTime = this.calculateEndTime(startTime, duration);

          if (noticeMinutes > 0) {
            const noticeCheck = await this.db.query(
              `SELECT (
                ($1::date + $2::time)
                >= NOW() + ($3::integer * INTERVAL '1 minute')
              ) AS valid`,
              [bookingDate, startTime, noticeMinutes],
            );
            if (!noticeCheck.rows[0]?.valid) continue;
          }

          const availability = await this.checkRestaurantAvailability(
            userId,
            bookingDate,
            startTime,
            endTime,
            people,
            requestedZone,
          );

          if (availability.available) {
            candidates.push({
              startTime,
              endTime,
              tableType: availability.tableType || null,
            });
          }

          if (candidates.length >= limit) break;
        }
      }

      return candidates;
    } catch (err) {
      console.error('Find alternative restaurant slots error:', err.message);
      return [];
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
      if (!(await this.isBusinessOpenOnDate(userId, bookingDate))) {
        return {
          available: false,
          staff: null,
          serviceId,
          reason: 'CLOSED',
        };
      }

      const hours = await this.getOpeningHoursForDate(userId, bookingDate);
      const openMinutes = this.timeToMinutes(hours.open_time);
      const closeMinutes = this.timeToMinutes(hours.close_time);
      const requestStart = this.timeToMinutes(startTime);
      const requestEnd = this.timeToMinutes(endTime);

      if (
        requestStart === null ||
        requestEnd === null ||
        requestStart < openMinutes ||
        requestEnd > closeMinutes
      ) {
        return {
          available: false,
          staff: null,
          serviceId,
          reason: 'OUTSIDE_OPENING_HOURS',
        };
      }

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

      // Staff are optional. With no staff configured, salon appointments use
      // the business's configured slot capacity just like a service business.
      if (!requestedStaffId && staff.length === 0) {
        const slot = await this.checkSlotAvailability(
          userId,
          bookingDate,
          startTime,
          endTime,
        );
        return {
          available: slot.available,
          staff: null,
          serviceId,
          reason: slot.available ? null : 'NO_SLOT_AVAILABLE',
        };
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

  // Salon MVP: appointments are not tied to a service. The business-configured
  // default duration and real slot/staff availability remain authoritative.
  async findSalonSlotAvailability(userId, bookingDate, startTime, requestedStaffId = null) {
    const settings = await this.getBusinessSettings(userId);
    const endTime = this.calculateEndTime(
      startTime,
      Number(settings.default_booking_duration_minutes || 60),
    );
    const availability = await this.checkSalonAvailability(
      userId,
      bookingDate,
      startTime,
      endTime,
      null,
      requestedStaffId,
    );
    return {
      available: availability.available,
      staff: availability.staff,
      startTime,
      endTime,
      reason: availability.reason || null,
    };
  }

  // =========================================================
  // SALON - ALTERNATIVE TIME SLOTS
  // =========================================================

  async findAlternativeSalonSlots(
    userId,
    bookingDate,
    requestedTime,
    serviceId,
    requestedStaffId = null,
    limit = 5,
  ) {
    try {
      if (!bookingDate || !requestedTime) return [];

      const settings = await this.getBusinessSettings(userId);
      const duration = Number(settings.default_booking_duration_minutes || 60);

      // Respect configured opening hours and holidays - never propose a
      // time on a day the business is closed.
      if (!(await this.isBusinessOpenOnDate(userId, bookingDate))) {
        return [];
      }
      const opening = await this.getOpeningHoursForDate(userId, bookingDate);
      const openingMinutes = this.timeToMinutes(opening.open_time);
      const closingMinutes = this.timeToMinutes(opening.close_time);

      const requestedMinutes = this.timeToMinutes(requestedTime);
      if (requestedMinutes === null) return [];

      const noticeMinutes = Number(settings.min_booking_notice_minutes || 0);
      const advanceDays = Number(settings.max_booking_advance_days || 30);

      // Never propose outside the business advance window.
      const dateCheck = await this.db.query(
        `SELECT ($1::date <= CURRENT_DATE + $2::integer) AS valid`,
        [bookingDate, advanceDays],
      );
      if (!dateCheck.rows[0]?.valid) return [];

      const candidates = [];
      const seen = new Set();

      // Search closest first: -30, +30, -60, +60, ...
      for (let distance = 30; distance <= 12 * 60 && candidates.length < limit; distance += 30) {
        for (const candidateMinutes of [requestedMinutes - distance, requestedMinutes + distance]) {
          if (candidateMinutes < 0 || candidateMinutes >= 24 * 60) continue;
          if (seen.has(candidateMinutes)) continue;
          seen.add(candidateMinutes);

          const endMinutes = candidateMinutes + duration;
          if (openingMinutes !== null && candidateMinutes < openingMinutes) continue;
          if (closingMinutes !== null && endMinutes > closingMinutes) continue;

          const startTime = this.minutesToTime(candidateMinutes);
          const endTime = this.calculateEndTime(startTime, duration);

          if (noticeMinutes > 0) {
            const noticeCheck = await this.db.query(
              `SELECT (
                ($1::date + $2::time)
                >= NOW() + ($3::integer * INTERVAL '1 minute')
              ) AS valid`,
              [bookingDate, startTime, noticeMinutes],
            );
            if (!noticeCheck.rows[0]?.valid) continue;
          }

          const availability = await this.checkSalonAvailability(
            userId,
            bookingDate,
            startTime,
            endTime,
            serviceId,
            requestedStaffId,
          );

          if (availability.available) {
            candidates.push({
              startTime,
              endTime,
              staff: availability.staff,
              service: null,
            });
          }

          if (candidates.length >= limit) break;
        }
      }

      return candidates;
    } catch (err) {
      console.error('Find alternative salon slots error:', err.message);
      return [];
    }
  }

  // Finds real appointment slots over an inclusive date range. It deliberately
  // returns dates with times instead of selecting an arbitrary day from a
  // customer phrase such as “next week”.
  async findSalonAvailabilityInRange(userId, fromDate, toDate, requestedStaffId = null, limit = 5) {
    if (!fromDate || !toDate || fromDate > toDate) return [];
    const settings = await this.getBusinessSettings(userId);
    const duration = Number(settings.default_booking_duration_minutes || 60);
    const results = [];
    const cursor = new Date(`${fromDate}T12:00:00Z`);
    const last = new Date(`${toDate}T12:00:00Z`);
    while (cursor <= last && results.length < limit) {
      const date = cursor.toISOString().slice(0, 10);
      const advanceCheck = await this.db.query(
        `SELECT ($1::date <= CURRENT_DATE + $2::integer) AS valid`,
        [date, Number(settings.max_booking_advance_days || 30)],
      );
      if (!advanceCheck.rows[0]?.valid) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        continue;
      }
      // A range search must never manufacture business hours, and must skip
      // holidays entirely - businesses need an opening-hours record and no
      // holiday on this date before we can offer an exact time.
      if (await this.isBusinessOpenOnDate(userId, date)) {
        const opening = await this.getOpeningHoursForDate(userId, date);
        const open = this.timeToMinutes(opening.open_time);
        const close = this.timeToMinutes(opening.close_time);
        for (let minutes = open; minutes + duration <= close && results.length < limit; minutes += 30) {
          const startTime = this.minutesToTime(minutes);
          if (Number(settings.min_booking_notice_minutes || 0) > 0) {
            const notice = await this.db.query(
              `SELECT (($1::date + $2::time) >= NOW() + ($3::integer * INTERVAL '1 minute')) AS valid`,
              [date, startTime, Number(settings.min_booking_notice_minutes)],
            );
            if (!notice.rows[0]?.valid) continue;
          }
          const endTime = this.calculateEndTime(startTime, duration);
          const availability = await this.checkSalonAvailability(userId, date, startTime, endTime, null, requestedStaffId);
          if (availability.available) results.push({ date, startTime, endTime, staff: availability.staff });
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return results;
  }

  timeToMinutes(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).slice(0, 5);
    const [hours, minutes] = text.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return hours * 60 + minutes;
  }

  minutesToTime(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
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

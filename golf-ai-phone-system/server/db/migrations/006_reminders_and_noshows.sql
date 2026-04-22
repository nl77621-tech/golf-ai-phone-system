-- Migration 006: Day-before reminders + no-show tracking

-- Track whether we already sent a reminder for this booking
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE;

-- Track no-shows per customer
ALTER TABLE customers ADD COLUMN IF NOT EXISTS no_show_count INTEGER DEFAULT 0;

-- Track no-show status on bookings
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS no_show BOOLEAN DEFAULT FALSE;

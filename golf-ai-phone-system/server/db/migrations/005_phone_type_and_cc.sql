-- Migration 005: Add line type detection and credit card fields
-- Adds line_type to customers (cached Twilio Lookup result)
-- Adds alternate_phone to customers (mobile number if primary is landline)
-- Adds card_last_four to booking_requests (last 4 digits of CC on file)

ALTER TABLE customers ADD COLUMN IF NOT EXISTS line_type VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS alternate_phone VARCHAR(20);

ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS card_last_four VARCHAR(4);

-- Add booking_settings to settings if not present
INSERT INTO settings (key, value, description)
VALUES ('booking_settings', '{"require_credit_card": false}', 'Booking behavior settings (credit card requirement, etc.)')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- Valleymede Golf AI Phone System
-- Database Schema
-- ============================================

-- Settings: key-value store for all configurable options
CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Customers: anyone who has called or been booked
CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    name VARCHAR(200),
    email VARCHAR(200),
    notes TEXT,
    call_count INTEGER DEFAULT 0,
    first_call_at TIMESTAMP DEFAULT NOW(),
    last_call_at TIMESTAMP DEFAULT NOW(),
    line_type VARCHAR(20),
    alternate_phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(phone)
);

-- Booking requests: collected by AI, processed by staff
CREATE TABLE IF NOT EXISTS booking_requests (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    customer_name VARCHAR(200),
    customer_phone VARCHAR(20),
    customer_email VARCHAR(200),
    requested_date DATE NOT NULL,
    requested_time TIME,
    party_size INTEGER DEFAULT 1,
    num_carts INTEGER DEFAULT 0,
    special_requests TEXT,
    status VARCHAR(20) DEFAULT 'pending',  -- pending, confirmed, rejected, cancelled
    card_last_four VARCHAR(4),
    staff_notes TEXT,
    call_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Modification requests: changes to existing bookings
CREATE TABLE IF NOT EXISTS modification_requests (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id),
    customer_name VARCHAR(200),
    customer_phone VARCHAR(20),
    request_type VARCHAR(20) NOT NULL, -- modify, cancel
    original_date DATE,
    original_time TIME,
    new_date DATE,
    new_time TIME,
    details TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- pending, processed, rejected
    staff_notes TEXT,
    call_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Call logs: every inbound call
CREATE TABLE IF NOT EXISTS call_logs (
    id SERIAL PRIMARY KEY,
    twilio_call_sid VARCHAR(100),
    caller_phone VARCHAR(20),
    customer_id INTEGER REFERENCES customers(id),
    duration_seconds INTEGER,
    summary TEXT,
    transcript TEXT,
    status VARCHAR(20) DEFAULT 'active', -- active, completed, transferred, failed
    transferred_to VARCHAR(20),
    started_at TIMESTAMP DEFAULT NOW(),
    ended_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Greetings: random greetings pool
CREATE TABLE IF NOT EXISTS greetings (
    id SERIAL PRIMARY KEY,
    message TEXT NOT NULL,
    for_known_caller BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_booking_requests_status ON booking_requests(status);
CREATE INDEX IF NOT EXISTS idx_booking_requests_date ON booking_requests(requested_date);
CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller_phone);
CREATE INDEX IF NOT EXISTS idx_call_logs_started ON call_logs(started_at);
CREATE INDEX IF NOT EXISTS idx_modification_requests_status ON modification_requests(status);

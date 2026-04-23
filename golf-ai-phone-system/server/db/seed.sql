-- ============================================
-- Seed Data (fresh install only)
-- ============================================
-- Creates Valleymede as business_id = 1 and seeds its default
-- settings + greetings. This file runs AFTER schema.sql on a
-- fresh database. On an existing production DB, use
-- server/db/migrations/001_multi_tenant.sql instead — the
-- migration seeds the same Valleymede row if missing.
-- ============================================

-- ----- Valleymede tenant row ------------------------------
INSERT INTO businesses (
    id, slug, name, twilio_phone_number, transfer_number, timezone,
    contact_email, contact_phone, status, plan
) VALUES (
    1,
    'valleymede-columbus',
    'Valleymede Columbus Golf Course',
    NULL,                         -- set by ops via env / admin UI when Twilio number is provisioned
    '+19056556300',
    'America/Toronto',
    'info@valleymedecolumbusgolf.com',
    '+19056556300',
    'active',
    'legacy'
)
ON CONFLICT (id) DO NOTHING;

SELECT setval(
    pg_get_serial_sequence('businesses', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 1) FROM businesses), 1)
);

-- ----- Valleymede default settings ------------------------
INSERT INTO settings (business_id, key, value, description) VALUES
(1, 'business_hours', '{
    "monday": {"open": "07:00", "close": "19:00"},
    "tuesday": {"open": "07:00", "close": "19:00"},
    "wednesday": {"open": "07:00", "close": "19:00"},
    "thursday": {"open": "07:00", "close": "19:00"},
    "friday": {"open": "06:30", "close": "19:30"},
    "saturday": {"open": "06:00", "close": "19:30"},
    "sunday": {"open": "06:00", "close": "19:30"}
}', 'Daily open/close times'),

(1, 'pricing', '{
    "weekday": {
        "daytime": {"label": "Open - 12:59 PM", "18_holes": 47.79},
        "pre_twilight": {"label": "1:00 PM - 2:59 PM", "18_holes": 44.25},
        "twilight": {"label": "3:00 PM - Close", "18_holes": 39.82, "9_holes": 30.97}
    },
    "weekend": {
        "daytime": {"label": "Open - 2:59 PM", "18_holes": 57.52},
        "twilight": {"label": "3:00 PM - Close", "18_holes": 48.67, "9_holes": 48.67}
    },
    "carts": {
        "18_holes_half": 21.24,
        "twilight": 12.39,
        "pull_cart": 5.31,
        "single_cart_surcharge": 10.00
    },
    "notes": "All prices subject to HST. Prices subject to change. 9-hole rates only at select times."
}', 'Green fees and cart pricing'),

(1, 'course_info', '{
    "name": "Valleymede Columbus Golf Course",
    "address": "3622 Simcoe Street North, Oshawa, ON L1H 0R5",
    "phone_local": "(905) 655-6300",
    "phone_tollfree": "1-866-717-0990",
    "email": "info@valleymedecolumbusgolf.com",
    "website": "valleymedecolumbusgolf.com",
    "holes": 18,
    "style": "British Links-style",
    "acres": 150,
    "yards": 6200,
    "description": "A beautiful 18-hole British Links-style golf course on 150 acres with open meadows, mature trees, and long natural grass mounds. Ideal for golfers of all skill levels.",
    "directions": "Approximately 15 minutes north of Highway 401, convenient access near Highway 407. Located on Simcoe Street North in Oshawa.",
    "signature_holes": [
        {"hole": 3, "description": "Features a stunning island green"},
        {"hole": 17, "description": "Elevated 200-yard par 3 tee surrounded by water and bunkers"}
    ]
}', 'General course information'),

(1, 'policies', '{
    "min_age": 10,
    "max_booking_size": 8,
    "max_players_per_group": 4,
    "cart_max_riders": 2,
    "cart_license_required": "G2 or higher",
    "cart_waiver_required": true,
    "no_outside_alcohol": true,
    "pull_carts_limited": true,
    "club_rentals_limited": true,
    "walk_ins": "Limited availability, pre-booking strongly recommended",
    "pairing_policy": "Golfers will be paired as needed",
    "cart_rules": [
        "Maximum 2 golfers per cart",
        "Drivers must have valid G2 license or higher",
        "All cart riders must sign waiver before play",
        "Carts prohibited on long grass areas and steep mounds",
        "Carts cannot cross white lines in front of greens",
        "Carts must stay on paths on holes 9 and 17",
        "No carts in parking area"
    ]
}', 'Course policies and rules'),

(1, 'memberships', '{
    "status": "SOLD OUT for 2026",
    "waitlist": true,
    "waitlist_email": "info@valleymedecolumbusgolf.com",
    "types": [
        {"name": "Full Membership", "price": 2900, "note": "with HST"},
        {"name": "Senior Full Membership", "price": 2700, "note": "with HST"}
    ],
    "benefits": "Golf access 7 days per week. Power carts NOT included.",
    "note": "Contact info@valleymedecolumbusgolf.com to join waitlist"
}', 'Membership information'),

(1, 'tournaments', '{
    "capacity_min": 24,
    "capacity_max": 144,
    "services": [
        "Power carts available",
        "Chipping and putting greens",
        "Registration table setup",
        "Licensed beverage cart service",
        "Closest to the Pin and Longest Drive markers",
        "Putting contest board",
        "Patio seating arrangement"
    ],
    "booking_info": "Contact directly with: contact person name, phone number, number of participants, preferred date, desired start time, and any additional details.",
    "note": "Tournament packages and pricing quoted individually"
}', 'Tournament and group outing info'),

(1, 'amenities', '{
    "facilities": [
        "Professional clubhouse",
        "Pro-shop",
        "Patio area",
        "Chipping and putting greens",
        "Fleet of new golf carts (2026)",
        "Beverage cart service"
    ],
    "rentals": {
        "pull_carts": "Limited, first-come first-serve",
        "club_rentals": "Limited, first-come first-serve",
        "single_rider_cart": "$10 additional fee"
    }
}', 'Facilities and amenities'),

(1, 'transfer_number', '"+19056556300"', 'Phone number to transfer calls to when human is needed'),

(1, 'notifications', '{
    "email_enabled": true,
    "sms_enabled": true,
    "email_to": "info@valleymedecolumbusgolf.com",
    "sms_to": "+19056556300"
}', 'How to notify staff of new bookings'),

(1, 'ai_personality', '{
    "name": "AI Assistant",
    "style": "Friendly, warm, natural. Sound like a real person who works at the course and loves golf. Keep it conversational, not robotic.",
    "language": "English primary. Switch to French if caller requests or speaks French.",
    "weather_behavior": "Only provide weather if asked. But if the conversation is going great and the weather is nice, feel free to mention it naturally like: You are in for a great day, looks like sunshine and 25 out there!",
    "booking_limit": 8,
    "after_hours_message": "Our staff isn''t available right now, but I can absolutely help you with bookings, course info, or anything else you need!"
}', 'AI voice agent personality and behavior settings'),

(1, 'announcements', '[]', 'Active announcements the AI should mention. Example: [{"message": "Course closed April 15 for maintenance", "active": true}]'),

(1, 'test_mode', '{
    "enabled": false,
    "test_phone": ""
}', 'Test phone number configuration'),

(1, 'booking_settings', '{"require_credit_card": false}', 'Booking behavior settings (credit card requirement, etc.)')

ON CONFLICT (business_id, key) DO NOTHING;

-- ----- Valleymede default greetings -----------------------
-- Greetings seed only runs when the greetings table is empty for this tenant.
INSERT INTO greetings (business_id, message, for_known_caller, active)
SELECT 1, message, for_known_caller, TRUE FROM (VALUES
    ('Hey there! Thanks for calling Valleymede Columbus Golf Course. What can I do for you today?', FALSE),
    ('Good day! You''ve reached Valleymede Columbus Golf Course. How can I help you out?',         FALSE),
    ('Hi! Welcome to Valleymede Columbus Golf Course. What can I help you with?',                  FALSE),
    ('Thanks for calling Valleymede Columbus! What''s on your mind today?',                        FALSE),
    ('Hey! Valleymede Columbus Golf Course here. How can I help?',                                 FALSE),
    ('Hello and welcome to Valleymede Columbus Golf Course! What can I do for you?',               FALSE),
    ('Hi there! You''ve reached Valleymede Columbus. Ready to book a tee time or is there something else I can help with?', FALSE),
    ('Good to hear from you! Valleymede Columbus Golf Course. How can I help today?',              FALSE),
    ('Hey {name}! Good to hear from you again. What can I help you with?',                         TRUE),
    ('Hi {name}! Welcome back to Valleymede Columbus. What can I do for you today?',               TRUE),
    ('{name}! Great to hear from you. How can I help?',                                            TRUE),
    ('Hey {name}, thanks for calling back! What''s up?',                                           TRUE),
    ('Hi there {name}! Calling about a tee time or something else I can help with?',               TRUE)
) AS v(message, for_known_caller)
WHERE NOT EXISTS (SELECT 1 FROM greetings WHERE business_id = 1);

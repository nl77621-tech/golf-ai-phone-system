-- ============================================
-- Seed Data: Valleymede Columbus Golf Course
-- ============================================

-- Business Hours (default)
INSERT INTO settings (key, value, description) VALUES
('business_hours', '{
    "monday": {"open": "07:00", "close": "19:00"},
    "tuesday": {"open": "07:00", "close": "19:00"},
    "wednesday": {"open": "07:00", "close": "19:00"},
    "thursday": {"open": "07:00", "close": "19:00"},
    "friday": {"open": "06:30", "close": "19:30"},
    "saturday": {"open": "06:00", "close": "19:30"},
    "sunday": {"open": "06:00", "close": "19:30"}
}', 'Daily open/close times'),

-- Pricing
('pricing', '{
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

-- Course Info
('course_info', '{
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

-- Policies
('policies', '{
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

-- Memberships
('memberships', '{
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

-- Tournaments
('tournaments', '{
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

-- Amenities
('amenities', '{
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

-- Staff transfer number (configure in Command Center)
('transfer_number', '"+19056556300"', 'Phone number to transfer calls to when human is needed'),

-- Notification settings
('notifications', '{
    "email_enabled": true,
    "sms_enabled": true,
    "email_to": "info@valleymedecolumbusgolf.com",
    "sms_to": "+19056556300"
}', 'How to notify staff of new bookings'),

-- AI personality settings
('ai_personality', '{
    "name": "AI Assistant",
    "style": "Friendly, warm, natural. Sound like a real person who works at the course and loves golf. Keep it conversational, not robotic.",
    "language": "English primary. Switch to French if caller requests or speaks French.",
    "weather_behavior": "Only provide weather if asked. But if the conversation is going great and the weather is nice, feel free to mention it naturally like: You are in for a great day, looks like sunshine and 25 out there!",
    "booking_limit": 8,
    "after_hours_message": "Our staff isn't available right now, but I can absolutely help you with bookings, course info, or anything else you need!"
}', 'AI voice agent personality and behavior settings'),

-- Announcements (empty by default)
('announcements', '[]', 'Active announcements the AI should mention. Example: [{"message": "Course closed April 15 for maintenance", "active": true}]'),

-- Test mode
('test_mode', '{
    "enabled": false,
    "test_phone": ""
}', 'Test phone number configuration')

ON CONFLICT (key) DO NOTHING;

-- Default greetings for unknown callers
INSERT INTO greetings (message, for_known_caller, active) VALUES
('Hey there! Thanks for calling Valleymede Columbus Golf Course. What can I do for you today?', false, true),
('Good day! You''ve reached Valleymede Columbus Golf Course. How can I help you out?', false, true),
('Hi! Welcome to Valleymede Columbus Golf Course. What can I help you with?', false, true),
('Thanks for calling Valleymede Columbus! What''s on your mind today?', false, true),
('Hey! Valleymede Columbus Golf Course here. How can I help?', false, true),
('Hello and welcome to Valleymede Columbus Golf Course! What can I do for you?', false, true),
('Hi there! You''ve reached Valleymede Columbus. Ready to book a tee time or is there something else I can help with?', false, true),
('Good to hear from you! Valleymede Columbus Golf Course. How can I help today?', false, true);

-- Default greetings for known callers (name gets injected)
INSERT INTO greetings (message, for_known_caller, active) VALUES
('Hey {name}! Good to hear from you again. What can I help you with?', true, true),
('Hi {name}! Welcome back to Valleymede Columbus. What can I do for you today?', true, true),
('{name}! Great to hear from you. How can I help?', true, true),
('Hey {name}, thanks for calling back! What''s up?', true, true),
('Hi there {name}! Calling about a tee time or something else I can help with?', true, true);

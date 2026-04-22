/**
 * Phone Lookup Service
 * Uses Twilio Lookup v2 API to detect line type (mobile, landline, VoIP)
 * so we know whether SMS will work for a given number.
 *
 * Cost: ~$0.03 per lookup (Twilio Line Type Intelligence)
 * Results are cached in the customers table to avoid repeat lookups.
 */
const { query, getSetting } = require('../config/database');
require('dotenv').config();

/**
 * Look up line type for a phone number using Twilio Lookup v2
 * Returns: 'mobile', 'landline', 'voip', 'unknown', or null on error
 */
async function lookupLineType(phone) {
  if (!phone) return null;
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[PhoneLookup] Twilio not configured — skipping lookup');
    return null;
  }

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    // Normalize phone to E.164
    let normalized = String(phone).replace(/[^+\d]/g, '');
    if (!normalized.startsWith('+')) {
      if (normalized.length === 10) normalized = '+1' + normalized;
      else if (normalized.length === 11 && normalized.startsWith('1')) normalized = '+' + normalized;
    }

    // Twilio Lookup v2 with Line Type Intelligence
    const result = await twilio.lookups.v2.phoneNumbers(normalized)
      .fetch({ fields: 'line_type_intelligence' });

    const lineType = result.lineTypeIntelligence?.type || 'unknown';
    console.log(`[PhoneLookup] ${normalized} → ${lineType}`);
    return lineType;
  } catch (err) {
    console.error(`[PhoneLookup] Lookup failed for ${phone}:`, err.message);
    return null;
  }
}

/**
 * Get the line type for a customer, using cached value if available.
 * If not cached, performs a live lookup and stores the result.
 */
async function getLineType(phone, customerId) {
  if (!phone) return null;

  // Check if we already have a cached line_type for this customer
  if (customerId) {
    try {
      const cached = await query('SELECT line_type FROM customers WHERE id = $1', [customerId]);
      if (cached.rows[0]?.line_type) {
        return cached.rows[0].line_type;
      }
    } catch (err) {
      // Column might not exist yet — continue to lookup
    }
  }

  // Perform live lookup
  const lineType = await lookupLineType(phone);

  // Cache result on customer record
  if (lineType && customerId) {
    try {
      await query('UPDATE customers SET line_type = $1 WHERE id = $2', [lineType, customerId]);
    } catch (err) {
      // Column might not exist yet — not critical
      console.warn('[PhoneLookup] Could not cache line_type:', err.message);
    }
  }

  return lineType;
}

/**
 * Check if a phone number can receive SMS
 */
function isSmsCapable(lineType) {
  if (!lineType) return true; // If we don't know, assume yes
  return lineType !== 'landline'; // mobile, voip, fixedVoip can usually receive SMS
}

module.exports = { lookupLineType, getLineType, isSmsCapable };

/**
 * Phone Lookup Service — tenant-scoped cache.
 *
 * The live Twilio Lookup call itself is tenant-agnostic (the line type of
 * +1‑416‑555‑1234 is the same regardless of which business is asking), but
 * the CACHE lives on a customer row — and customer rows are scoped by
 * business_id. So any read/write against customers.line_type MUST include
 * the tenant id.
 */
const { query } = require('../config/database');
const { requireBusinessId } = require('../context/tenant-context');
require('dotenv').config();

/**
 * Look up line type for a phone number using Twilio Lookup v2.
 * Returns 'mobile' | 'landline' | 'voip' | 'fixedVoip' | 'unknown' | null.
 *
 * Tenant-agnostic — no businessId needed.
 */
async function lookupLineType(phone) {
  if (!phone) return null;
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[PhoneLookup] Twilio not configured — skipping lookup');
    return null;
  }

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    let normalized = String(phone).replace(/[^+\d]/g, '');
    if (!normalized.startsWith('+')) {
      if (normalized.length === 10) normalized = '+1' + normalized;
      else if (normalized.length === 11 && normalized.startsWith('1')) normalized = '+' + normalized;
    }

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
 * Get the line type for a customer, using the tenant's cached value if
 * available. Looks up the `customers` row scoped by (business_id, id) so we
 * can never read another tenant's cached value.
 */
async function getLineType(businessId, phone, customerId) {
  requireBusinessId(businessId, 'getLineType');
  if (!phone) return null;

  // Check cache first (tenant-scoped)
  if (customerId) {
    try {
      const cached = await query(
        'SELECT line_type FROM customers WHERE id = $1 AND business_id = $2',
        [customerId, businessId]
      );
      if (cached.rows[0]?.line_type) {
        return cached.rows[0].line_type;
      }
    } catch (err) {
      // Column might not exist yet — continue to live lookup
    }
  }

  // Perform live lookup
  const lineType = await lookupLineType(phone);

  // Cache back onto the tenant's customer row
  if (lineType && customerId) {
    try {
      await query(
        'UPDATE customers SET line_type = $1 WHERE id = $2 AND business_id = $3',
        [lineType, customerId, businessId]
      );
    } catch (err) {
      console.warn(`[tenant:${businessId}] Could not cache line_type:`, err.message);
    }
  }

  return lineType;
}

/**
 * Check if a phone number can receive SMS based on a known line type.
 * Returns true when the line type is unknown — defensive default so we
 * don't silently drop SMS for customers whose line type wasn't looked up.
 */
function isSmsCapable(lineType) {
  if (!lineType) return true;
  return lineType !== 'landline';
}

module.exports = { lookupLineType, getLineType, isSmsCapable };

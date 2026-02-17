import crypto from 'crypto';
import twilio from 'twilio';

const { validateRequest } = twilio;

/**
 * Validate Twilio webhook signature
 */
export function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = process.env.WEBHOOK_URL + req.originalUrl;

  if (!signature) {
    return false;
  }

  return validateRequest(authToken, signature, url, req.body);
}

/**
 * Sanitize phone number to E.164 format
 */
export function sanitizePhoneNumber(phone) {
  if (!phone) return null;

  // Remove all non-digit characters except leading +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Ensure it starts with +
  if (!cleaned.startsWith('+')) {
    // Assume North American if 10 digits
    if (cleaned.length === 10) {
      cleaned = '+1' + cleaned;
    } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
      cleaned = '+' + cleaned;
    }
  }

  return cleaned;
}

/**
 * Extract client name from message if mentioned
 */
export function extractClientName(body) {
  // Simple patterns like "This is Sarah" or "My name is John"
  // Prefix is case-insensitive but name must start with uppercase letter
  const patterns = [
    /(?:[Tt]his is|[Mm]y name is|[Ii]'m|[Ii] am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /^([A-Z][a-z]+)\s+here/
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Validate internal API key for read-only access
 */
export function validateApiKey(req) {
  const expected = process.env.SMS_READ_API_KEY;
  const provided = req.headers['x-api-key'];

  if (!expected || !provided) {
    return false;
  }

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

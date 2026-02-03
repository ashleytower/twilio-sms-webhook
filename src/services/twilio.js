import Twilio from 'twilio';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('twilio');

const client = new Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

/**
 * Send an SMS message via Twilio
 */
export async function sendSMS(to, body) {
  try {
    const message = await client.messages.create({
      body,
      from: FROM_NUMBER,
      to,
      statusCallback: process.env.WEBHOOK_URL + '/status'
    });

    logger.info({ sid: message.sid, to }, 'SMS sent successfully');
    return { success: true, sid: message.sid };
  } catch (error) {
    logger.error({ error, to }, 'Failed to send SMS');
    return { success: false, error: error.message };
  }
}

/**
 * Parse incoming Twilio webhook body
 */
export function parseIncomingMessage(body) {
  return {
    messageSid: body.MessageSid,
    from: body.From,
    to: body.To,
    body: body.Body,
    numMedia: parseInt(body.NumMedia || '0', 10),
    mediaUrls: parseMediaUrls(body)
  };
}

/**
 * Extract media URLs from Twilio webhook
 */
function parseMediaUrls(body) {
  const numMedia = parseInt(body.NumMedia || '0', 10);
  if (numMedia === 0) return null;

  const urls = [];
  for (let i = 0; i < numMedia; i++) {
    const url = body[`MediaUrl${i}`];
    const contentType = body[`MediaContentType${i}`];
    if (url) {
      urls.push({ url, contentType });
    }
  }

  return urls.length > 0 ? urls : null;
}

/**
 * Generate empty TwiML response
 */
export function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

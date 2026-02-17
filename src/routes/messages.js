import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { sanitizePhoneNumber, validateApiKey } from '../utils/validation.js';
import { searchMessages } from '../services/supabase.js';

const router = Router();
const logger = createLogger('messages');

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const rateLimits = new Map();

function getRequestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function isRateLimited(key) {
  const now = Date.now();
  const existing = rateLimits.get(key);

  if (!existing || now > existing.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  existing.count += 1;
  if (existing.count > RATE_LIMIT_MAX) {
    return true;
  }

  rateLimits.set(key, existing);
  return false;
}

function isAllowedIp(ip) {
  const allowList = process.env.SMS_READ_ALLOWLIST;
  if (!allowList) return true;
  const allowed = allowList
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  return allowed.includes(ip);
}

router.get('/search', async (req, res) => {
  try {
    if (!process.env.SMS_READ_API_KEY) {
      logger.error('SMS_READ_API_KEY is not set');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const requestIp = getRequestIp(req);

    if (!isAllowedIp(requestIp)) {
      logger.warn({ ip: requestIp }, 'IP not allowed for SMS search');
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (isRateLimited(requestIp)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    if (!validateApiKey(req)) {
      logger.warn({ ip: requestIp }, 'Unauthorized SMS search');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rawPhone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    const rawSince = typeof req.query.since === 'string' ? req.query.since.trim() : '';
    const rawDirection = typeof req.query.direction === 'string' ? req.query.direction.trim() : '';
    const rawLimit = typeof req.query.limit === 'string' ? req.query.limit.trim() : '';

    const phone = rawPhone ? sanitizePhoneNumber(rawPhone) : '';
    const direction = rawDirection === 'inbound' || rawDirection === 'outbound' ? rawDirection : undefined;
    const limit = Math.min(Math.max(parseInt(rawLimit || '20', 10) || 20, 1), 50);
    const since = rawSince && !Number.isNaN(Date.parse(rawSince)) ? rawSince : undefined;

    if (!rawQuery && !phone) {
      return res.status(400).json({ error: 'Missing search query or phone number' });
    }

    const { messages, error } = await searchMessages({
      query: rawQuery,
      phone,
      direction,
      limit,
      since,
    });

    if (error) {
      logger.error({ error }, 'SMS search failed');
      return res.status(500).json({ error: 'Search failed' });
    }

    const payload = messages.map(message => ({
      id: message.id,
      conversationId: message.conversation_id,
      phoneNumber: message.sms_conversations?.phone_number || null,
      clientName: message.sms_conversations?.client_name || null,
      direction: message.direction,
      body: message.body || message.draft_body || '',
      status: message.status,
      createdAt: message.created_at,
    }));

    res.set('Cache-Control', 'no-store');
    return res.json({ count: payload.length, messages: payload });
  } catch (error) {
    logger.error({ error }, 'Unhandled SMS search error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

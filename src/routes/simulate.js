import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { validateApiKey } from '../utils/validation.js';
import { processIncomingMessage } from '../services/smsProcessor.js';

const router = Router();
const logger = createLogger('simulate');

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30;
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

router.post('/', async (req, res) => {
  try {
    if (!process.env.SMS_READ_API_KEY) {
      logger.error('SMS_READ_API_KEY is not set');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const requestIp = getRequestIp(req);

    if (!isAllowedIp(requestIp)) {
      logger.warn({ ip: requestIp }, 'IP not allowed for simulation');
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (isRateLimited(requestIp)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    if (!validateApiKey(req)) {
      logger.warn({ ip: requestIp }, 'Unauthorized simulation');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }
    }

    const { from, text, body: messageBody, sendApproval } = body || {};
    const messageText = messageBody || text;

    if (!from || !messageText) {
      return res.status(400).json({ error: 'Missing required fields: from, body' });
    }

    const message = {
      from,
      body: messageText,
      messageSid: `sim_${Date.now()}`,
      mediaUrls: [],
    };

    const result = await processIncomingMessage(message, {
      sendApproval: Boolean(sendApproval),
    });

    return res.status(200).json({ success: true, result });
  } catch (error) {
    logger.error({ error }, 'Simulation failed');
    return res.status(500).json({ error: 'Simulation failed' });
  }
});

export default router;

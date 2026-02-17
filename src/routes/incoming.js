import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { validateTwilioSignature } from '../utils/validation.js';
import { parseIncomingMessage, emptyTwiml } from '../services/twilio.js';
import { processIncomingMessage } from '../services/smsProcessor.js';

const router = Router();
const logger = createLogger('incoming');

router.post('/', async (req, res) => {
  // Always respond with TwiML to avoid Twilio retries
  res.type('text/xml');

  try {
    // Validate Twilio signature in production
    if (process.env.NODE_ENV === 'production') {
      if (!validateTwilioSignature(req)) {
        logger.warn({ headers: req.headers }, 'Invalid Twilio signature');
        return res.status(403).send(emptyTwiml());
      }
    }

    // Parse the incoming message
    const message = parseIncomingMessage(req.body);
    logger.info({
      from: message.from,
      body: message.body.substring(0, 50)
    }, 'Received SMS');

    // Process asynchronously - respond to Twilio immediately
    res.send(emptyTwiml());

    // Continue processing in background
    await processIncomingMessage(message);

  } catch (error) {
    logger.error({ error }, 'Error processing incoming SMS');
    res.send(emptyTwiml());
  }
});

export default router;

import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { validateTwilioSignature } from '../utils/validation.js';
import { emptyTwiml } from '../services/twilio.js';

const router = Router();
const logger = createLogger('status');

router.post('/', async (req, res) => {
  res.type('text/xml');

  try {
    // Validate Twilio signature in production
    if (process.env.NODE_ENV === 'production') {
      if (!validateTwilioSignature(req)) {
        logger.warn('Invalid Twilio signature on status callback');
        return res.status(403).send(emptyTwiml());
      }
    }

    const { MessageSid, MessageStatus, To, ErrorCode } = req.body;

    logger.info({
      sid: MessageSid,
      status: MessageStatus,
      to: To,
      error: ErrorCode
    }, 'Delivery status update');

    // Log failures for debugging
    if (MessageStatus === 'failed' || MessageStatus === 'undelivered') {
      logger.error({
        sid: MessageSid,
        to: To,
        errorCode: ErrorCode
      }, 'SMS delivery failed');
    }

    res.send(emptyTwiml());

  } catch (error) {
    logger.error({ error }, 'Error processing status callback');
    res.send(emptyTwiml());
  }
});

export default router;

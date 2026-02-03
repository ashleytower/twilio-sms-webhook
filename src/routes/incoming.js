import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { validateTwilioSignature, sanitizePhoneNumber, extractClientName } from '../utils/validation.js';
import { parseIncomingMessage, emptyTwiml } from '../services/twilio.js';
import { getOrCreateConversation, storeIncomingMessage, storeDraftReply, getConversationHistory } from '../services/supabase.js';
import { searchClientContext, getBusinessContext } from '../services/mem0.js';
import { getCalendarContext } from '../services/calendar.js';
import { generateDraftReply } from '../services/claude.js';
import { sendApprovalRequest } from '../services/telegram.js';

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

/**
 * Process incoming message asynchronously
 */
async function processIncomingMessage(message) {
  try {
    const phoneNumber = sanitizePhoneNumber(message.from);
    const clientName = extractClientName(message.body);

    // Get or create conversation
    const conversation = await getOrCreateConversation(phoneNumber, clientName);

    // Store incoming message
    await storeIncomingMessage(
      conversation.id,
      message.messageSid,
      message.body,
      message.mediaUrls
    );

    // Gather context in parallel
    const [
      clientContext,
      businessContext,
      calendarContext,
      history
    ] = await Promise.all([
      searchClientContext(message.body, phoneNumber),
      getBusinessContext(),
      getCalendarContext(message.body),
      getConversationHistory(conversation.id)
    ]);

    // Generate draft reply
    const draftReply = await generateDraftReply({
      incomingMessage: message.body,
      clientName: conversation.client_name || clientName,
      businessContext: clientContext ? `${businessContext}\n\nClient notes:\n${clientContext}` : businessContext,
      conversationHistory: history,
      calendarContext
    });

    // Store draft
    const draftMessage = await storeDraftReply(conversation.id, draftReply);

    // Send to Telegram for approval
    await sendApprovalRequest({
      messageId: draftMessage.id,
      phoneNumber,
      clientName: conversation.client_name || clientName,
      incomingBody: message.body,
      calendarContext,
      draftReply
    });

    logger.info({
      conversationId: conversation.id,
      draftId: draftMessage.id
    }, 'SMS processed, awaiting approval');

  } catch (error) {
    logger.error({ error }, 'Failed to process incoming message');
  }
}

export default router;

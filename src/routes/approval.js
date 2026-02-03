import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { getMessage, approveMessage, rejectMessage, markMessageSent } from '../services/supabase.js';
import { sendSMS } from '../services/twilio.js';
import { answerCallback, updateMessage, sendMessage } from '../services/telegram.js';

const router = Router();
const logger = createLogger('approval');

// Store for pending edits (messageId -> true)
const pendingEdits = new Map();

router.post('/', async (req, res) => {
  try {
    const update = req.body;

    // Handle callback queries (button presses)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return res.json({ ok: true });
    }

    // Handle text messages (edited replies)
    if (update.message?.text) {
      await handleTextMessage(update.message);
      return res.json({ ok: true });
    }

    res.json({ ok: true });

  } catch (error) {
    logger.error({ error }, 'Error processing Telegram webhook');
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Handle inline button presses
 */
async function handleCallbackQuery(callbackQuery) {
  const { id: callbackId, data, message: telegramMessage } = callbackQuery;
  const [action, messageId] = data.split(':');

  logger.info({ action, messageId }, 'Callback received');

  // Acknowledge the callback immediately
  await answerCallback(callbackId);

  switch (action) {
    case 'approve':
      await handleApprove(messageId, telegramMessage);
      break;
    case 'edit':
      await handleEdit(messageId, telegramMessage);
      break;
    case 'reject':
      await handleReject(messageId, telegramMessage);
      break;
    default:
      logger.warn({ action }, 'Unknown callback action');
  }
}

/**
 * Handle approve button
 */
async function handleApprove(messageId, telegramMessage) {
  const dbMessage = await getMessage(messageId);
  if (!dbMessage) {
    logger.error({ messageId }, 'Message not found');
    return;
  }

  const conversation = dbMessage.sms_conversations;
  if (!conversation) {
    logger.error({ messageId }, 'Conversation not found');
    return;
  }

  // Approve and get final body
  const approved = await approveMessage(messageId);

  // Send SMS
  const result = await sendSMS(conversation.phone_number, approved.body);

  if (result.success) {
    await markMessageSent(messageId, result.sid);
    await updateMessage(
      telegramMessage.message_id,
      `Sent to ${conversation.phone_number}:\n"${approved.body}"`
    );
    logger.info({ messageId, to: conversation.phone_number }, 'SMS approved and sent');
  } else {
    await updateMessage(
      telegramMessage.message_id,
      `Failed to send SMS: ${result.error}`
    );
    logger.error({ messageId, error: result.error }, 'SMS send failed');
  }
}

/**
 * Handle edit button - prompts for new text
 */
async function handleEdit(messageId, telegramMessage) {
  pendingEdits.set(messageId, {
    telegramMessageId: telegramMessage.message_id,
    timestamp: Date.now()
  });

  await updateMessage(
    telegramMessage.message_id,
    'Reply with your edited message text:'
  );

  // Clean up old pending edits after 10 minutes
  setTimeout(() => pendingEdits.delete(messageId), 10 * 60 * 1000);
}

/**
 * Handle text messages (for edited replies)
 */
async function handleTextMessage(message) {
  // Check if any edits are pending
  for (const [messageId, editInfo] of pendingEdits.entries()) {
    // Only process if recent (within 10 minutes)
    if (Date.now() - editInfo.timestamp < 10 * 60 * 1000) {
      const editedText = message.text;

      // Get the original message
      const dbMessage = await getMessage(messageId);
      if (!dbMessage) continue;

      const conversation = dbMessage.sms_conversations;
      if (!conversation) continue;

      // Approve with edited text
      const approved = await approveMessage(messageId, editedText);

      // Send SMS
      const result = await sendSMS(conversation.phone_number, editedText);

      if (result.success) {
        await markMessageSent(messageId, result.sid);
        await sendMessage(
          `Sent edited message to ${conversation.phone_number}:\n"${editedText}"`
        );
      } else {
        await sendMessage(`Failed to send: ${result.error}`);
      }

      pendingEdits.delete(messageId);
      logger.info({ messageId, edited: true }, 'Edited SMS sent');
      return;
    }
  }

  // No pending edit found - might be a regular message
  logger.debug({ text: message.text?.substring(0, 50) }, 'Text message received (no pending edit)');
}

/**
 * Handle reject button
 */
async function handleReject(messageId, telegramMessage) {
  await rejectMessage(messageId);
  await updateMessage(
    telegramMessage.message_id,
    'Message rejected (not sent)'
  );
  logger.info({ messageId }, 'SMS rejected');
}

export default router;

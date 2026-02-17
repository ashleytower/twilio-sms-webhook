import { createLogger } from '../utils/logger.js';
import { sanitizePhoneNumber, extractClientName } from '../utils/validation.js';
import { getOrCreateConversation, storeIncomingMessage, storeDraftReply, getConversationHistory, checkMessageExists, approveMessage } from './supabase.js';
import { searchClientContext, getBusinessContext } from './mem0.js';
import { getCalendarContext } from './calendar.js';
import { generateDraftReply } from './claude.js';
import { sendApprovalRequest } from './telegram.js';
import { evaluateMenuChange, sendInboundSms } from './mtlApi.js';
import { setPendingAction } from './pendingActions.js';
import { getRelevantCorrections } from './corrections.js';

const logger = createLogger('sms-processor');

export async function processIncomingMessage(message, options = {}) {
  try {
    const phoneNumber = sanitizePhoneNumber(message.from);
    const clientName = extractClientName(message.body);

    const conversation = await getOrCreateConversation(phoneNumber, clientName);

    // Deduplicate: skip if this messageSid was already processed (Twilio webhook retry)
    if (message.messageSid) {
      const existing = await checkMessageExists(message.messageSid);
      if (existing) {
        logger.info({ messageSid: message.messageSid }, 'Duplicate message skipped');
        return { success: true, duplicate: true };
      }
    }

    await storeIncomingMessage(
      conversation.id,
      message.messageSid,
      message.body,
      message.mediaUrls
    );

    try {
      const inboundResult = await sendInboundSms({
        from: message.from,
        to: message.to,
        body: message.body,
        provider: 'twilio',
        providerMessageId: message.messageSid,
        direction: 'inbound',
        status: 'received',
        receivedAt: new Date().toISOString(),
        data: {
          numMedia: message.numMedia,
          mediaUrls: message.mediaUrls,
        },
      });

      if (!inboundResult.ok) {
        logger.warn({ error: inboundResult.error }, 'MTL inbound SMS sync failed');
      }
    } catch (error) {
      logger.warn({ error }, 'MTL inbound SMS sync errored');
    }

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

    const actionResult = await evaluateMenuChange({
      phone: phoneNumber,
      message: message.body,
    });

    const actionContext = buildActionContext(actionResult);

    const correctionRules = await getRelevantCorrections(message.body).catch(err => {
      logger.warn({ err }, 'Failed to get correction rules');
      return [];
    });

    const draftReply = await generateDraftReply({
      incomingMessage: message.body,
      clientName: conversation.client_name || clientName,
      businessContext: clientContext ? `${businessContext}\n\nClient notes:\n${clientContext}` : businessContext,
      conversationHistory: history,
      calendarContext,
      actionContext,
      correctionRules
    });

    const draftMessage = await storeDraftReply(conversation.id, draftReply);

    if (actionResult.ok && actionResult.data?.status === 'ready' && actionResult.data?.action) {
      const actionType = actionResult.data.action;
      const oldDisplay = actionResult.data.oldCocktailDisplay || actionResult.data.oldCocktail;
      const newDisplay = actionResult.data.newCocktailDisplay || actionResult.data.newCocktail;
      const payload = {
        action: actionType,
        phone: phoneNumber,
        eventId: actionResult.data.eventId,
        oldCocktail: oldDisplay,
        newCocktail: newDisplay,
        addCocktail: newDisplay,
        removeCocktail: oldDisplay,
      };

      setPendingAction(draftMessage.id, {
        type: actionType,
        payload,
        summary: actionResult.data.summary || 'Menu update',
      });
    }

    const shouldSendApproval = options.sendApproval !== false && canSendApproval();
    let approvalSent = false;
    if (shouldSendApproval) {
      const telegramResult = await sendApprovalRequest({
        messageId: draftMessage.id,
        phoneNumber,
        clientName: conversation.client_name || clientName,
        incomingBody: message.body,
        calendarContext,
        draftReply,
        actionSummary: actionResult.data?.summary || actionResult.data?.message,
        actionStatus: actionResult.data?.status,
      });

      if (telegramResult) {
        approvalSent = true;
      } else {
        // Telegram notification failed -- auto-approve so the message isn't stuck in pending_approval
        logger.warn({ draftId: draftMessage.id }, 'Telegram notification failed, auto-approving draft');
        await approveMessage(draftMessage.id, draftReply);
      }
    }

    logger.info({
      conversationId: conversation.id,
      draftId: draftMessage.id,
      approvalSent
    }, 'SMS processed');

    return {
      success: true,
      draftId: draftMessage.id,
      draftReply,
      approvalSent,
      action: actionResult.data?.action,
      actionStatus: actionResult.data?.status,
      actionSummary: actionResult.data?.summary,
      actionMessage: actionResult.data?.message,
    };
  } catch (error) {
    logger.error({ error }, 'Failed to process incoming message');
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function buildActionContext(actionResult) {
  if (!actionResult?.ok || !actionResult.data) return '';

  const { status, action, summary, message, options } = actionResult.data;

  if (status === 'ready' && action) {
    return `Action available: ${summary}. If approved, confirm the change in your reply.`;
  }

  if (status === 'ambiguous' && Array.isArray(options) && options.length > 0) {
    const optionList = options
      .map((opt) => `${opt.clientName}${opt.eventDate ? ` (${opt.eventDate})` : ''}`)
      .join(', ');
    return `Need clarification: multiple events match. Ask which one: ${optionList}.`;
  }

  if (status === 'not_found') {
    return `No matching event found. Ask which event this refers to.`;
  }

  if (status === 'no_action') {
    return '';
  }

  if (message) {
    return `Note: ${message}`;
  }

  return '';
}

function canSendApproval() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';
import { getMessage, approveMessage, rejectMessage, markMessageSent } from '../services/supabase.js';
import { sendSMS } from '../services/twilio.js';
import { answerCallback, updateMessage, sendMessage } from '../services/telegram.js';
import { applyMenuChange, sendInboundSms } from '../services/mtlApi.js';
import { getPendingAction, clearPendingAction } from '../services/pendingActions.js';
import { storeCorrection } from '../services/corrections.js';

const router = Router();
const logger = createLogger('approval');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Webhook auth middleware: verify Telegram secret token if configured
// Only applies to the POST / (Telegram webhook) route, not the web approval routes.
function telegramAuth(req, res, next) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return next();

  const headerToken = req.headers['x-telegram-bot-api-secret-token'];
  if (headerToken !== secret) {
    logger.warn('Telegram webhook auth failed');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.post('/', telegramAuth, async (req, res) => {
  try {
    const update = req.body;

    // Handle callback queries (button presses)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return res.json({ ok: true });
    }

    res.json({ ok: true });

  } catch (error) {
    logger.error({ error }, 'Error processing Telegram webhook');
    res.status(500).json({ error: 'Internal error' });
  }
});

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
    case 'reject':
      await handleReject(messageId, telegramMessage);
      break;
    default:
      logger.warn({ action }, 'Unknown callback action');
  }
}

async function getLastInboundContext(conversationId) {
  if (!conversationId) return undefined;
  try {
    const { data } = await supabase
      .from('sms_messages')
      .select('body')
      .eq('conversation_id', conversationId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.body || undefined;
  } catch (err) {
    logger.warn({ err, conversationId }, 'Failed to look up inbound context');
    return undefined;
  }
}

async function sendApprovedSms(messageId, body, telegramMessageId, isEdit) {
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

  const approved = await approveMessage(messageId, isEdit ? body : undefined);
  const finalBody = isEdit ? body : approved.body;

  const actionResult = await executePendingAction(messageId);
  if (actionResult.status === 'failed') {
    if (isEdit || !telegramMessageId) {
      await sendMessage(`Failed to apply action: ${actionResult.error}`);
    } else {
      await updateMessage(telegramMessageId, `Failed to apply action: ${actionResult.error}`);
    }
    return;
  }

  const result = await sendSMS(conversation.phone_number, finalBody);

  const actionNote = actionResult.status === 'applied'
    ? `\n\n✅ ${actionResult.summary}`
    : '';

  if (result.success) {
    await syncOutboundSms({
      to: conversation.phone_number,
      body: finalBody,
      status: 'sent',
      providerMessageId: result.sid,
      sourceMessageId: messageId,
    });
    await markMessageSent(messageId, result.sid);

    const label = isEdit ? 'Sent edited message to' : 'Sent to';
    if (isEdit || !telegramMessageId) {
      await sendMessage(`${label} ${conversation.phone_number}:\n"${finalBody}"${actionNote}`);
    } else {
      await updateMessage(telegramMessageId, `${label} ${conversation.phone_number}:\n"${finalBody}"${actionNote}`);
    }
    logger.info({ messageId, to: conversation.phone_number, edited: !!isEdit }, 'SMS approved and sent');
  } else {
    await syncOutboundSms({
      to: conversation.phone_number,
      body: finalBody,
      status: 'failed',
      error: result.error,
      sourceMessageId: messageId,
    });
    if (isEdit || !telegramMessageId) {
      await sendMessage(`Failed to send: ${result.error}`);
    } else {
      await updateMessage(telegramMessageId, `Failed to send SMS: ${result.error}`);
    }
    logger.error({ messageId, error: result.error }, 'SMS send failed');
  }
}

async function handleApprove(messageId, telegramMessage) {
  await sendApprovedSms(messageId, null, telegramMessage.message_id, false);
}

async function handleReject(messageId, telegramMessage) {
  const dbMessage = await getMessage(messageId);
  await rejectMessage(messageId);
  clearPendingAction(messageId);
  if (dbMessage) {
    const incomingContext = await getLastInboundContext(dbMessage.conversation_id);
    storeCorrection({
      channel: 'sms',
      action: 'reject',
      incomingContext,
      incomingFrom: dbMessage.sms_conversations?.phone_number,
      originalDraft: dbMessage.draft_body,
      sourceRecordId: messageId,
      sourceTable: 'sms_messages',
      metadata: { client_name: dbMessage.sms_conversations?.client_name }
    }).catch(err => logger.warn({ err }, 'Correction storage failed'));
  }
  await updateMessage(
    telegramMessage.message_id,
    'Message rejected (not sent)'
  );
  logger.info({ messageId }, 'SMS rejected');
}

// ---------------------------------------------------------------------------
// Web approval routes (GET/POST /:messageId)
// These are NOT behind Telegram auth -- they are accessed via browser links.
// ---------------------------------------------------------------------------

function renderPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
background:#1a1a2e;color:#e0e0e0;padding:16px;min-height:100vh}
.container{max-width:600px;margin:0 auto}
h1{font-size:1.3rem;margin-bottom:12px;color:#fff}
h2{font-size:1.1rem;margin:16px 0 8px;color:#ccc}
.label{font-size:0.8rem;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:4px}
.value{font-size:1rem;margin-bottom:16px;color:#e0e0e0}
blockquote{border-left:3px solid #444;padding:8px 12px;margin:8px 0 16px;
background:#16213e;border-radius:4px;font-style:italic;white-space:pre-wrap}
textarea{width:100%;min-height:140px;padding:12px;border:1px solid #444;border-radius:8px;
background:#16213e;color:#e0e0e0;font-family:inherit;font-size:1rem;resize:vertical}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
button{border:none;border-radius:8px;padding:14px 20px;font-size:1rem;font-weight:600;
cursor:pointer;color:#fff;min-height:44px;transition:opacity 0.2s}
button:active{opacity:0.8}
.btn-approve{background:#4CAF50}
.btn-edit{background:#2196F3}
.btn-reject{background:#f44336}
.status-box{text-align:center;padding:40px 20px;border-radius:12px;margin-top:20px}
.status-ok{background:#1b5e20}
.status-warn{background:#e65100}
.status-err{background:#b71c1c}
.context-box{background:#16213e;border-radius:8px;padding:12px;margin-bottom:16px;font-size:0.9rem}
.context-box .heading{color:#90caf9;font-weight:600;margin-bottom:4px}
</style>
</head><body><div class="container">${bodyHtml}</div></body></html>`;
}

router.get('/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const dbMessage = await getMessage(messageId);

    if (!dbMessage) {
      return res.status(404).send(renderPage('Not Found',
        '<div class="status-box status-warn"><h1>Message Not Found</h1><p>This approval link is invalid or the message has been deleted.</p></div>'));
    }

    const status = dbMessage.status;
    if (status === 'sent' || status === 'rejected' || status === 'approved') {
      const label = status === 'sent' ? 'Already Sent' : status === 'approved' ? 'Already Approved' : 'Already Rejected';
      const cls = status === 'sent' || status === 'approved' ? 'status-ok' : 'status-warn';
      return res.send(renderPage(label,
        `<div class="status-box ${cls}"><h1>${label}</h1><p>This message has already been ${status}.</p></div>`));
    }

    const conversation = dbMessage.sms_conversations || {};
    const phone = conversation.phone_number || 'Unknown';
    const clientName = conversation.client_name || '';

    // Get last inbound message for context
    let inboundBody = '';
    try {
      inboundBody = await getLastInboundContext(dbMessage.conversation_id) || '';
    } catch (_) { /* best effort */ }

    const draft = dbMessage.draft_body || '';
    const metadata = dbMessage.metadata || {};
    const calendarContext = metadata.calendar_context || '';
    const actionSummary = metadata.action_summary || metadata.pending_action_summary || '';

    let contextHtml = '';
    if (calendarContext) {
      contextHtml += `<div class="context-box"><div class="heading">Calendar</div>${escapeHtml(calendarContext)}</div>`;
    }
    if (actionSummary) {
      contextHtml += `<div class="context-box"><div class="heading">Pending Action</div>${escapeHtml(actionSummary)}</div>`;
    }

    const bodyHtml = `
<h1>SMS Approval</h1>
<div class="label">From</div>
<div class="value">${escapeHtml(phone)}${clientName ? ' &mdash; ' + escapeHtml(clientName) : ''}</div>
${inboundBody ? `<div class="label">Their Message</div><blockquote>${escapeHtml(inboundBody)}</blockquote>` : ''}
${contextHtml}
<form method="POST" action="">
  <div class="label">Draft Reply</div>
  <textarea name="editedBody">${escapeHtml(draft)}</textarea>
  <div class="actions">
    <button type="submit" name="action" value="approve" class="btn-approve">Approve &amp; Send</button>
    <button type="submit" name="action" value="edit" class="btn-edit">Send Edited Text</button>
    <button type="submit" name="action" value="reject" class="btn-reject">Reject</button>
  </div>
</form>`;

    res.send(renderPage('SMS Approval', bodyHtml));
  } catch (error) {
    logger.error({ error, messageId: req.params.messageId }, 'Error rendering approval page');
    res.status(500).send(renderPage('Error',
      '<div class="status-box status-err"><h1>Something went wrong</h1><p>Could not load the approval page. Please try again or use Telegram.</p></div>'));
  }
});

router.post('/:messageId', async (req, res) => {
  const { messageId } = req.params;
  try {
    const { action, editedBody } = req.body || {};

    const dbMessage = await getMessage(messageId);
    if (!dbMessage) {
      return res.status(404).send(renderPage('Not Found',
        '<div class="status-box status-warn"><h1>Message Not Found</h1><p>This message no longer exists.</p></div>'));
    }

    if (dbMessage.status === 'sent' || dbMessage.status === 'rejected' || dbMessage.status === 'approved') {
      const label = dbMessage.status === 'sent' ? 'Already Sent' : dbMessage.status === 'approved' ? 'Already Approved' : 'Already Rejected';
      return res.send(renderPage(label,
        `<div class="status-box status-warn"><h1>${label}</h1><p>This message was already ${dbMessage.status}. No action taken.</p></div>`));
    }

    const conversation = dbMessage.sms_conversations || {};

    if (action === 'approve') {
      await sendApprovedSms(messageId, null, null, false);
      logger.info({ messageId }, 'Web approval: approved');
      return res.send(renderPage('Sent',
        `<div class="status-box status-ok"><h1>Message Sent</h1><p>SMS sent to ${escapeHtml(conversation.phone_number || '')}.</p></div>`));
    }

    if (action === 'edit') {
      const finalBody = (editedBody || '').trim();
      if (!finalBody) {
        return res.status(400).send(renderPage('Error',
          '<div class="status-box status-warn"><h1>Empty Message</h1><p>Cannot send an empty message. Go back and enter text.</p></div>'));
      }

      // Store correction for learning
      const incomingContext = await getLastInboundContext(dbMessage.conversation_id);
      storeCorrection({
        channel: 'sms',
        action: 'edit',
        incomingContext,
        incomingFrom: conversation.phone_number,
        originalDraft: dbMessage.draft_body,
        correctedText: finalBody,
        sourceRecordId: messageId,
        sourceTable: 'sms_messages',
        metadata: { client_name: conversation.client_name, conversation_id: dbMessage.conversation_id }
      }).catch(err => logger.warn({ err }, 'Correction storage failed (web edit)'));

      await sendApprovedSms(messageId, finalBody, null, true);
      logger.info({ messageId }, 'Web approval: edited and sent');
      return res.send(renderPage('Sent (Edited)',
        `<div class="status-box status-ok"><h1>Edited Message Sent</h1><p>SMS sent to ${escapeHtml(conversation.phone_number || '')}.</p></div>`));
    }

    if (action === 'reject') {
      const incomingContext = await getLastInboundContext(dbMessage.conversation_id);
      await rejectMessage(messageId);
      clearPendingAction(messageId);

      storeCorrection({
        channel: 'sms',
        action: 'reject',
        incomingContext,
        incomingFrom: conversation.phone_number,
        originalDraft: dbMessage.draft_body,
        sourceRecordId: messageId,
        sourceTable: 'sms_messages',
        metadata: { client_name: conversation.client_name }
      }).catch(err => logger.warn({ err }, 'Correction storage failed (web reject)'));

      logger.info({ messageId }, 'Web approval: rejected');
      return res.send(renderPage('Rejected',
        '<div class="status-box status-warn"><h1>Message Rejected</h1><p>The draft was rejected and will not be sent.</p></div>'));
    }

    // Unknown action
    return res.status(400).send(renderPage('Invalid Action',
      '<div class="status-box status-err"><h1>Invalid Action</h1><p>Unrecognized form action.</p></div>'));

  } catch (error) {
    logger.error({ error, messageId }, 'Error processing web approval action');
    res.status(500).send(renderPage('Error',
      '<div class="status-box status-err"><h1>Something went wrong</h1><p>The action could not be completed. Please try again or use Telegram.</p></div>'));
  }
});

export default router;

async function executePendingAction(messageId) {
  const pending = getPendingAction(messageId);
  if (!pending) return { status: 'none' };

  if (pending.type === 'update_menu' || pending.type === 'add_menu' || pending.type === 'remove_menu') {
    const result = await applyMenuChange(pending.payload);
    if (!result.ok || result.data?.status !== 'applied') {
      return { status: 'failed', error: result.error || result.data?.error || 'Menu update failed' };
    }

    clearPendingAction(messageId);
    return { status: 'applied', summary: result.data?.summary || pending.summary };
  }

  clearPendingAction(messageId);
  return { status: 'none' };
}

async function syncOutboundSms({ to, body, status, providerMessageId, error, sourceMessageId }) {
  try {
    const fromNumber = process.env.TWILIO_PHONE_NUMBER || '';
    const result = await sendInboundSms({
      from: fromNumber,
      to,
      body,
      provider: 'twilio',
      providerMessageId,
      direction: 'outbound',
      status,
      receivedAt: new Date().toISOString(),
      data: {
        source: 'twilio-sms-skill',
        sourceMessageId,
        error,
      },
    });

    if (!result.ok) {
      logger.warn({ error: result.error }, 'MTL outbound SMS sync failed');
    }
  } catch (syncError) {
    logger.warn({ error: syncError }, 'MTL outbound SMS sync errored');
  }
}

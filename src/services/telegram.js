import { createLogger } from '../utils/logger.js';

const logger = createLogger('telegram');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send approval request to Telegram with web link (no webhook needed)
 * This avoids conflicts with OpenClaw's Telegram long-polling
 */
export async function sendApprovalRequest(params) {
  const {
    messageId,
    phoneNumber,
    clientName,
    incomingBody,
    calendarContext,
    draftReply
  } = params;

  // Get the webhook URL base for approval links
  const webhookUrl = process.env.WEBHOOK_URL || 'https://twilio-sms-production-b6b8.up.railway.app';
  const approvalUrl = `${webhookUrl}/approval/${messageId}`;

  // Format the approval message with link
  const displayName = clientName || 'Unknown';
  const text = formatApprovalMessage({
    displayName,
    phoneNumber,
    incomingBody,
    calendarContext,
    draftReply,
    approvalUrl
  });

  // Use inline keyboard with URL button (no callback, just opens link)
  const keyboard = {
    inline_keyboard: [
      [
        { text: '📝 Review & Approve', url: approvalUrl }
      ]
    ]
  };

  try {
    const response = await fetch(`${BASE_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        reply_markup: keyboard
      })
    });

    const data = await response.json();

    if (!data.ok) {
      logger.error({ error: data }, 'Telegram API error');
      return null;
    }

    logger.info({ messageId: data.result.message_id }, 'Approval request sent');
    return data.result.message_id;
  } catch (error) {
    logger.error({ error }, 'Failed to send Telegram message');
    return null;
  }
}

/**
 * Format the approval message for Telegram
 */
function formatApprovalMessage(params) {
  const { displayName, phoneNumber, incomingBody, calendarContext, draftReply, approvalUrl } = params;

  let text = `<b>📱 SMS from ${escapeHtml(displayName)}</b>\n`;
  text += `<code>${escapeHtml(phoneNumber)}</code>\n\n`;
  text += `<blockquote>${escapeHtml(incomingBody)}</blockquote>\n\n`;

  if (calendarContext) {
    text += `<b>📅 Calendar:</b>\n${escapeHtml(calendarContext)}\n\n`;
  }

  text += `<b>💬 Draft reply:</b>\n`;
  text += `<i>"${escapeHtml(draftReply)}"</i>\n\n`;
  text += `<a href="${approvalUrl}">Click to review, edit, or approve</a>`;

  return text;
}

/**
 * Update message after button press
 */
export async function updateMessage(telegramMessageId, text) {
  try {
    await fetch(`${BASE_URL}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        message_id: telegramMessageId,
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (error) {
    logger.error({ error }, 'Failed to update Telegram message');
  }
}

/**
 * Answer callback query (dismisses loading state)
 */
export async function answerCallback(callbackQueryId, text = '') {
  try {
    await fetch(`${BASE_URL}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text
      })
    });
  } catch (error) {
    logger.error({ error }, 'Failed to answer callback');
  }
}

/**
 * Send a simple message
 */
export async function sendMessage(text) {
  try {
    await fetch(`${BASE_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (error) {
    logger.error({ error }, 'Failed to send message');
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

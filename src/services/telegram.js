import { createLogger } from '../utils/logger.js';

const logger = createLogger('telegram');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Send approval request to Telegram with inline buttons
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

  // Format the approval message
  const displayName = clientName || 'Unknown';
  const text = formatApprovalMessage({
    displayName,
    phoneNumber,
    incomingBody,
    calendarContext,
    draftReply
  });

  // Create inline keyboard
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `approve:${messageId}` },
        { text: 'Edit', callback_data: `edit:${messageId}` },
        { text: 'Reject', callback_data: `reject:${messageId}` }
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
  const { displayName, phoneNumber, incomingBody, calendarContext, draftReply } = params;

  let text = `<b>SMS from ${escapeHtml(displayName)}</b>\n`;
  text += `(${escapeHtml(phoneNumber)})\n\n`;
  text += `<blockquote>${escapeHtml(incomingBody)}</blockquote>\n\n`;

  if (calendarContext) {
    text += `<b>Calendar:</b>\n${escapeHtml(calendarContext)}\n\n`;
  }

  text += `<b>Draft reply:</b>\n`;
  text += `<i>"${escapeHtml(draftReply)}"</i>`;

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

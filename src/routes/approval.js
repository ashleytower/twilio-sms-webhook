import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { getMessage, approveMessage, rejectMessage, markMessageSent } from '../services/supabase.js';
import { sendSMS } from '../services/twilio.js';
import { sendMessage } from '../services/telegram.js';

const router = Router();
const logger = createLogger('approval');

/**
 * Web-based approval page - GET shows the form, POST processes the action
 * This avoids Telegram webhook conflicts with OpenClaw
 */

// Show approval page
router.get('/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const dbMessage = await getMessage(messageId);

    if (!dbMessage) {
      return res.status(404).send(renderPage('Message not found', '<p>This message does not exist or has already been processed.</p>'));
    }

    if (dbMessage.status !== 'draft') {
      return res.send(renderPage('Already Processed', `<p>This message was already ${dbMessage.status}.</p>`));
    }

    const conversation = dbMessage.sms_conversations;
    const html = renderApprovalForm(messageId, dbMessage, conversation);
    res.send(html);

  } catch (error) {
    logger.error({ error }, 'Error loading approval page');
    res.status(500).send(renderPage('Error', '<p>Something went wrong. Please try again.</p>'));
  }
});

// Process approval action
router.post('/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    const { action, editedText } = req.body;

    const dbMessage = await getMessage(messageId);
    if (!dbMessage) {
      return res.status(404).send(renderPage('Not Found', '<p>Message not found.</p>'));
    }

    if (dbMessage.status !== 'draft') {
      return res.send(renderPage('Already Processed', `<p>This message was already ${dbMessage.status}.</p>`));
    }

    const conversation = dbMessage.sms_conversations;
    if (!conversation) {
      return res.status(400).send(renderPage('Error', '<p>Conversation not found.</p>'));
    }

    switch (action) {
      case 'approve': {
        const finalText = editedText?.trim() || dbMessage.body;
        await approveMessage(messageId, finalText);
        const result = await sendSMS(conversation.phone_number, finalText);

        if (result.success) {
          await markMessageSent(messageId, result.sid);
          await sendMessage(`✅ SMS sent to ${conversation.phone_number}:\n"${finalText}"`);
          logger.info({ messageId, to: conversation.phone_number }, 'SMS approved and sent');
          return res.send(renderPage('Sent!', `<p>Message sent to ${conversation.phone_number}</p><p>"${escapeHtml(finalText)}"</p>`));
        } else {
          logger.error({ messageId, error: result.error }, 'SMS send failed');
          return res.send(renderPage('Send Failed', `<p>Error: ${escapeHtml(result.error)}</p>`));
        }
      }

      case 'reject': {
        await rejectMessage(messageId);
        await sendMessage(`❌ SMS rejected (not sent to ${conversation.phone_number})`);
        logger.info({ messageId }, 'SMS rejected');
        return res.send(renderPage('Rejected', '<p>Message was not sent.</p>'));
      }

      default:
        return res.status(400).send(renderPage('Error', '<p>Invalid action.</p>'));
    }

  } catch (error) {
    logger.error({ error }, 'Error processing approval');
    res.status(500).send(renderPage('Error', '<p>Something went wrong. Please try again.</p>'));
  }
});

/**
 * Render the approval form
 */
function renderApprovalForm(messageId, message, conversation) {
  const clientName = conversation?.client_name || 'Unknown';
  const phoneNumber = conversation?.phone_number || 'Unknown';

  return renderPage('Approve SMS', `
    <div class="card">
      <h2>SMS from ${escapeHtml(clientName)}</h2>
      <p class="phone">${escapeHtml(phoneNumber)}</p>

      <div class="incoming">
        <label>Incoming message:</label>
        <blockquote>${escapeHtml(message.incoming_body || 'N/A')}</blockquote>
      </div>

      <form method="POST" action="/approval/${messageId}">
        <div class="draft">
          <label for="editedText">Draft reply (edit if needed):</label>
          <textarea name="editedText" id="editedText" rows="4">${escapeHtml(message.body)}</textarea>
        </div>

        <div class="buttons">
          <button type="submit" name="action" value="approve" class="approve">Send SMS</button>
          <button type="submit" name="action" value="reject" class="reject">Reject</button>
        </div>
      </form>
    </div>
  `);
}

/**
 * Render a page with consistent styling
 */
function renderPage(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - SMS Approval</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 500px;
      margin: 0 auto;
    }
    h1 { color: #fff; margin-bottom: 20px; }
    .card {
      background: #16213e;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    }
    h2 { margin: 0 0 8px 0; color: #fff; }
    .phone { color: #888; margin: 0 0 20px 0; }
    label { display: block; color: #888; margin-bottom: 8px; font-size: 14px; }
    blockquote {
      background: #0f3460;
      border-left: 3px solid #e94560;
      margin: 0 0 20px 0;
      padding: 12px 16px;
      border-radius: 0 8px 8px 0;
    }
    textarea {
      width: 100%;
      padding: 12px;
      border: 1px solid #333;
      border-radius: 8px;
      background: #0f3460;
      color: #fff;
      font-size: 16px;
      resize: vertical;
    }
    textarea:focus { outline: 2px solid #e94560; border-color: transparent; }
    .buttons {
      display: flex;
      gap: 12px;
      margin-top: 20px;
    }
    button {
      flex: 1;
      padding: 14px 20px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.1s, opacity 0.1s;
    }
    button:active { transform: scale(0.98); }
    .approve { background: #00d26a; color: #000; }
    .approve:hover { background: #00b85c; }
    .reject { background: #e94560; color: #fff; }
    .reject:hover { background: #d13a54; }
    .draft { margin-bottom: 0; }
    p { line-height: 1.6; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(title)}</h1>
    ${content}
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default router;

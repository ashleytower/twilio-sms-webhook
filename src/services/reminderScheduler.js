import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';
import { sendMessage } from './telegram.js';

const logger = createLogger('reminderScheduler');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_USER_ID = process.env.USER_ID || '3ed111ff-c28f-4cda-b987-1afa4f7eb081';

let intervalId = null;
let vapiKeyWarned = false;

/**
 * Start the reminder checker - runs every 60 seconds
 * Returns the interval ID
 */
export function startReminderChecker() {
  if (intervalId) {
    logger.warn('Reminder checker already running');
    return intervalId;
  }

  logger.info('Starting reminder checker (60s interval)');

  // Run immediate check
  checkReminders().catch(err =>
    logger.error({ err }, 'Initial reminder check failed')
  );

  // Set up interval
  intervalId = setInterval(() => {
    checkReminders().catch(err =>
      logger.error({ err }, 'Reminder check failed')
    );
  }, 60_000);

  return intervalId;
}

/**
 * Check for due reminders and trigger phone calls
 */
export async function checkReminders() {
  try {
    // Guard: skip if required env vars are missing
    if (!process.env.VAPI_API_KEY || !process.env.ASHLEY_PHONE_NUMBER) {
      if (!vapiKeyWarned) {
        logger.warn('VAPI_API_KEY or ASHLEY_PHONE_NUMBER not configured, skipping reminder checks');
        vapiKeyWarned = true;
      }
      return;
    }

    // Query for due reminders
    const { data: dueReminders, error: queryError } = await supabase
      .from('reminders')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .order('scheduled_for', { ascending: true });

    if (queryError) {
      logger.error({ error: queryError }, 'Failed to query reminders');
      return;
    }

    if (!dueReminders || dueReminders.length === 0) {
      return; // No reminders due
    }

    logger.info({ count: dueReminders.length }, 'Found due reminders');

    // Process each due reminder
    for (const reminder of dueReminders) {
      await processReminder(reminder);
    }
  } catch (error) {
    logger.error({ error }, 'Error in checkReminders');
  }
}

/**
 * Process a single reminder
 */
async function processReminder(reminder) {
  const { id, message } = reminder;

  try {
    // Optimistic lock: only claim if still pending
    const { data: claimed, error: updateError } = await supabase
      .from('reminders')
      .update({ status: 'calling' })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .single();

    if (updateError || !claimed) {
      logger.info({ id }, 'Reminder already being processed, skipping');
      return;
    }

    // Create natural first message
    const firstMessage = `Hey Ashley, just a heads up — ${message}.`;

    // Call Vapi API
    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: process.env.VAPI_ASSISTANT_ID,
        assistantOverrides: {
          firstMessage,
          model: {
            provider: 'anthropic',
            model: 'claude-3-7-sonnet-20250219',
            messages: [{
              role: 'system',
              content: `You are Max, Ashley's AI employee at MTL Craft Cocktails. You just called Ashley to deliver a reminder: "${message}". That was your first message. If Ashley wants to chat, ask questions, or discuss anything — emails, tasks, business — be helpful and natural. You're her assistant, not just a reminder bot. Keep your tone casual and genuine.`
            }]
          }
        },
        customer: {
          number: process.env.ASHLEY_PHONE_NUMBER
        },
        phoneNumberId: '8da70eaa-17e4-4e9d-ad53-d070833edd8b'
      })
    });

    const responseData = await response.json();

    if (response.ok && responseData.id) {
      // Success: mark as completed
      await supabase
        .from('reminders')
        .update({
          status: 'completed',
          vapi_call_id: responseData.id,
          completed_at: new Date().toISOString()
        })
        .eq('id', id);

      await sendMessage(`📞 Reminder call placed: ${message}`);
      logger.info({ id, vapiCallId: responseData.id }, 'Reminder call placed successfully');
    } else {
      // Failure: increment retry count
      await handleReminderFailure(reminder, responseData);
    }
  } catch (error) {
    logger.error({ error, id }, 'Failed to process reminder');
    await handleReminderFailure(reminder, { error: error.message });
  }
}

/**
 * Handle reminder failure with retry logic
 */
async function handleReminderFailure(reminder, errorData) {
  const { id, message, retry_count = 0 } = reminder;
  const newRetryCount = retry_count + 1;

  logger.error({ id, retry_count: newRetryCount, errorData }, 'Reminder call failed');

  if (newRetryCount >= 3) {
    // Max retries reached: mark as failed
    await supabase
      .from('reminders')
      .update({
        status: 'failed',
        retry_count: newRetryCount
      })
      .eq('id', id);

    await sendMessage(`⚠️ Reminder call failed after 3 attempts: ${message}`);
    logger.warn({ id, message }, 'Reminder marked as failed after max retries');
  } else {
    // Keep as pending for retry
    await supabase
      .from('reminders')
      .update({
        status: 'pending',
        retry_count: newRetryCount
      })
      .eq('id', id);

    logger.info({ id, retry_count: newRetryCount }, 'Reminder will retry next cycle');
  }
}

/**
 * Create a new reminder
 * @param {string} message - Reminder message
 * @param {string} scheduledFor - ISO timestamp
 * @returns {Promise<object>} Created reminder row
 */
export async function createReminder(message, scheduledFor) {
  const { data, error } = await supabase
    .from('reminders')
    .insert({
      user_id: DEFAULT_USER_ID,
      message,
      scheduled_for: scheduledFor,
      status: 'pending',
      retry_count: 0
    })
    .select()
    .single();

  if (error) {
    logger.error({ error }, 'Failed to create reminder');
    throw error;
  }

  logger.info({ id: data.id, scheduledFor }, 'Reminder created');
  return data;
}

/**
 * List all pending reminders ordered by scheduled_for
 * @returns {Promise<Array>} Pending reminders
 */
export async function listPendingReminders() {
  const { data, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('status', 'pending')
    .order('scheduled_for', { ascending: true });

  if (error) {
    logger.error({ error }, 'Failed to list pending reminders');
    return [];
  }

  return data || [];
}

/**
 * Cancel a reminder by ID
 * @param {string} id - Reminder ID
 * @returns {Promise<object|null>} Updated reminder or null
 */
export async function cancelReminder(id) {
  const { data, error } = await supabase
    .from('reminders')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .single();

  if (error) {
    logger.error({ error, id }, 'Failed to cancel reminder');
    return null;
  }

  logger.info({ id }, 'Reminder cancelled');
  return data;
}

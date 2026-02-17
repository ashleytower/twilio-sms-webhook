import { Router } from 'express';
import { createLogger } from '../utils/logger.js';
import { validateApiKey } from '../utils/validation.js';
import { createReminder, listPendingReminders, cancelReminder } from '../services/reminderScheduler.js';

const router = Router();
const logger = createLogger('reminders');

/**
 * POST / - Create a reminder
 * Body: { message: string, scheduled_for: string (ISO 8601) }
 */
router.post('/', async (req, res) => {
  try {
    if (!validateApiKey(req)) {
      logger.warn('Unauthorized reminder creation attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { message, scheduled_for } = req.body;

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required and must be a non-empty string' });
    }

    // Validate scheduled_for
    if (!scheduled_for || typeof scheduled_for !== 'string') {
      return res.status(400).json({ error: 'scheduled_for is required and must be an ISO 8601 datetime string' });
    }

    const scheduledDate = new Date(scheduled_for);
    if (isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ error: 'scheduled_for must be a valid ISO 8601 datetime' });
    }

    // Ensure scheduled_for is in the future
    if (scheduledDate <= new Date()) {
      return res.status(400).json({ error: 'scheduled_for must be in the future' });
    }

    // Limit message length
    if (message.trim().length > 500) {
      return res.status(400).json({ error: 'Message must be 500 characters or fewer' });
    }

    const reminder = await createReminder(message.trim(), scheduledDate);

    logger.info({ reminderId: reminder.id, scheduledFor: scheduled_for }, 'Reminder created');
    return res.status(201).json(reminder);
  } catch (error) {
    logger.error({ error, body: req.body }, 'Failed to create reminder');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET / - List pending reminders
 */
router.get('/', async (req, res) => {
  try {
    if (!validateApiKey(req)) {
      logger.warn('Unauthorized reminder list attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const reminders = await listPendingReminders();

    logger.info({ count: reminders.length }, 'Listed pending reminders');
    return res.status(200).json({ count: reminders.length, reminders });
  } catch (error) {
    logger.error({ error }, 'Failed to list reminders');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /:id - Cancel a reminder
 */
router.delete('/:id', async (req, res) => {
  try {
    if (!validateApiKey(req)) {
      logger.warn('Unauthorized reminder cancellation attempt');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: 'Invalid reminder ID format' });
    }

    const cancelledReminder = await cancelReminder(id);

    if (!cancelledReminder) {
      logger.warn({ reminderId: id }, 'Reminder not found');
      return res.status(404).json({ error: 'Reminder not found' });
    }

    logger.info({ reminderId: id }, 'Reminder cancelled');
    return res.status(200).json(cancelledReminder);
  } catch (error) {
    logger.error({ error, reminderId: req.params.id }, 'Failed to cancel reminder');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

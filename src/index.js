import express from 'express';
import { createLogger } from './utils/logger.js';
import incomingRouter from './routes/incoming.js';
import statusRouter from './routes/status.js';
import approvalRouter from './routes/approval.js';
import messagesRouter from './routes/messages.js';
import simulateRouter from './routes/simulate.js';
import voiceRouter from './routes/voice.js';
import remindersRouter from './routes/reminders.js';
import vapiToolsRouter from './routes/vapiTools.js';
import { reconcileUnpromotedRules } from './services/corrections.js';
import { startReminderChecker } from './services/reminderScheduler.js';

const logger = createLogger('server');
const app = express();

// Raw body for Twilio signature validation
app.use('/incoming', express.urlencoded({ extended: false }));
app.use('/status', express.urlencoded({ extended: false }));

// JSON for Telegram webhooks + URL-encoded for web approval form POST
app.use('/approval', express.json());
app.use('/approval', express.urlencoded({ extended: false }));
// JSON for simulation requests
app.use('/simulate', express.json());
// URL-encoded for Twilio voice webhook, JSON for mode endpoints
app.use('/voice', express.urlencoded({ extended: false }));
app.use('/voice/mode', express.json());
// JSON for reminder CRUD
app.use('/reminders', express.json());
// JSON for Vapi tool call webhooks
app.use('/vapi', express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/incoming', incomingRouter);
app.use('/status', statusRouter);
app.use('/approval', approvalRouter);
app.use('/messages', messagesRouter);
app.use('/simulate', simulateRouter);
app.use('/voice', voiceRouter);
app.use('/reminders', remindersRouter);
app.use('/vapi', vapiToolsRouter);

// Error handler
app.use((err, req, res, next) => {
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Twilio SMS server started');

  // Reconcile any unpromoted correction rules after startup settles
  setTimeout(() => {
    reconcileUnpromotedRules()
      .catch(err => logger.warn({ err }, 'Startup reconciliation failed'));
  }, 15000);

  // Start reminder checker after startup settles
  setTimeout(() => {
    startReminderChecker();
    logger.info('Reminder checker started');
  }, 10000);
});

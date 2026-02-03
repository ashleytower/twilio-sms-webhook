import express from 'express';
import { createLogger } from './utils/logger.js';
import incomingRouter from './routes/incoming.js';
import statusRouter from './routes/status.js';
import approvalRouter from './routes/approval.js';

const logger = createLogger('server');
const app = express();

// Raw body for Twilio signature validation
app.use('/incoming', express.urlencoded({ extended: false }));
app.use('/status', express.urlencoded({ extended: false }));

// JSON for Telegram webhooks
app.use('/approval', express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/incoming', incomingRouter);
app.use('/status', statusRouter);
app.use('/approval', approvalRouter);

// Error handler
app.use((err, req, res, next) => {
  logger.error({ err, path: req.path }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Twilio SMS server started');
});

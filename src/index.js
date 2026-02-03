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

// URL-encoded for web approval form
app.use('/approval', express.urlencoded({ extended: false }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Voice mode toggle (in-memory, resets on deploy)
let voiceMode = process.env.VOICE_MODE || 'forward'; // 'ai' or 'forward'

// Voice call handling with AI/forward toggle
app.all('/voice', (req, res) => {
  const forwardTo = process.env.FORWARD_TO_NUMBER || '+15146647557';
  const vapiAssistantId = process.env.VAPI_ASSISTANT_ID || '1427681a-7f23-46f9-9714-2f82c4b8c9fb';

  res.type('text/xml');

  if (voiceMode === 'ai') {
    // Route to Vapi AI assistant via SIP
    logger.info({ mode: 'ai', assistant: vapiAssistantId }, 'Routing call to Vapi');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>sip:${vapiAssistantId}@sip.vapi.ai</Sip>
  </Dial>
</Response>`);
  } else {
    // Direct forward to cell
    logger.info({ mode: 'forward', to: forwardTo }, 'Forwarding call');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Please hold while I connect you.</Say>
  <Dial callerId="+14382557557">${forwardTo}</Dial>
</Response>`);
  }
});

// Toggle voice mode via API
app.post('/voice/mode', express.json(), (req, res) => {
  const { mode } = req.body;
  if (mode === 'ai' || mode === 'forward') {
    voiceMode = mode;
    logger.info({ newMode: mode }, 'Voice mode changed');
    res.json({ success: true, mode: voiceMode });
  } else {
    res.status(400).json({ error: 'Invalid mode. Use "ai" or "forward"' });
  }
});

// Get current voice mode
app.get('/voice/mode', (req, res) => {
  res.json({ mode: voiceMode });
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

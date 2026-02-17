import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import Twilio from 'twilio';
import { createLogger } from '../utils/logger.js';

const router = Router();
const logger = createLogger('voice');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SETTINGS_KEY = 'voice_mode';
const DEFAULT_MODE = 'forward';

/**
 * Get voice mode from Supabase user_context table
 */
async function getVoiceMode() {
  const { data, error } = await supabase
    .from('user_context')
    .select('value')
    .eq('key', SETTINGS_KEY)
    .single();

  if (error || !data) {
    return DEFAULT_MODE;
  }

  return data.value || DEFAULT_MODE;
}

/**
 * Set voice mode in Supabase user_context table
 */
async function setVoiceMode(mode) {
  const { error } = await supabase
    .from('user_context')
    .upsert({ key: SETTINGS_KEY, value: mode }, { onConflict: 'key' });

  if (error) {
    logger.error({ error }, 'Failed to set voice mode');
    throw error;
  }
}

/**
 * GET /voice/mode - Check current voice mode
 */
router.get('/mode', async (req, res) => {
  try {
    const mode = await getVoiceMode();
    res.json({ mode });
  } catch (error) {
    logger.error({ error }, 'Error getting voice mode');
    res.status(500).json({ error: 'Failed to get voice mode' });
  }
});

/**
 * POST /voice/mode - Set voice mode ("ai" or "forward")
 */
router.post('/mode', async (req, res) => {
  try {
    const { mode } = req.body;

    if (!mode || !['ai', 'forward'].includes(mode)) {
      return res.status(400).json({ error: 'Mode must be "ai" or "forward"' });
    }

    await setVoiceMode(mode);
    logger.info({ mode }, 'Voice mode updated');
    res.json({ mode, updated: true });
  } catch (error) {
    logger.error({ error }, 'Error setting voice mode');
    res.status(500).json({ error: 'Failed to set voice mode' });
  }
});

/**
 * POST /voice/incoming - Twilio voice webhook
 * Routes calls based on current voice mode:
 *   forward -> dials ASHLEY_PHONE_NUMBER
 *   ai      -> dials VAPI_PHONE_NUMBER
 */
router.post('/', async (req, res) => {
  res.type('text/xml');

  try {
    const mode = await getVoiceMode();
    const twiml = new Twilio.twiml.VoiceResponse();

    logger.info({ mode, from: req.body?.From }, 'Incoming voice call');

    if (mode === 'ai') {
      const vapiNumber = process.env.VAPI_PHONE_NUMBER;
      if (!vapiNumber) {
        logger.error('VAPI_PHONE_NUMBER not configured');
        twiml.say('Sorry, the AI assistant is not available right now. Please try again later.');
        return res.send(twiml.toString());
      }
      twiml.dial(vapiNumber);
    } else {
      const ashleyNumber = process.env.ASHLEY_PHONE_NUMBER;
      if (!ashleyNumber) {
        logger.error('ASHLEY_PHONE_NUMBER not configured');
        twiml.say('Sorry, we are unable to connect your call right now. Please try again later.');
        return res.send(twiml.toString());
      }
      twiml.dial(ashleyNumber);
    }

    res.send(twiml.toString());
  } catch (error) {
    logger.error({ error }, 'Error handling incoming voice call');
    const twiml = new Twilio.twiml.VoiceResponse();
    twiml.say('Sorry, an error occurred. Please try again later.');
    res.send(twiml.toString());
  }
});

export default router;

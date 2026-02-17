import { createLogger } from '../utils/logger.js';

const logger = createLogger('mtl-api');

function getConfig() {
  const baseUrl = process.env.MTL_API_BASE_URL;
  const apiSecret = process.env.MTL_API_SECRET;
  return { baseUrl, apiSecret };
}

async function callMtlEndpoint(pathname, payload) {
  const { baseUrl, apiSecret } = getConfig();

  if (!baseUrl || !apiSecret) {
    return { ok: false, error: 'MTL API not configured' };
  }

  const endpoint = new URL(pathname, baseUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-app-source': apiSecret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: 'Invalid JSON response' };
      }
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: data?.error || 'MTL API error' };
    }

    return { ok: true, status: response.status, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MTL API error';
    logger.error({ error: message }, 'MTL API request failed');
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callMtlApi(payload) {
  return callMtlEndpoint('/api/sms/menu-update', payload);
}

export async function evaluateMenuChange({ phone, message, eventIdentifier }) {
  return callMtlApi({
    phone,
    message,
    eventIdentifier,
    dryRun: true,
  });
}

export async function applyMenuChange(actionPayload) {
  return callMtlApi({
    ...actionPayload,
    apply: true,
  });
}

export async function sendInboundSms(payload) {
  return callMtlEndpoint('/api/sms/inbound', payload);
}

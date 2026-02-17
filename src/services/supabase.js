import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('supabase');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_USER_ID = process.env.USER_ID || '3ed111ff-c28f-4cda-b987-1afa4f7eb081';

/**
 * Get or create conversation for a phone number
 */
export async function getOrCreateConversation(phoneNumber, clientName = null) {
  // Try to find existing conversation
  const { data: existing, error: findError } = await supabase
    .from('sms_conversations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single();

  if (existing) {
    // Update last message time and increment count
    const { data: updated, error: updateError } = await supabase
      .from('sms_conversations')
      .update({
        last_message_at: new Date().toISOString(),
        message_count: existing.message_count + 1,
        ...(clientName && !existing.client_name && { client_name: clientName })
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (updateError) {
      logger.error({ error: updateError }, 'Failed to update conversation');
    }

    const convo = updated || existing;

    // Resolve unified contact (fire-and-forget)
    resolveContact(phoneNumber, null, null, clientName, convo.id)
      .catch(err => logger.warn({ err }, 'Contact resolution failed'));

    return convo;
  }

  // Create new conversation
  const { data: newConvo, error: createError } = await supabase
    .from('sms_conversations')
    .insert({
      phone_number: phoneNumber,
      client_name: clientName,
      last_message_at: new Date().toISOString(),
      message_count: 1,
      status: 'active'
    })
    .select()
    .single();

  if (createError) {
    logger.error({ error: createError }, 'Failed to create conversation');
    throw createError;
  }

  // Resolve unified contact (fire-and-forget)
  resolveContact(phoneNumber, null, null, clientName, newConvo.id)
    .catch(err => logger.warn({ err }, 'Contact resolution failed'));

  logger.info({ phoneNumber, id: newConvo.id }, 'Created new conversation');
  return newConvo;
}

/**
 * Check if a message with this Twilio SID already exists (deduplication)
 */
export async function checkMessageExists(twilioSid) {
  const { data } = await supabase
    .from('sms_messages')
    .select('id')
    .eq('twilio_sid', twilioSid)
    .limit(1)
    .maybeSingle();

  return !!data;
}

/**
 * Store an incoming message
 */
export async function storeIncomingMessage(conversationId, twilioSid, body, mediaUrls = null) {
  const { data, error } = await supabase
    .from('sms_messages')
    .insert({
      conversation_id: conversationId,
      twilio_sid: twilioSid,
      direction: 'inbound',
      body,
      media_urls: mediaUrls,
      status: 'received'
    })
    .select()
    .single();

  if (error) {
    logger.error({ error }, 'Failed to store incoming message');
    throw error;
  }

  return data;
}

/**
 * Store a draft reply pending approval
 */
export async function storeDraftReply(conversationId, draftBody) {
  const { data, error } = await supabase
    .from('sms_messages')
    .insert({
      conversation_id: conversationId,
      direction: 'outbound',
      body: '',
      draft_body: draftBody,
      status: 'pending_approval'
    })
    .select()
    .single();

  if (error) {
    logger.error({ error }, 'Failed to store draft reply');
    throw error;
  }

  return data;
}

/**
 * Update message after approval
 */
export async function approveMessage(messageId, finalBody = null) {
  const { data: existing } = await supabase
    .from('sms_messages')
    .select('draft_body')
    .eq('id', messageId)
    .single();

  const body = finalBody || existing?.draft_body || '';

  const { data, error } = await supabase
    .from('sms_messages')
    .update({
      body,
      status: 'approved',
      approved_at: new Date().toISOString()
    })
    .eq('id', messageId)
    .select()
    .single();

  if (error) {
    logger.error({ error, messageId }, 'Failed to approve message');
    throw error;
  }

  return data;
}

/**
 * Mark message as sent
 */
export async function markMessageSent(messageId, twilioSid) {
  const { error } = await supabase
    .from('sms_messages')
    .update({
      twilio_sid: twilioSid,
      status: 'sent',
      sent_at: new Date().toISOString()
    })
    .eq('id', messageId);

  if (error) {
    logger.error({ error, messageId }, 'Failed to mark message sent');
  }
}

/**
 * Mark message as rejected
 */
export async function rejectMessage(messageId) {
  const { error } = await supabase
    .from('sms_messages')
    .update({ status: 'rejected' })
    .eq('id', messageId);

  if (error) {
    logger.error({ error, messageId }, 'Failed to reject message');
  }
}

/**
 * Get recent conversation history
 */
export async function getConversationHistory(conversationId, limit = 10) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .in('status', ['received', 'sent'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error }, 'Failed to get conversation history');
    return [];
  }

  return data.reverse();
}

/**
 * Get conversation by ID
 */
export async function getConversation(conversationId) {
  const { data, error } = await supabase
    .from('sms_conversations')
    .select('*')
    .eq('id', conversationId)
    .single();

  if (error) {
    logger.error({ error }, 'Failed to get conversation');
    return null;
  }

  return data;
}

/**
 * Get message by ID
 */
export async function getMessage(messageId) {
  const { data, error } = await supabase
    .from('sms_messages')
    .select('*, sms_conversations(*)')
    .eq('id', messageId)
    .single();

  if (error) {
    logger.error({ error }, 'Failed to get message');
    return null;
  }

  return data;
}

/**
 * Search messages for read-only access
 */
export async function searchMessages({ query, phone, direction, limit = 20, since }) {
  let builder = supabase
    .from('sms_messages')
    .select('id, conversation_id, direction, body, draft_body, status, created_at, sms_conversations(phone_number, client_name)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (since) {
    builder = builder.gte('created_at', since);
  }

  if (direction) {
    builder = builder.eq('direction', direction);
  }

  if (phone) {
    builder = builder.eq('sms_conversations.phone_number', phone);
  }

  if (query) {
    const safeQuery = query.replace(/,/g, ' ');
    builder = builder.or(
      `body.ilike.%${safeQuery}%,draft_body.ilike.%${safeQuery}%`
    );
  }

  const { data, error } = await builder;
  return { messages: data || [], error };
}

/**
 * Resolve or create a unified contact and link to a conversation.
 */
async function resolveContact(phone, email, instagram, name, conversationId) {
  const { data: contactId, error } = await supabase.rpc('resolve_contact', {
    p_user_id: DEFAULT_USER_ID,
    p_phone: phone || null,
    p_email: email || null,
    p_instagram: instagram || null,
    p_name: name || null,
    p_source: 'sms'
  });

  if (error) {
    logger.warn({ error }, 'resolve_contact RPC failed');
    return;
  }

  if (contactId && conversationId) {
    await supabase
      .from('sms_conversations')
      .update({ contact_id: contactId })
      .eq('id', conversationId);
  }

  logger.info({ contactId, conversationId }, 'Unified contact resolved');
}

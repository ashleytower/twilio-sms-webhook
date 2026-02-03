import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('supabase');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

    return updated || existing;
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

  logger.info({ phoneNumber, id: newConvo.id }, 'Created new conversation');
  return newConvo;
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

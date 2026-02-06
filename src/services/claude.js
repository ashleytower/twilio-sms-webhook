import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('claude');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Generate a draft reply to an SMS
 */
export async function generateDraftReply(params) {
  const {
    incomingMessage,
    clientName,
    businessContext,
    conversationHistory,
    calendarContext
  } = params;

  const detectedLanguage = detectLanguage(incomingMessage);
  const systemPrompt = buildSystemPrompt(businessContext, detectedLanguage);
  const userPrompt = buildUserPrompt({
    incomingMessage,
    clientName,
    conversationHistory,
    calendarContext
  });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const draft = response.content[0].text.trim();

    // Remove any quotation marks the model might add
    const cleaned = draft.replace(/^["']|["']$/g, '').trim();

    logger.info({ length: cleaned.length }, 'Generated draft reply');
    return cleaned;
  } catch (error) {
    logger.error({ error }, 'Failed to generate draft');
    return generateFallbackReply(incomingMessage);
  }
}

/**
 * Build system prompt for draft generation
 */
function buildSystemPrompt(businessContext, language) {
  const langDirective = language === 'fr'
    ? 'RESPOND ENTIRELY IN FRENCH. The client wrote in French.'
    : 'RESPOND ENTIRELY IN ENGLISH. The client wrote in English.';

  return `You are Max, a bilingual AI assistant for MTL Craft Cocktails, a mobile bartending service in Montreal.

Your task: Write a brief, friendly SMS reply to a client inquiry.

LANGUAGE: ${langDirective}

Guidelines:
- Keep it under 160 characters when possible (SMS length)
- Be warm, professional, and enthusiastic
- Default to "yes, we can help" unless clearly impossible
- If they ask about availability, say yes (the team rarely declines)
- Don't mention specific pricing unless they ask directly
- Use conversational tone, not corporate speak
- End with a clear next step or question when appropriate

Business context:
${businessContext}

Output only the SMS reply text, nothing else.`;
}

/**
 * Build user prompt with conversation context
 */
function buildUserPrompt(params) {
  const { incomingMessage, clientName, conversationHistory, calendarContext } = params;

  let prompt = '';

  if (conversationHistory && conversationHistory.length > 0) {
    prompt += 'Previous messages:\n';
    for (const msg of conversationHistory.slice(-5)) {
      const direction = msg.direction === 'inbound' ? 'Client' : 'Max';
      prompt += `${direction}: ${msg.body}\n`;
    }
    prompt += '\n';
  }

  if (calendarContext) {
    prompt += `Calendar info: ${calendarContext}\n\n`;
  }

  const name = clientName || 'Client';
  prompt += `New message from ${name}:\n"${incomingMessage}"\n\n`;
  prompt += 'Write a friendly SMS reply:';

  return prompt;
}

/**
 * Detect language from message text
 */
function detectLanguage(text) {
  const lower = text.toLowerCase();
  const frenchIndicators = /[àâéèêëïîôùûüç]|bonjour|salut|merci|bonsoir|s'il vous|svp|oui|est-ce que|je voudrais|nous cherchons|disponible|événement|fête|mariage|réservation|prix|tarif|soirée|cocktails? pour/;
  return frenchIndicators.test(lower) ? 'fr' : 'en';
}

/**
 * Generate fallback reply if Claude fails
 */
function generateFallbackReply(incomingMessage) {
  const lower = incomingMessage.toLowerCase();

  // Detect French
  const isFrench = /bonjour|salut|merci|prix|disponible|événement|fête|mariage|réservation/.test(lower);

  if (isFrench) {
    if (lower.includes('prix') || lower.includes('coût') || lower.includes('tarif')) {
      return "Merci de nous contacter! Nos forfaits varient selon l'événement. Pouvez-vous m'en dire plus?";
    }
    if (lower.includes('disponible') || lower.includes('réserv')) {
      return "Bonjour! Oui, on serait ravis de vous aider. C'est pour quelle date?";
    }
    return "Merci pour votre message! Je reviens vers vous sous peu.";
  }

  // English fallbacks
  if (lower.includes('price') || lower.includes('cost') || lower.includes('rate')) {
    return "Thanks for reaching out! Our packages vary by event size. Can you tell me more about what you're planning?";
  }

  if (lower.includes('available') || lower.includes('book')) {
    return "Hi! Yes, we'd love to help with your event. What date are you looking at?";
  }

  return "Thanks for your message! I'll get back to you shortly with more details.";
}

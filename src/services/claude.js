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
    calendarContext,
    actionContext,
    correctionRules
  } = params;

  // History includes the just-stored inbound message, so <= 1 means first contact.
  const isFirstMessage = !conversationHistory || conversationHistory.length <= 1;

  // First messages use a dedicated simple prompt to ensure template adherence.
  // Follow-ups use the full prompt with business context for natural conversation.
  if (isFirstMessage) {
    return generateFirstMessageReply(incomingMessage, clientName, correctionRules);
  }

  return generateFollowUpReply({
    incomingMessage,
    clientName,
    businessContext,
    conversationHistory,
    calendarContext,
    actionContext,
    correctionRules
  });
}

/**
 * Detect language of incoming message (French vs English)
 */
function detectLanguage(text) {
  if (!text) return 'en';
  const frenchPattern = /[àâéèêëïîôùûüç]|bonjour|salut|merci|disponible|prix|réserv|bonsoir|combien|cherche|fête|soirée|mariage|événement|personne|barman|cocktail pour/i;
  return frenchPattern.test(text) ? 'fr' : 'en';
}

/**
 * Detect inquiry type from message
 */
function detectInquiryType(text) {
  if (!text) return 'unknown';
  const lower = text.toLowerCase();
  if (/workshop|class|mixolog|team.?build|bachelorette.?activ|learn|cours|atelier|appren/i.test(lower)) {
    return 'workshop';
  }
  if (/event|wedding|party|bartend|bar\b|cocktail|hire|gala|reception|mariag|noce|réception|servic/i.test(lower)) {
    return 'bar_service';
  }
  return 'unknown';
}

/**
 * Generate first-message reply using templates.
 * No LLM needed -- the template is filled in programmatically.
 * Questions the client already answered are removed.
 */
function generateFirstMessageReply(incomingMessage, clientName) {
  const lang = detectLanguage(incomingMessage);
  const type = detectInquiryType(incomingMessage);
  const name = clientName || '';

  const template = getFirstMessageTemplate(type, lang, name, incomingMessage);
  logger.info({ type, lang, name: name || '(none)' }, 'Generated first-message draft from template');
  return template;
}

/**
 * Get the first-message template for a given inquiry type and language.
 * Removes questions the client already answered based on keyword matching.
 */
function getFirstMessageTemplate(type, lang, name, incomingMessage) {
  const greeting = name ? `Hey ${name},` : (lang === 'fr' ? 'Bonjour!' : 'Hey there,');
  const lower = (incomingMessage || '').toLowerCase();

  // Detect what info was already provided
  const hasDate = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b/i.test(lower) || /\d{1,2}[\/\-]\d{1,2}/i.test(lower);
  const hasGuestCount = /\b\d{1,4}\s*(guest|person|people|personne|invit)|(?:team|group|party) of \d{1,4}|about \d{1,4}\b/i.test(lower);
  const hasLocation = /\b(at |in |venue|location|address|hotel|hall|salle|lieu|chez)\b/i.test(lower);

  if (type === 'workshop') {
    const questions = [];
    if (!hasGuestCount) questions.push(lang === 'fr' ? '- Combien de personnes dans le groupe?' : '- How many people in the group?');
    if (!hasDate) questions.push(lang === 'fr' ? '- Quelle date?' : '- What date works?');
    if (!hasLocation) questions.push(lang === 'fr' ? "- Quelle est l'adresse?" : "- What's the address?");

    const questionBlock = questions.length > 0
      ? `\n${lang === 'fr' ? 'Quelques details:' : 'A few quick details:'}\n${questions.join('\n')}\n`
      : '';

    if (lang === 'fr') {
      return `${greeting}

Absolument! Nos ateliers sont super fun -- tout le monde met la main a la pate pour creer des cocktails.
${questionBlock}
Quel est votre courriel? Je vous envoie le menu et la proposition.`;
    }
    return `${greeting}

We do! Our workshops are super fun -- everyone gets hands-on making craft cocktails.
${questionBlock}
What's your email? I'll send over the menu and proposal.`;
  }

  if (type === 'bar_service') {
    const questions = [];
    if (!hasDate || !hasLocation) {
      questions.push(lang === 'fr'
        ? '- La date et le lieu, de quelle heure a quelle heure?'
        : '- The date and location, from what time to what time?');
    }
    questions.push(lang === 'fr'
      ? '- Location de bar ou installation sur un espace existant?'
      : '- Bar rental or setup on an existing space?');
    questions.push(lang === 'fr'
      ? '- Vraie verrerie ou plastique?'
      : '- Real glassware or plastic?');
    questions.push(lang === 'fr'
      ? "- Vous fournissez l'alcool ou nous?"
      : '- Would you like to supply the alcohol or us?');

    if (lang === 'fr') {
      return `${greeting}

Merci de nous avoir contactes! Pour preparer votre proposition, quelques questions:
${questions.join('\n')}

Les deux options sont cle en main. Une fois les cocktails choisis, si vous fournissez l'alcool, on vous dit exactement quoi avoir sous la main.

Quel est votre courriel? Je vous envoie la proposition et le menu.`;
    }
    return `${greeting}

Thanks for reaching out! To put together your proposal, a few quick questions:
${questions.join('\n')}

Both options are completely turnkey. Once you choose the cocktails, if you supply the alcohol, we'll let you know exactly what to have on hand.

What's your email? I'll send you the proposal and menu.`;
  }

  // Unknown type
  if (lang === 'fr') {
    return `${greeting}

Merci pour votre message! On offre des services de bar pour evenements et des ateliers de mixologie.

Vous cherchez quel type de service? Quelques details pour commencer:
- La date et le nombre de personnes?
- Le lieu?

Quel est votre courriel? Je vous envoie l'info.`;
  }
  return `${greeting}

Thanks for reaching out! We offer bar service for events and cocktail workshops.

What type of service are you looking for? A few basics to get started:
- The date and group size?
- The location?

What's your email? I'll send you the details.`;
}

/**
 * Generate follow-up reply with full business context.
 */
async function generateFollowUpReply(params) {
  const {
    incomingMessage,
    clientName,
    businessContext,
    conversationHistory,
    calendarContext,
    actionContext,
    correctionRules
  } = params;

  const lang = detectLanguage(incomingMessage);

  const system = `You are Max, the AI assistant for MTL Craft Cocktails, a mobile bartending service in Montreal.

LANGUAGE (MANDATORY): Reply in ${lang === 'fr' ? 'French' : 'English'} only. Do NOT switch languages.

TONE & STYLE:
- Professional but warm. Use "we" not "I" or "Ashley".
- NEVER say "awesome", "Great question!", or similar filler.
- NO emojis unless the client uses them first.
- Don't be wordy when you already know half the info. Confirm what they said, ask what's missing.

FOLLOW-UP RULES:
- Answer their question directly. Don't re-ask qualifying questions already answered.
- If qualifying info is still missing (date, location, time range, bar rental vs setup, glassware, alcohol supply, email), ask for it.
- Do NOT quote pricing, rates, or per-person costs unless the client EXPLICITLY asks "how much" or "what's the price". We send pricing in the proposal.
- Do NOT list what's included in our packages. Just ask what's missing and offer to send the proposal.
- For bar service: If they chose Tailored (supply own alcohol) + real glassware, ask if they're serving wine (we need wine glasses). If they chose open bar with us, ask if they want wine included.
- For workshops: If they ask "do you have a venue/space?", THEN mention Loft Beauty in Old Port. Otherwise always assume we go to them.
- NEVER offer themed cocktails for workshops. We send the menu, they pick.

CORPORATE VS PRIVATE:
- Corporate events: Always quote WITH alcohol (open bar). Don't suggest they supply their own.
- Private events: Present both options (supply own alcohol OR open bar with us).

PAYMENT (only if asked): Credit card via payment link. No e-transfers.

Business context (reference only -- do NOT quote pricing from here unless the client asks):
${businessContext}

${actionContext ? `\nAction context:\n${actionContext}\n` : ''}
${correctionRules?.length > 0 ? `\nCORRECTION RULES (learned from past edits -- follow strictly):\n${correctionRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n` : ''}
Output ONLY the message text. No labels, no quotes, no formatting markers.`;

  let userPrompt = '';
  if (conversationHistory && conversationHistory.length > 0) {
    userPrompt += 'Previous messages:\n';
    for (const msg of conversationHistory.slice(-5)) {
      const direction = msg.direction === 'inbound' ? 'Client' : 'Max';
      userPrompt += `${direction}: ${msg.body}\n`;
    }
    userPrompt += '\n';
  }

  if (calendarContext) {
    userPrompt += `Calendar info: ${calendarContext}\n\n`;
  }

  const name = clientName || 'Client';
  userPrompt += `New message from ${name}:\n"${incomingMessage}"\n\nReply naturally:`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const draft = response.content[0].text.trim().replace(/^["']|["']$/g, '').trim();
    logger.info({ length: draft.length }, 'Generated follow-up draft');
    return draft;
  } catch (error) {
    logger.error({ error }, 'Failed to generate follow-up draft');
    return generateFallbackReply(incomingMessage);
  }
}

/**
 * Rewrite a draft based on Ashley's correction notes.
 * Takes the original draft and her instructions, produces a polished revised message.
 */
export async function rewriteDraftFromCorrections(originalDraft, corrections, clientMessage) {
  const lang = detectLanguage(clientMessage || originalDraft);

  const system = `You are Max, assistant for MTL Craft Cocktails (mobile bartending, Montreal).
Rewrite the draft SMS below based on the correction notes from the business owner.
Reply in ${lang === 'fr' ? 'French' : 'English'} only.
Tone: professional, warm. Use "we" not "I". No emojis. No filler.
Do NOT add pricing or dollar amounts unless the correction notes specifically include them.
Output ONLY the rewritten message text. No labels, no quotes.`;

  const user = `ORIGINAL DRAFT:
${originalDraft}

CLIENT'S MESSAGE (for context):
${clientMessage || '(not available)'}

OWNER'S CORRECTION NOTES:
${corrections}

Rewrite the draft incorporating these corrections. Keep it professional and ready to send as an SMS:`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }]
    });

    const draft = response.content[0].text.trim().replace(/^["']|["']$/g, '').trim();
    logger.info({ length: draft.length }, 'Rewritten draft from corrections');
    return draft;
  } catch (error) {
    logger.error({ error }, 'Failed to rewrite draft');
    // Fall back to the raw corrections text
    return corrections;
  }
}

/**
 * Generate fallback reply if Claude fails
 */
function generateFallbackReply(incomingMessage) {
  const lower = incomingMessage.toLowerCase();
  const isFrench = /[àâéèêëïîôùûüç]|bonjour|salut|merci|disponible|prix|réserv/i.test(incomingMessage);

  if (lower.includes('price') || lower.includes('cost') || lower.includes('rate') || lower.includes('prix') || lower.includes('tarif')) {
    return isFrench
      ? "Merci de nous avoir contactes! Nos forfaits varient selon la taille de l'evenement. Pouvez-vous m'en dire plus?"
      : "Thanks for reaching out! Our packages vary by event size. Can you tell me more about what you're planning?";
  }

  if (lower.includes('available') || lower.includes('book') || lower.includes('disponible') || lower.includes('réserv')) {
    return isFrench
      ? "Bonjour! Oui, on serait ravis de vous aider. Quelle date avez-vous en tete?"
      : "Hi! Yes, we'd love to help with your event. What date are you looking at?";
  }

  return isFrench
    ? "Merci pour votre message! Je vous reviens sous peu avec plus de details."
    : "Thanks for your message! I'll get back to you shortly with more details.";
}

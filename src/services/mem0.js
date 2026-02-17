import { createLogger } from '../utils/logger.js';
import { searchMemoriesPgvector } from './pgvector.js';

const logger = createLogger('mem0');

/**
 * Search pgvector for client context.
 */
export async function searchClientContext(query, phoneNumber = null) {
  try {
    const searchQuery = phoneNumber ? `${query} phone:${phoneNumber}` : query;
    const results = await searchMemoriesPgvector(searchQuery, 0.6, 5);

    if (!results || results.length === 0) {
      return null;
    }

    const context = results.map(r => `- ${r.content}`).join('\n');
    logger.info({ count: results.length }, 'Found pgvector context');
    return context;
  } catch (error) {
    logger.error({ error }, 'pgvector search failed');
    return null;
  }
}

/**
 * Get business context (pricing, services, etc.)
 */
export async function getBusinessContext() {
  try {
    const results = await searchMemoriesPgvector(
      'pricing services packages cocktails events workshops syrups bar open bar mixologist',
      0.6, 15
    );
    if (results && results.length > 0) {
      return results.map(r => r.content).join('\n');
    }
    return getDefaultBusinessContext();
  } catch (error) {
    logger.error({ error }, 'Failed to get business context');
    return getDefaultBusinessContext();
  }
}

/**
 * Default business context if pgvector fails
 */
function getDefaultBusinessContext() {
  return `MTL Craft Cocktails - Mobile bartending services in Montreal
- The Tailored Bar Experience (client supplies alcohol): $15-25/person depending on event type and duration
- The Ultimate Bar Experience (open bar, we supply alcohol): $30-60/person depending on duration and drinking crowd
- Premium open bar (Hendrick's, Grey Goose, Casamigos level): $75/person
- Full mocktail bar (The Drink Without The Drunk): $25/person
- Consumption bar (per-drink): $12.50/cocktail
- Standard alcohol we supply: Tequila 1800, Tanqueray gin, Kettle One vodka, Jameson whiskey, Bacardi White rum, Chivas scotch
- Workshop pricing: $72/person at client location, $89/person at Loft Beauty (Old Port)
- Handmade syrup prices: 8oz $15, 16oz $25, 26oz $30
- Bar rental: 4ft $150, 6ft $200, 8ft $300 (delivery included)
- Glassware rental: ~$1/glass (1 glass/person/hour rule)
- Everything made from scratch - syrups, shrubs, infusions
- MK Kosher certified
- Fully bilingual English and French
- Completely turnkey: we supply everything
- Workshop venue: Loft Beauty, 59 Rue de Bresoles, Montreal (Old Port)
- Workshop min 6 people, max 80 people
- Setup: 1 hour standard, 2 hours for big events, 3-4 hours for weddings
- Mixologist rate: $40/hour per mixologist (includes setup and teardown)
- 1 bartender per 40 guests (scales: 60 guests = 2, 120 guests = 3, etc.)
- Travel fee: $60 within Montreal, $150 outside Montreal (1h15+)
- Deposit: 25%, balance due day before event
- Payment: Credit card via payment link
- Can send cocktail menu on request
- Cocktail tastings available for weddings`;
}

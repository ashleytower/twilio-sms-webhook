import { createLogger } from '../utils/logger.js';

const logger = createLogger('mem0');

const RUBE_API_URL = process.env.RUBE_API_URL;
const RUBE_API_KEY = process.env.RUBE_API_KEY;

/**
 * Search Mem0 for client context via Rube MCP
 */
export async function searchClientContext(query, phoneNumber = null) {
  try {
    // Search for relevant memories
    const searchQuery = phoneNumber
      ? `${query} phone:${phoneNumber}`
      : query;

    const response = await callRubeTool('MEM0_SEARCH', {
      query: searchQuery,
      user_id: 'ashley',
      limit: 5
    });

    if (!response.success || !response.data?.memories) {
      return null;
    }

    const memories = response.data.memories;
    if (memories.length === 0) {
      return null;
    }

    // Format memories as context
    const context = memories
      .map(m => `- ${m.memory}`)
      .join('\n');

    logger.info({ count: memories.length }, 'Found Mem0 context');
    return context;
  } catch (error) {
    logger.error({ error }, 'Mem0 search failed');
    return null;
  }
}

/**
 * Get business context (pricing, services, etc.)
 */
export async function getBusinessContext() {
  try {
    const response = await callRubeTool('MEM0_SEARCH', {
      query: 'pricing services packages cocktails events',
      user_id: 'ashley',
      limit: 10
    });

    if (!response.success || !response.data?.memories) {
      return getDefaultBusinessContext();
    }

    const memories = response.data.memories;
    if (memories.length === 0) {
      return getDefaultBusinessContext();
    }

    return memories
      .map(m => m.memory)
      .join('\n');
  } catch (error) {
    logger.error({ error }, 'Failed to get business context');
    return getDefaultBusinessContext();
  }
}

/**
 * Default business context if Mem0 fails
 */
function getDefaultBusinessContext() {
  return `MTL Craft Cocktails - Mobile bartending services in Montreal
- Event packages available
- Professional bartenders
- Custom cocktail menus`;
}

/**
 * Call a Rube MCP tool
 */
async function callRubeTool(toolName, params) {
  if (!RUBE_API_URL || !RUBE_API_KEY) {
    logger.warn('Rube not configured, skipping Mem0');
    return { success: false };
  }

  try {
    const response = await fetch(`${RUBE_API_URL}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RUBE_API_KEY}`
      },
      body: JSON.stringify({
        tool: toolName,
        params
      })
    });

    const data = await response.json();
    return { success: true, data };
  } catch (error) {
    logger.error({ error, tool: toolName }, 'Rube tool call failed');
    return { success: false, error: error.message };
  }
}

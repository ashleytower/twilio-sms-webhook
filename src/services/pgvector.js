import { createClient } from '@supabase/supabase-js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('pgvector');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEFAULT_USER_ID = process.env.USER_ID || '3ed111ff-c28f-4cda-b987-1afa4f7eb081';

/**
 * Get embedding vector from Ollama nomic-embed-text.
 * Returns float array or null on failure.
 */
async function getEmbedding(text) {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Ollama embed request failed');
      return null;
    }

    const data = await response.json();
    if (data.embeddings && data.embeddings[0]) {
      return data.embeddings[0];
    }

    logger.warn('No embeddings in Ollama response');
    return null;
  } catch (error) {
    logger.warn({ error: error.message }, 'Ollama embedding failed');
    return null;
  }
}

/**
 * Store a memory with embedding to Supabase pgvector.
 * Returns true on success, false on failure.
 */
export async function storeMemoryWithEmbedding(content, category = 'general', importance = 5, source = '') {
  const embedding = await getEmbedding(content);
  if (!embedding) {
    logger.warn('Skipping memory storage (no embedding available)');
    return false;
  }

  const { data, error } = await supabase.rpc('upsert_memory', {
    p_user_id: DEFAULT_USER_ID,
    p_content: content,
    p_embedding: embedding,
    p_category: category,
    p_importance: Number(importance),
    p_source: source
  });

  if (error) {
    logger.error({ error }, 'Failed to store memory');
    return false;
  }

  logger.info({ category }, 'Stored memory with embedding');
  return true;
}

/**
 * Search pgvector memories by semantic similarity.
 * Returns array of {content, similarity} or empty array on failure.
 */
export async function searchMemoriesPgvector(query, threshold = 0.6, count = 10) {
  const embedding = await getEmbedding(query);
  if (!embedding) {
    return [];
  }

  const { data, error } = await supabase.rpc('match_memories', {
    p_user_id: DEFAULT_USER_ID,
    p_embedding: embedding,
    p_threshold: Number(threshold),
    p_count: Number(count)
  });

  if (error) {
    logger.warn({ error }, 'pgvector search failed');
    return [];
  }

  return (data || []).map(row => ({
    content: row.content,
    similarity: row.similarity
  }));
}

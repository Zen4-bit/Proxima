/**
 * Proxima — Session Store
 * Maps session fingerprints to per-provider conversation state.
 * Provides LRU eviction (max 1000 per provider) and TTL-based expiry (24h).
 */

const crypto = require('crypto');

// ─── Constants ───────────────────────────────────────────
const MAX_SIZE = 1000;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── ProviderSessionMap ──────────────────────────────────

class ProviderSessionMap {
  constructor(maxSize = MAX_SIZE, ttlMs = TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.entries = new Map(); // fingerprint → { state, lastAccessed, createdAt }
  }

  /**
   * Look up a session by fingerprint.
   * Returns the conversation state or null.
   * Updates lastAccessed on hit. Evicts expired entries lazily.
   */
  lookup(fingerprint) {
    const entry = this.entries.get(fingerprint);
    if (!entry) return null;

    // TTL check — evict if expired
    if (Date.now() - entry.lastAccessed > this.ttlMs) {
      this.entries.delete(fingerprint);
      return null;
    }

    // Update lastAccessed and move to end of Map (most recently used)
    entry.lastAccessed = Date.now();
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, entry);

    return entry.state;
  }

  /**
   * Store a session mapping. Enforces max capacity with LRU eviction.
   */
  store(fingerprint, conversationState) {
    // If key already exists, delete it first so re-insertion moves it to end
    if (this.entries.has(fingerprint)) {
      this.entries.delete(fingerprint);
    } else if (this.entries.size >= this.maxSize) {
      // Evict LRU entry (first entry in Map iteration order)
      const lruKey = this.entries.keys().next().value;
      this.entries.delete(lruKey);
      console.warn(`[SessionStore] WARNING: Evicting LRU session for provider (at capacity: ${this.maxSize})`);
    }

    this.entries.set(fingerprint, {
      state: conversationState,
      lastAccessed: Date.now(),
      createdAt: Date.now()
    });
  }

  /**
   * Remove a specific session mapping.
   */
  remove(fingerprint) {
    return this.entries.delete(fingerprint);
  }

  /**
   * Clear all sessions.
   */
  clear() {
    this.entries.clear();
  }

  /**
   * Get the number of active (non-expired) entries.
   */
  get size() {
    return this.entries.size;
  }
}

// ─── Top-level Store ─────────────────────────────────────

const providers = {
  chatgpt: new ProviderSessionMap(),
  claude: new ProviderSessionMap(),
  gemini: new ProviderSessionMap(),
  perplexity: new ProviderSessionMap()
};

// ─── Content Normalization ───────────────────────────────

/**
 * Normalize message content to a plain string.
 * Handles:
 *   - string values (pass-through)
 *   - OpenAI content-part arrays: [{ type: "text", text: "..." }, ...]
 *   - Objects with a `text` field: { text: "..." }
 */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    // OpenAI content-part array — concatenate text parts
    return content
      .filter(part => part && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('');
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }

  return '';
}

// ─── Message Extraction ──────────────────────────────────

/**
 * Extract and normalize the content of the last user-role message.
 */
function extractLastUserMessage(messages) {
  if (!messages || !Array.isArray(messages)) return '';
  const userMsgs = messages.filter(m => m && m.role === 'user');
  if (userMsgs.length === 0) return '';
  return normalizeContent(userMsgs[userMsgs.length - 1].content);
}

/**
 * Compose a message for a new session:
 * Prepend the last system prompt (if any) to the last user message,
 * separated by a double newline.
 */
function composeNewSessionMessage(messages) {
  if (!messages || !Array.isArray(messages)) return '';

  const lastUserMsg = extractLastUserMessage(messages);
  const systemMsgs = messages.filter(m => m && m.role === 'system');

  if (systemMsgs.length > 0) {
    const systemContent = normalizeContent(systemMsgs[systemMsgs.length - 1].content);
    if (systemContent) {
      return systemContent + '\n\n' + lastUserMsg;
    }
  }

  return lastUserMsg;
}

// ─── Fingerprint Computation ─────────────────────────────

/**
 * Compute a session fingerprint from a messages array.
 * SHA-256 hash of the normalized first user-role message content.
 * Returns crypto.randomUUID() for malformed/missing user messages.
 */
function computeFingerprint(messages) {
  if (!messages || !Array.isArray(messages)) {
    return crypto.randomUUID();
  }

  const firstUserMsg = messages.find(m => m && m.role === 'user');
  if (!firstUserMsg) {
    return crypto.randomUUID();
  }

  const normalized = normalizeContent(firstUserMsg.content);
  if (!normalized) {
    return crypto.randomUUID();
  }

  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ─── Public API ──────────────────────────────────────────

/**
 * Look up a session for a given fingerprint and provider.
 * Returns conversation state or null.
 */
function lookup(fingerprint, provider) {
  const map = providers[provider];
  if (!map) return null;
  return map.lookup(fingerprint);
}

/**
 * Store a session mapping for a given fingerprint and provider.
 */
function store(fingerprint, provider, conversationState) {
  const map = providers[provider];
  if (!map) return;
  map.store(fingerprint, conversationState);
}

/**
 * Remove a specific session mapping.
 */
function remove(fingerprint, provider) {
  const map = providers[provider];
  if (!map) return false;
  return map.remove(fingerprint);
}

/**
 * Clear all sessions for a provider (used by newConversation reset).
 */
function clearProvider(provider) {
  const map = providers[provider];
  if (!map) return;
  map.clear();
}

/**
 * Get session statistics.
 */
function getStats() {
  const providerStats = {};
  let totalCount = 0;

  for (const [name, map] of Object.entries(providers)) {
    providerStats[name] = map.size;
    totalCount += map.size;
  }

  return {
    sessionCount: totalCount,
    providers: providerStats
  };
}

// ─── Exports ─────────────────────────────────────────────

module.exports = {
  computeFingerprint,
  lookup,
  store,
  remove,
  clearProvider,
  getStats,
  // Utilities exported for use by rest-api.cjs and tests
  normalizeContent,
  extractLastUserMessage,
  composeNewSessionMessage,
  // Expose class for testing with custom parameters
  ProviderSessionMap
};

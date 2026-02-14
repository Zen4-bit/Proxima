// Proxima SDK - JavaScript/Node.js client
//
// Usage:
//   const { Proxima } = require('./proxima');
//   const client = new Proxima();
//   const res = await client.chat("Hello", { model: "claude" });
//   console.log(res.text);

class ProximaResponse {
    constructor(data) {
        this._data = data;
        const first = (data.choices || [])[0] || {};
        const msg = first.message || {};
        const proxima = data.proxima || {};

        this.text = msg.content || '';
        this.model = data.model || first.model || '';
        this.id = data.id || '';
        this.finishReason = first.finish_reason || '';
        this.responseTimeMs = proxima.responseTimeMs || 0;
        this.provider = proxima.provider || this.model;
        this.function = data.function || '';
    }

    toString() { return this.text; }
    toJSON() { return this._data; }
}

class Proxima {
    /**
 * @param {Object} options
 * @param {string} [options.baseUrl='http://localhost:3210']
 * @param {string} [options.apiKey]
 * @param {string} [options.model='auto'] - Default model
 * @param {number} [options.timeout=120000] - Request timeout in ms
 * @param {number} [options.maxRetries=3] - Max retry attempts on connection failure
 */
    constructor({ baseUrl = 'http://localhost:3210', apiKey = null, model = 'auto', timeout = 120000, maxRetries = 3 } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.defaultModel = model;
        this.timeout = timeout;
        this.maxRetries = maxRetries;
        this.headers = { 'Content-Type': 'application/json' };
        if (apiKey) this.headers['Authorization'] = `Bearer ${apiKey}`;
    }

    /**
     * ONE function for everything.
     *
     * @param {string} message - Your message/prompt
     * @param {Object} [options] - Options
     * @param {string} [options.model] - "chatgpt", "claude", "gemini", "perplexity", "auto"
     * @param {string} [options.function] - "search", "translate", "brainstorm", "code", "analyze"
     *
     * Extra options based on function:
     *   function: "translate" → { to: "Hindi", from: "English" }
     *   function: "code"      → { action: "generate|review|debug|explain", language: "Python", code: "..." }
     *   function: "analyze"   → { url: "https://...", question: "...", focus: "..." }
     *
     * @returns {ProximaResponse} with .text, .model, .responseTimeMs
     *
     * @example
     * // Chat
     * await client.chat("Hello", { model: "claude" });
     *
     * // Search
     * await client.chat("AI news", { model: "perplexity", function: "search" });
     *
     * // Translate
     * await client.chat("Hello", { model: "gemini", function: "translate", to: "Hindi" });
     *
     * // Code generate
     * await client.chat("Sort algo", { model: "claude", function: "code", action: "generate", language: "Python" });
     *
     * // Brainstorm
     * await client.chat("Startup ideas", { function: "brainstorm" });
     *
     * // Analyze URL
     * await client.chat("", { function: "analyze", url: "https://example.com" });
     */
    async chat(message = '', options = {}) {
        const { model, ...rest } = options;
        const body = {
            model: model || this.defaultModel,
            ...rest
        };
        if (message) body.message = message;

        return this._post('/v1/chat/completions', body);
    }

    // System

    /** List all available models */
    async getModels() {
        const data = await this._get('/v1/models');
        return data.data || [];
    }

    /** Get function catalog */
    async getFunctions() {
        return this._get('/v1/functions');
    }

    /** Get response time statistics */
    async getStats() {
        return this._get('/v1/stats');
    }

    /** Start fresh conversations */
    async newConversation() {
        return this._postRaw('/v1/conversations/new', {});
    }

    // Internals

    async _fetchWithRetry(url, options, timeoutMs) {
        let lastError = null;

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);

                const res = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(timer);
                return res;
            } catch (err) {
                if (err.name === 'AbortError') {
                    lastError = new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
                } else if (err.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
                    lastError = new Error(
                        `Cannot connect to Proxima at ${this.baseUrl}. ` +
                        `Is the Proxima app running? (attempt ${attempt + 1}/${this.maxRetries})`
                    );
                } else {
                    throw err; // Don't retry unknown errors
                }

                // Wait before retry (exponential backoff: 1s, 2s)
                if (attempt < this.maxRetries - 1) {
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
        }

        throw lastError;
    }

    async _post(endpoint, body) {
        const res = await this._fetchWithRetry(`${this.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body)
        }, this.timeout);

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `API error: ${res.status}`);
        }
        return new ProximaResponse(await res.json());
    }

    async _postRaw(endpoint, body) {
        const res = await this._fetchWithRetry(`${this.baseUrl}${endpoint}`, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body)
        }, 30000);
        return res.json();
    }

    async _get(endpoint) {
        const res = await this._fetchWithRetry(`${this.baseUrl}${endpoint}`, {
            headers: this.headers
        }, 30000);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    }
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Proxima, ProximaResponse };
}

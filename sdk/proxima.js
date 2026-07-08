// Proxima SDK - JavaScript/Node.js client

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

    constructor({ baseUrl = null, apiKey = null, model = 'auto', timeout = 120000, maxRetries = 3 } = {}) {

        const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};
        const port = _env.PROXIMA_REST_PORT || _env.PROXIMA_PORT || '3210';
        this.baseUrl = (baseUrl || `http://localhost:${port}`).replace(/\/$/, '');
        this.defaultModel = model;
        this.timeout = timeout;
        this.maxRetries = maxRetries;
        this.headers = { 'Content-Type': 'application/json' };
        if (apiKey) this.headers['Authorization'] = `Bearer ${apiKey}`;
    }


    async chat(message = '', options = {}) {
        const { model, ...rest } = options;
        const body = {
            model: model || this.defaultModel,
            ...rest
        };
        if (message) body.message = message;

        return this._post('/v1/chat/completions', body);
    }


    async getModels() {
        const data = await this._get('/v1/models');
        return data.data || [];
    }


    async getFunctions() {
        return this._get('/v1/functions');
    }


    async getStats() {
        return this._get('/v1/stats');
    }


    async newConversation(provider) {
        return this._postRaw('/v1/conversations/new', { provider });
    }



    async _fetchWithRetry(url, options, timeoutMs) {
        let lastError = null;

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    return await fetch(url, { ...options, signal: controller.signal });
                } finally {
                    clearTimeout(timer);
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    lastError = new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
                } else if (err.code === 'ECONNREFUSED' || err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
                    lastError = new Error(
                        `Cannot connect to Proxima at ${this.baseUrl}. ` +
                        `Is the Proxima app running? (attempt ${attempt + 1}/${this.maxRetries})`
                    );
                } else {
                    throw err;
                }


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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { Proxima, ProximaResponse };
}

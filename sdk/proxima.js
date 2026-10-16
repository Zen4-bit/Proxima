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

function _discoverRestPort() {
    const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    if (_env.PROXIMA_REST_PORT || _env.PROXIMA_PORT) {
        const p = parseInt(_env.PROXIMA_REST_PORT || _env.PROXIMA_PORT, 10);
        if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
    }
    if (typeof process !== 'undefined' && typeof require !== 'undefined') {
        try {
            const fs = require('fs');
            const path = require('path');
            const candidates = [];
            if (_env.PROXIMA_DATA_DIR) {
                candidates.push(path.join(_env.PROXIMA_DATA_DIR, 'rest-port.json'));
            } else {
                const home = _env.HOME || '';
                if (process.platform === 'win32') {
                    const base = _env.APPDATA || path.join(_env.USERPROFILE || home, 'AppData', 'Roaming');
                    candidates.push(path.join(base, 'Proxima', 'rest-port.json'), path.join(base, 'proxima', 'rest-port.json'));
                } else if (process.platform === 'darwin') {
                    const base = path.join(home, 'Library', 'Application Support');
                    candidates.push(path.join(base, 'Proxima', 'rest-port.json'), path.join(base, 'proxima', 'rest-port.json'));
                } else {
                    const xdg = _env.XDG_CONFIG_HOME || path.join(home, '.config');
                    candidates.push(path.join(xdg, 'Proxima', 'rest-port.json'), path.join(xdg, 'proxima', 'rest-port.json'));
                }
            }
            const existing = candidates.filter(f => fs.existsSync(f));
            if (existing.length > 1) {
                existing.sort((a, b) => {
                    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
                });
            }
            for (const portFilePath of existing) {
                try {
                    const data = JSON.parse(fs.readFileSync(portFilePath, 'utf8'));
                    const p = parseInt(data.port, 10);
                    if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
                } catch {}
            }
        } catch {}
    }
    return 3210;
}

class Proxima {

    constructor({ baseUrl = null, apiKey = null, model = 'auto', timeout = 120000, maxRetries = 3 } = {}) {
        const port = _discoverRestPort();
        this.baseUrl = (baseUrl || `http://localhost:${port}`).replace(/\/$/, '');
        this.defaultModel = model;
        this.timeout = timeout;
        this.maxRetries = maxRetries;
        this.headers = { 'Content-Type': 'application/json' };
        if (apiKey) this.headers['Authorization'] = `Bearer ${apiKey}`;
    }


    async chat(message = '', options = {}) {
        const { model, thinking_level, thinkingLevel, reasoning_effort, ...rest } = options;
        const body = {
            model: model || this.defaultModel,
            ...rest
        };
        const resolvedThinking = thinking_level || thinkingLevel;
        if (resolvedThinking) body.thinking_level = resolvedThinking;
        if (reasoning_effort) body.reasoning_effort = reasoning_effort;
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

    _endpointUrl(endpoint) {
        const base = this.baseUrl.replace(/\/+$/, '');
        const ep = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
        if (base.endsWith('/v1') && ep.startsWith('/v1/')) {
            return `${base}${ep.slice(3)}`;
        }
        return `${base}${ep}`;
    }

    async _post(endpoint, body) {
        const res = await this._fetchWithRetry(this._endpointUrl(endpoint), {
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
        const res = await this._fetchWithRetry(this._endpointUrl(endpoint), {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body)
        }, 30000);
        return res.json();
    }

    async _get(endpoint) {
        const res = await this._fetchWithRetry(this._endpointUrl(endpoint), {
            headers: this.headers
        }, 30000);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        return res.json();
    }
}

Proxima.Proxima = Proxima;
Proxima.ProximaResponse = ProximaResponse;
Proxima.default = Proxima;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Proxima;
    module.exports.Proxima = Proxima;
    module.exports.ProximaResponse = ProximaResponse;
    module.exports.default = Proxima;
}

if (typeof globalThis !== 'undefined') {
    globalThis.Proxima = Proxima;
    globalThis.ProximaResponse = ProximaResponse;
}

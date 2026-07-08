// Proxima — IPC Bridge.
// Handles TCP socket communication, port scanning, heartbeat watchdogs, and provider queues.

import net from 'net';
import { ProviderError, RateLimitError, AuthError, TimeoutError } from '../utils/errors.js';

const DEFAULT_IPC_PORT = 19222;
const PORT_SCAN_RANGE = 20;

export class IPCClient {
    constructor(port = DEFAULT_IPC_PORT, token = null) {
        this._basePort = port;
        this._lastGoodPort = port;
        this.port = port;
        this._tokenSource = token;
        this.token = typeof token === 'function' ? null : token;
        this.socket = null;
        this.connected = false;
        this._shuttingDown = false;
        this.responseBuffer = '';
        this.pendingRequests = new Map();
        this.requestId = 0;
    }

    _refreshToken() {
        if (typeof this._tokenSource === 'function') {
            try {
                this.token = this._tokenSource() || null;
            } catch (e) {
                this.token = null;
            }
        }
    }

    async connect() {
        if (this._shuttingDown) throw new Error('IPC client is shutting down');
        if (this.connected) return true;

        if (this._connecting) return this._connecting;

        this._connecting = this._doConnect().finally(() => {
            this._connecting = null;
        });
        return this._connecting;
    }

    async _doConnect() {
        if (this.connected) return true;

        this._refreshToken();
        if (this.socket) {
            try { this.socket.destroy(); } catch(e) {}
            this.socket = null;
        }

        const candidates = [];
        if (this._lastGoodPort) candidates.push(this._lastGoodPort);
        for (let i = 0; i < PORT_SCAN_RANGE; i++) {
            const p = this._basePort + i;
            if (!candidates.includes(p)) candidates.push(p);
        }

        let lastErr = null;
        for (const tryPort of candidates) {
            try {
                await this._connectToPort(tryPort);
                this._lastGoodPort = tryPort;
                this.port = tryPort;
                if (tryPort !== this._basePort) {
                    console.error(`[MCP] Connected to Agent Hub on port ${tryPort}`);
                }
                return true;
            } catch (err) {
                lastErr = err;
                if (err && (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')) {
                    continue;
                }
                break;
            }
        }
        throw lastErr || new Error('Could not connect to Agent Hub — is Proxima running?');
    }

    _connectToPort(port) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
                settled = true;
                this.socket = socket;
                this.connected = true;
                console.error(`[MCP] Connected to Agent Hub on port ${port}`);
                resolve(true);
            });

            socket.on('data', (data) => {
                this.responseBuffer += data.toString();
                this.processBuffer();
            });

            socket.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    try { socket.destroy(); } catch (e) {}
                    reject(err);
                    return;
                }
                console.error('[MCP] IPC Error:', err.message);
                this.connected = false;
            });

            socket.on('close', () => {
                if (this.socket === socket) {
                    console.error('[MCP] Disconnected from Agent Hub');
                    this.connected = false;
                    for (const [, entry] of this.pendingRequests) {
                        if (entry.timer) clearTimeout(entry.timer);
                        entry.reject(new Error('Connection to Agent Hub lost'));
                    }
                    this.pendingRequests.clear();
                }
            });

            setTimeout(() => {
                if (!settled) {
                    settled = true;
                    try { socket.destroy(); } catch (e) {}
                    const e = new Error('connect timeout');
                    e.code = 'ETIMEDOUT';
                    reject(e);
                }
            }, 1500);
        });
    }

    processBuffer() {
        const lines = this.responseBuffer.split('\n');
        this.responseBuffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const response = JSON.parse(line);
                    const pending = response.requestId && this.pendingRequests.get(response.requestId);

                    if (response.type === 'heartbeat') {
                        if (pending && typeof pending.onActivity === 'function') {
                            pending.onActivity();
                        }
                        continue;
                    }

                    if (pending) {
                        this.pendingRequests.delete(response.requestId);
                        if (pending.timer) clearTimeout(pending.timer);
                        pending.resolve(response);
                    }
                } catch (e) {
                    console.error('[MCP] Parse error:', e);
                }
            }
        }
    }

    async send(action, provider = null, data = {}) {
        if (this._shuttingDown) throw new Error('IPC client is shutting down');
        if (!this.connected) {
            await this.connect();
        }

        const requestId = ++this.requestId;
        const request = { requestId, action, provider, data };
        const IDLE_TIMEOUT_MS = parseInt(process.env.AGENT_HUB_IDLE_TIMEOUT_MS, 10) || 150000;

        if (this.token) request.token = this.token;
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, timer: null, onActivity: null };

            const armTimer = () => {
                if (entry.timer) clearTimeout(entry.timer);
                entry.timer = setTimeout(() => {
                    if (this.pendingRequests.has(requestId)) {
                        this.pendingRequests.delete(requestId);
                        reject(new Error('Request timed out — no activity from Agent Hub (no heartbeat)'));
                    }
                }, IDLE_TIMEOUT_MS);
                if (entry.timer.unref) entry.timer.unref();
            };
            entry.onActivity = armTimer;

            this.pendingRequests.set(requestId, entry);
            armTimer();

            try {
                this.socket.write(JSON.stringify(request) + '\n');
            } catch (e) {
                if (entry.timer) clearTimeout(entry.timer);
                this.pendingRequests.delete(requestId);
                reject(e);
            }
        });
    }

    disconnect() {
        this._shuttingDown = true;
        this._connecting = null;

        if (this.socket) {
            try { this.socket.destroy(); } catch (e) { }
        } else {
            for (const [, entry] of this.pendingRequests) {
                if (entry.timer) clearTimeout(entry.timer);
                try { entry.reject(new Error('Connection to Agent Hub lost')); } catch (e) { /* ignore */ }
            }
            this.pendingRequests.clear();
        }
        this.connected = false;
    }
}

export class AIProvider {
    constructor(name, ipcClient, isEnabledFn) {
        this.name = name;
        this.ipc = ipcClient;
        this.isEnabled = isEnabledFn;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
        this.maxCacheSize = 100;

        this._queue = Promise.resolve();
        this._queueLength = 0;

        this._cleanupInterval = setInterval(() => this.cleanCache(), 10 * 60 * 1000);
        if (this._cleanupInterval.unref) this._cleanupInterval.unref();
    }

    cleanCache() {
        const now = Date.now();
        for (const [key, val] of this.cache) {
            if (now - val.time > this.cacheTimeout) {
                this.cache.delete(key);
            }
        }
        if (this.cache.size > this.maxCacheSize) {
            const entries = [...this.cache.entries()];
            entries.sort((a, b) => a[1].time - b[1].time);
            const toDelete = entries.slice(0, entries.length - this.maxCacheSize);
            for (const [key] of toDelete) {
                this.cache.delete(key);
            }
        }
    }

    async ensureInitialized() {
        if (!this.isEnabled(this.name)) {
            throw new Error(`${this.name} is disabled. Enable it in Proxima Agent Hub settings.`);
        }
        await this.ipc.send('initProvider', this.name);
    }

    async isLoggedIn() {
        const result = await this.ipc.send('isLoggedIn', this.name);
        return result.loggedIn;
    }


    _classifyError(rawMessage) {
        const msg = String(rawMessage || `${this.name} request failed`);
        const lower = msg.toLowerCase();
        if (lower.includes('rate limit') || lower.includes('too many requests') || /\b429\b/.test(lower)) {
            return new RateLimitError(this.name);
        }
        if (lower.includes('session expired') || lower.includes('unauthorized')
            || lower.includes('authentication') || lower.includes('not logged in')
            || /\b401\b/.test(lower)) {
            return new AuthError(this.name);
        }
        if (lower.includes('timed out') || lower.includes('timeout')) {
            return new TimeoutError(this.name, 0);
        }
        // Unrecognized — plain Error so the retry engine's existing message/status
        // heuristics still apply unchanged (no behavior change for this path).
        return new Error(msg);
    }


    async _doChat(message, filePath = null, engine = null) {
        await this.ensureInitialized();

        console.error(`[${this.name}] Sending message...`);
        const sendResult = await this.ipc.send('sendMessage', this.name, {
            message, filePath, engine,
            conversationId: 'mcp-session',
        });

        if (sendResult.response && sendResult.response.length > 0) {
            console.error(`[${this.name}] ✓ Got API response (${sendResult.response.length} chars)`);
            return sendResult.response;
        }

        if (sendResult.success === false || sendResult.error) {
            throw this._classifyError(sendResult.error || `${this.name} request failed`);
        }

        throw new ProviderError(this.name, `${this.name} returned no response`, {
            code: 'EMPTY_RESPONSE', retryable: false,
        });
    }

    async chat(message, useCache = true, filePath = null, engine = null) {

        const cacheKey = `${message}\u0000${filePath || ''}\u0000${engine || ''}`;


        if (useCache && this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.time < this.cacheTimeout) {
                console.error(`[${this.name}] Using cached response`);
                return cached.response;
            }
        }

        this._queueLength++;
        const position = this._queueLength;
        if (position > 1) {
            console.error(`[${this.name}] Request queued (position ${position}). Waiting for previous to complete...`);
        }

        const responsePromise = this._queue.then(async () => {
            console.error(`[${this.name}] Processing request (${position} of ${this._queueLength})...`);
            const response = await this._doChat(message, filePath, engine);
            this.cache.set(cacheKey, { response, time: Date.now() });
            this._queueLength--;
            return response;
        }).catch((err) => {
            this._queueLength--;
            throw err;
        });


        this._queue = responsePromise.catch(() => {});

        return responsePromise;
    }

    async search(query, useCache = true) {
        return await this.chat(query, useCache);
    }

    async executeScript(script) {
        const result = await this.ipc.send('executeScript', this.name, { script });
        return result;
    }

    async newConversation() {
        await this.ipc.send('newConversation', this.name);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}


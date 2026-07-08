// Proxima — WebSocket Server.
// Bidirectional real-time gateway executing actions on logged-in providers.

const { WebSocketServer } = require('ws');
const byok = require('./byok/index.cjs');

let handleMCPRequest = null;
let getEnabledProviders = null;
let wss = null;
let security = null;
let pingInterval = null;
const clients = new Map();

const MAX_WS_CONNECTIONS = 64;
const WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const wsStats = {
    totalConnections: 0,
    activeConnections: 0,
    totalMessages: 0,
    totalErrors: 0,
    startTime: null
};

function initWebSocket(httpServer, mcpHandler, enabledProvidersFn, securityFns) {
    handleMCPRequest = mcpHandler;
    getEnabledProviders = enabledProvidersFn || (() => []);
    security = securityFns || {};
    wsStats.startTime = new Date();

    wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

    httpServer.on('upgrade', (request, socket, head) => {
        let url;
        try {
            url = new URL(request.url, `http://${request.headers.host}`);
        } catch {
            try { socket.destroy(); } catch {}
            return;
        }

        if (url.pathname !== '/ws' && url.pathname !== '/websocket') {
            socket.destroy();
            return;
        }

        // Drive-by / CSRF origin validation check.
        if (typeof security.isAllowedOrigin === 'function' && !security.isAllowedOrigin(request)) {
            console.warn('[WS] Rejected cross-origin upgrade from origin:', request.headers['origin']);
            try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch {}
            socket.destroy();
            return;
        }

        if (typeof security.isWsAuthorized === 'function' && !security.isWsAuthorized(request, url)) {
            console.warn('[WS] Rejected unauthorized upgrade (missing/invalid API key)');
            try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch {}
            socket.destroy();
            return;
        }

        if (clients.size >= MAX_WS_CONNECTIONS) {
            console.warn(`[WS] Rejected upgrade — connection limit reached (${MAX_WS_CONNECTIONS}).`);
            try { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); } catch {}
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    wss.on('connection', (ws, request) => {
        const clientId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        
        clients.set(clientId, {
            ws,
            connectedAt: new Date(),
            messageCount: 0
        });

        wsStats.totalConnections++;
        wsStats.activeConnections = clients.size;

        console.log(`[WS] Client connected: ${clientId} (${wsStats.activeConnections} active)`);

        sendJSON(ws, {
            type: 'connected',
            clientId,
            version: '5.0.0',
            message: 'Connected to Proxima WebSocket',
            timestamp: new Date().toISOString()
        });

        ws.on('message', async (raw) => {
            wsStats.totalMessages++;
            const client = clients.get(clientId);
            if (client) client.messageCount++;

            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                sendJSON(ws, { type: 'error', error: 'Invalid JSON', timestamp: new Date().toISOString() });
                return;
            }

            await handleWSMessage(ws, clientId, msg).catch((e) => {
                wsStats.totalErrors++;
                try { sendJSON(ws, { type: 'error', error: e && e.message ? e.message : String(e), timestamp: new Date().toISOString() }); } catch { }
            });
        });

        ws.on('close', () => {
            clients.delete(clientId);
            wsStats.activeConnections = clients.size;
            console.log(`[WS] Client disconnected: ${clientId} (${wsStats.activeConnections} active)`);
        });

        ws.on('error', (err) => {
            wsStats.totalErrors++;
            console.error(`[WS] Error for ${clientId}:`, err.message);
        });

        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
    });

    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    pingInterval = setInterval(() => {
        if (!wss) { clearInterval(pingInterval); pingInterval = null; return; }
        wss.clients.forEach(ws => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);
    if (pingInterval.unref) pingInterval.unref();

    console.log('[WS] WebSocket server ready on /ws');
}

function closeWebSocket() {
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
    for (const { ws } of clients.values()) {
        try { ws.terminate(); } catch {}
    }
    clients.clear();
    wsStats.activeConnections = 0;
    if (wss) {
        try { wss.close(); } catch {}
        wss = null;
    }
}

async function queryProvider(provider, message, filePath = null, engine = null, conversationId = null, modelId = null) {
    const byokKey = byok.keys.isEnabled() ? byok.keys.getKey(provider) : null;
    if (byokKey) {
        const messages = [{ role: 'user', content: message }];
        const result = await byok.callProvider(provider, byokKey, messages, {
            filePath, engine, modelId: modelId || null,
        });
        return result.text;
    }

    const sendResult = await handleMCPRequest({
        action: 'sendMessage',
        provider,
        data: { message, filePath, engine, conversationId }
    });
    
    if (!sendResult.success) {
        throw new Error(sendResult.error || `Failed to send to ${provider}`);
    }

    if (sendResult.response && sendResult.response.length > 0) {
        return sendResult.response;
    }

    return '';
}

function pickBestProvider(preferred) {
    const enabled = getEnabledProviders ? getEnabledProviders() : [];
    if (preferred && preferred !== 'auto') {
        const clean = preferred.toLowerCase().trim();
        if (['3.5-flash', '3.1-pro', '3.1-flash-lite'].includes(clean)) {
            return 'gemini';
        }
        if (clean.startsWith('gemini')) {
            return 'gemini';
        }

        if (enabled.includes(preferred)) return preferred;

        const alias = preferred.toLowerCase();
        const found = enabled.find(p => p.toLowerCase() === alias);
        if (found) return found;
        return null;
    }
    const priorityList = ['claude', 'chatgpt', 'gemini', 'perplexity', 'deepseek', 'groq', 'xai', 'openrouter', 'together', 'fireworks', 'mistral', 'nvidia'];
    const priority = priorityList.find(p => enabled.includes(p));
    if (priority) return priority;
    return enabled.length > 0 ? enabled[0] : null;
}

async function handleWSMessage(ws, clientId, msg) {
    const { action, id } = msg;
    const requestId = id || `req_${Date.now()}`;

    if (!action) {
        sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "action" field', timestamp: new Date().toISOString() });
        return;
    }

    switch (action) {
        case 'ask':
        case 'chat': {
            const { model = 'auto', message, filePath = null } = msg;
            
            let modelInput = model;
            let byokModelId = null;
            if (typeof modelInput === 'string' && modelInput.includes('@')) {
                const atIdx = modelInput.indexOf('@');
                byokModelId = modelInput.substring(atIdx + 1);
                modelInput = modelInput.substring(0, atIdx);
            }

            if (filePath && (modelInput === 'auto' || !modelInput)) {
                modelInput = 'gemini';
            }

            const provider = pickBestProvider(modelInput);
            if (!provider) {
                sendJSON(ws, { type: 'error', id: requestId, error: `Model "${modelInput}" not available. Enabled: ${(getEnabledProviders ? getEnabledProviders() : []).join(', ')}` });
                return;
            }

            if (filePath) {
                const fs = require('fs');
                if (!fs.existsSync(filePath)) {
                    sendJSON(ws, { type: 'error', id: requestId, error: `File not found at local path: ${filePath}` });
                    return;
                }
            }

            let engine = null;
            const cleanModel = String(model || 'auto').toLowerCase().trim();
            if (!byokModelId && provider === 'gemini') {
                if (['3.5-flash', '3.1-pro', '3.1-flash-lite'].includes(cleanModel)) {
                    engine = cleanModel;
                } else if (cleanModel.startsWith('gemini')) {
                    const suffix = cleanModel.replace(/^gemini-?/, '');
                    if (['3.5-flash', '3.1-pro', '3.1-flash-lite'].includes(suffix)) {
                        engine = suffix;
                    }
                }

                if (!engine) {
                    engine = filePath ? '3.1-pro' : '3.5-flash';
                }
            }

            sendJSON(ws, { type: 'status', id: requestId, status: 'processing', model: provider, timestamp: new Date().toISOString() });

            const conversationId = msg.conversationId || msg.conversation_id || msg.sessionId || msg.session_id || null;
            const startTime = Date.now();
            try {
                const content = await queryProvider(provider, message, filePath, engine, conversationId, byokModelId);
                const responseTimeMs = Date.now() - startTime;

                sendJSON(ws, {
                    type: 'response',
                    id: requestId,
                    action: 'ask',
                    model: provider,
                    content,
                    responseTimeMs,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                sendJSON(ws, { type: 'error', id: requestId, error: err.message, timestamp: new Date().toISOString() });
            }
            break;
        }

        case 'search': {
            const { query, message } = msg;
            const searchQuery = query || message;
            if (!searchQuery) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "query" or "message"' });
                return;
            }

            const provider = pickBestProvider('perplexity') || pickBestProvider('auto');
            if (!provider) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'No search provider available' });
                return;
            }

            sendJSON(ws, { type: 'status', id: requestId, status: 'searching', model: provider, timestamp: new Date().toISOString() });

            const startTime = Date.now();
            try {
                const content = await queryProvider(provider, searchQuery);
                sendJSON(ws, {
                    type: 'response',
                    id: requestId,
                    action: 'search',
                    model: provider,
                    content,
                    responseTimeMs: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                sendJSON(ws, { type: 'error', id: requestId, error: err.message });
            }
            break;
        }

        case 'code': {
            const { description, message, subaction = 'generate', language } = msg;
            const desc = description || message;
            if (!desc) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "description" or "message"' });
                return;
            }

            const provider = pickBestProvider(msg.model || 'auto');
            if (!provider) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'No provider available' });
                return;
            }

            sendJSON(ws, { type: 'status', id: requestId, status: 'coding', model: provider, timestamp: new Date().toISOString() });

            const prompts = {
                generate: `Generate ${language || ''} code for: ${desc}`,
                review: `Review this code for bugs, improvements, and best practices:\n\n${desc}`,
                explain: `Explain this code in detail:\n\n${desc}`,
                optimize: `Optimize this code for performance:\n\n${desc}`,
                debug: `Debug this code and find the issue:\n\n${desc}`
            };
            const prompt = prompts[subaction] || prompts.generate;

            const startTime = Date.now();
            try {
                const content = await queryProvider(provider, prompt);
                sendJSON(ws, {
                    type: 'response',
                    id: requestId,
                    action: 'code',
                    subaction,
                    model: provider,
                    content,
                    responseTimeMs: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                sendJSON(ws, { type: 'error', id: requestId, error: err.message });
            }
            break;
        }

        case 'translate': {
            const { text, message, to = 'English', from } = msg;
            const input = text || message;
            if (!input) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "text" or "message"' });
                return;
            }

            const provider = pickBestProvider(msg.model || 'auto');
            if (!provider) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'No provider available' });
                return;
            }

            sendJSON(ws, { type: 'status', id: requestId, status: 'translating', model: provider, timestamp: new Date().toISOString() });

            const prompt = from
                ? `Translate the following from ${from} to ${to}:\n\n${input}`
                : `Translate the following to ${to}:\n\n${input}`;

            const startTime = Date.now();
            try {
                const content = await queryProvider(provider, prompt);
                sendJSON(ws, {
                    type: 'response',
                    id: requestId,
                    action: 'translate',
                    to, from,
                    model: provider,
                    content,
                    responseTimeMs: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                sendJSON(ws, { type: 'error', id: requestId, error: err.message });
            }
            break;
        }

        case 'brainstorm': {
            const { topic, message } = msg;
            const subject = topic || message;
            if (!subject) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "topic" or "message"' });
                return;
            }

            const provider = pickBestProvider(msg.model || 'auto');
            if (!provider) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'No provider available' });
                return;
            }

            sendJSON(ws, { type: 'status', id: requestId, status: 'brainstorming', model: provider, timestamp: new Date().toISOString() });

            const prompt = `Brainstorm creative and innovative ideas about: ${subject}\n\nProvide at least 5-8 diverse ideas with brief explanations.`;

            const startTime = Date.now();
            try {
                const content = await queryProvider(provider, prompt);
                sendJSON(ws, {
                    type: 'response',
                    id: requestId,
                    action: 'brainstorm',
                    model: provider,
                    content,
                    responseTimeMs: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                sendJSON(ws, { type: 'error', id: requestId, error: err.message });
            }
            break;
        }

        case 'debate': {
            const { topic, message } = msg;
            const subject = topic || message;
            if (!subject) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "topic" or "message"' });
                return;
            }

            const enabled = getEnabledProviders ? getEnabledProviders() : [];
            if (enabled.length === 0) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'No providers available for debate' });
                return;
            }

            sendJSON(ws, { type: 'status', id: requestId, status: 'debating', providers: enabled, timestamp: new Date().toISOString() });

            const startTime = Date.now();
            const results = {};
            
            for (const provider of enabled) {
                try {
                    sendJSON(ws, { type: 'status', id: requestId, status: `asking ${provider}...`, timestamp: new Date().toISOString() });
                    const content = await queryProvider(provider, `Give your perspective on this topic. Be direct and opinionated:\n\n${subject}`);
                    results[provider] = content;
                } catch (err) {
                    results[provider] = `Error: ${err.message}`;
                }
            }

            sendJSON(ws, {
                type: 'response',
                id: requestId,
                action: 'debate',
                topic: subject,
                results,
                providers: Object.keys(results),
                responseTimeMs: Date.now() - startTime,
                timestamp: new Date().toISOString()
            });
            break;
        }

        case 'audit':
        case 'security_audit': {
            const { code, message } = msg;
            const codeInput = code || message;
            if (!codeInput) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "code" or "message"' });
                return;
            }

            const provider = pickBestProvider(msg.model || 'auto');
            if (!provider) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'No provider available' });
                return;
            }

            sendJSON(ws, { type: 'status', id: requestId, status: 'auditing', model: provider, timestamp: new Date().toISOString() });

            const prompt = `Perform a security audit on this code. Identify vulnerabilities (SQL injection, XSS, CSRF, etc.), rate severity, and suggest fixes:\n\n${codeInput}`;

            const startTime = Date.now();
            try {
                const content = await queryProvider(provider, prompt);
                sendJSON(ws, {
                    type: 'response',
                    id: requestId,
                    action: 'security_audit',
                    model: provider,
                    content,
                    responseTimeMs: Date.now() - startTime,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                sendJSON(ws, { type: 'error', id: requestId, error: err.message });
            }
            break;
        }

        case 'ping': {
            sendJSON(ws, { type: 'pong', id: requestId, timestamp: new Date().toISOString() });
            break;
        }

        case 'stats': {
            sendJSON(ws, {
                type: 'stats',
                id: requestId,
                data: {
                    ...wsStats,
                    uptime: wsStats.startTime ? Math.floor((Date.now() - wsStats.startTime) / 1000) + 's' : '0s',
                    enabledProviders: getEnabledProviders ? getEnabledProviders() : [],
                    clients: Array.from(clients.entries()).map(([id, c]) => ({
                        id,
                        connectedAt: c.connectedAt.toISOString(),
                        messages: c.messageCount
                    }))
                },
                timestamp: new Date().toISOString()
            });
            break;
        }

        case 'new_conversation':
        case 'new':
        case 'reset': {
            const requested = msg.model || null;
            if (!requested) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'A "model" (provider) is required to reset: chatgpt, claude, gemini, or perplexity.', timestamp: new Date().toISOString() });
                break;
            }
            const target = pickBestProvider(requested);
            if (!target) {
                sendJSON(ws, { type: 'error', id: requestId, error: `Unknown or disabled provider: ${requested}`, timestamp: new Date().toISOString() });
                break;
            }
            try {
                await handleMCPRequest({ action: 'newConversation', provider: target, data: {} });
                sendJSON(ws, { type: 'response', id: requestId, action: 'new_conversation', provider: target, message: `${target} conversation reset`, timestamp: new Date().toISOString() });
            } catch (err) {
                sendJSON(ws, { type: 'error', id: requestId, error: err.message });
            }
            break;
        }

        default:
            sendJSON(ws, {
                type: 'error',
                id: requestId,
                error: `Unknown action: "${action}"`,
                availableActions: ['ask', 'search', 'code', 'translate', 'brainstorm', 'debate', 'audit', 'new_conversation', 'ping', 'stats'],
                timestamp: new Date().toISOString()
            });
    }
}

function sendJSON(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(data) {
    const msg = JSON.stringify(data);
    if (wss) {
        wss.clients.forEach(ws => {
            if (ws.readyState === 1) ws.send(msg);
        });
    }
}

function getWSStats() { return wsStats; }

module.exports = { initWebSocket, closeWebSocket, broadcast, getWSStats };

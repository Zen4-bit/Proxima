// ─────────────────────────────────────────────────────
// Proxima WebSocket Server
// Real-time bidirectional AI communication
// Connects on the same HTTP server via upgrade
// ─────────────────────────────────────────────────────

const { WebSocketServer } = require('ws');

let handleMCPRequest = null;
let getEnabledProviders = null;
let wss = null;
const clients = new Map();


const wsStats = {
    totalConnections: 0,
    activeConnections: 0,
    totalMessages: 0,
    totalErrors: 0,
    startTime: null
};

// ─── Init ────────────────────────────────────────────
function initWebSocket(httpServer, mcpHandler, enabledProvidersFn) {
    handleMCPRequest = mcpHandler;
    getEnabledProviders = enabledProvidersFn || (() => []);
    wsStats.startTime = new Date();

    wss = new WebSocketServer({ noServer: true });

    // Intercept HTTP upgrade requests for /ws path
    httpServer.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        
        if (url.pathname === '/ws' || url.pathname === '/websocket') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
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

        // Send welcome message with server version
        sendJSON(ws, {
            type: 'connected',
            clientId,
            version: '4.1.0',
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

            await handleWSMessage(ws, clientId, msg);
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

        // Keepalive ping/pong
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
    });

    // Terminate stale connections every 30s
    const pingInterval = setInterval(() => {
        if (!wss) { clearInterval(pingInterval); return; }
        wss.clients.forEach(ws => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    console.log('[WS] WebSocket server ready on /ws');
}

// ─── Provider Helper ─────────────────────────────────
// Uses same handleMCPRequest format as REST API:
// { action: 'sendMessage', provider: 'claude', data: { message } }
// { action: 'getResponseWithTyping', provider: 'claude', data: {} }

async function queryProvider(provider, message) {
    const sendResult = await handleMCPRequest({
        action: 'sendMessage',
        provider,
        data: { message }
    });
    
    if (!sendResult.success) {
        throw new Error(sendResult.error || `Failed to send to ${provider}`);
    }

    // Use engine response if available, only DOM-poll when engine didn't return content
    if (sendResult.result && sendResult.result.response && sendResult.result.response.length > 0) {
        return sendResult.result.response;
    }

    const responseResult = await handleMCPRequest({
        action: 'getResponseWithTyping',
        provider,
        data: {}
    });

    return responseResult.response || responseResult.result || '';
}

function pickBestProvider(preferred) {
    const enabled = getEnabledProviders ? getEnabledProviders() : [];
    if (preferred && preferred !== 'auto') {
        if (enabled.includes(preferred)) return preferred;

        const alias = preferred.toLowerCase();
        const found = enabled.find(p => p.toLowerCase() === alias);
        if (found) return found;
        return null;
    }
    return ['claude', 'chatgpt', 'gemini', 'perplexity'].find(p => enabled.includes(p)) || null;
}

// ─── Message Handler ────────────────────────────────
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
            const { model = 'auto', message } = msg;
            if (!message) {
                sendJSON(ws, { type: 'error', id: requestId, error: 'Missing "message" field' });
                return;
            }

            const provider = pickBestProvider(model);
            if (!provider) {
                sendJSON(ws, { type: 'error', id: requestId, error: `Model "${model}" not available. Enabled: ${(getEnabledProviders ? getEnabledProviders() : []).join(', ')}` });
                return;
            }


            sendJSON(ws, { type: 'status', id: requestId, status: 'processing', model: provider, timestamp: new Date().toISOString() });

            const startTime = Date.now();
            try {
                const content = await queryProvider(provider, message);
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
            try {
                await handleMCPRequest({ action: 'newConversation', provider: msg.model || null, data: {} });
                sendJSON(ws, { type: 'response', id: requestId, action: 'new_conversation', message: 'All conversations reset', timestamp: new Date().toISOString() });
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

// ─── Helpers ─────────────────────────────────────────
function sendJSON(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

// ─── Broadcast ───────────────────────────────────────
function broadcast(data) {
    const msg = JSON.stringify(data);
    if (wss) {
        wss.clients.forEach(ws => {
            if (ws.readyState === 1) ws.send(msg);
        });
    }
}

function getWSStats() { return wsStats; }

module.exports = { initWebSocket, broadcast, getWSStats };

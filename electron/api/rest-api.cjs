// Proxima — REST API Gateway.
// OpenAI-compatible HTTP gateway for session and BYOK providers with key auth and CSRF protection.

const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');
const fs = require('fs');
const { initWebSocket, closeWebSocket } = require('./ws-server.cjs');
const { scrapeUrl } = require('../../src/tools/web-scraper.cjs');
const { searchDDG, formatResultsMarkdown } = require('../../src/tools/ddg-search.cjs');
const { buildToolCallingPrompt, parseToolCallResponse, formatToolCallResponse } = require('./tool-calling.cjs');

const byok = require('./byok/index.cjs');

const { getDocsPage } = require('./pages/docs.cjs');
const { getAPIKeyPage } = require('./pages/apikey.cjs');
const { getCLIDocsPage } = require('./pages/cli.cjs');
const { getWSDocsPage } = require('./pages/ws.cjs');

const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT) || 3210;
const VERSION = '5.0.0';
const API_PREFIX = '/v1';

const MODEL_ALIASES = {
    'chatgpt': 'chatgpt', 'gpt': 'chatgpt', 'gpt-4': 'chatgpt', 'gpt-4o': 'chatgpt',
    'gpt-4.5': 'chatgpt', 'openai': 'chatgpt',
    'claude': 'claude', 'claude-3': 'claude', 'claude-3.5': 'claude', 'claude-4': 'claude',
    'anthropic': 'claude', 'sonnet': 'claude', 'opus': 'claude', 'haiku': 'claude',
    'gemini': 'gemini', 'gemini-pro': 'gemini', 'gemini-2': 'gemini', 'gemini-2.5': 'gemini',
    'google': 'gemini', 'bard': 'gemini',
    'perplexity': 'perplexity', 'pplx': 'perplexity', 'sonar': 'perplexity',
    'auto': 'auto', 'all': 'all'
};

let handleMCPRequest = null;
let getEnabledProvidersList = null;
let httpServer = null;

const crypto = require('crypto');
const _fs = require('fs');
const _path = require('path');

function getApiKeyPath() {
    const { app } = require('electron');
    return _path.join(app.getPath('userData'), 'api-key.json');
}

let _apiKeyCache;

function loadApiKey() {
    if (_apiKeyCache !== undefined) return _apiKeyCache;
    try {
        const keyPath = getApiKeyPath();
        if (_fs.existsSync(keyPath)) { _apiKeyCache = JSON.parse(_fs.readFileSync(keyPath, 'utf8')); return _apiKeyCache; }
    } catch (e) { }
    _apiKeyCache = null;
    return null;
}

function saveApiKey(keyData) {
    _apiKeyCache = keyData;
    try { _fs.writeFileSync(getApiKeyPath(), JSON.stringify(keyData, null, 2)); }
    catch (e) { console.error('[API Key] Save failed:', e.message); }
}

function generateApiKey() {
    const key = `sk-${crypto.randomBytes(16).toString('hex')}-proxima`;
    const keyData = { key, createdAt: new Date().toISOString(), lastUsed: null, totalUses: 0 };
    saveApiKey(keyData);
    console.log('[API Key] New API key generated and saved.');
    return keyData;
}

function revokeApiKey() {
    try { const p = getApiKeyPath(); if (_fs.existsSync(p)) _fs.unlinkSync(p); _apiKeyCache = null; console.log('[API Key] Key revoked'); return true; }
    catch (e) { return false; }
}

function validateToken(token) {
    const keyData = loadApiKey();
    if (!keyData) return true;
    if (!token) return false;
    if (token === keyData.key) {
        keyData.lastUsed = new Date().toISOString();
        keyData.totalUses = (keyData.totalUses || 0) + 1;
        if ((keyData.totalUses % 20) === 0) saveApiKey(keyData);
        return true;
    }
    return false;
}

function validateApiKey(req) {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    return validateToken(token);
}

// Validate WebSocket handshake authorization using either headers or query parameters.
function isWsAuthorized(req, url) {
    const keyData = loadApiKey();
    if (!keyData) return true;

    const origin = req.headers['origin'];
    if (origin && isAllowedOrigin(req)) return true;

    let token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (!token && url && url.searchParams) {
        token = (url.searchParams.get('api_key') || url.searchParams.get('key') || '').trim();
    }
    return validateToken(token);
}

// Validate client origin for CSRF/drive-by protection.
function isAllowedOrigin(req) {
    const origin = req.headers['origin'];
    if (!origin) return true;
    try {
        const u = new URL(origin);
        const host = u.hostname;
        const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
        if (!isLoopback) return false;

        // Restrict origin port to matching local server port for secure loopback validation.
        const serverPort = req.socket && req.socket.localPort;
        if (serverPort) {
            const originPort = u.port
                ? parseInt(u.port, 10)
                : (u.protocol === 'https:' ? 443 : 80);
            if (originPort !== serverPort) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function corsHeaders(req) {
    const origin = req.headers['origin'];
    const allowOrigin = (origin && isAllowedOrigin(req)) ? origin : 'http://localhost';
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
}

const stats = { totalRequests: 0, totalErrors: 0, startTime: null, providers: {} };

function initProviderStats(p) {
    if (!stats.providers[p]) stats.providers[p] = { totalCalls: 0, totalErrors: 0, totalTimeMs: 0, avgTimeMs: 0, minTimeMs: Infinity, maxTimeMs: 0, lastCallTime: null, last5: [] };
}

function recordCall(provider, timeMs, isError = false) {
    initProviderStats(provider);
    const p = stats.providers[provider];
    p.totalCalls++; stats.totalRequests++;
    if (isError) { p.totalErrors++; stats.totalErrors++; return; }
    p.totalTimeMs += timeMs;
    p.avgTimeMs = Math.round(p.totalTimeMs / (p.totalCalls - p.totalErrors));
    if (timeMs < p.minTimeMs) p.minTimeMs = timeMs;
    if (timeMs > p.maxTimeMs) p.maxTimeMs = timeMs;
    p.lastCallTime = new Date().toISOString();
    p.last5.push(timeMs); if (p.last5.length > 5) p.last5.shift();
}

function getFormattedStats() {
    const formatted = {};
    for (const [name, d] of Object.entries(stats.providers)) {
        formatted[name] = {
            calls: d.totalCalls, errors: d.totalErrors,
            avgTime: d.avgTimeMs > 0 ? `${(d.avgTimeMs / 1000).toFixed(1)}s` : '-',
            minTime: d.minTimeMs < Infinity ? `${(d.minTimeMs / 1000).toFixed(1)}s` : '-',
            maxTime: d.maxTimeMs > 0 ? `${(d.maxTimeMs / 1000).toFixed(1)}s` : '-',
            last5: d.last5.map(t => `${(t / 1000).toFixed(1)}s`), lastCall: d.lastCallTime
        };
    }
    return { uptime: `${Math.floor(process.uptime())}s`, totalRequests: stats.totalRequests, totalErrors: stats.totalErrors, providers: formatted };
}

function initRestAPI(config) {
    handleMCPRequest = config.handleMCPRequest;
    getEnabledProvidersList = config.getEnabledProviders;
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const MAX = 10 * 1024 * 1024;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX) {
                req.destroy();
                const e = new Error('Request body too large');
                e.statusCode = 413;
                reject(e);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve(body ? JSON.parse(body) : {});
            } catch {
                const e = new Error('Invalid JSON body');
                e.statusCode = 400;
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function sendJSON(res, code, data) {
    const cors = res._proximaCors || { 'Access-Control-Allow-Origin': 'http://localhost', 'Vary': 'Origin' };
    res.writeHead(code, { 'Content-Type': 'application/json', ...cors, 'X-Powered-By': 'Proxima AI' });
    res.end(JSON.stringify(data, null, 2));
}

function sendError(res, code, msg, type = 'api_error') {
    sendJSON(res, code, { error: { message: msg, type, code }, timestamp: new Date().toISOString() });
}

function getEnabled() {
    if (byok.keys.isEnabled()) {
        return byok.keys.listConfigured();
    }
    return getEnabledProvidersList ? getEnabledProvidersList() : [];
}
function resolveModel(m) {
    if (!m) return 'auto';
    const clean = String(m).trim();

    if (clean.includes('@')) {
        return clean.toLowerCase();
    }

    const lower = clean.toLowerCase();
    
    if (lower.startsWith('gemini:')) {
        const sub = lower.split(':')[1];
        if (['3.5-flash', '3.1-pro', '3.1-flash-lite', 'auto'].includes(sub)) {
            return 'gemini:' + sub;
        }
    }
    
    if (['3.5-flash', '3.1-pro', '3.1-flash-lite'].includes(lower)) {
        return 'gemini:' + lower;
    }
    
    if (lower.startsWith('gemini-')) {
        const suffix = lower.replace('gemini-', '');
        if (['3.5-flash', '3.1-pro', '3.1-flash-lite', 'auto'].includes(suffix)) {
            return 'gemini:' + suffix;
        }
    }
    
    if (lower === 'gemini') {
        return 'gemini:auto';
    }

    return MODEL_ALIASES[lower] || lower;
}

function resolveModels(modelField, byokKey = null) {
    const enabled = getEnabled();

    function _parseResolved(resolvedStr) {
        let baseProvider, gemini = null, byokModelId = null;

        if (resolvedStr.includes('@')) {
            const atIdx = resolvedStr.indexOf('@');
            baseProvider = resolvedStr.substring(0, atIdx);
            byokModelId = resolvedStr.substring(atIdx + 1);
        } else {
            const parts = resolvedStr.split(':');
            baseProvider = parts[0];
            gemini = parts[1] || null;
        }

        return { baseProvider, gemini, byokModelId };
    }

    if (Array.isArray(modelField)) {
        const _seen = new Set();
        const resolved = modelField.map(m => {
            const resolvedStr = resolveModel(m);
            const parsed = _parseResolved(resolvedStr);
            return { resolvedStr, ...parsed };
        }).filter(item => {
            return item.baseProvider !== 'auto' && item.baseProvider !== 'all' && 
                (enabled.includes(item.baseProvider) || (byokKey && byok.keys.VALID_PROVIDERS.includes(item.baseProvider)));
        }).filter(item => {
            if (_seen.has(item.resolvedStr)) return false;
            _seen.add(item.resolvedStr);
            return true;
        });
        if (resolved.length === 0) return { mode: 'error', providers: [], error: `None of [${modelField.join(', ')}] available` };
        const geminis = resolved.map(r => r.gemini);
        const byokModelIds = resolved.map(r => r.byokModelId);
        return {
            mode: resolved.length === 1 ? 'single' : 'multi',
            providers: resolved.map(r => r.baseProvider),
            gemini: geminis[0] || null,
            geminis,
            byokModelId: byokModelIds[0] || null,
            byokModelIds,
        };
    }
    const resolved = resolveModel(modelField);
    if (resolved === 'all') return { mode: 'all', providers: enabled, gemini: null, geminis: enabled.map(() => null), byokModelId: null, byokModelIds: enabled.map(() => null) };
    if (resolved === 'auto') {
        const best = pickBestProvider();
        return best ? { mode: 'single', providers: [best], gemini: null, geminis: [null], byokModelId: null, byokModelIds: [null] } : { mode: 'error', providers: [], error: 'No providers available' };
    }
    const parsed = _parseResolved(resolved);
    if (enabled.includes(parsed.baseProvider) || (byokKey && byok.keys.VALID_PROVIDERS.includes(parsed.baseProvider))) {
        return { mode: 'single', providers: [parsed.baseProvider], gemini: parsed.gemini, geminis: [parsed.gemini], byokModelId: parsed.byokModelId, byokModelIds: [parsed.byokModelId] };
    }
    return { mode: 'error', providers: [], error: `"${modelField}" not available. Enabled: ${enabled.join(', ')}` };
}

// Mirror SmartRouter logic to dynamically skip degraded providers based on recent error rate.
function _isDegraded(providerName) {
    const p = stats.providers[providerName];
    if (!p || p.totalCalls < 3) return false;
    const errorRate = p.totalErrors / p.totalCalls;
    return errorRate > 0.5;
}

function pickBestProvider(preferred) {
    const enabled = getEnabled();
    if (preferred && preferred !== 'auto') {
        // Normalize preferred model to base provider name.
        let base = String(preferred).toLowerCase().trim();
        if (base.includes('@')) base = base.slice(0, base.indexOf('@'));
        else if (base.includes(':')) base = base.slice(0, base.indexOf(':'));
        if (['3.5-flash', '3.1-pro', '3.1-flash-lite'].includes(base) || base.startsWith('gemini')) {
            base = 'gemini';
        }
        return enabled.includes(base) ? base : null;
    }

    const priorityList = ['claude', 'chatgpt', 'gemini', 'perplexity', 'deepseek', 'groq', 'xai', 'openrouter', 'together', 'fireworks', 'mistral', 'nvidia'];
    const priority = priorityList.filter(p => enabled.includes(p));
    if (priority.length === 0) {
        return enabled.length > 0 ? enabled[0] : null;
    }
    const healthy = priority.find(p => !_isDegraded(p));
    return healthy || priority[0];
}

function extractMessage(body) {
    if (body.messages && Array.isArray(body.messages)) {
        const userMsgs = body.messages.filter(m => m.role === 'user');
        if (userMsgs.length > 0) return userMsgs[userMsgs.length - 1].content;
    }
    return body.message || body.query || body.prompt || body.content || body.text || body.question || null;
}

async function queryProvider(provider, messageOrMessages, filePath = null, gemini = null, onChunk = null, conversationId = null, byokKey = null, tools = null, byokModelId = null) {
    const effectiveKey = byokKey || (byok.keys.isEnabled() ? byok.keys.getKey(provider) : null);
    if (effectiveKey) {
        initProviderStats(provider);
        const start = Date.now();
        try {
            let history;

            if (Array.isArray(messageOrMessages)) {
                history = messageOrMessages.map(m => ({ ...m }));
            } else {
                history = [{ role: 'user', content: messageOrMessages }];
            }

            const result = await byok.callProvider(provider, effectiveKey, history, {
                filePath, engine: gemini, onChunk, tools, modelId: byokModelId || null,
            });

            const elapsed = Date.now() - start;

            if (!result.text && (!result.toolCalls || result.toolCalls.length === 0)) {
                throw new Error(`${provider} returned empty response (no text, no tool calls) after ${(elapsed/1000).toFixed(1)}s`);
            }

            recordCall(provider, elapsed);
            return { 
                text: result.text, 
                toolCalls: result.toolCalls || null,
                model: result.model || provider, 
                responseTimeMs: elapsed 
            };
        } catch (e) {
            recordCall(provider, 0, true);
            throw e;
        }
    }

    initProviderStats(provider); const start = Date.now();
    try {
        const sendResult = await handleMCPRequest({ action: 'sendMessage', provider, data: { message: messageOrMessages, filePath, gemini, onChunk, conversationId } });
        if (!sendResult.success) throw new Error(sendResult.error || `Failed to send to ${provider}`);

        let responseText = (sendResult.response && sendResult.response.length > 0) ? sendResult.response : '';

        if (!responseText) {
            const elapsed = Date.now() - start;
            throw new Error(`${provider} returned empty response after all retry attempts (${(elapsed/1000).toFixed(1)}s)`);
        }

        const elapsed = Date.now() - start; recordCall(provider, elapsed);
        return { text: responseText, model: provider, responseTimeMs: elapsed };
    } catch (e) { recordCall(provider, 0, true); throw e; }
}

async function queryMultiple(providers, message, byokKey = null, filePath = null) {
    const results = {}, timings = {};
    await Promise.all(providers.map(async p => {
        try { const r = await queryProvider(p, message, filePath, null, null, null, byokKey); results[p] = r.text; timings[p] = r.responseTimeMs; }
        catch (e) { results[p] = null; timings[p] = { error: e.message }; }
    }));
    return { results, timings, models: providers };
}

function estimateTokens(t) { return t ? Math.ceil(t.length / 4) : 0; }

function formatChatResponse(result, model) {
    const ct = estimateTokens(result.text);
    return {
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: result.model || model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: ct, total_tokens: ct },
        proxima: { provider: result.model, responseTimeMs: result.responseTimeMs }
    };
}

function sendStreamResponse(res, text, model) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...(res._proximaCors || {}) });
    const id = `chatcmpl-${Date.now()}`, created = Math.floor(Date.now() / 1000);
    for (let i = 0; i < text.length; i += 20) {
        if (res.destroyed || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text.slice(i, i + 20) }, finish_reason: null }] })}\n\n`);
    }
    if (res.destroyed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
}

function sendStreamToolCallResponse(res, toolCalls, model) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...(res._proximaCors || {}) });
    const id = `chatcmpl-${Date.now()}`, created = Math.floor(Date.now() / 1000);
    const deltas = toolCalls.map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }));
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: deltas }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
}

function formatAllResponse(allResults) {
    const choices = []; let i = 0;
    for (const [provider, text] of Object.entries(allResults.results)) {
        if (text) choices.push({ index: i++, message: { role: 'assistant', content: text }, finish_reason: 'stop', model: provider, responseTimeMs: allResults.timings[provider] });
    }
    return { id: `proxima-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'all', choices, proxima: { providers: allResults.models, timings: allResults.timings } };
}

const { createRouteHandler } = require('./routes.cjs');
const handleRoute = createRouteHandler({
    API_PREFIX, VERSION, MODEL_ALIASES,
    sendJSON, sendError, getEnabled, resolveModel, resolveModels, pickBestProvider, extractMessage,
    queryProvider, queryMultiple, formatChatResponse, formatAllResponse, sendStreamResponse, sendStreamToolCallResponse,
    getFormattedStats, handleMCPRequest: () => handleMCPRequest, loadApiKey,
    getDocsPage, getAPIKeyPage, getCLIDocsPage, getWSDocsPage,
    scrapeUrl, searchDDG, formatResultsMarkdown,
    buildToolCallingPrompt, parseToolCallResponse, formatToolCallResponse,
    byok,
});

let agentUiProcess = null;

const pythonEnv = require('../python-env.cjs');

function getPythonExecutable() {
    const resolved = pythonEnv.resolveInterpreter();
    if (resolved) return resolved;
    return process.platform === 'win32' ? 'python' : 'python3';
}

function getAgentWorkingDir() {
    const agentDir = pythonEnv.getAgentSourceDir();
    return agentDir && fs.existsSync(agentDir) ? agentDir : process.cwd();
}

function startAgentUiServer() {
    if (agentUiProcess) {
        console.log('[Agent Web UI] Server already running');
        return;
    }
    
    const pyExe = getPythonExecutable();
    const agentDir = getAgentWorkingDir();
    
    console.log(`[Agent Web UI] Spawning Web UI server using Python: ${pyExe}`);
    
    agentUiProcess = spawn(pyExe, ['-m', 'proxima_agent.web'], {
        cwd: agentDir,
        env: (() => {
            const env = { ...process.env };
            delete env.PYTHONPATH;
            delete env.PYTHONHOME;
            env.PYTHONIOENCODING = 'utf-8';
            env.PYTHONUNBUFFERED = '1';
            return env;
        })()
    });
    
    agentUiProcess.stdout.on('data', (data) => {
        console.log(`[Agent Web UI stdout] ${data.toString().trim()}`);
    });
    
    agentUiProcess.stderr.on('data', (data) => {
        console.error(`[Agent Web UI stderr] ${data.toString().trim()}`);
    });
    
    agentUiProcess.on('close', (code) => {
        console.log(`[Agent Web UI] Process exited with code ${code}`);
        agentUiProcess = null;
    });

    agentUiProcess.on('error', (err) => {
        console.error('[Agent Web UI] Failed to spawn process:', err.message);
        agentUiProcess = null;
    });
}

function stopAgentUiServer() {
    if (agentUiProcess) {
        console.log('[Agent Web UI] Stopping Web UI server...');
        agentUiProcess.kill();
        agentUiProcess = null;
    }
}

process.on('exit', () => {
    stopAgentUiServer();
});

function startRestAPI() {
    if (!handleMCPRequest) { console.error('[API] Not initialized'); return; }

    try {
        startAgentUiServer();
    } catch (err) {
        console.error('[Agent Web UI] Failed to start:', err.message);
    }

    httpServer = http.createServer(async (req, res) => {
        res._proximaCors = corsHeaders(req);

        if (req.method === 'OPTIONS') {
            res.writeHead(204, { ...res._proximaCors, 'Access-Control-Max-Age': '86400' });
            return res.end();
        }

        if (!isAllowedOrigin(req)) {
            return sendError(res, 403, 'Cross-origin requests are not allowed', 'forbidden');
        }

        const url = new URL(req.url, `http://localhost:${REST_PORT}`);
        const publicPaths = ['/', '/docs', '/cli', '/ws', '/websocket', '/openapi.json', '/v1/openapi.json', '/api-key', '/v1/byok/models', '/v1/models', '/v1/stats', '/v1/functions'];
        if (!publicPaths.includes(url.pathname) && !validateApiKey(req)) {
            return sendError(res, 401, 'Invalid or missing API key', 'authentication_error');
        }
        try {
            const body = req.method === 'POST' ? await parseBody(req) : {};
            const providerKey = (req.headers['x-provider-key'] || '').trim();
            if (providerKey) body._byokKey = providerKey;
            await handleRoute(req.method, url.pathname, body, res);
        } catch (err) { console.error('[API] Error:', err.message); if (!res.headersSent) sendError(res, err.statusCode || 500, err.message); }
    });

    const onListening = () => {
        stats.startTime = new Date();
        const boundPort = (httpServer.address() && httpServer.address().port) || REST_PORT;
        console.log(`[API] Proxima API v${VERSION} at http://localhost:${boundPort}`);
        try { initWebSocket(httpServer, handleMCPRequest, getEnabled, { isAllowedOrigin, isWsAuthorized }); console.log(`[API] WebSocket at ws://localhost:${boundPort}/ws`); }
        catch (err) { console.error('[API] WebSocket init failed:', err.message); }
    };

    const MAX_PORT_ATTEMPTS = 20;
    let _portAttempt = 0;

    httpServer.listen(REST_PORT, '127.0.0.1', onListening);

    httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            if (_portAttempt < MAX_PORT_ATTEMPTS) {
                const busyPort = REST_PORT + _portAttempt;
                _portAttempt++;
                const nextPort = REST_PORT + _portAttempt;
                console.error(`[API] Port ${busyPort} in use, trying ${nextPort}`);
                httpServer.listen(nextPort, '127.0.0.1', onListening);
            } else {
                console.error(`[API] Could not bind any port in range ${REST_PORT}-${REST_PORT + MAX_PORT_ATTEMPTS}. Giving up.`);
            }
        } else {
            console.error('[API] Error:', err.message);
        }
    });
    return httpServer;
}

function stopRestAPI() {
    try {
        stopAgentUiServer();
    } catch (err) {
        console.error('[Agent Web UI] Failed to stop:', err.message);
    }
    try { closeWebSocket(); } catch (err) { console.error('[API] WS close failed:', err.message); }
    if (httpServer) {
        httpServer.close(() => console.log('[API] Stopped'));
        httpServer = null;
    }
}
function isRestAPIRunning() { return httpServer !== null && httpServer.listening; }

module.exports = { initRestAPI, startRestAPI, stopRestAPI, isRestAPIRunning, generateApiKey, revokeApiKey, loadApiKey, byok };

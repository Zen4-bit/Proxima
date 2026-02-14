// Proxima REST API — OpenAI-compatible gateway for all providers
// POST /v1/chat/completions  { "model": "claude", "messages": [...] }

const http = require('http');
const { URL } = require('url');

// ─── Config ──────────────────────────────────────────────
const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT) || 3210;
const VERSION = '2.1.0';
const API_PREFIX = '/v1';

// ─── Model Aliases ───────────────────────────────────────
// Users can use any of these names to refer to a provider
const MODEL_ALIASES = {
    // ChatGPT
    'chatgpt': 'chatgpt', 'gpt': 'chatgpt', 'gpt-4': 'chatgpt', 'gpt-4o': 'chatgpt',
    'gpt-4.5': 'chatgpt', 'openai': 'chatgpt',

    // Claude
    'claude': 'claude', 'claude-3': 'claude', 'claude-3.5': 'claude', 'claude-4': 'claude',
    'anthropic': 'claude', 'sonnet': 'claude', 'opus': 'claude', 'haiku': 'claude',

    // Gemini
    'gemini': 'gemini', 'gemini-pro': 'gemini', 'gemini-2': 'gemini', 'gemini-2.5': 'gemini',
    'google': 'gemini', 'bard': 'gemini',

    // Perplexity
    'perplexity': 'perplexity', 'pplx': 'perplexity', 'sonar': 'perplexity',

    // Special
    'auto': 'auto',   // Auto-pick best available
    'all': 'all'       // Query all providers
};

// ─── State ───────────────────────────────────────────────
let handleMCPRequest = null;
let getEnabledProvidersList = null;
let httpServer = null;

// ─── Response Time Tracking ──────────────────────────────
const stats = {
    totalRequests: 0,
    totalErrors: 0,
    startTime: null,
    providers: {}
};

function initProviderStats(provider) {
    if (!stats.providers[provider]) {
        stats.providers[provider] = {
            totalCalls: 0, totalErrors: 0, totalTimeMs: 0,
            avgTimeMs: 0, minTimeMs: Infinity, maxTimeMs: 0,
            lastCallTime: null, last5: []
        };
    }
}

function recordCall(provider, timeMs, isError = false) {
    initProviderStats(provider);
    const p = stats.providers[provider];
    p.totalCalls++;
    stats.totalRequests++;
    if (isError) { p.totalErrors++; stats.totalErrors++; return; }
    p.totalTimeMs += timeMs;
    p.avgTimeMs = Math.round(p.totalTimeMs / (p.totalCalls - p.totalErrors));
    if (timeMs < p.minTimeMs) p.minTimeMs = timeMs;
    if (timeMs > p.maxTimeMs) p.maxTimeMs = timeMs;
    p.lastCallTime = new Date().toISOString();
    p.last5.push(timeMs);
    if (p.last5.length > 5) p.last5.shift();
}

function getFormattedStats() {
    const formatted = {};
    for (const [name, d] of Object.entries(stats.providers)) {
        formatted[name] = {
            calls: d.totalCalls, errors: d.totalErrors,
            avgTime: d.avgTimeMs > 0 ? `${(d.avgTimeMs / 1000).toFixed(1)}s` : '-',
            minTime: d.minTimeMs < Infinity ? `${(d.minTimeMs / 1000).toFixed(1)}s` : '-',
            maxTime: d.maxTimeMs > 0 ? `${(d.maxTimeMs / 1000).toFixed(1)}s` : '-',
            last5: d.last5.map(t => `${(t / 1000).toFixed(1)}s`),
            lastCall: d.lastCallTime
        };
    }
    return {
        uptime: `${Math.floor(process.uptime())}s`,
        totalRequests: stats.totalRequests,
        totalErrors: stats.totalErrors,
        providers: formatted
    };
}

// ─── Init ────────────────────────────────────────────────
function initRestAPI(config) {
    handleMCPRequest = config.handleMCPRequest;
    getEnabledProvidersList = config.getEnabledProviders;
}

// ─── Helpers ─────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit
        req.on('data', chunk => {
            body += chunk;
            if (body.length > MAX_BODY_SIZE) {
                req.destroy();
                reject(new Error('Request body too large (max 10MB)'));
            }
        });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

function sendJSON(res, code, data) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'X-Powered-By': 'Proxima AI'
    });
    res.end(JSON.stringify(data, null, 2));
}

function sendError(res, code, msg, type = 'api_error') {
    sendJSON(res, code, {
        error: { message: msg, type, code },
        timestamp: new Date().toISOString()
    });
}

function getEnabled() {
    return getEnabledProvidersList ? getEnabledProvidersList() : [];
}

function resolveModel(model) {
    if (!model) return 'auto';
    const key = String(model).toLowerCase().trim();
    return MODEL_ALIASES[key] || key;
}

// Resolve model(s) — supports string OR array
// Returns: { mode: 'single'|'multi'|'all'|'auto', providers: [...] }
function resolveModels(modelField) {
    const enabled = getEnabled();

    // Array of models: ["claude", "chatgpt"]
    if (Array.isArray(modelField)) {
        const resolved = modelField
            .map(m => resolveModel(m))
            .filter(m => m !== 'auto' && m !== 'all')
            .filter(m => enabled.includes(m));
        const unique = [...new Set(resolved)];
        if (unique.length === 0) {
            return { mode: 'error', providers: [], error: `None of [${modelField.join(', ')}] are available. Enabled: ${enabled.join(', ')}` };
        }
        return { mode: unique.length === 1 ? 'single' : 'multi', providers: unique };
    }

    // String
    const resolved = resolveModel(modelField);

    if (resolved === 'all') {
        return { mode: 'all', providers: enabled };
    }
    if (resolved === 'auto') {
        const best = pickBestProvider();
        if (!best) return { mode: 'error', providers: [], error: 'No providers available' };
        return { mode: 'single', providers: [best] };
    }
    if (enabled.includes(resolved)) {
        return { mode: 'single', providers: [resolved] };
    }
    return { mode: 'error', providers: [], error: `Model "${modelField}" not available. Enabled: ${enabled.join(', ')}` };
}

function pickBestProvider(preferred) {
    const enabled = getEnabled();
    if (preferred && preferred !== 'auto') {
        if (enabled.includes(preferred)) return preferred;
        return null;
    }
    return ['claude', 'chatgpt', 'gemini', 'perplexity'].find(p => enabled.includes(p)) || null;
}

function extractMessage(body) {
    // Support multiple formats:
    // 1. OpenAI format: { messages: [{role: "user", content: "Hello"}] }
    // 2. Simple format: { message: "Hello" }
    // 3. Query format:  { query: "Hello" }
    // 4. Prompt format: { prompt: "Hello" }
    // 5. Content format: { content: "Hello" }

    if (body.messages && Array.isArray(body.messages)) {
        // OpenAI format — get last user message
        const userMsgs = body.messages.filter(m => m.role === 'user');
        if (userMsgs.length > 0) return userMsgs[userMsgs.length - 1].content;
    }
    return body.message || body.query || body.prompt || body.content || body.text || body.question || null;
}

// ─── Core: Send to Provider with Timing ──────────────────
async function queryProvider(provider, message) {
    initProviderStats(provider);
    const start = Date.now();

    try {
        const sendResult = await handleMCPRequest({
            action: 'sendMessage', provider, data: { message }
        });
        if (!sendResult.success) throw new Error(sendResult.error || `Failed to send to ${provider}`);

        const responseResult = await handleMCPRequest({
            action: 'getResponseWithTyping', provider, data: {}
        });

        const elapsed = Date.now() - start;
        recordCall(provider, elapsed);
        return {
            text: responseResult.response || responseResult.result || '',
            model: provider,
            responseTimeMs: elapsed
        };
    } catch (e) {
        recordCall(provider, 0, true);
        throw e;
    }
}

async function queryProviderWithFile(provider, message, filePath) {
    initProviderStats(provider);
    const start = Date.now();

    try {
        const result = await handleMCPRequest({
            action: 'sendMessageWithFile', provider, data: { message, filePath }
        });
        const elapsed = Date.now() - start;
        recordCall(provider, elapsed);
        return { text: result.response || '', model: provider, responseTimeMs: elapsed };
    } catch (e) {
        recordCall(provider, 0, true);
        throw e;
    }
}

async function queryAll(message) {
    return queryMultiple(getEnabled(), message);
}

async function queryMultiple(providers, message) {
    const results = {};
    const timings = {};

    await Promise.all(providers.map(async provider => {
        try {
            const r = await queryProvider(provider, message);
            results[provider] = r.text;
            timings[provider] = r.responseTimeMs;
        } catch (e) {
            results[provider] = null;
            timings[provider] = { error: e.message };
        }
    }));

    return { results, timings, models: providers };
}

// ─── OpenAI-Compatible Response Format ───────────────────
function formatChatResponse(result, model) {
    return {
        id: `proxima-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: result.text },
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: 0, // Not tracked in DOM scraping mode
            completion_tokens: 0,
            total_tokens: 0
        },
        proxima: {
            provider: result.model,
            responseTimeMs: result.responseTimeMs
        }
    };
}

function formatAllResponse(allResults) {
    const choices = [];
    let i = 0;
    for (const [provider, text] of Object.entries(allResults.results)) {
        if (text) {
            choices.push({
                index: i++,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop',
                model: provider,
                responseTimeMs: allResults.timings[provider]
            });
        }
    }
    return {
        id: `proxima-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'all',
        choices,
        proxima: { providers: allResults.models, timings: allResults.timings }
    };
}

// ─── API Docs HTML ───────────────────────────────────────
function getDocsPage() {
    const enabled = getEnabled();
    const s = getFormattedStats();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxima API</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Inter',sans-serif;background:#08080d;color:#d4d4e0;min-height:100vh;line-height:1.6}
        .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(139,92,246,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,.025) 1px,transparent 1px);background-size:60px 60px}
        .wrap{max-width:920px;margin:0 auto;padding:36px 20px;position:relative;z-index:1}
        .head{text-align:center;margin-bottom:32px}
        .logo{font-size:42px;font-weight:700;background:linear-gradient(135deg,#a78bfa,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .sub{color:#666;font-size:14px;margin-top:2px}
        .chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px}
        .chip{display:flex;align-items:center;gap:5px;padding:4px 11px;border-radius:16px;font-size:11px;font-weight:500;background:rgba(139,92,246,.06);border:1px solid rgba(139,92,246,.12)}
        .chip.on .d{background:#22c55e;box-shadow:0 0 6px #22c55e}.chip.off .d{background:#ef4444}
        .d{width:6px;height:6px;border-radius:50%}
        .line{height:1px;background:linear-gradient(90deg,transparent,rgba(139,92,246,.3),transparent);margin:24px 0}
        .sec{margin-bottom:24px}
        .st{font-size:16px;font-weight:600;color:#a78bfa;margin-bottom:10px}
        .card{background:rgba(16,16,24,.85);border:1px solid rgba(139,92,246,.1);border-radius:8px;padding:14px 16px;margin-bottom:5px;transition:border-color .2s}
        .card:hover{border-color:rgba(139,92,246,.3)}
        .row{display:flex;align-items:center;gap:8px}
        .m{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;min-width:36px;text-align:center}
        .m.g{background:rgba(34,197,94,.1);color:#22c55e}.m.p{background:rgba(59,130,246,.1);color:#3b82f6}
        .ep{font-family:'JetBrains Mono',monospace;font-size:12px;color:#c4b5fd}.ds{color:#555;font-size:11px;margin-left:auto}
        .sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
        .sc{background:rgba(16,16,24,.85);border:1px solid rgba(139,92,246,.1);border-radius:8px;padding:12px 14px}
        .sl{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
        .sv{font-size:22px;font-weight:700;color:#c4b5fd;margin-top:2px}
        .ss{color:#444;font-size:10px;margin-top:1px}
        .ex{background:rgba(6,6,12,.9);border:1px solid rgba(139,92,246,.12);border-radius:8px;padding:14px;margin-top:5px}
        .ex h4{color:#a78bfa;font-size:10px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}
        pre{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5;color:#a5b4fc;white-space:pre-wrap}
        .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.15);margin-left:8px}
        .foot{text-align:center;margin-top:36px;color:#333;font-size:11px}
        .ar{color:#444;font-size:10px;margin-top:6px}
        .highlight{background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.2);border-radius:8px;padding:16px;margin:12px 0}
        .highlight h3{color:#a78bfa;font-size:14px;margin-bottom:6px}
        .highlight p{color:#888;font-size:12px}
        .model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px;margin-top:8px}
        .model-item{font-family:'JetBrains Mono',monospace;font-size:11px;color:#a5b4fc;padding:4px 8px;background:rgba(139,92,246,.04);border-radius:4px}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="head">
            <div class="logo">⚡ Proxima API</div>
            <p class="sub">Unified AI Gateway · Port ${REST_PORT} · v${VERSION}</p>
            <div class="chips">
                ${['perplexity', 'chatgpt', 'claude', 'gemini'].map(p =>
        `<div class="chip ${enabled.includes(p) ? 'on' : 'off'}"><div class="d"></div>${p[0].toUpperCase() + p.slice(1)}</div>`
    ).join('')}
            </div>
        </div>

        <div class="highlight">
            <h3>🎯 ONE Endpoint — Everything</h3>
            <p>Same URL for chat, search, translate, code, analyze. Use <code>"function"</code> field to change behavior.</p>
            <pre style="margin-top:8px">
POST /v1/chat/completions

// Chat
{"model": "claude", "message": "Hello"}

// Search — add "function": "search"
{"model": "perplexity", "message": "AI news", "function": "search"}

// Translate — add "function": "translate" + "to"
{"model": "gemini", "message": "Hello", "function": "translate", "to": "Hindi"}

// Code — add "function": "code"
{"model": "claude", "message": "Sort algo", "function": "code"}</pre>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📊 Live Stats</div>
            <div class="sg">
                <div class="sc"><div class="sl">Requests</div><div class="sv">${s.totalRequests}</div><div class="ss">${s.totalErrors} errors</div></div>
                <div class="sc"><div class="sl">Uptime</div><div class="sv">${s.uptime}</div></div>
                ${Object.entries(s.providers).map(([n, d]) => `<div class="sc"><div class="sl">${n[0].toUpperCase() + n.slice(1)}</div><div class="sv">${d.avgTime}</div><div class="ss">${d.calls} calls · ${d.minTime}–${d.maxTime}</div></div>`).join('')}
            </div>
            <div class="ar">Auto-refreshes every 10s</div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🤖 Models</div>
            <div class="model-grid">
                <div class="model-item" style="border:1px solid rgba(34,197,94,.15)">chatgpt · gpt-4 · openai</div>
                <div class="model-item" style="border:1px solid rgba(249,115,22,.15)">claude · sonnet · anthropic</div>
                <div class="model-item" style="border:1px solid rgba(59,130,246,.15)">gemini · google · bard</div>
                <div class="model-item" style="border:1px solid rgba(168,85,247,.15)">perplexity · pplx · sonar</div>
                <div class="model-item">auto → best available</div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">⚡ Functions (same endpoint, different body)</div>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#22c55e;font-weight:600">chat</td><td style="padding:8px">No function field needed</td><td style="padding:8px;color:#888">Default</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#3b82f6;font-weight:600">search</td><td style="padding:8px">"function": "search"</td><td style="padding:8px;color:#888">Web search + AI</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#f97316;font-weight:600">translate</td><td style="padding:8px">"function": "translate", "to": "Hindi"</td><td style="padding:8px;color:#888">Translate text</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#a855f7;font-weight:600">brainstorm</td><td style="padding:8px">"function": "brainstorm"</td><td style="padding:8px;color:#888">Generate ideas</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#ef4444;font-weight:600">code</td><td style="padding:8px">"function": "code", "action": "generate|review|debug|explain"</td><td style="padding:8px;color:#888">Code tools</td></tr>
            <tr><td style="padding:8px;color:#06b6d4;font-weight:600">analyze</td><td style="padding:8px">"function": "analyze", "url": "..."</td><td style="padding:8px;color:#888">Analyze URL/content</td></tr>
            </table>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📖 Examples — ALL use same URL</div>
            <div class="ex">
                <h4>Chat</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "claude", "message": "What is AI?"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Search (same URL, add function)</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -d '{"model": "perplexity", "message": "AI news 2026", "function": "search"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Translate (same URL, add function + to)</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -d '{"model": "gemini", "message": "Hello world", "function": "translate", "to": "Hindi"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Code Generate (same URL, add function + action)</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -d '{"model": "claude", "message": "Sort algorithm", "function": "code", "action": "generate", "language": "Python"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Any Model — Same Pattern</h4>
                <pre>// ChatGPT se search
{"model": "chatgpt", "message": "AI trends", "function": "search"}

// Gemini se code
{"model": "gemini", "message": "REST API", "function": "code"}

// Perplexity se chat
{"model": "perplexity", "message": "Explain quantum computing"}

// Auto pick — har cheez ke liye
{"model": "auto", "message": "Hello"}</pre>
            </div>
        </div>

        <div class="foot">Proxima API v${VERSION} — Zen4-bit ⚡</div>
    </div>
    <script>setTimeout(()=>location.reload(),10000);</script>
</body>
</html>`;
}

// ─── Route Handler ───────────────────────────────────────
async function handleRoute(method, pathname, body, res) {

    // Main endpoint — everything goes through here
    // The "function" field in the body determines what happens
    if (method === 'POST' && pathname === `${API_PREFIX}/chat/completions`) {
        const fn = (body.function || '').toLowerCase().trim();
        const modelInput = body.model || 'auto';
        const resolved = resolveModels(modelInput);

        if (resolved.mode === 'error') {
            return sendError(res, 404, resolved.error, 'model_not_found');
        }

        // Helper: run prompt on resolved models
        async function run(prompt, defaultModel, extraFields = {}) {
            const input = body.model || defaultModel || 'auto';
            const r = resolveModels(input);
            if (r.mode === 'error') return sendError(res, 404, r.error);
            try {
                if (r.mode === 'single') {
                    const result = await queryProvider(r.providers[0], prompt);
                    sendJSON(res, 200, { ...formatChatResponse(result, r.providers[0]), ...extraFields });
                } else {
                    const multi = await queryMultiple(r.providers, prompt);
                    sendJSON(res, 200, { ...formatAllResponse(multi), ...extraFields });
                }
            } catch (e) { sendError(res, 500, e.message); }
        }

        // ── function: "search" ──
        if (fn === 'search') {
            const q = body.query || extractMessage(body);
            if (!q) return sendError(res, 400, 'message or query required');
            return run(q, 'perplexity', { function: 'search' });
        }

        // ── function: "translate" ──
        if (fn === 'translate') {
            const text = body.text || extractMessage(body);
            const to = body.to || body.targetLanguage;
            if (!text) return sendError(res, 400, 'message or text required');
            if (!to) return sendError(res, 400, '"to" field required (target language)');
            const from = body.from || body.sourceLanguage || '';
            const prompt = `Translate the following${from ? ` from ${from}` : ''} to ${to}. Only output the translation:\n\n${text}`;
            return run(prompt, 'auto', { function: 'translate', original: text, to });
        }

        // ── function: "brainstorm" ──
        if (fn === 'brainstorm') {
            const topic = body.topic || extractMessage(body);
            if (!topic) return sendError(res, 400, 'message or topic required');
            const prompt = `Brainstorm creative ideas for: ${topic}\n\nProvide diverse, practical suggestions.`;
            return run(prompt, 'auto', { function: 'brainstorm', topic });
        }

        // ── function: "code" ──
        if (fn === 'code') {
            const action = body.action || 'generate';
            let prompt;
            switch (action) {
                case 'generate': {
                    const desc = body.description || extractMessage(body);
                    if (!desc) return sendError(res, 400, 'message or description required');
                    prompt = `Generate ${body.language || 'JavaScript'} code:\n${desc}\n\nProvide clean, production-ready code.`;
                    break;
                }
                case 'review':
                    if (!body.code) return sendError(res, 400, 'code field required');
                    prompt = `Review this ${body.language || ''} code for bugs, performance, security:\n\`\`\`${body.language || ''}\n${body.code}\n\`\`\``;
                    break;
                case 'debug':
                    if (!body.code && !body.error) return sendError(res, 400, 'code or error required');
                    prompt = 'Debug:\n';
                    if (body.code) prompt += `\`\`\`${body.language || ''}\n${body.code}\n\`\`\`\n`;
                    if (body.error) prompt += `Error: ${body.error}\n`;
                    prompt += 'Identify the bug, explain, and fix.';
                    break;
                case 'explain':
                    if (!body.code) return sendError(res, 400, 'code field required');
                    prompt = `Explain this ${body.language || ''} code:\n\`\`\`${body.language || ''}\n${body.code}\n\`\`\``;
                    break;
                default:
                    return sendError(res, 400, `Unknown action: ${action}. Use: generate, review, debug, explain`);
            }
            return run(prompt, 'claude', { function: 'code', action });
        }

        // ── function: "analyze" ──
        if (fn === 'analyze') {
            const url = body.url;
            const content = url || extractMessage(body);
            if (!content) return sendError(res, 400, 'message, url, or content required');
            const prompt = url
                ? `Analyze this URL: ${url}${body.question ? `\nQuestion: ${body.question}` : ''}${body.focus ? `\nFocus: ${body.focus}` : ''}`
                : `Analyze: ${content}${body.question ? `\nQuestion: ${body.question}` : ''}`;
            return run(prompt, url ? 'perplexity' : 'auto', { function: 'analyze' });
        }

        // ── No function = Normal Chat (default) ──
        const message = extractMessage(body);
        if (!message) return sendError(res, 400, 'No message provided. Use "messages" array or "message" field.');

        try {
            if (resolved.mode === 'single') {
                const provider = resolved.providers[0];
                const result = body.file
                    ? await queryProviderWithFile(provider, message, body.file)
                    : await queryProvider(provider, message);
                sendJSON(res, 200, formatChatResponse(result, provider));
            } else {
                const multiResults = await queryMultiple(resolved.providers, message);
                sendJSON(res, 200, formatAllResponse(multiResults));
            }
        } catch (e) {
            sendError(res, 500, e.message);
        }
        return;
    }

    // /v1/models
    if (method === 'GET' && pathname === `${API_PREFIX}/models`) {
        const enabled = getEnabled();
        const models = enabled.map(p => ({
            id: p, object: 'model', created: Math.floor(Date.now() / 1000),
            owned_by: 'proxima', status: 'enabled',
            aliases: Object.entries(MODEL_ALIASES).filter(([_, v]) => v === p).map(([k]) => k).filter(k => k !== p)
        }));
        // Also show disabled ones
        const allProviders = ['chatgpt', 'claude', 'gemini', 'perplexity'];
        allProviders.filter(p => !enabled.includes(p)).forEach(p => {
            models.push({
                id: p, object: 'model', owned_by: 'proxima', status: 'disabled',
                aliases: Object.entries(MODEL_ALIASES).filter(([_, v]) => v === p).map(([k]) => k).filter(k => k !== p)
            });
        });
        models.push({ id: 'auto', object: 'model', owned_by: 'proxima', description: 'Auto-picks best available model' });
        sendJSON(res, 200, { object: 'list', data: models });
        return;
    }

    // /v1/functions
    if (method === 'GET' && pathname === `${API_PREFIX}/functions`) {
        sendJSON(res, 200, {
            version: VERSION,
            endpoint: 'POST /v1/chat/completions',
            description: 'ONE endpoint for everything. Use the "function" field to change behavior.',
            models: { available: getEnabled(), aliases: MODEL_ALIASES },
            functions: {
                chat: {
                    description: 'Normal chat (default when no function specified)',
                    body: { model: 'string', message: 'string' },
                    example: { model: 'claude', message: 'Hello' }
                },
                search: {
                    description: 'Web search with AI analysis',
                    body: { model: 'string', message: 'string', function: 'search' },
                    example: { model: 'perplexity', message: 'AI news 2026', function: 'search' }
                },
                translate: {
                    description: 'Translate text to another language',
                    body: { model: 'string', message: 'string', function: 'translate', to: 'string' },
                    optional: { from: 'source language (auto-detected if omitted)' },
                    example: { model: 'auto', message: 'Hello world', function: 'translate', to: 'Hindi' }
                },
                brainstorm: {
                    description: 'Generate creative ideas',
                    body: { model: 'string', message: 'string', function: 'brainstorm' },
                    example: { model: 'auto', message: 'Startup ideas', function: 'brainstorm' }
                },
                code: {
                    description: 'Code generate / review / debug / explain',
                    body: { model: 'string', message: 'string', function: 'code', action: 'generate|review|debug|explain' },
                    optional: { language: 'programming language', code: 'existing code', error: 'error message' },
                    examples: [
                        { model: 'claude', message: 'Sort algorithm', function: 'code', action: 'generate', language: 'Python' },
                        { model: 'claude', function: 'code', action: 'review', code: 'def add(a,b): return a+b' },
                        { model: 'claude', function: 'code', action: 'debug', code: 'print(1/0)', error: 'ZeroDivisionError' }
                    ]
                },
                analyze: {
                    description: 'Analyze a URL or content',
                    body: { model: 'string', message: 'string or url', function: 'analyze' },
                    optional: { url: 'URL to analyze', question: 'specific question', focus: 'focus area' },
                    example: { model: 'perplexity', function: 'analyze', url: 'https://example.com', question: 'What is this?' }
                }
            }
        });
        return;
    }

    // (removed — logic is now inside /v1/chat/completions)
    // async function runOnModels(modelInput, prompt, defaultModel, extraFields = {}) {
    //     // Default model if not specified
    //     const input = modelInput || defaultModel || 'auto';
    //     const resolved = resolveModels(input);

    //     if (resolved.mode === 'error') {
    //         return { error: true, code: 404, message: resolved.error };
    //     }

    //     try {
    //         if (resolved.mode === 'single') {
    //             const r = await queryProvider(resolved.providers[0], prompt);
    //             return { error: false, response: { ...formatChatResponse(r, resolved.providers[0]), ...extraFields } };
    //         } else {
    //             const multiResults = await queryMultiple(resolved.providers, prompt);
    //             return { error: false, response: { ...formatAllResponse(multiResults), ...extraFields } };
    //         }
    //     } catch (e) {
    //         return { error: true, code: 500, message: e.message };
    //     }
    // }

    // Old tool endpoints (consolidated into /v1/chat/completions)

    // ── Search ──
    // if (method === 'POST' && pathname === `${API_PREFIX}/tools/search`) {
    //     const q = extractMessage(body);
    //     if (!q) return sendError(res, 400, 'Query required');
    //     const result = await runOnModels(body.model, q, 'perplexity', { tool: 'search' });
    //     if (result.error) return sendError(res, result.code, result.message);
    //     sendJSON(res, 200, result.response);
    //     return;
    // }

    // ── Translate ──
    // if (method === 'POST' && pathname === `${API_PREFIX}/tools/translate`) {
    //     const { text, targetLanguage, sourceLanguage } = body;
    //     if (!text) return sendError(res, 400, 'text required');
    //     if (!targetLanguage) return sendError(res, 400, 'targetLanguage required');
    //     const prompt = `Translate the following${sourceLanguage ? ` from ${sourceLanguage}` : ''} to ${targetLanguage}. Only output the translation:\n\n${text}`;
    //     const result = await runOnModels(body.model, prompt, 'auto', { tool: 'translate', original: text, targetLanguage });
    //     if (result.error) return sendError(res, result.code, result.message);
    //     sendJSON(res, 200, result.response);
    //     return;
    // }

    // ── Brainstorm ──
    // if (method === 'POST' && pathname === `${API_PREFIX}/tools/brainstorm`) {
    //     const topic = body.topic || extractMessage(body);
    //     if (!topic) return sendError(res, 400, 'topic required');
    //     const prompt = `Brainstorm creative ideas for: ${topic}\n\nProvide diverse, practical suggestions.`;
    //     const result = await runOnModels(body.model, prompt, 'auto', { tool: 'brainstorm', topic });
    //     if (result.error) return sendError(res, result.code, result.message);
    //     sendJSON(res, 200, result.response);
    //     return;
    // }

    // ── Code Tools ──
    // if (method === 'POST' && pathname === `${API_PREFIX}/tools/code`) {
    //     const action = body.action || 'generate';
    //     let prompt;
    //     switch (action) {
    //         case 'generate':
    //             if (!body.description) return sendError(res, 400, 'description required');
    //             prompt = `Generate ${body.language || 'JavaScript'} code:\n${body.description}\n\nProvide clean, production-ready code.`;
    //             break;
    //         case 'review':
    //             if (!body.code) return sendError(res, 400, 'code required');
    //             prompt = `Review this ${body.language || ''} code for bugs, performance, security:\n\`\`\`${body.language || ''}\n${body.code}\n\`\`\``;
    //             break;
    //         case 'debug':
    //             if (!body.code && !body.error) return sendError(res, 400, 'code or error required');
    //             prompt = 'Debug:\n';
    //             if (body.code) prompt += `\`\`\`${body.language || ''}\n${body.code}\n\`\`\`\n`;
    //             if (body.error) prompt += `Error: ${body.error}\n`;
    //             prompt += 'Identify the bug, explain, and fix.';
    //             break;
    //         case 'explain':
    //             if (!body.code) return sendError(res, 400, 'code required');
    //             prompt = `Explain this ${body.language || ''} code:\n\`\`\`${body.language || ''}\n${body.code}\n\`\`\``;
    //             break;
    //         default:
    //             return sendError(res, 400, `Unknown action: ${action}. Use: generate, review, debug, explain`);
    //     }
    //     const result = await runOnModels(body.model, prompt, 'claude', { tool: 'code', action });
    //     if (result.error) return sendError(res, result.code, result.message);
    //     sendJSON(res, 200, result.response);
    //     return;
    // }

    // ── Analyze ──
    // if (method === 'POST' && pathname === `${API_PREFIX}/tools/analyze`) {
    //     const { url, question, focus } = body;
    //     const content = url || extractMessage(body);
    //     if (!content) return sendError(res, 400, 'url or content required');
    //     const prompt = url
    //         ? `Analyze this URL: ${url}${question ? `\nQuestion: ${question}` : ''}${focus ? `\nFocus: ${focus}` : ''}`
    //         : `Analyze: ${content}${question ? `\nQuestion: ${question}` : ''}`;
    //     const defaultModel = url ? 'perplexity' : 'auto';
    //     const result = await runOnModels(body.model, prompt, defaultModel, { tool: 'analyze' });
    //     if (result.error) return sendError(res, result.code, result.message);
    //     sendJSON(res, 200, result.response);
    //     return;
    // }

    // /v1/stats, /v1/conversations/*

    if (method === 'GET' && pathname === `${API_PREFIX}/stats`) {
        sendJSON(res, 200, { ...getFormattedStats(), timestamp: new Date().toISOString() });
        return;
    }

    if (method === 'POST' && pathname === `${API_PREFIX}/conversations/new`) {
        try {
            const result = await handleMCPRequest({ action: 'newConversation', provider: 'all', data: {} });
            sendJSON(res, 200, { success: true, message: 'New conversations started', result });
        } catch (e) { sendError(res, 500, e.message); }
        return;
    }

    // Legacy endpoints (still work for backwards compat)

    if (method === 'POST' && pathname.startsWith('/api/ask/')) {
        const providerName = pathname.split('/').pop();
        const model = resolveModel(providerName);
        const message = extractMessage(body);
        if (!message) return sendError(res, 400, 'message required');

        if (model === 'all') {
            try {
                const allResults = await queryAll(message);
                sendJSON(res, 200, { success: true, enabledProviders: allResults.models, responses: allResults.results, timings: allResults.timings });
            } catch (e) { sendError(res, 500, e.message); }
            return;
        }

        const p = pickBestProvider(model);
        if (!p) return sendError(res, 503, `${providerName} not available`);
        try {
            const r = await queryProvider(p, message);
            sendJSON(res, 200, { success: true, provider: p, response: r.text, responseTimeMs: r.responseTimeMs });
        } catch (e) { sendError(res, 500, e.message); }
        return;
    }

    if (method === 'GET' && pathname === '/api/status') {
        const statusResult = await handleMCPRequest({ action: 'getStatus', provider: 'all', data: {} });
        sendJSON(res, 200, {
            success: true, server: 'Proxima API', version: VERSION,
            port: REST_PORT, enabledProviders: getEnabled(),
            providers: statusResult.providers || {},
            stats: getFormattedStats()
        });
        return;
    }

    if (method === 'GET' && pathname === '/api/stats') {
        sendJSON(res, 200, { success: true, ...getFormattedStats() });
        return;
    }

    // Docs page
    if (method === 'GET' && (pathname === '/' || pathname === '/docs')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(getDocsPage());
        return;
    }

    sendError(res, 404, `Not found: ${method} ${pathname}`);
}

// ─── Server ──────────────────────────────────────────────
function startRestAPI() {
    if (!handleMCPRequest) {
        console.error('[API] Not initialized');
        return;
    }

    httpServer = http.createServer(async (req, res) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Max-Age': '86400'
            });
            return res.end();
        }

        const url = new URL(req.url, `http://localhost:${REST_PORT}`);
        try {
            const body = req.method === 'POST' ? await parseBody(req) : {};
            await handleRoute(req.method, url.pathname, body, res);
        } catch (err) {
            console.error('[API] Error:', err.message);
            sendError(res, 500, err.message);
        }
    });

    httpServer.listen(REST_PORT, '127.0.0.1', () => {
        stats.startTime = new Date();
        console.log(`[API] ⚡ Proxima API v${VERSION} running at http://localhost:${REST_PORT}`);
    });

    httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[API] Port ${REST_PORT} in use, trying ${REST_PORT + 1}`);
            httpServer.listen(REST_PORT + 1, '127.0.0.1');
        } else {
            console.error('[API] Error:', err.message);
        }
    });

    return httpServer;
}

module.exports = { initRestAPI, startRestAPI };

// Proxima REST API — OpenAI-compatible gateway for all providers
// POST /v1/chat/completions  { "model": "claude", "messages": [...] }

const http = require('http');
const { URL } = require('url');
const { initWebSocket, getWSStats } = require('./ws-server.cjs');

// ─── Config ──────────────────────────────────────────────
const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT) || 3210;
const VERSION = '4.1.0';
const API_PREFIX = '/v1';

// ─── Model Aliases ───────────────────────────────────────

const MODEL_ALIASES = {
    
    'chatgpt': 'chatgpt', 'gpt': 'chatgpt', 'gpt-4': 'chatgpt', 'gpt-4o': 'chatgpt',
    'gpt-4.5': 'chatgpt', 'openai': 'chatgpt',

    
    'claude': 'claude', 'claude-3': 'claude', 'claude-3.5': 'claude', 'claude-4': 'claude',
    'anthropic': 'claude', 'sonnet': 'claude', 'opus': 'claude', 'haiku': 'claude',

    
    'gemini': 'gemini', 'gemini-pro': 'gemini', 'gemini-2': 'gemini', 'gemini-2.5': 'gemini',
    'google': 'gemini', 'bard': 'gemini',

    
    'perplexity': 'perplexity', 'pplx': 'perplexity', 'sonar': 'perplexity',

    
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

// Resolve model — supports string, array, or 'auto'
// Returns: { mode: 'single'|'multi'|'all'|'auto', providers: [...] }
function resolveModels(modelField) {
    const enabled = getEnabled();

    
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

        // Engine path already returns the full response in sendResult
        // Only fall back to getResponseWithTyping (DOM) if engine didn't return content
        let responseText = '';
        if (sendResult.result && sendResult.result.response && sendResult.result.response.length > 0) {
            responseText = sendResult.result.response;
        } else {
            const responseResult = await handleMCPRequest({
                action: 'getResponseWithTyping', provider, data: {}
            });
            responseText = responseResult.response || responseResult.result || '';
        }

        const elapsed = Date.now() - start;
        recordCall(provider, elapsed);
        return {
            text: responseText,
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

// ─── Shared Chat Widget ──────────────────────────────────
function getChatHTML(accentColor = '#22c55e') {
    const rgb = accentColor === '#22c55e' ? '34,197,94' : accentColor === '#a78bfa' ? '139,92,246' : '6,182,212';
    return `
        <div class="sec">
            <div class="st" style="color:${accentColor}">💬 Live Chat <span style="font-size:10px;color:#555;font-weight:400;">· via WebSocket</span> <span id="ws-status" style="font-size:10px;padding:2px 8px;border-radius:10px;margin-left:8px;background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.15)">Disconnected</span></div>
            <div id="chat-box" style="background:rgba(6,6,12,.95);border:1px solid rgba(${rgb},.15);border-radius:12px;overflow:hidden;">
                <div style="padding:10px 14px;background:rgba(${rgb},.04);border-bottom:1px solid rgba(${rgb},.1);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <select id="provider-select" style="background:rgba(16,16,24,.9);color:${accentColor};border:1px solid rgba(${rgb},.2);border-radius:6px;padding:5px 10px;font-size:12px;font-family:'JetBrains Mono',monospace;outline:none;cursor:pointer;">
                        <option value="auto">🤖 Auto</option>
                        <option value="claude">🟣 Claude</option>
                        <option value="chatgpt">🟢 ChatGPT</option>
                        <option value="gemini">🔵 Gemini</option>
                        <option value="perplexity">🟡 Perplexity</option>
                    </select>
                    <button id="ws-connect-btn" onclick="toggleWS()" style="background:rgba(${rgb},.15);color:${accentColor};border:1px solid rgba(${rgb},.25);border-radius:6px;padding:5px 14px;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;">Connect</button>
                    <button id="battle-toggle-btn" onclick="toggleBattle()" style="background:rgba(249,115,22,.08);color:#f97316;border:1px solid rgba(249,115,22,.2);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;">&#9876; Battle</button>
                    <button onclick="clearChat()" style="background:rgba(255,255,255,.03);color:#555;border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:5px 10px;font-size:10px;cursor:pointer;">Clear</button>
                    <span id="ws-timer" style="font-size:10px;color:#333;margin-left:auto;font-family:'JetBrains Mono',monospace;"></span>
                </div>
                <div id="battle-panel" style="display:none;padding:8px 14px;background:rgba(249,115,22,.03);border-bottom:1px solid rgba(249,115,22,.1);">
                    <div style="font-size:10px;color:#f97316;font-weight:600;margin-bottom:6px;">&#9876; BATTLE MODE &#8212; Select 2-4 providers:</div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#a78bfa;cursor:pointer;"><input type="checkbox" class="battle-cb" value="claude" style="accent-color:#a78bfa;"> Claude</label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#22c55e;cursor:pointer;"><input type="checkbox" class="battle-cb" value="chatgpt" style="accent-color:#22c55e;"> ChatGPT</label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#3b82f6;cursor:pointer;"><input type="checkbox" class="battle-cb" value="gemini" style="accent-color:#3b82f6;"> Gemini</label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#f97316;cursor:pointer;"><input type="checkbox" class="battle-cb" value="perplexity" style="accent-color:#f97316;"> Perplexity</label>
                    </div>
                </div>
                <div id="chat-messages" style="height:360px;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;scroll-behavior:smooth;">
                    <div style="text-align:center;color:#333;font-size:11px;padding:40px 0;">Connect and start chatting with AI ⚡</div>
                </div>
                <div style="padding:10px 14px;border-top:1px solid rgba(${rgb},.1);display:flex;gap:8px;">
                    <input id="chat-input" type="text" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendChat()" style="flex:1;background:rgba(16,16,24,.9);color:#e0e0e0;border:1px solid rgba(${rgb},.15);border-radius:8px;padding:10px 14px;font-size:13px;font-family:'Inter',sans-serif;outline:none;transition:border-color .2s;" onfocus="this.style.borderColor='rgba(${rgb},.4)'" onblur="this.style.borderColor='rgba(${rgb},.15)'" />
                    <button onclick="sendChat()" style="background:linear-gradient(135deg,#22c55e,#06b6d4);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Send ⚡</button>
                </div>
            </div>
        </div>`;
}

function getChatJS() {
    return `
    <script>
    let ws=null,reqTimer=null,reqStart=0,battleMode=false,battleId=0,battleResults={};
    const msgArea=document.getElementById('chat-messages'),input=document.getElementById('chat-input'),statusEl=document.getElementById('ws-status'),connectBtn=document.getElementById('ws-connect-btn'),timerEl=document.getElementById('ws-timer');
    function setStatus(t,c){statusEl.textContent=t;const r=c==='#22c55e'?'34,197,94':c==='#f97316'?'249,115,22':'239,68,68';statusEl.style.background='rgba('+r+',.1)';statusEl.style.color=c;statusEl.style.borderColor='rgba('+r+',.15)';}
    function toggleWS(){if(ws&&ws.readyState===1){ws.close();return;}connectWS();}
    function connectWS(){try{ws=new WebSocket('ws://localhost:${REST_PORT}/ws');}catch(e){addSystem('Connection failed');return;}
    setStatus('Connecting...','#f97316');connectBtn.textContent='Connecting...';
    ws.onopen=()=>{setStatus('Connected','#22c55e');connectBtn.textContent='Disconnect';connectBtn.style.background='rgba(239,68,68,.15)';connectBtn.style.color='#ef4444';connectBtn.style.borderColor='rgba(239,68,68,.25)';input.focus();};
    ws.onmessage=(e)=>{handleMsg(JSON.parse(e.data));};
    ws.onclose=()=>{setStatus('Disconnected','#ef4444');connectBtn.textContent='Connect';connectBtn.style.background='rgba(34,197,94,.15)';connectBtn.style.color='#22c55e';connectBtn.style.borderColor='rgba(34,197,94,.25)';clearTimer();};
    ws.onerror=()=>{addSystem('Connection error — is Proxima running?');};}
    function handleMsg(m){switch(m.type){case 'connected':addSystem('Connected as '+m.clientId);break;case 'status':updateStatus(m);break;case 'response':clearTimer();removeTyping();if(battleMode){addBattleResponse(m.content,m.model,m.responseTimeMs);}else{addAI(m.content,m.model,m.responseTimeMs);}break;case 'error':clearTimer();removeTyping();addError(m.error);break;case 'pong':addSystem('Pong!');break;}}
    function toggleBattle(){battleMode=!battleMode;var bp=document.getElementById('battle-panel');var bb=document.getElementById('battle-toggle-btn');var ps=document.getElementById('provider-select');if(battleMode){bp.style.display='block';bb.style.background='rgba(249,115,22,.2)';bb.style.borderColor='rgba(249,115,22,.4)';ps.style.display='none';}else{bp.style.display='none';bb.style.background='rgba(249,115,22,.08)';bb.style.borderColor='rgba(249,115,22,.2)';ps.style.display='';}}
    function getSelectedBattle(){var cbs=document.querySelectorAll('.battle-cb:checked');var arr=[];cbs.forEach(function(c){arr.push(c.value);});return arr;}
    function sendChat(){const t=input.value.trim();if(!t||!ws||ws.readyState!==1)return;if(battleMode){var providers=getSelectedBattle();if(providers.length<2){addSystem('Select at least 2 providers for battle!');return;}addUser(t);battleId++;battleResults={};addBattleGrid(providers);reqStart=Date.now();startTimer();providers.forEach(function(p){ws.send(JSON.stringify({action:'ask',model:p,message:t}));});}else{const m=document.getElementById('provider-select').value;addUser(t);reqStart=Date.now();startTimer();ws.send(JSON.stringify({action:'ask',model:m,message:t}));}input.value='';input.focus();}
    function addUser(t){const d=document.createElement('div');d.style.cssText='align-self:flex-end;max-width:75%;background:linear-gradient(135deg,rgba(34,197,94,.15),rgba(6,182,212,.1));border:1px solid rgba(34,197,94,.2);border-radius:12px 12px 2px 12px;padding:10px 14px;';d.innerHTML='<div style="font-size:9px;color:#22c55e;margin-bottom:4px;font-weight:600;">YOU</div><div style="font-size:13px;color:#e0e0e0;line-height:1.5;">'+esc(t)+'</div>';msgArea.appendChild(d);scroll();}
    function md(s){if(!s)return '';var bt=String.fromCharCode(96);s=s.replace(new RegExp(bt+bt+bt+'([\\\\s\\\\S]*?)'+bt+bt+bt,'g'),function(_,c){return '<pre style="background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.05);border-radius:6px;padding:8px;margin:6px 0;font-size:11px;font-family:monospace;color:#a5b4fc;overflow-x:auto;">'+esc(c.trim())+'</pre>';});s=s.replace(new RegExp(bt+'([^'+bt+']+)'+bt,'g'),'<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:3px;font-size:11px;font-family:monospace;color:#67e8f9;">$1</code>');s=s.replace(/^### (.+)$/gm,'<div style="font-size:14px;font-weight:600;color:#e0e0e0;margin:8px 0 4px;">$1</div>');s=s.replace(/^## (.+)$/gm,'<div style="font-size:15px;font-weight:700;color:#e0e0e0;margin:10px 0 4px;">$1</div>');s=s.replace(/^# (.+)$/gm,'<div style="font-size:16px;font-weight:700;color:#fff;margin:10px 0 6px;">$1</div>');s=s.replace(/\\*\\*(.+?)\\*\\*/g,'<strong style="color:#e0e0e0;">$1</strong>');s=s.replace(/\\*(.+?)\\*/g,'<em>$1</em>');s=s.replace(/^- (.+)$/gm,'<div style="padding-left:12px;margin:2px 0;">&#8226; $1</div>');s=s.replace(/\\n/g,'<br>');return s;}
    function addSystem(t){const d=document.createElement('div');d.style.cssText='text-align:center;font-size:10px;color:#444;padding:4px;';d.textContent=t;msgArea.appendChild(d);scroll();}
    function addAI(c,m,ms){const colors={claude:'#a78bfa',chatgpt:'#22c55e',gemini:'#3b82f6',perplexity:'#f97316',auto:'#06b6d4'};const cl=colors[m]||'#22c55e';const d=document.createElement('div');d.style.cssText='align-self:flex-start;max-width:85%;background:rgba(16,16,24,.8);border:1px solid rgba(255,255,255,.06);border-radius:12px 12px 12px 2px;padding:10px 14px;';d.innerHTML='<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:9px;color:'+cl+';font-weight:600;">'+(m||'AI').toUpperCase()+'</span><span style="font-size:9px;color:#333;">'+(ms?(ms/1000).toFixed(1)+'s':'')+'</span></div><div style="font-size:13px;color:#ccc;line-height:1.6;word-wrap:break-word;">'+md(c)+'</div>';msgArea.appendChild(d);scroll();}
    function addBattleGrid(providers){var colors={claude:'#a78bfa',chatgpt:'#22c55e',gemini:'#3b82f6',perplexity:'#f97316'};var cols=providers.length<=2?'1fr 1fr':providers.length===3?'1fr 1fr 1fr':'1fr 1fr';var d=document.createElement('div');d.id='battle-grid-'+battleId;d.style.cssText='display:grid;grid-template-columns:'+cols+';gap:8px;width:100%;';providers.forEach(function(p){var cell=document.createElement('div');cell.id='battle-cell-'+p+'-'+battleId;cell.style.cssText='background:rgba(16,16,24,.8);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px;min-height:80px;';var cl=colors[p]||'#22c55e';cell.innerHTML='<div style="font-size:9px;color:'+cl+';font-weight:700;margin-bottom:6px;text-transform:uppercase;display:flex;align-items:center;gap:4px;">'+p+'<span style="display:inline-flex;gap:2px;margin-left:4px;"><span style="width:3px;height:3px;background:'+cl+';border-radius:50%;animation:pulse 1s infinite;"></span><span style="width:3px;height:3px;background:'+cl+';border-radius:50%;animation:pulse 1s infinite .2s;"></span><span style="width:3px;height:3px;background:'+cl+';border-radius:50%;animation:pulse 1s infinite .4s;"></span></span></div><div class="battle-content" style="font-size:12px;color:#888;line-height:1.5;">Waiting...</div>';d.appendChild(cell);});msgArea.appendChild(d);scroll();}
    function addBattleResponse(c,m,ms){var cell=document.getElementById('battle-cell-'+m+'-'+battleId);if(cell){var cl={claude:'#a78bfa',chatgpt:'#22c55e',gemini:'#3b82f6',perplexity:'#f97316'}[m]||'#22c55e';cell.innerHTML='<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="font-size:9px;color:'+cl+';font-weight:700;text-transform:uppercase;">'+m+'</span><span style="font-size:9px;color:#555;">'+(ms?(ms/1000).toFixed(1)+'s':'')+'</span></div><div style="font-size:12px;color:#ccc;line-height:1.5;word-wrap:break-word;">'+md(c)+'</div>';cell.style.borderColor='rgba(255,255,255,.1)';scroll();}else{addAI(c,m,ms);}}
    function addError(t){const d=document.createElement('div');d.style.cssText='align-self:flex-start;max-width:80%;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.15);border-radius:8px;padding:8px 12px;';d.innerHTML='<span style="font-size:10px;color:#ef4444;">⚠ '+esc(t)+'</span>';msgArea.appendChild(d);scroll();}
    function updateStatus(m){removeTyping();const d=document.createElement('div');d.className='typing-indicator';d.style.cssText='align-self:flex-start;font-size:10px;color:#22c55e;padding:6px 12px;background:rgba(34,197,94,.05);border-radius:8px;display:flex;align-items:center;gap:6px;';d.innerHTML='<span style="display:inline-flex;gap:3px;"><span style="width:4px;height:4px;background:#22c55e;border-radius:50%;animation:pulse 1s infinite;"></span><span style="width:4px;height:4px;background:#22c55e;border-radius:50%;animation:pulse 1s infinite .2s;"></span><span style="width:4px;height:4px;background:#22c55e;border-radius:50%;animation:pulse 1s infinite .4s;"></span></span> '+(m.status||'processing')+'...';msgArea.appendChild(d);scroll();}
    function removeTyping(){msgArea.querySelectorAll('.typing-indicator').forEach(e=>e.remove());}
    function clearChat(){msgArea.innerHTML='<div style="text-align:center;color:#333;font-size:11px;padding:40px 0;">Chat cleared ⚡</div>';}
    function startTimer(){clearTimer();reqTimer=setInterval(()=>{timerEl.textContent=((Date.now()-reqStart)/1000).toFixed(1)+'s';},100);}
    function clearTimer(){if(reqTimer){clearInterval(reqTimer);reqTimer=null;}setTimeout(()=>{timerEl.textContent='';},2000);}
    function scroll(){msgArea.scrollTop=msgArea.scrollHeight;}
    function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    </script>
    <style>@keyframes pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}#chat-messages::-webkit-scrollbar{width:4px}#chat-messages::-webkit-scrollbar-track{background:transparent}#chat-messages::-webkit-scrollbar-thumb{background:rgba(34,197,94,.15);border-radius:4px}</style>`;
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
        .nav{display:flex;justify-content:center;gap:4px;margin-bottom:24px}
        .nav a{padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:all .2s;border:1px solid transparent}
        .nav a.active{background:rgba(139,92,246,.15);color:#a78bfa;border-color:rgba(139,92,246,.3)}
        .nav a:not(.active){color:#666;background:rgba(16,16,24,.5);border-color:rgba(255,255,255,.05)}
        .nav a:not(.active):hover{color:#a78bfa;border-color:rgba(139,92,246,.2);background:rgba(139,92,246,.05)}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="nav"><a href="/" class="active">⚡ REST API</a><a href="/cli">🖥️ CLI</a><a href="/ws">🔌 WebSocket</a></div>
        <div class="head">
            <div class="logo">⚡ Proxima API</div>
            <p class="sub">Unified AI Gateway · Port ${REST_PORT} · v${VERSION}</p>
            <div class="chips">
                ${['perplexity', 'chatgpt', 'claude', 'gemini'].map(p =>
        `<div class="chip ${enabled.includes(p) ? 'on' : 'off'}"><div class="d"></div>${p[0].toUpperCase() + p.slice(1)}</div>`
    ).join('')}
            </div>
        </div>

        ${getChatHTML('#a78bfa')}
        <div class="line"></div>

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
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#06b6d4;font-weight:600">analyze</td><td style="padding:8px">"function": "analyze", "url": "..."</td><td style="padding:8px;color:#888">Analyze URL/content</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#eab308;font-weight:600">security_audit</td><td style="padding:8px">"function": "security_audit", "code": "..."</td><td style="padding:8px;color:#888">Security vulnerability scan</td></tr>
            <tr><td style="padding:8px;color:#ec4899;font-weight:600">debate</td><td style="padding:8px">"function": "debate"</td><td style="padding:8px;color:#888">Multi-perspective debate</td></tr>
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

        <div class="foot">Proxima API v${VERSION} — Zen4-bit ⚡</div>
    </div>
    ${getChatJS()}
</body>
</html>`;
}

// ─── CLI Docs Page ───────────────────────────────────────
function getCLIDocsPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxima CLI</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Inter',sans-serif;background:#08080d;color:#d4d4e0;min-height:100vh;line-height:1.6}
        .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(6,182,212,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(6,182,212,.02) 1px,transparent 1px);background-size:60px 60px}
        .wrap{max-width:920px;margin:0 auto;padding:36px 20px;position:relative;z-index:1}
        .head{text-align:center;margin-bottom:32px}
        .logo{font-size:42px;font-weight:700;background:linear-gradient(135deg,#06b6d4,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .sub{color:#666;font-size:14px;margin-top:2px}
        .back{display:inline-block;margin-top:12px;color:#a78bfa;text-decoration:none;font-size:12px;padding:4px 12px;border:1px solid rgba(139,92,246,.2);border-radius:16px;transition:all .2s}
        .back:hover{border-color:rgba(139,92,246,.5);background:rgba(139,92,246,.05)}
        .line{height:1px;background:linear-gradient(90deg,transparent,rgba(6,182,212,.3),transparent);margin:24px 0}
        .sec{margin-bottom:24px}
        .st{font-size:16px;font-weight:600;color:#06b6d4;margin-bottom:10px}
        .card{background:rgba(16,16,24,.85);border:1px solid rgba(6,182,212,.1);border-radius:8px;padding:14px 16px;margin-bottom:5px;transition:border-color .2s}
        .card:hover{border-color:rgba(6,182,212,.3)}
        .highlight{background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.15);border-radius:8px;padding:16px;margin:12px 0}
        .highlight h3{color:#06b6d4;font-size:14px;margin-bottom:6px}
        .highlight p{color:#888;font-size:12px}
        .ex{background:rgba(6,6,12,.9);border:1px solid rgba(6,182,212,.12);border-radius:8px;padding:14px;margin-top:5px}
        .ex h4{color:#06b6d4;font-size:10px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}
        pre{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5;color:#a5b4fc;white-space:pre-wrap}
        .foot{text-align:center;margin-top:36px;color:#333;font-size:11px}
        .cmd-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
        .cmd{padding:10px 14px;background:rgba(16,16,24,.85);border:1px solid rgba(6,182,212,.08);border-radius:8px;transition:border-color .2s}
        .cmd:hover{border-color:rgba(6,182,212,.25)}
        .cmd-name{font-family:'JetBrains Mono',monospace;font-size:12px;color:#06b6d4;font-weight:600}
        .cmd-desc{font-size:11px;color:#666;margin-top:2px}
        .tag{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;margin-left:4px}
        .tag-new{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.15)}
        .tag-ctx{background:rgba(249,115,22,.08);color:#f97316;border:1px solid rgba(249,115,22,.12)}
        .nav{display:flex;justify-content:center;gap:4px;margin-bottom:24px}
        .nav a{padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:all .2s;border:1px solid transparent}
        .nav a.active{background:rgba(6,182,212,.15);color:#06b6d4;border-color:rgba(6,182,212,.3)}
        .nav a:not(.active){color:#666;background:rgba(16,16,24,.5);border-color:rgba(255,255,255,.05)}
        .nav a:not(.active):hover{color:#06b6d4;border-color:rgba(6,182,212,.2);background:rgba(6,182,212,.05)}
        @media(max-width:640px){.cmd-grid{grid-template-columns:1fr}}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="nav"><a href="/">⚡ REST API</a><a href="/cli" class="active">🖥️ CLI</a><a href="/ws">🔌 WebSocket</a></div>
        <div class="head">
            <div class="logo">🖥️ Proxima CLI</div>
            <p class="sub">Talk to AI from your terminal · v${VERSION}</p>
        </div>

        ${getChatHTML('#06b6d4')}
        <div class="line"></div>

        <div class="highlight">
            <h3>⚡ Quick Start</h3>
            <p>Install and start using AI from your terminal in seconds.</p>
            <pre style="margin-top:10px">
# Option 1: Run directly
node cli/proxima-cli.cjs ask claude "What is AI?"

# Option 2: npm script
npm run cli -- ask claude "Hello"

# Option 3: Register globally (use from any folder on this PC)
npm link
proxima ask claude "Hello"</pre>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📋 All Commands</div>
            <div class="cmd-grid">
                <div class="cmd"><div class="cmd-name">ask <span style="color:#666">[model]</span> "msg"</div><div class="cmd-desc">Chat with any AI provider</div></div>
                <div class="cmd"><div class="cmd-name">compare "question"</div><div class="cmd-desc">Ask all providers, compare side-by-side</div></div>
                <div class="cmd"><div class="cmd-name">search "query"</div><div class="cmd-desc">Web search via Perplexity</div></div>
                <div class="cmd"><div class="cmd-name">brainstorm "topic"</div><div class="cmd-desc">Generate creative ideas</div></div>
                <div class="cmd"><div class="cmd-name">translate "text" --to Lang</div><div class="cmd-desc">Translate to any language</div></div>
                <div class="cmd"><div class="cmd-name">code "description"</div><div class="cmd-desc">Generate / review / explain code</div></div>
                <div class="cmd"><div class="cmd-name">debate "topic"</div><div class="cmd-desc">Multi-AI debate on any topic</div></div>
                <div class="cmd"><div class="cmd-name">audit "code"</div><div class="cmd-desc">Security vulnerability scan</div></div>
                <div class="cmd"><div class="cmd-name">analyze "url"</div><div class="cmd-desc">Analyze URL or content</div></div>
                <div class="cmd"><div class="cmd-name">fix "error" <span class="tag tag-new">NEW</span></div><div class="cmd-desc">Fix errors with AI help</div></div>
                <div class="cmd"><div class="cmd-name">models</div><div class="cmd-desc">List all providers (ON/OFF)</div></div>
                <div class="cmd"><div class="cmd-name">status</div><div class="cmd-desc">Server health check</div></div>
                <div class="cmd"><div class="cmd-name">stats</div><div class="cmd-desc">Provider response times</div></div>
                <div class="cmd"><div class="cmd-name">new</div><div class="cmd-desc">Reset all conversations</div></div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🤖 Provider Control</div>
            <div class="ex">
                <h4>Choose Your AI</h4>
                <pre>
# Specific provider
proxima ask claude "Explain quantum computing"
proxima ask chatgpt "Write a poem about AI"
proxima ask gemini "Summarize this topic"
proxima ask perplexity "Latest news on AI"

# Auto-pick best available
proxima ask "Hello"
proxima ask auto "Hello"

# All providers at once
proxima ask all "What is consciousness?"
proxima compare "Is water wet?"</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🔧 Context-Aware Features <span class="tag tag-ctx">SMART</span></div>
            <p style="color:#888;font-size:12px;margin-bottom:10px">Pipe command output, errors, or file content directly to AI for instant help.</p>

            <div class="cmd-grid">
                <div class="ex">
                    <h4>📥 Pipe Error Output</h4>
                    <pre># Build error → AI fixes it
npm run build 2>&1 | proxima fix

# Python error → AI fix
python app.py 2>&1 | proxima fix

# Any command output
docker logs app | proxima ask "any errors?"</pre>
                </div>
                <div class="ex">
                    <h4>📄 File as Context</h4>
                    <pre># Explain a file
proxima ask "explain this" --file src/app.js

# Review a file
proxima ask "review for bugs" --file server.py

# Fix error with source file
proxima fix "TypeError" --file src/utils.js</pre>
                </div>
                <div class="ex">
                    <h4>🔀 Pipe + Question</h4>
                    <pre># Log analysis
cat error.log | proxima ask "what went wrong?"

# Git changes → code review
git diff | proxima code review

# Config check
cat nginx.conf | proxima ask "any issues?"</pre>
                </div>
                <div class="ex">
                    <h4>⚡ Auto-Fix Mode</h4>
                    <pre># Just pipe anything — auto detects
npm test 2>&1 | proxima fix
cargo build 2>&1 | proxima fix
go build . 2>&1 | proxima fix

# Even without a command name:
some-command 2>&1 | proxima</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">💻 Code Tools</div>
            <div class="ex">
                <h4>Generate, Review, Explain, Debug</h4>
                <pre>
# Generate code
proxima code "REST API with auth" --lang Python
proxima code "sort algorithm" --lang JavaScript

# Review code
proxima code review "def fib(n): return fib(n-1)+fib(n-2)"
cat app.js | proxima code review

# Explain code
proxima code explain "async/await patterns"
cat complex.py | proxima code explain

# Debug
proxima code debug "function fails on empty array"</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">⚙️ Options & Environment</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>Flags</h4>
                    <pre>--model, -m    Specify AI model
--to           Target language (translate)
--from         Source language (translate)
--lang, -l     Programming language (code)
--file         Send file as context
--q            Question for analyze
--json         Raw JSON output</pre>
                </div>
                <div class="ex">
                    <h4>Environment Variables</h4>
                    <pre># Custom port
set PROXIMA_PORT=4000
proxima ask claude "Hello"

# Custom host
set PROXIMA_HOST=192.168.1.100
proxima status

# Default: 127.0.0.1:${REST_PORT}</pre>
                </div>
            </div>
        </div>

        <div class="foot">Proxima CLI v${VERSION} — Zen4-bit ⚡</div>
    </div>
    ${getChatJS()}
</body>
</html>`;
}

// ─── WebSocket Docs Page ─────────────────────────────────
function getWSDocsPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxima WebSocket</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Inter',sans-serif;background:#08080d;color:#d4d4e0;min-height:100vh;line-height:1.6}
        .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(34,197,94,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(34,197,94,.02) 1px,transparent 1px);background-size:60px 60px}
        .wrap{max-width:920px;margin:0 auto;padding:36px 20px;position:relative;z-index:1}
        .head{text-align:center;margin-bottom:32px}
        .logo{font-size:42px;font-weight:700;background:linear-gradient(135deg,#22c55e,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .sub{color:#666;font-size:14px;margin-top:2px}
        .line{height:1px;background:linear-gradient(90deg,transparent,rgba(34,197,94,.3),transparent);margin:24px 0}
        .sec{margin-bottom:24px}
        .st{font-size:16px;font-weight:600;color:#22c55e;margin-bottom:10px}
        .highlight{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);border-radius:8px;padding:16px;margin:12px 0}
        .highlight h3{color:#22c55e;font-size:14px;margin-bottom:6px}
        .highlight p{color:#888;font-size:12px}
        .ex{background:rgba(6,6,12,.9);border:1px solid rgba(34,197,94,.12);border-radius:8px;padding:14px;margin-top:5px}
        .ex h4{color:#22c55e;font-size:10px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}
        pre{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5;color:#a5b4fc;white-space:pre-wrap}
        .foot{text-align:center;margin-top:36px;color:#333;font-size:11px}
        .cmd-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
        .cmd{padding:10px 14px;background:rgba(16,16,24,.85);border:1px solid rgba(34,197,94,.08);border-radius:8px;transition:border-color .2s}
        .cmd:hover{border-color:rgba(34,197,94,.25)}
        .cmd-name{font-family:'JetBrains Mono',monospace;font-size:12px;color:#22c55e;font-weight:600}
        .cmd-desc{font-size:11px;color:#666;margin-top:2px}
        .tag{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;margin-left:4px}
        .tag-live{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.15)}
        .nav{display:flex;justify-content:center;gap:4px;margin-bottom:24px}
        .nav a{padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:all .2s;border:1px solid transparent}
        .nav a.active{background:rgba(34,197,94,.15);color:#22c55e;border-color:rgba(34,197,94,.3)}
        .nav a:not(.active){color:#666;background:rgba(16,16,24,.5);border-color:rgba(255,255,255,.05)}
        .nav a:not(.active):hover{color:#22c55e;border-color:rgba(34,197,94,.2);background:rgba(34,197,94,.05)}
        @media(max-width:640px){.cmd-grid{grid-template-columns:1fr}}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="nav"><a href="/">⚡ REST API</a><a href="/cli">🖥️ CLI</a><a href="/ws" class="active">🔌 WebSocket</a></div>
        <div class="head">
            <div class="logo">🔌 Proxima WebSocket</div>
            <p class="sub">Real-time AI communication · ws://localhost:${REST_PORT}/ws</p>
        </div>

        ${getChatHTML('#22c55e')}
        <div class="line"></div>

        <div class="highlight">
            <h3>⚡ Connect</h3>
            <p>Persistent connection — send multiple messages without reconnecting.</p>
            <pre style="margin-top:10px">
// JavaScript
const ws = new WebSocket("ws://localhost:${REST_PORT}/ws");

ws.onopen = () => console.log("Connected!");
ws.onmessage = (e) => console.log(JSON.parse(e.data));

// Send a message
ws.send(JSON.stringify({
    action: "ask",
    model: "claude",
    message: "What is AI?"
}));</pre>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📋 Available Actions</div>
            <div class="cmd-grid">
                <div class="cmd"><div class="cmd-name">ask <span class="tag tag-live">LIVE</span></div><div class="cmd-desc">Chat with any AI provider</div></div>
                <div class="cmd"><div class="cmd-name">search</div><div class="cmd-desc">Web search via Perplexity</div></div>
                <div class="cmd"><div class="cmd-name">code</div><div class="cmd-desc">Generate / review / explain code</div></div>
                <div class="cmd"><div class="cmd-name">translate</div><div class="cmd-desc">Translate text</div></div>
                <div class="cmd"><div class="cmd-name">brainstorm</div><div class="cmd-desc">Creative ideas</div></div>
                <div class="cmd"><div class="cmd-name">debate</div><div class="cmd-desc">Multi-provider debate</div></div>
                <div class="cmd"><div class="cmd-name">audit</div><div class="cmd-desc">Security vulnerability scan</div></div>
                <div class="cmd"><div class="cmd-name">ping</div><div class="cmd-desc">Connection health check</div></div>
                <div class="cmd"><div class="cmd-name">stats</div><div class="cmd-desc">Server statistics</div></div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📨 Message Format</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>→ Send (Client to Server)</h4>
                    <pre>{
  "action": "ask",
  "model": "claude",
  "message": "What is AI?",
  "id": "optional-request-id"
}</pre>
                </div>
                <div class="ex">
                    <h4>← Receive (Server to Client)</h4>
                    <pre>// Status update
{"type":"status","id":"req_1","status":"processing"}

// Response
{"type":"response","id":"req_1",
 "content":"AI is...",
 "model":"claude",
 "responseTimeMs":5420}

// Error
{"type":"error","id":"req_1",
 "error":"Provider unavailable"}</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📝 All Actions — Examples</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>💬 Ask / Chat</h4>
                    <pre>// Ask specific provider
{"action":"ask","model":"claude",
 "message":"Write a haiku"}

// Auto-pick best
{"action":"ask",
 "message":"Hello world"}</pre>
                </div>
                <div class="ex">
                    <h4>🔍 Search</h4>
                    <pre>{"action":"search",
 "query":"Latest AI news 2026"}</pre>
                </div>
                <div class="ex">
                    <h4>💻 Code</h4>
                    <pre>// Generate
{"action":"code",
 "description":"Sort algorithm",
 "language":"Python"}

// Review
{"action":"code","subaction":"review",
 "description":"def fib(n):..."}</pre>
                </div>
                <div class="ex">
                    <h4>🌐 Translate</h4>
                    <pre>{"action":"translate",
 "text":"Hello world",
 "to":"Hindi"}</pre>
                </div>
                <div class="ex">
                    <h4>🧠 Brainstorm</h4>
                    <pre>{"action":"brainstorm",
 "topic":"AI startup ideas"}</pre>
                </div>
                <div class="ex">
                    <h4>⚔️ Debate</h4>
                    <pre>{"action":"debate",
 "topic":"Is AI dangerous?"}</pre>
                </div>
                <div class="ex">
                    <h4>🛡️ Security Audit</h4>
                    <pre>{"action":"audit",
 "code":"app.get('/user',
  (req,res)=>db.query(
  'SELECT * WHERE id='+req.id))"}</pre>
                </div>
                <div class="ex">
                    <h4>❤️ Ping / Stats</h4>
                    <pre>{"action":"ping"}
// → {"type":"pong"}

{"action":"stats"}
// → {"type":"stats","data":{...}}</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🔧 Client Examples</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>JavaScript (Browser / Node.js)</h4>
                    <pre>const ws = new WebSocket("ws://localhost:${REST_PORT}/ws");

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'response') {
    console.log(msg.content);
  }
};

ws.onopen = () => {
  ws.send(JSON.stringify({
    action: "ask",
    model: "claude",
    message: "Explain AI"
  }));
};</pre>
                </div>
                <div class="ex">
                    <h4>Python</h4>
                    <pre>import websocket, json

ws = websocket.create_connection(
  "ws://localhost:${REST_PORT}/ws"
)

# Send
ws.send(json.dumps({
  "action": "ask",
  "model": "claude",
  "message": "What is AI?"
}))

# Receive
result = json.loads(ws.recv())  # status
result = json.loads(ws.recv())  # response
print(result["content"])</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📡 Event Types</div>
            <div class="cmd-grid">
                <div class="cmd"><div class="cmd-name">connected</div><div class="cmd-desc">Initial connection — returns clientId</div></div>
                <div class="cmd"><div class="cmd-name">status</div><div class="cmd-desc">Processing status update (processing, searching, etc.)</div></div>
                <div class="cmd"><div class="cmd-name">response</div><div class="cmd-desc">AI response with content and timing</div></div>
                <div class="cmd"><div class="cmd-name">error</div><div class="cmd-desc">Error with message</div></div>
                <div class="cmd"><div class="cmd-name">pong</div><div class="cmd-desc">Reply to ping</div></div>
                <div class="cmd"><div class="cmd-name">stats</div><div class="cmd-desc">Server statistics data</div></div>
            </div>
        </div>

        <div class="foot">Proxima WebSocket v${VERSION} — Zen4-bit ⚡</div>
    </div>
    ${getChatJS()}
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

        // ── function: "security_audit" ──
        if (fn === 'security_audit') {
            const code = body.code || extractMessage(body);
            if (!code) return sendError(res, 400, 'code or message required');
            const lang = body.language ? ` (${body.language})` : '';
            const prompt = `You are a senior security engineer. Perform a thorough security audit of this code${lang}.

CODE:
${code}

Check for: injection vulnerabilities, auth flaws, data exposure, input validation issues, cryptographic issues, config problems, dependency risks.

For each issue: Severity (CRITICAL/HIGH/MEDIUM/LOW), Location, Description, Fix.
End with a security score (0-100).`;
            return run(prompt, 'claude', { function: 'security_audit' });
        }

        // ── function: "debate" ──
        if (fn === 'debate') {
            const topic = body.topic || extractMessage(body);
            if (!topic) return sendError(res, 400, 'topic or message required');
            const sides = body.sides || 2;
            const resolved2 = resolveModels(body.model || 'all');
            if (resolved2.mode === 'error') return sendError(res, 404, resolved2.error);

            if (resolved2.providers.length < 2) {
                // Single provider — generate both sides
                const prompt = `Debate this topic from ${sides} different perspectives with strong arguments and evidence:\n\nTopic: ${topic}\n\nFormat: ## Perspective [N]: [Position]\n- Arguments\n- Evidence\n\nEnd with balanced conclusion.`;
                return run(prompt, 'auto', { function: 'debate', topic });
            }

            // Multi-provider debate
            const stances = ['FOR / supportive', 'AGAINST / critical', 'NEUTRAL / analytical', 'ALTERNATIVE / unconventional'];
            const debateResults = {};
            const debateTimings = {};
            await Promise.all(resolved2.providers.slice(0, sides).map(async (provider, i) => {
                try {
                    const stance = stances[i] || `Perspective ${i + 1}`;
                    const r = await queryProvider(provider, `You are debating this topic. Your position: ${stance}.\n\nTopic: ${topic}\n\nPresent your strongest arguments. Be persuasive. Do NOT present the other side.`);
                    debateResults[provider] = { stance, response: r.text };
                    debateTimings[provider] = r.responseTimeMs;
                } catch (e) {
                    debateResults[provider] = { stance: stances[i], error: e.message };
                }
            }));
            sendJSON(res, 200, {
                id: `proxima-${Date.now()}`, object: 'chat.completion', model: 'debate',
                topic, perspectives: debateResults, timings: debateTimings,
                proxima: { function: 'debate', providers: resolved2.providers.slice(0, sides) }
            });
            return;
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
                },
                security_audit: {
                    description: 'Scan code for security vulnerabilities',
                    body: { model: 'string', code: 'string', function: 'security_audit' },
                    optional: { language: 'programming language' },
                    example: { model: 'claude', code: 'app.get("/user", (req,res) => { db.query("SELECT * FROM users WHERE id=" + req.query.id) })', function: 'security_audit' }
                },
                debate: {
                    description: 'Multi-perspective debate on any topic',
                    body: { model: 'string or "all"', message: 'string', function: 'debate' },
                    optional: { sides: 'number of perspectives (default: 2)' },
                    example: { model: 'all', message: 'Is AI a threat to humanity?', function: 'debate' }
                }
            }
        });
        return;
    }

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

    // /api/stats — redirects to /v1/stats
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

    // CLI docs page
    if (method === 'GET' && pathname === '/cli') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(getCLIDocsPage());
        return;
    }
    // WebSocket docs page
    if (method === 'GET' && (pathname === '/ws' || pathname === '/websocket')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(getWSDocsPage());
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

        // Init WebSocket on same server
        try {
            initWebSocket(httpServer, handleMCPRequest, getEnabled);
            console.log(`[API] 🔌 WebSocket ready at ws://localhost:${REST_PORT}/ws`);
        } catch (err) {
            console.error('[API] WebSocket init failed:', err.message);
        }
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

function stopRestAPI() {
    if (httpServer) {
        httpServer.close(() => {
            console.log('[API] ⏹ REST API server stopped');
        });
        httpServer = null;
    }
}

function isRestAPIRunning() {
    return httpServer !== null && httpServer.listening;
}

module.exports = { initRestAPI, startRestAPI, stopRestAPI, isRestAPIRunning };

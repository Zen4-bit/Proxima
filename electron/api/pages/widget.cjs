// Proxima — Shared Chat Widget
//
// Provides the in-page live-chat widget (markup via getChatHTML, client script
// via getChatJS) embedded in every docs page. The widget fetches /v1/models to
// populate providers, talks to the /ws WebSocket, and supports a multi-provider
// "battle" mode.
const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT, 10) || 3210;
const VERSION = '5.0.0';

// Covers session and BYOK providers; unknown ids fall back to teal via getColor().
const PROVIDER_COLORS = {
    claude: '#a78bfa', chatgpt: '#22c55e', gemini: '#3b82f6', perplexity: '#f97316',
    deepseek: '#06b6d4', groq: '#ec4899', xai: '#eab308', nvidia: '#76b900',
    openrouter: '#ff6b6b', together: '#8b5cf6', fireworks: '#ef4444', mistral: '#f59e0b',
    auto: '#06b6d4'
};

function getChatHTML(accentColor = '#22c55e') {
    const rgb = accentColor === '#22c55e' ? '34,197,94' : accentColor === '#a78bfa' ? '139,92,246' : '6,182,212';
    return `
        <div class="sec">
            <div class="st" style="color:${accentColor}">\u{1F4AC} Live Chat <span style="font-size:10px;color:#555;font-weight:400;">\u00B7 via WebSocket</span> <span id="ws-status" style="font-size:10px;padding:2px 8px;border-radius:10px;margin-left:8px;background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.15)">Disconnected</span> <span id="mode-badge" style="font-size:9px;padding:2px 8px;border-radius:10px;margin-left:4px;background:rgba(34,197,94,.08);color:#555;border:1px solid rgba(255,255,255,.06);display:none;"></span></div>
            <div id="chat-box" style="background:rgba(6,6,12,.95);border:1px solid rgba(${rgb},.15);border-radius:12px;overflow:hidden;">
                <div style="padding:10px 14px;background:rgba(${rgb},.04);border-bottom:1px solid rgba(${rgb},.1);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <select id="provider-select" style="background:rgba(16,16,24,.9);color:${accentColor};border:1px solid rgba(${rgb},.2);border-radius:6px;padding:5px 10px;font-size:12px;font-family:'JetBrains Mono',monospace;outline:none;cursor:pointer;">
                        <option value="auto">\u{1F916} Auto</option>
                        <option value="_loading" disabled>Loading...</option>
                    </select>
                    <button id="ws-connect-btn" onclick="toggleWS()" style="background:rgba(${rgb},.15);color:${accentColor};border:1px solid rgba(${rgb},.25);border-radius:6px;padding:5px 14px;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;">Connect</button>
                    <button id="battle-toggle-btn" onclick="toggleBattle()" style="background:rgba(249,115,22,.08);color:#f97316;border:1px solid rgba(249,115,22,.2);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;">&#9876; Battle</button>
                    <button onclick="clearChat()" style="background:rgba(255,255,255,.03);color:#555;border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:5px 10px;font-size:10px;cursor:pointer;">Clear</button>
                    <span id="ws-timer" style="font-size:10px;color:#333;margin-left:auto;font-family:'JetBrains Mono',monospace;"></span>
                </div>
                <div id="battle-panel" style="display:none;padding:8px 14px;background:rgba(249,115,22,.03);border-bottom:1px solid rgba(249,115,22,.1);">
                    <div style="font-size:10px;color:#f97316;font-weight:600;margin-bottom:6px;">&#9876; BATTLE MODE &#8212; Select 2-4 providers:</div>
                    <div id="battle-checkboxes" style="display:flex;gap:8px;flex-wrap:wrap;">
                        <span style="font-size:10px;color:#555;">Loading providers...</span>
                    </div>
                </div>
                <div id="chat-messages" style="height:360px;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;scroll-behavior:smooth;">
                    <div style="text-align:center;color:#333;font-size:11px;padding:40px 0;">Connect and start chatting with AI \u26A1</div>
                </div>
                <div style="padding:10px 14px;border-top:1px solid rgba(${rgb},.1);display:flex;gap:8px;">
                    <input id="chat-input" type="text" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendChat()" style="flex:1;background:rgba(16,16,24,.9);color:#e0e0e0;border:1px solid rgba(${rgb},.15);border-radius:8px;padding:10px 14px;font-size:13px;font-family:'Inter',sans-serif;outline:none;transition:border-color .2s;" onfocus="this.style.borderColor='rgba(${rgb},.4)'" onblur="this.style.borderColor='rgba(${rgb},.15)'" />
                    <button onclick="sendChat()" style="background:linear-gradient(135deg,#22c55e,#06b6d4);color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .2s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Send \u26A1</button>
                </div>
            </div>
        </div>`;
}

function getChatJS() {
    const colorsJSON = JSON.stringify(PROVIDER_COLORS);
    return `
    <script>
    // ─── Dynamic Provider State ──────────────────────
    const PROVIDER_COLORS = ${colorsJSON};
    let _gatewayMode = 'session';
    let _enabledProviders = [];
    let _modelsData = [];

    function getColor(p) { return PROVIDER_COLORS[p] || '#06b6d4'; }

    // Fetch /v1/models on page load and populate UI
    async function loadModels() {
        try {
            const res = await fetch('/v1/models');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            _gatewayMode = data.mode || 'session';
            _modelsData = data.data || [];
            _enabledProviders = _modelsData
                .filter(m => m.status === 'enabled' && m.id !== 'auto' && !m.id.includes('-flash') && m.id !== '3.1-pro' && m.id !== 'gemini:auto')
                .map(m => m.id);
        } catch (e) {
            console.warn('[Widget] Could not fetch models, using defaults:', e.message);
            _gatewayMode = 'session';
            _enabledProviders = ['chatgpt', 'claude', 'gemini', 'perplexity'];
        }
        populateDropdown();
        populateBattle();
        populateChips();
        populateModelGrid();
        showModeBadge();
    }

    function showModeBadge() {
        var badge = document.getElementById('mode-badge');
        if (!badge) return;
        if (_gatewayMode === 'api') {
            badge.textContent = 'API Mode';
            badge.style.display = 'inline';
            badge.style.background = 'rgba(249,115,22,.1)';
            badge.style.color = '#f97316';
            badge.style.borderColor = 'rgba(249,115,22,.2)';
        } else {
            badge.textContent = 'Session';
            badge.style.display = 'inline';
            badge.style.background = 'rgba(34,197,94,.08)';
            badge.style.color = '#22c55e';
            badge.style.borderColor = 'rgba(34,197,94,.15)';
        }
    }

    function populateDropdown() {
        var sel = document.getElementById('provider-select');
        if (!sel) return;
        sel.innerHTML = '<option value="auto">\\u{1F916} Auto</option>';
        _enabledProviders.forEach(function(p) {
            var opt = document.createElement('option');
            opt.value = p;
            var modelInfo = _modelsData.find(m => m.id === p);
            var label = p.charAt(0).toUpperCase() + p.slice(1);
            if (_gatewayMode === 'api' && modelInfo && modelInfo.selectedModel) {
                label += ' \\u2192 ' + modelInfo.selectedModel;
            }
            opt.textContent = label;
            opt.style.color = getColor(p);
            sel.appendChild(opt);
        });
    }

    function populateBattle() {
        var container = document.getElementById('battle-checkboxes');
        if (!container) return;
        container.innerHTML = '';
        _enabledProviders.forEach(function(p) {
            var cl = getColor(p);
            var label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:4px;font-size:11px;color:' + cl + ';cursor:pointer;';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'battle-cb';
            cb.value = p;
            cb.style.accentColor = cl;
            label.appendChild(cb);
            label.appendChild(document.createTextNode(' ' + p.charAt(0).toUpperCase() + p.slice(1)));
            container.appendChild(label);
        });
    }

    // Update provider pills on the docs page (if they exist)
    function populateChips() {
        var container = document.getElementById('provider-chips');
        if (!container) return;
        container.innerHTML = '';
        _enabledProviders.forEach(function(p) {
            var div = document.createElement('div');
            div.className = 'chip on';
            div.innerHTML = '<div class="d"></div>' + p.charAt(0).toUpperCase() + p.slice(1);
            container.appendChild(div);
        });
    }

    // Update model grid on the docs page (if it exists)
    function populateModelGrid() {
        var grid = document.getElementById('model-grid-dynamic');
        if (!grid) return;
        grid.innerHTML = '';
        _modelsData.filter(m => m.status === 'enabled' && m.id !== 'auto').forEach(function(m) {
            var cl = getColor(m.id);
            var div = document.createElement('div');
            div.className = 'model-item';
            div.style.border = '1px solid ' + cl + '33';
            var text = m.id;
            if (m.selectedModel) text += ' \\u2192 ' + m.selectedModel;
            if (m.description) text += ' \\u00B7 ' + m.description;
            div.textContent = text;
            grid.appendChild(div);
        });
        // Always add auto
        var autoDiv = document.createElement('div');
        autoDiv.className = 'model-item';
        autoDiv.textContent = 'auto \\u2192 best available';
        grid.appendChild(autoDiv);
    }

    // ─── WebSocket Chat Logic ────────────────────────
    let ws=null,reqTimer=null,reqStart=0,battleMode=false,battleId=0,battleResults={};
    const msgArea=document.getElementById('chat-messages'),input=document.getElementById('chat-input'),statusEl=document.getElementById('ws-status'),connectBtn=document.getElementById('ws-connect-btn'),timerEl=document.getElementById('ws-timer');
    function setStatus(t,c){statusEl.textContent=t;const r=c==='#22c55e'?'34,197,94':c==='#f97316'?'249,115,22':'239,68,68';statusEl.style.background='rgba('+r+',.1)';statusEl.style.color=c;statusEl.style.borderColor='rgba('+r+',.15)';}
    function toggleWS(){if(ws&&ws.readyState===1){ws.close();return;}connectWS();}
    function connectWS(){try{var _wsProto=location.protocol==='https:'?'wss:':'ws:';var _wsHost=location.host||'localhost:${REST_PORT}';ws=new WebSocket(_wsProto+'//'+_wsHost+'/ws');}catch(e){addSystem('Connection failed');return;}
    setStatus('Connecting...','#f97316');connectBtn.textContent='Connecting...';
    ws.onopen=()=>{setStatus('Connected','#22c55e');connectBtn.textContent='Disconnect';connectBtn.style.background='rgba(239,68,68,.15)';connectBtn.style.color='#ef4444';connectBtn.style.borderColor='rgba(239,68,68,.25)';input.focus();};
    ws.onmessage=(e)=>{try{handleMsg(JSON.parse(e.data));}catch(_e){addSystem('Received a malformed message from server');}};
    ws.onclose=()=>{setStatus('Disconnected','#ef4444');connectBtn.textContent='Connect';connectBtn.style.background='rgba(34,197,94,.15)';connectBtn.style.color='#22c55e';connectBtn.style.borderColor='rgba(34,197,94,.25)';clearTimer();};
    ws.onerror=()=>{addSystem('Connection error \\u2014 is Proxima running?');};}
    function handleMsg(m){switch(m.type){case 'connected':addSystem('Connected as '+m.clientId);break;case 'status':updateStatus(m);break;case 'response':clearTimer();removeTyping();if(battleMode){addBattleResponse(m.content,m.model,m.responseTimeMs);}else{addAI(m.content,m.model,m.responseTimeMs);}break;case 'error':clearTimer();removeTyping();addError(m.error);break;case 'pong':addSystem('Pong!');break;}}
    function toggleBattle(){battleMode=!battleMode;var bp=document.getElementById('battle-panel');var bb=document.getElementById('battle-toggle-btn');var ps=document.getElementById('provider-select');if(battleMode){bp.style.display='block';bb.style.background='rgba(249,115,22,.2)';bb.style.borderColor='rgba(249,115,22,.4)';ps.style.display='none';}else{bp.style.display='none';bb.style.background='rgba(249,115,22,.08)';bb.style.borderColor='rgba(249,115,22,.2)';ps.style.display='';}}
    function getSelectedBattle(){var cbs=document.querySelectorAll('.battle-cb:checked');var arr=[];cbs.forEach(function(c){arr.push(c.value);});return arr;}
    function sendChat(){const t=input.value.trim();if(!t||!ws||ws.readyState!==1)return;if(battleMode){var providers=getSelectedBattle();if(providers.length<2){addSystem('Select at least 2 providers for battle!');return;}addUser(t);battleId++;battleResults={};addBattleGrid(providers);reqStart=Date.now();startTimer();providers.forEach(function(p){ws.send(JSON.stringify({action:'ask',model:p,message:t}));});}else{const m=document.getElementById('provider-select').value;addUser(t);reqStart=Date.now();startTimer();ws.send(JSON.stringify({action:'ask',model:m,message:t}));}input.value='';input.focus();}
    function addUser(t){const d=document.createElement('div');d.style.cssText='align-self:flex-end;max-width:75%;background:linear-gradient(135deg,rgba(34,197,94,.15),rgba(6,182,212,.1));border:1px solid rgba(34,197,94,.2);border-radius:12px 12px 2px 12px;padding:10px 14px;';d.innerHTML='<div style="font-size:9px;color:#22c55e;margin-bottom:4px;font-weight:600;">YOU</div><div style="font-size:13px;color:#e0e0e0;line-height:1.5;">'+esc(t)+'</div>';msgArea.appendChild(d);scroll();}
    function md(s){if(!s)return '';s=esc(s);var bt=String.fromCharCode(96);s=s.replace(new RegExp(bt+bt+bt+'([\\\\s\\\\S]*?)'+bt+bt+bt,'g'),function(_,c){return '<pre style="background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.05);border-radius:6px;padding:8px;margin:6px 0;font-size:11px;font-family:monospace;color:#a5b4fc;overflow-x:auto;">'+c.trim()+'</pre>';});s=s.replace(new RegExp(bt+'([^'+bt+']+)'+bt,'g'),'<code style="background:rgba(255,255,255,.08);padding:1px 5px;border-radius:3px;font-size:11px;font-family:monospace;color:#67e8f9;">$1</code>');s=s.replace(/^### (.+)$/gm,'<div style="font-size:14px;font-weight:600;color:#e0e0e0;margin:8px 0 4px;">$1</div>');s=s.replace(/^## (.+)$/gm,'<div style="font-size:15px;font-weight:700;color:#e0e0e0;margin:10px 0 4px;">$1</div>');s=s.replace(/^# (.+)$/gm,'<div style="font-size:16px;font-weight:700;color:#fff;margin:10px 0 6px;">$1</div>');s=s.replace(/\\*\\*(.+?)\\*\\*/g,'<strong style="color:#e0e0e0;">$1</strong>');s=s.replace(/\\*(.+?)\\*/g,'<em>$1</em>');s=s.replace(/^- (.+)$/gm,'<div style="padding-left:12px;margin:2px 0;">&#8226; $1</div>');s=s.replace(/\\n/g,'<br>');return s;}
    function addSystem(t){const d=document.createElement('div');d.style.cssText='text-align:center;font-size:10px;color:#444;padding:4px;';d.textContent=t;msgArea.appendChild(d);scroll();}
    function addAI(c,m,ms){var cl=getColor(m);const d=document.createElement('div');d.style.cssText='align-self:flex-start;max-width:85%;background:rgba(16,16,24,.8);border:1px solid rgba(255,255,255,.06);border-radius:12px 12px 12px 2px;padding:10px 14px;';d.innerHTML='<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="font-size:9px;color:'+cl+';font-weight:600;">'+(m||'AI').toUpperCase()+'</span><span style="font-size:9px;color:#333;">'+(ms?(ms/1000).toFixed(1)+'s':'')+'</span></div><div style="font-size:13px;color:#ccc;line-height:1.6;word-wrap:break-word;">'+md(c)+'</div>';msgArea.appendChild(d);scroll();}
    function addBattleGrid(providers){var cols=providers.length<=2?'1fr 1fr':providers.length===3?'1fr 1fr 1fr':'1fr 1fr';var d=document.createElement('div');d.id='battle-grid-'+battleId;d.style.cssText='display:grid;grid-template-columns:'+cols+';gap:8px;width:100%;';providers.forEach(function(p){var cell=document.createElement('div');cell.id='battle-cell-'+p+'-'+battleId;cell.style.cssText='background:rgba(16,16,24,.8);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px;min-height:80px;';var cl=getColor(p);cell.innerHTML='<div style="font-size:9px;color:'+cl+';font-weight:700;margin-bottom:6px;text-transform:uppercase;display:flex;align-items:center;gap:4px;">'+p+'<span style="display:inline-flex;gap:2px;margin-left:4px;"><span style="width:3px;height:3px;background:'+cl+';border-radius:50%;animation:pulse 1s infinite;"></span><span style="width:3px;height:3px;background:'+cl+';border-radius:50%;animation:pulse 1s infinite .2s;"></span><span style="width:3px;height:3px;background:'+cl+';border-radius:50%;animation:pulse 1s infinite .4s;"></span></span></div><div class="battle-content" style="font-size:12px;color:#888;line-height:1.5;">Waiting...</div>';d.appendChild(cell);});msgArea.appendChild(d);scroll();}
    function addBattleResponse(c,m,ms){var cell=document.getElementById('battle-cell-'+m+'-'+battleId);if(cell){var cl=getColor(m);cell.innerHTML='<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="font-size:9px;color:'+cl+';font-weight:700;text-transform:uppercase;">'+m+'</span><span style="font-size:9px;color:#555;">'+(ms?(ms/1000).toFixed(1)+'s':'')+'</span></div><div style="font-size:12px;color:#ccc;line-height:1.5;word-wrap:break-word;">'+md(c)+'</div>';cell.style.borderColor='rgba(255,255,255,.1)';scroll();}else{addAI(c,m,ms);}}
    function addError(t){const d=document.createElement('div');d.style.cssText='align-self:flex-start;max-width:80%;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.15);border-radius:8px;padding:8px 12px;';d.innerHTML='<span style="font-size:10px;color:#ef4444;">\\u26A0 '+esc(t)+'</span>';msgArea.appendChild(d);scroll();}
    function updateStatus(m){removeTyping();const d=document.createElement('div');d.className='typing-indicator';d.style.cssText='align-self:flex-start;font-size:10px;color:#22c55e;padding:6px 12px;background:rgba(34,197,94,.05);border-radius:8px;display:flex;align-items:center;gap:6px;';d.innerHTML='<span style="display:inline-flex;gap:3px;"><span style="width:4px;height:4px;background:#22c55e;border-radius:50%;animation:pulse 1s infinite;"></span><span style="width:4px;height:4px;background:#22c55e;border-radius:50%;animation:pulse 1s infinite .2s;"></span><span style="width:4px;height:4px;background:#22c55e;border-radius:50%;animation:pulse 1s infinite .4s;"></span></span> '+(m.status||'processing')+'...';msgArea.appendChild(d);scroll();}
    function removeTyping(){msgArea.querySelectorAll('.typing-indicator').forEach(e=>e.remove());}
    function clearChat(){msgArea.innerHTML='<div style="text-align:center;color:#333;font-size:11px;padding:40px 0;">Chat cleared \\u26A1</div>';}
    function startTimer(){clearTimer();reqTimer=setInterval(()=>{timerEl.textContent=((Date.now()-reqStart)/1000).toFixed(1)+'s';},100);}
    function clearTimer(){if(reqTimer){clearInterval(reqTimer);reqTimer=null;}setTimeout(()=>{timerEl.textContent='';},2000);}
    function scroll(){msgArea.scrollTop=msgArea.scrollHeight;}
    function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

    // ─── Init: load models on page ready ─────────────
    loadModels();
    </script>
    <style>@keyframes pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}#chat-messages::-webkit-scrollbar{width:4px}#chat-messages::-webkit-scrollbar-track{background:transparent}#chat-messages::-webkit-scrollbar-thumb{background:rgba(34,197,94,.15);border-radius:4px}</style>`;
}

module.exports = { getChatHTML, getChatJS, REST_PORT, VERSION, PROVIDER_COLORS };

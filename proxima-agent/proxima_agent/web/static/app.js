// Proxima — Web UI Application Core.
// Manages WebSocket state, dynamic chat flows, settings synchronization, and tool authorization UI.

// User avatar SVG markup
const USER_AVATAR_HTML = `<div class="message-avatar user-avatar" title="User"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></div>`;

// UI and socket state
const State = {
    ws: null,
    connected: false,
    agentRunning: false,
    conversationId: null,
    messageCount: 0,
    currentStreamEl: null,
    currentStreamText: '',
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    reconnectDelay: 1000,
    lastCodeCard: null,
    sidebarOpen: false,
    settingsOpen: false,
    config: {},
    conversations: [],
    attachedFiles: [],
    selectedModel: 'claude',
    selectedMode: 'full_auto',
    activityPanelOpen: true,
    activeTimelineStep: null,
    // BYOK state
    byokGlobalModels: [],
    byokGlobalEnabled: false,
    byokHasLocal: false,
    byokSyncTimer: null,
    byokSelectedProvider: null,
    byokSessionModelsHTML: null,
    _byokLocalModels: [],
    lastTaskTitle: '',
    lastTaskCompletedAt: null,
};

// Sound effects playback using Web Audio API
function playSound(type) {
    if (!State.config?.sound) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.15;
        if (type === 'success') {
            osc.frequency.value = 880; osc.type = 'sine';
            osc.start(); osc.stop(ctx.currentTime + 0.12);
        } else {
            osc.frequency.value = 330; osc.type = 'square';
            osc.start(); osc.stop(ctx.currentTime + 0.25);
        }
        setTimeout(() => ctx.close(), 500);
    } catch (e) { }
}

// Cache DOM elements
const DOM = {};
function cacheDom() {
    DOM.chatMessages = document.getElementById('chat-messages');
    DOM.chatInput = document.getElementById('chat-input');
    DOM.sendBtn = document.getElementById('send-btn');
    DOM.stopBtn = document.getElementById('stop-btn');
    DOM.newSessionBtn = document.getElementById('new-session-btn');
    DOM.modelTrigger = document.getElementById('model-trigger');
    DOM.modelTriggerText = document.getElementById('model-trigger-text');
    DOM.modelPopup = document.getElementById('model-popup');
    DOM.connectionStatus = document.getElementById('connection-status');
    DOM.connectionDot = document.getElementById('connection-dot');
    DOM.connectionText = document.getElementById('connection-text');
    DOM.typingInd = document.getElementById('typing-indicator');
    DOM.approvalModal = document.getElementById('approval-modal');
    DOM.approvalCode = document.getElementById('approval-code');
    DOM.approveAllow = document.getElementById('approve-allow-btn');
    DOM.approveDeny = document.getElementById('approve-deny-btn');
    DOM.toasts = document.getElementById('toast-container');
    DOM.sidebar = document.getElementById('sidebar');
    DOM.sidebarToggle = document.getElementById('sidebar-toggle');
    DOM.sidebarClose = document.getElementById('sidebar-close');
    DOM.historyList = document.getElementById('history-list');
    DOM.historySearch = document.getElementById('history-search');
    DOM.settingsBtn = document.getElementById('settings-btn');
    DOM.settingsModal = document.getElementById('settings-modal');
    DOM.settingsClose = document.getElementById('settings-close');
    DOM.settingsSave = document.getElementById('settings-save');
    DOM.brainBar = document.getElementById('brain-bar');
    DOM.brainFill = document.getElementById('brain-progress-fill');
    DOM.brainLabel = document.getElementById('brain-label');
    DOM.fileInput = document.getElementById('file-input');
    DOM.filePreview = document.getElementById('file-preview');
    DOM.attachBtn = document.getElementById('attach-btn');
    DOM.themeToggleBtn = document.getElementById('theme-toggle-btn');
    DOM.themeIconSun = document.getElementById('theme-icon-sun');
    DOM.themeIconMoon = document.getElementById('theme-icon-moon');

    // Redesign elements
    DOM.activityPanel = document.getElementById('activity-panel');
    DOM.activityToggle = document.getElementById('activity-toggle');
    DOM.timelineSteps = document.getElementById('timeline-steps');
    DOM.activityLogs = document.getElementById('activity-logs');
    DOM.clearActivityLogs = document.getElementById('clear-activity-logs');
    DOM.pinnedChatsList = document.getElementById('pinned-chats-list');
    DOM.foldersList = document.getElementById('folders-list');
    DOM.exportBtn = document.getElementById('export-btn');
    DOM.exportPopup = document.getElementById('export-popup');
}


// WebSocket connection management
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    State.ws = new WebSocket(`${proto}//${location.host}/ws`);

    State.ws.onopen = () => {
        State.connected = true;
        // Reset reconnect attempts after 5s of connection stability.
        // Prevents reconnect loops if multiple tabs are open.
        if (State._stableTimer) clearTimeout(State._stableTimer);
        State._stableTimer = setTimeout(() => { State.reconnectAttempts = 0; }, 5000);
        // Badge stays Offline until server confirms gateway is up
    };

    State.ws.onclose = () => {
        State.connected = false;
        if (State._stableTimer) { clearTimeout(State._stableTimer); State._stableTimer = null; }
        DOM.connectionStatus.classList.remove('connected');
        DOM.connectionStatus.title = 'Disconnected';
        DOM.connectionText.textContent = 'Offline';
        State.agentRunning = false;
        syncUI();
        if (State.reconnectAttempts < State.maxReconnectAttempts) {
            const d = State.reconnectDelay * Math.pow(1.5, State.reconnectAttempts);
            State.reconnectAttempts++;
            setTimeout(connectWS, d);
        } else {
            toast('Connection lost. Refresh to reconnect.', 'error');
        }
    };

    State.ws.onerror = () => { };
    State.ws.onmessage = (e) => {
        try { routeMessage(JSON.parse(e.data)); } catch (err) { console.error('Bad msg:', e.data); }
    };
}


// Route incoming messages
function routeMessage(msg) {
    const h = {
        status: onStatus,
        session_init: onSession,
        session_reset: onSession,
        thinking: onThinking,
        console: onConsole,
        token: onToken,
        assistant_message: onAssistant,
        code_start: onCodeStart,
        code_result: onCodeResult,
        input_request: onInputRequest,
        approval_request: onApprovalRequest,
        suggest_request: onSuggestRequest,
        agent_done: onDone,
        error: onError,
        plan_update: onBrain,
        brain_state: onBrain,
        debug_log: onDebugLog,
    };
    const fn = h[msg.type];
    if (fn) fn(msg);
}


// WebSocket event handlers
function onStatus(msg) {
    if (msg.model) setModel(msg.model, false);
    if (msg.mode) setMode(msg.mode, false);
    if (msg.multi_agent !== undefined) setMultiAgent(msg.multi_agent, false);
    if (msg.running !== undefined) { State.agentRunning = msg.running; syncUI(); }
    // Gateway connectivity drives the badge
    if (msg.connected !== undefined) {
        if (msg.connected) {
            DOM.connectionStatus.classList.add('connected');
            DOM.connectionStatus.title = 'Proxima Gateway Online';
            DOM.connectionText.textContent = 'Online';
        } else {
            DOM.connectionStatus.classList.remove('connected');
            DOM.connectionStatus.title = 'Proxima Gateway Offline';
            DOM.connectionText.textContent = 'Offline';
        }
    }
}

function onSession(msg) {
    State.conversationId = msg.conversation_id;
    if (msg.type === 'session_reset') {
        DOM.chatMessages.innerHTML = '';
        State.messageCount = 0;
        State.currentStreamEl = null;
        State.currentStreamText = '';
        State.lastCodeCard = null;
        hideBrain();
        showWelcome();
        window.history.pushState(null, '', '/');
        toast('New conversation started', 'info');
        loadHistory();
    } else if (msg.type === 'session_init') {
        window.history.pushState(null, '', `/c/${msg.conversation_id}`);
        loadHistory();
    }
}

function onThinking() {
    finalizeStream();
    showTyping();
    const badge = document.getElementById('agent-badge');
    const badgeText = document.getElementById('agent-badge-text');
    if (badge && badgeText) {
        badge.className = 'agent-badge thinking';
        badgeText.textContent = 'Thinking';
    }
}

// Activity timeline UI helpers
function getOperationType(code, desc) {
    const c = (code || '').toLowerCase();
    const d = (desc || '').toLowerCase();
    if (c.includes('browser.open') || c.includes('browser.connect') || c.includes('open_browser_url') || d.includes('browser') || d.includes('opening browser')) {
        return 'Opening Browser';
    }
    if (c.includes('browser.read') || c.includes('browser.scrape') || c.includes('read_url_content') || c.includes('read_browser_page') || d.includes('read') || d.includes('scrape') || d.includes('website')) {
        return 'Reading Website';
    }
    if (c.includes('write_to_file') || c.includes('write_file') || c.includes('open(') && c.includes("'w'") || d.includes('create file') || d.includes('write file')) {
        return 'Creating File';
    }
    return 'Executing Command';
}

function addSystemLog(text, type = 'stdout') {
    if (!DOM.activityLogs) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.textContent = text;
    DOM.activityLogs.appendChild(line);
    DOM.activityLogs.scrollTop = DOM.activityLogs.scrollHeight;
}

function getCategoryIconHTML(opType, code, desc) {
    const c = (code || '').toLowerCase();
    const d = (desc || '').toLowerCase();
    const o = (opType || '').toLowerCase();

    // 1. Browser
    if (o.includes('browser') || o.includes('website') || c.includes('browser.') || c.includes('open_browser_url') || c.includes('read_url_content') || c.includes('read_browser_page') || d.includes('browser') || d.includes('website') || d.includes('scrape')) {
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;
    }
    // 2. Input / Approval
    if (d.includes('input') || d.includes('approval') || d.includes('suggest') || d.includes('ask') || d.includes('permission') || c.includes('ask_permission') || c.includes('ask_question') || c.includes('input_request') || c.includes('suggest_request')) {
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><line x1="6" y1="8" x2="6" y2="8"></line><line x1="10" y1="8" x2="10" y2="8"></line><line x1="14" y1="8" x2="14" y2="8"></line><line x1="18" y1="8" x2="18" y2="8"></line><line x1="6" y1="12" x2="6" y2="12"></line><line x1="10" y1="12" x2="10" y2="12"></line><line x1="14" y1="12" x2="14" y2="12"></line><line x1="18" y1="12" x2="18" y2="12"></line><line x1="7" y1="16" x2="17" y2="16"></line></svg>`;
    }
    // 3. File
    if (o.includes('file') || o.includes('directory') || d.includes('file') || d.includes('folder') || d.includes('directory') || c.includes('write_to_file') || c.includes('write_file') || c.includes('replace_file_content') || c.includes('multi_replace_file_content') || c.includes('view_file') || c.includes('list_dir')) {
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
    }
    // 4. Desktop
    if (d.includes('screenshot') || d.includes('desktop') || d.includes('screen') || c.includes('screenshot') || c.includes('click') || c.includes('mouse') || c.includes('keyboard')) {
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
    }
    // 5. Shell
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;
}

function addTimelineStep(opType, description, code) {
    if (!DOM.timelineSteps) return null;

    const empty = DOM.timelineSteps.querySelector('.timeline-empty');
    if (empty) empty.remove();

    DOM.timelineSteps.querySelectorAll('.timeline-step.active').forEach(el => {
        el.classList.remove('active');
        el.classList.add('completed');
    });

    const stepId = 'step-' + Date.now();
    const stepEl = document.createElement('div');
    stepEl.className = 'timeline-step active';
    stepEl.id = stepId;

    const shortDesc = description || (code ? code.split('\n')[0] : 'Executing...');
    const iconHTML = getCategoryIconHTML(opType, code, description);

    stepEl.innerHTML = `
        <div class="step-icon-wrapper">
            ${iconHTML}
        </div>
        <div class="step-content">
            <div class="step-header-row">
                <span class="step-title">${opType}</span>
                <span class="step-time">Running...</span>
            </div>
            <div class="step-desc" title="${escAttr(shortDesc)}">${esc(shortDesc)}</div>
            <div class="step-details" id="${stepId}-details">
                <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px;">Code:</div>
                <pre><code>${highlightPython(code || '')}</code></pre>
            </div>
        </div>
    `;

    stepEl.querySelector('.step-header-row').addEventListener('click', () => {
        const det = stepEl.querySelector('.step-details');
        if (det) det.classList.toggle('open');
    });

    DOM.timelineSteps.appendChild(stepEl);
    DOM.timelineSteps.scrollTop = DOM.timelineSteps.scrollHeight;

    return stepEl;
}

function completeTimelineStep(stepEl, success, duration, result) {
    if (!stepEl) return;
    stepEl.classList.remove('active');
    stepEl.classList.add(success ? 'completed' : 'error');

    const timeEl = stepEl.querySelector('.step-time');
    if (timeEl) {
        timeEl.textContent = (typeof duration === 'number' ? duration.toFixed(2) : duration) + 's';
    }

    const details = stepEl.querySelector('.step-details');
    if (details) {
        const codeBlock = details.querySelector('code');
        const resText = result || '(no output)';

        let extraHtml = '';

        const screenshotMatch = resText.match(/(?:saved|screenshot|screenshot saved|capture)[:\s]+([^\s\(\)]+\.png)/i);
        if (screenshotMatch && screenshotMatch[1]) {
            const path = screenshotMatch[1];
            // Wrap in semantic anchor to bypass inline onclick CSP block
            extraHtml += `<div style="margin-top: 8px;"><span style="color: var(--text-tertiary);">Screenshot:</span><a href="/api/file?path=${encodeURIComponent(path)}" target="_blank"><img src="/api/file?path=${encodeURIComponent(path)}" class="screenshot-preview"></a></div>`;
        }

        const fileMatch = resText.match(/(?:created|saved|written to|file)[:\s]+([^\s\(\)]+\.(?:txt|py|js|json|html|css|md|c|cpp|go|rs))/i);
        if (fileMatch && fileMatch[1]) {
            extraHtml += `<div style="margin-top: 6px;"><span style="color: var(--text-tertiary);">File:</span> <a href="/api/file?path=${encodeURIComponent(fileMatch[1])}" target="_blank" style="color: var(--accent); text-decoration: underline;">${esc(fileMatch[1])}</a></div>`;
        }

        details.innerHTML = `
            <div style="font-weight: 600; color: var(--text-tertiary); margin-bottom: 4px;">Code:</div>
            <pre><code>${codeBlock.innerHTML}</code></pre>
            <div class="timeline-result-container">
                <button class="timeline-result-toggle">
                    <svg class="chevron-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 18l6-6-6-6"/></svg>
                    <span>Result</span>
                </button>
                <div class="timeline-result-preview">
                    ${formatTerminalOutput(resText)}
                </div>
            </div>
            ${extraHtml}
        `;

        // Programmatic event listener to bypass inline onclick CSP block
        const toggleBtn = details.querySelector('.timeline-result-toggle');
        const previewDiv = details.querySelector('.timeline-result-preview');
        if (toggleBtn && previewDiv) {
            toggleBtn.addEventListener('click', (e) => {
                previewDiv.classList.toggle('open');
                toggleBtn.classList.toggle('active');
                e.stopPropagation();
            });
        }
    }
}

function onConsole(msg) {
    const txt = msg.text || '';
    if (!txt.trim()) return;
    hideTyping();
    addSystemLog(txt, 'stdout');
    if (State.lastCodeCard) { appendCardStatus(State.lastCodeCard, txt); scrollDown(); return; }
    ensureStream();
    appendStream(txt + '\n');
}

function onToken(msg) { hideTyping(); ensureStream(); appendStream(msg.content || ''); }

function onAssistant(msg) {
    hideTyping();
    finalizeStream();
    const c = msg.content || '';
    if (!c.trim()) return;
    const el = mkAssistantMsg();
    const b = el.querySelector('.message-bubble');
    try { b.innerHTML = md(c); addCopy(b); } catch (e) { b.textContent = c; }
    addMessageCopyButton(el, c);
    scrollDown();
}

function onCodeStart(msg) {
    hideTyping(); finalizeStream();

    const badge = document.getElementById('agent-badge');
    const badgeText = document.getElementById('agent-badge-text');
    if (badge && badgeText) {
        badge.className = 'agent-badge running';
        badgeText.textContent = 'Running';
    }

    State.lastTaskTitle = msg.desc || 'Executing tool...';
    State.lastTaskCompletedAt = null;
    updateExecutionCard();

    const opType = getOperationType(msg.code, msg.desc);
    State.activeTimelineStep = addTimelineStep(opType, msg.desc, msg.code);
    addSystemLog(`[Tool] Starting: ${opType} - ${msg.desc || 'No description'}`, 'system');

    const card = mkExecCard(msg.desc || 'Executing...', msg.code || '');
    State.lastCodeCard = card;
    const w = document.createElement('div');
    w.className = 'message assistant';
    w.innerHTML = `<div class="message-avatar assistant-avatar"><div class="proxima-cube proxima-cube-xs proxima-cube-static"><div class="proxima-eye"><div class="proxima-pupil"></div></div><div class="proxima-eye"><div class="proxima-pupil"></div></div></div></div><div class="message-bubble execution-bubble"></div>`;
    w.querySelector('.message-bubble').appendChild(card);
    DOM.chatMessages.appendChild(w);
    State.messageCount++;
    scrollDown();
}

function onCodeResult(msg) {
    const c = State.lastCodeCard;
    if (c) {
        if (c._timer) { clearInterval(c._timer); c._timer = null; }
        c.classList.remove('running');
        c.classList.add(msg.success ? 'success' : 'error');
        const icon = c.querySelector('.exec-status-icon');
        if (icon) {
            icon.className = 'exec-status-icon ' + (msg.success ? 'success' : 'error');
            icon.innerHTML = msg.success
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        }
        const prog = c.querySelector('.exec-progress');
        if (prog) prog.style.display = 'none';
        const statusText = c.querySelector('.exec-status-text');
        if (statusText) statusText.remove();
        const dur = c.querySelector('.exec-duration');
        if (dur) dur.textContent = (typeof msg.duration === 'number' ? msg.duration.toFixed(2) : msg.duration) + 's';
        const body = c.querySelector('.exec-body');
        if (body) {
            const rd = document.createElement('div');
            rd.className = 'exec-result' + (msg.success ? '' : ' error-result');
            const rt = msg.result || '(no output)';
            const tr = rt.length > 2000 ? rt.substring(0, 2000) + '\n...(truncated)' : rt;
            rd.innerHTML = formatTerminalOutput(tr);
            body.appendChild(rd);
        }
        State.lastCodeCard = null;
    }

    if (State.activeTimelineStep) {
        completeTimelineStep(State.activeTimelineStep, msg.success, msg.duration, msg.result);
        addSystemLog(`[Tool] Finished with ${msg.success ? 'success' : 'error'} (${typeof msg.duration === 'number' ? msg.duration.toFixed(2) : msg.duration}s)`, msg.success ? 'success' : 'system');
        State.activeTimelineStep = null;
    }

    const badge = document.getElementById('agent-badge');
    const badgeText = document.getElementById('agent-badge-text');
    if (badge && badgeText) {
        badge.className = 'agent-badge idle';
        badgeText.textContent = 'Idle';
    }
    scrollDown();
}

function onInputRequest(msg) {
    // Structured approval piggybacked on input_request (backward compat)
    if (msg.is_approval || msg.action || msg.reasons) {
        return onApprovalRequest(msg);
    }
    showInlineInput(msg.prompt || '');
}

function onApprovalRequest(msg) {
    const action = msg.action || 'Execute code';
    const code = msg.code || '';
    const reasons = Array.isArray(msg.reasons) ? msg.reasons : [];

    let html = `<div class="approval-action"><strong>Action:</strong> ${esc(action)}</div>`;

    if (reasons.length) {
        html += '<div class="approval-risks"><strong>Risk triggers:</strong><ul>';
        reasons.forEach(r => { html += `<li>${esc(r)}</li>`; });
        html += '</ul></div>';
    }

    if (code) {
        html += `<div class="approval-code-label"><strong>Code preview:</strong></div>`;
        html += `<pre class="approval-code-block">${esc(code)}</pre>`;
    }

    DOM.approvalCode.innerHTML = html;
    DOM.approvalModal.classList.add('visible');
}

function onSuggestRequest(msg) {
    // Render suggest options as interactive buttons.
    // Empty choice acts as skip to let the agent decide.
    hideTyping();
    finalizeStream();

    const context = msg.context || '';
    const options = Array.isArray(msg.options) ? msg.options : [];

    const c = document.createElement('div');
    c.className = 'message assistant';

    const optsHtml = options.map((opt, i) =>
        `<button class="suggest-option" data-idx="${i}">
            <span class="suggest-option-num">${i + 1}</span>
            <span class="suggest-option-text">${esc(opt)}</span>
        </button>`
    ).join('');

    c.innerHTML = `<div class="message-avatar assistant-avatar"><div class="proxima-cube proxima-cube-xs proxima-cube-static"><div class="proxima-eye"><div class="proxima-pupil"></div></div><div class="proxima-eye"><div class="proxima-pupil"></div></div></div></div>
        <div class="message-bubble">
            <div class="suggest-box">
                <div class="suggest-header">💡 Suggest mode — pick an approach</div>
                ${context ? `<div class="suggest-context">${esc(context)}</div>` : ''}
                <div class="suggest-options">${optsHtml}</div>
                <div class="suggest-custom">
                    <input type="text" class="inline-input suggest-custom-input" placeholder="Or type your own instruction...">
                    <button class="btn btn-primary btn-sm suggest-custom-send">Send</button>
                </div>
                <button class="suggest-skip">Skip — let the agent decide</button>
            </div>
        </div>`;
    DOM.chatMessages.appendChild(c);
    scrollDown();

    const box = c.querySelector('.suggest-box');
    let resolved = false;

    function resolve(value, label) {
        if (resolved) return;
        resolved = true;
        wsSend({ type: 'suggest_choice', value: value });
        box.innerHTML = `<div class="suggest-header">💡 Suggest mode</div><div class="suggest-resolved">${esc(label)}</div>`;
        scrollDown();
    }

    box.querySelectorAll('.suggest-option').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const text = options[idx] || '';
            resolve(text, `Chose: ${text}`);
        });
    });

    const customInput = box.querySelector('.suggest-custom-input');
    const customSend = box.querySelector('.suggest-custom-send');
    function submitCustom() {
        const v = customInput.value.trim();
        if (!v) return;
        resolve(v, `Custom: ${v}`);
    }
    customSend.addEventListener('click', submitCustom);
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCustom(); });

    box.querySelector('.suggest-skip').addEventListener('click', () => {
        resolve('', 'Skipped — agent will decide');
    });
}

function _stopActiveExecCardTimer() {
    // Clear the live-duration interval on a still-"running" exec card that never
    // received a matching code_result (e.g. the run ended between code_start and
    // code_result). Without this its 100ms setInterval leaks, ticking forever on
    // an orphaned node. Mirrors the guarded cleanup in onCodeResult().
    const c = State.lastCodeCard;
    if (c && c._timer) {
        clearInterval(c._timer);
        c._timer = null;
        c.classList.remove('running');
    }
}

function onDone() {
    State.agentRunning = false;
    _stopActiveExecCardTimer();
    State.lastCodeCard = null;
    finalizeStream();
    hideTyping();
    syncUI();
    loadHistory();

    const badge = document.getElementById('agent-badge');
    const badgeText = document.getElementById('agent-badge-text');
    if (badge && badgeText) {
        badge.className = 'agent-badge idle';
        badgeText.textContent = 'Idle';
    }

    State.lastTaskCompletedAt = Date.now();
    updateExecutionCard();

    if (State.activeTimelineStep) {
        completeTimelineStep(State.activeTimelineStep, true, 0.1, 'Finished');
        State.activeTimelineStep = null;
    }

    if (DOM.timelineSteps) {
        const step = document.createElement('div');
        step.className = 'timeline-step completed';
        step.innerHTML = `
            <div class="step-icon-wrapper">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div class="step-content">
                <div class="step-header-row">
                    <span class="step-title" style="color: var(--success);">Task Completed</span>
                </div>
            </div>
        `;
        DOM.timelineSteps.appendChild(step);
    }
    playSound('success');
}

function onError(msg) {
    if (msg.code === 'ALREADY_CONNECTED') { toast(msg.message, 'error'); return; }
    toast(msg.message || 'Unknown error', 'error');
    playSound('error');
    // Stop the orphaned exec-card timer on error too — otherwise a failure
    // between code_start and code_result leaves its interval running.
    _stopActiveExecCardTimer();
    if (State.messageCount > 0) {
        hideTyping(); finalizeStream();
        const el = mkAssistantMsg();
        el.querySelector('.message-bubble').innerHTML = `<div class="error-notice">${esc(msg.message || 'Error')}</div>`;
    }
}

function onBrain(msg) {
    const d = msg.plan || msg;
    const done = d.done || 0, total = d.total || 0;
    if (total <= 0) { hideBrain(); return; }
    const pct = Math.min(100, Math.round((done / total) * 100));
    DOM.brainFill.style.width = pct + '%';
    DOM.brainLabel.textContent = `${done}/${total}`;
    DOM.brainBar.classList.remove('hidden');
}

function hideBrain() {
    DOM.brainBar.classList.add('hidden');
    DOM.brainFill.style.width = '0%';
}

function onDebugLog(msg) {
    if (!State.config?.debug) return;
    const reqStr = JSON.stringify(msg.request, null, 2);
    const respStr = JSON.stringify(msg.response, null, 2);
    const card = document.createElement('div');
    card.className = 'debug-card';
    card.innerHTML = `<details class="debug-details">
        <summary class="debug-summary">🔍 API Call — ${esc(msg.request?.model || 'unknown')}</summary>
        <div class="debug-section">
            <div class="debug-label">Request</div>
            <pre class="debug-pre">${esc(reqStr)}</pre>
        </div>
        <div class="debug-section">
            <div class="debug-label">Response</div>
            <pre class="debug-pre">${esc(respStr)}</pre>
        </div>
    </details>`;
    DOM.chatMessages.appendChild(card);
    scrollDown();
}

// Chat interface UI helpers
function addUserMsg(text, fileNames = []) {
    hideWelcome();
    const el = document.createElement('div');
    el.className = 'message user';
    let filesHtml = '';
    if (fileNames.length) {
        filesHtml = '<div class="msg-file-chips">' + fileNames.map(name => {
            const icon = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(name) ? '\uD83D\uDDBC' : '\uD83D\uDCC4';
            return `<span class="msg-file-chip">${icon} ${esc(name)}</span>`;
        }).join('') + '</div>';
    }
    el.innerHTML = `${USER_AVATAR_HTML}<div class="message-bubble">${filesHtml}${esc(text)}</div>`;
    DOM.chatMessages.appendChild(el);
    addMessageCopyButton(el, text);
    State.messageCount++;
    scrollDown();
}

function mkAssistantMsg() {
    const el = document.createElement('div');
    el.className = 'message assistant';
    el.innerHTML = `<div class="message-avatar assistant-avatar"><div class="proxima-cube proxima-cube-xs proxima-cube-static"><div class="proxima-eye"><div class="proxima-pupil"></div></div><div class="proxima-eye"><div class="proxima-pupil"></div></div></div></div><div class="message-bubble"></div>`;
    DOM.chatMessages.appendChild(el);
    State.messageCount++;
    return el;
}

function ensureStream() {
    if (!State.currentStreamEl) {
        hideTyping();
        const el = mkAssistantMsg();
        State.currentStreamEl = el.querySelector('.message-bubble');
        State.currentStreamText = '';
    }
}

function appendStream(t) {
    if (!State.currentStreamEl) return;
    State.currentStreamText += t;
    // Coalesce re-renders to once per animation frame. Re-parsing the FULL
    // markdown + re-scanning all code blocks on EVERY token was O(n^2) and
    // froze the UI on long responses. finalizeStream() still does a final pass.
    if (State._streamRenderPending) return;
    State._streamRenderPending = true;
    requestAnimationFrame(() => {
        State._streamRenderPending = false;
        if (!State.currentStreamEl) return;
        try { State.currentStreamEl.innerHTML = md(State.currentStreamText); addCopy(State.currentStreamEl); }
        catch (e) { State.currentStreamEl.textContent = State.currentStreamText; }
        scrollDown();
    });
}

function finalizeStream() {
    if (State.currentStreamEl && State.currentStreamText.trim()) {
        const textToCopy = State.currentStreamText;
        try { State.currentStreamEl.innerHTML = md(textToCopy); addCopy(State.currentStreamEl); } catch (e) { }
        const msgEl = State.currentStreamEl.closest('.message');
        if (msgEl) {
            addMessageCopyButton(msgEl, textToCopy);
        }
    }
    State.currentStreamEl = null;
    State.currentStreamText = '';
}

function appendCardStatus(card, text) {
    let s = card.querySelector('.exec-status-text');
    if (!s) { s = document.createElement('div'); s.className = 'exec-status-text'; const h = card.querySelector('.exec-header'); if (h) h.after(s); }
    const lines = text.trim().split('\n');
    const last = lines[lines.length - 1].trim();
    if (last) s.textContent = last;
}

function showInlineInput(prompt) {
    const c = document.createElement('div');
    c.className = 'message assistant';
    c.innerHTML = `<div class="message-avatar assistant-avatar"><div class="proxima-cube proxima-cube-xs proxima-cube-static"><div class="proxima-eye"><div class="proxima-pupil"></div></div><div class="proxima-eye"><div class="proxima-pupil"></div></div></div></div>
        <div class="message-bubble"><div class="inline-input-prompt">${esc(prompt)}</div><div class="inline-input-group"><input type="text" class="inline-input" placeholder="Type your response..." autofocus><button class="btn btn-primary btn-sm">Send</button></div></div>`;
    DOM.chatMessages.appendChild(c);
    scrollDown();
    const inp = c.querySelector('.inline-input'), btn = c.querySelector('.btn');
    function submit() {
        const v = inp.value.trim();
        wsSend({ type: 'input_response', value: v });
        c.querySelector('.message-bubble').innerHTML = `<div class="inline-input-prompt">${esc(prompt)}</div><div class="inline-answer">${esc(v || '(empty)')}</div>`;
    }
    btn.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    inp.focus();
}


// Syntax highlighter and terminal output formatting
function highlightPython(code) {
    const keywords = new Set(['def', 'class', 'return', 'if', 'else', 'elif', 'for', 'in', 'import', 'from', 'print', 'try', 'except', 'as', 'and', 'or', 'not', 'pass', 'with', 'lambda', 'yield', 'global', 'nonlocal', 'assert', 'break', 'continue']);
    const builtins = new Set(['len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'print', 'open', 'close', 'read', 'write', 'append', 'exists', 'path', 'join', 'True', 'False', 'None', 'self']);

    const tokenRegex = /(#[^\n]*)|("[^"\\]*(?:\\.[^"\\]*)*")|('[^'\\]*(?:\\.[^'\\]*)*')|([a-zA-Z_]\w*)|([0-9]+)|([^\s\w]+)|(\s+)/g;
    const tokens = [];
    let match;

    while ((match = tokenRegex.exec(code)) !== null) {
        const [text, comment, strDouble, strSingle, word, num, op, ws] = match;
        if (comment) {
            tokens.push(`<span style="color: #71717a; font-style: italic;">${esc(text)}</span>`);
        } else if (strDouble || strSingle) {
            tokens.push(`<span style="color: #10b981;">${esc(text)}</span>`); // emerald string
        } else if (word) {
            if (keywords.has(word)) {
                tokens.push(`<span style="color: #f59e0b; font-weight: 600;">${esc(text)}</span>`); // amber keywords
            } else if (builtins.has(word)) {
                tokens.push(`<span style="color: #38bdf8;">${esc(text)}</span>`); // sky blue builtins
            } else {
                tokens.push(esc(text));
            }
        } else if (num) {
            tokens.push(`<span style="color: #a78bfa;">${esc(text)}</span>`); // purple numbers
        } else {
            tokens.push(esc(text));
        }
    }
    return tokens.length > 0 ? tokens.join('') : esc(code);
}

function formatTerminalOutput(text) {
    let html = esc(text);
    // Highlight [✓], PASS, SUCCESS in bright emerald
    html = html.replace(/(\[✓\]|PASS:|SUCCESS:|PASSED)/g, '<span style="color: #10b981; font-weight: 600;">$1</span>');
    // Highlight [✗], FAIL, ERROR in bright red
    html = html.replace(/(\[✗\]|FAIL:|ERROR:|FAILED)/g, '<span style="color: #f43f5e; font-weight: 600;">$1</span>');
    // Highlight URLs in sky blue
    html = html.replace(/(https?:\/\/[^\s]+|file:\/\/\/[^\s]+)/g, '<span style="color: #38bdf8; text-decoration: underline; cursor: pointer;">$1</span>');
    // Highlight step-like markers or brackets
    html = html.replace(/(info:|warning:)/gi, '<span style="color: #fbbf24; font-weight: 600;">$1</span>');
    return html;
}

// Execution card rendering
function mkExecCard(desc, code) {
    const c = document.createElement('div');
    c.className = 'execution-card running';
    c.innerHTML = `<div class="exec-header">
        <div class="exec-status">
            <span class="exec-status-icon running"><svg class="exec-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.2"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg></span>
            <span class="exec-desc">${esc(desc)}</span>
        </div>
        <div class="exec-header-right">
            <span class="exec-duration">0.0s</span>
            <svg class="exec-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </div>
    </div>
    <div class="exec-progress"><div class="exec-progress-bar"></div></div>
    <div class="exec-body"><div class="exec-code"><span class="exec-label">Code</span><pre><code>${highlightPython(code)}</code></pre></div></div>`;
    const durEl = c.querySelector('.exec-duration');
    const t0 = performance.now();
    c._timer = setInterval(() => {
        durEl.textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's';
    }, 100);
    c.querySelector('.exec-header').addEventListener('click', () => {
        c.querySelector('.exec-body').classList.toggle('open');
        c.classList.toggle('expanded');
    });
    return c;
}


// Welcome screen layout rendering
function showWelcome() {
    if (document.getElementById('welcome-screen')) return;
    const w = document.createElement('div');
    w.id = 'welcome-screen';
    w.className = 'welcome-screen';
    w.innerHTML = `
        <div class="welcome-icon">
            <div class="proxima-cube proxima-cube-lg">
                <div class="proxima-eye"><div class="proxima-pupil"></div></div>
                <div class="proxima-eye"><div class="proxima-pupil"></div></div>
            </div>
        </div>
        <h1 class="welcome-title">Proxima</h1>
        <p class="welcome-subtitle">Let's make something happen. What's on your mind?</p>
        
        <div class="welcome-grid">
            <div class="welcome-card" data-prompt="open google.com and search for the latest AI coding news">
                <div class="welcome-card-icon blue">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="2" y1="12" x2="22" y2="12"></line>
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                    </svg>
                </div>
                <div>
                    <div style="font-weight: 600; color: var(--text-primary);">Web Automation</div>
                    <div style="font-size: 11px; opacity: 0.85;">Browse websites and extract info</div>
                </div>
            </div>
            <div class="welcome-card" data-prompt="check my current CPU usage and list the top active processes">
                <div class="welcome-card-icon green">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="4 17 10 11 20 11"></polyline>
                        <polyline points="12 19 20 11 12 3"></polyline>
                    </svg>
                </div>
                <div>
                    <div style="font-weight: 600; color: var(--text-primary);">Terminal Tasks</div>
                    <div style="font-size: 11px; opacity: 0.85;">Run scripts and system commands</div>
                </div>
            </div>
            <div class="welcome-card" data-prompt="calculate the total sizes of all files and subfolders in my Downloads folder, and list them sorted from largest to smallest">
                <div class="welcome-card-icon purple">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                </div>
                <div>
                    <div style="font-weight: 600; color: var(--text-primary);">File Operations</div>
                    <div style="font-size: 11px; opacity: 0.85;">Read, write, and manage folder structures</div>
                </div>
            </div>
            <div class="welcome-card" data-prompt="list all the programs that are set to launch automatically when my computer starts up">
                <div class="welcome-card-icon orange">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                        <line x1="8" y1="21" x2="16" y2="21"></line>
                        <line x1="12" y1="17" x2="12" y2="21"></line>
                    </svg>
                </div>
                <div>
                    <div style="font-weight: 600; color: var(--text-primary);">System Inspection</div>
                    <div style="font-size: 11px; opacity: 0.85;">Inspect desktops, screens and hardware</div>
                </div>
            </div>
        </div>
    `;
    DOM.chatMessages.appendChild(w);

    w.querySelectorAll('.welcome-card').forEach(card => {
        card.addEventListener('click', () => {
            const prompt = card.dataset.prompt;
            if (DOM.chatInput) {
                DOM.chatInput.value = prompt;
                DOM.chatInput.focus();
                DOM.chatInput.style.height = 'auto';
                DOM.chatInput.style.height = Math.min(DOM.chatInput.scrollHeight, 200) + 'px';
            }
        });
    });
}

function hideWelcome() { const w = document.getElementById('welcome-screen'); if (w) w.remove(); }


// Markdown parsing and copying
function md(text) {
    if (typeof marked === 'undefined') return esc(text);
    marked.setOptions({ breaks: true, gfm: true });
    // Sanitize marked's output before it ever reaches innerHTML — closes the
    // XSS path from agent-rendered web/file content.
    return sanitizeHtml(marked.parse(String(text == null ? '' : text)));
}

function addCopy(container) {
    container.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn'; btn.textContent = 'Copy';
        btn.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent).then(() => {
                btn.textContent = 'Copied!'; btn.classList.add('copied');
                setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
            });
        };
        pre.style.position = 'relative';
        pre.appendChild(btn);
    });
}

function addMessageCopyButton(messageEl, textToCopy) {
    const bubble = messageEl.querySelector('.message-bubble');
    if (!bubble) return;
    if (bubble.querySelector('.msg-copy-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'msg-copy-btn';
    btn.title = 'Copy message';
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

    btn.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(textToCopy).then(() => {
            btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            btn.classList.add('copied');
            toast('Message copied', 'success');
            setTimeout(() => {
                btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
                btn.classList.remove('copied');
            }, 2000);
        });
    };

    bubble.appendChild(btn);
}


// File upload management
function initFileUpload() {
    if (!DOM.fileInput || !DOM.chatInput) return;

    DOM.fileInput.addEventListener('change', () => {
        for (const f of DOM.fileInput.files) addFile(f);
        DOM.fileInput.value = '';
    });

    const ic = DOM.chatInput.closest('.composer-card') || DOM.chatInput.closest('.input-container');
    if (ic) {
        ic.addEventListener('dragover', (e) => { e.preventDefault(); ic.style.borderColor = 'var(--accent)'; });
        ic.addEventListener('dragleave', () => { ic.style.borderColor = ''; });
        ic.addEventListener('drop', (e) => {
            e.preventDefault(); ic.style.borderColor = '';
            for (const f of e.dataTransfer.files) addFile(f);
        });
    }
}

function addFile(file) {
    State.attachedFiles.push(file);
    renderFiles();
}

function removeFile(idx) {
    State.attachedFiles.splice(idx, 1);
    renderFiles();
}

function renderFiles() {
    if (State.attachedFiles.length === 0) {
        DOM.filePreview.classList.add('hidden');
        DOM.filePreview.innerHTML = '';
        return;
    }
    DOM.filePreview.classList.remove('hidden');
    DOM.filePreview.innerHTML = State.attachedFiles.map((f, i) => {
        const icon = f.type.startsWith('image/') ? '\uD83D\uDDBC' : '\uD83D\uDCC4';
        return `<div class="file-chip">${icon} <span>${esc(f.name)}</span><span class="file-chip-remove" data-idx="${i}">\u00D7</span></div>`;
    }).join('');
    DOM.filePreview.querySelectorAll('.file-chip-remove').forEach(btn => {
        btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.idx)));
    });
}





// Sidebar UI layout
function updateResizerVisibility() {
    const sidebarResizer = document.getElementById('sidebar-resizer');
    const activityResizer = document.getElementById('activity-resizer');
    if (sidebarResizer) {
        sidebarResizer.style.display = State.sidebarOpen ? '' : 'none';
    }
    if (activityResizer) {
        activityResizer.style.display = State.activityPanelOpen ? '' : 'none';
    }
}

function updateExecutionCard() {
    const cardTitle = document.getElementById('current-task-title');
    const cardHeader = document.querySelector('.task-card-header');
    if (!cardTitle || !cardHeader) return;

    if (State.agentRunning) {
        const progressEl = document.getElementById('task-progress');
        const progressText = progressEl ? progressEl.textContent : '0/0 tool steps';
        cardHeader.innerHTML = `
            <span class="task-card-label">Current Execution</span>
            <span id="task-progress" class="task-card-progress">${progressText}</span>
        `;
        cardTitle.textContent = State.lastTaskTitle || 'Executing...';
    } else {
        let timeStr = 'Standby';
        if (State.lastTaskCompletedAt) {
            const elapsed = Math.floor((Date.now() - State.lastTaskCompletedAt) / 1000);
            if (elapsed < 60) {
                timeStr = `Completed ${elapsed}s ago`;
            } else if (elapsed < 3600) {
                timeStr = `Completed ${Math.floor(elapsed / 60)}m ago`;
            } else if (elapsed < 86400) {
                timeStr = `Completed ${Math.floor(elapsed / 3600)}h ago`;
            } else {
                timeStr = `Completed ${Math.floor(elapsed / 86400)}d ago`;
            }
        }
        cardHeader.innerHTML = `
            <span class="task-card-label">Current Status</span>
            <span class="task-card-progress" style="color: var(--text-muted); font-weight: 500;">${timeStr}</span>
        `;

        const lastTaskText = State.lastTaskTitle ? `Last Task: ${State.lastTaskTitle}` : 'Waiting for prompt';
        cardTitle.innerHTML = `
            <div style="font-size: 12px; color: var(--text-primary); font-family: var(--font-mono); font-weight: 500; word-break: break-word; line-height: 1.4;" title="${escAttr(lastTaskText)}">${esc(lastTaskText)}</div>
        `;
    }
}

// Sidebar state toggles
function toggleSidebar() {
    State.sidebarOpen = !State.sidebarOpen;
    DOM.sidebar.classList.toggle('collapsed', !State.sidebarOpen);
    DOM.sidebarToggle.classList.toggle('active', State.sidebarOpen);
    localStorage.setItem('proxima_sidebar', State.sidebarOpen ? '1' : '0');
    if (State.sidebarOpen) loadHistory();
    updateResizerVisibility();
}

function closeSidebar() {
    State.sidebarOpen = false;
    DOM.sidebar.classList.add('collapsed');
    DOM.sidebarToggle.classList.remove('active');
    localStorage.setItem('proxima_sidebar', '0');
    updateResizerVisibility();
}

// Activity panel management
function toggleActivityPanel() {
    State.activityPanelOpen = !State.activityPanelOpen;
    DOM.activityPanel.classList.toggle('collapsed', !State.activityPanelOpen);
    DOM.activityToggle.classList.toggle('active', State.activityPanelOpen);
    localStorage.setItem('proxima_activity', State.activityPanelOpen ? '1' : '0');
    updateResizerVisibility();
}

function restoreActivityPanel() {
    const saved = localStorage.getItem('proxima_activity');
    const shouldOpen = saved === null || saved === '1';
    State.activityPanelOpen = shouldOpen;
    DOM.activityPanel.classList.toggle('collapsed', !shouldOpen);
    DOM.activityToggle.classList.toggle('active', shouldOpen);
    updateResizerVisibility();
}

async function loadHistory() {
    try {
        const r = await fetch('/api/history');
        State.conversations = await r.json() || [];
        renderHistory(State.conversations);
    } catch (e) {
        if (DOM.historyList) DOM.historyList.innerHTML = '<div class="history-empty">Failed to load</div>';
    }
}

function renderItemHtml(c) {
    const t = escAttr(c.title || 'Untitled');
    const d = fmtDate(c.created_at || c.updated_at);
    const active = c.id === State.conversationId;
    const pinned = c.is_pinned === 1;
    const folderName = c.folder_name || '';

    return `
        <div class="history-item${active ? ' active' : ''}" data-id="${c.id}" title="${t}">
            <svg class="history-item-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <div class="history-item-title">${t}</div>
            <div class="history-item-meta">
                <span class="history-item-date">${d}</span>
                <div class="history-item-actions-wrapper">
                    <button class="history-item-menu-btn" title="Actions" data-id="${c.id}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <circle cx="12" cy="12" r="1.5"></circle>
                            <circle cx="19" cy="12" r="1.5"></circle>
                            <circle cx="5" cy="12" r="1.5"></circle>
                        </svg>
                    </button>
                    <div class="history-item-dropdown" id="dropdown-${c.id}">
                        <button class="dropdown-item rename-btn" data-id="${c.id}" data-title="${t}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            <span>Rename</span>
                        </button>
                        <button class="dropdown-item pin-btn" data-id="${c.id}" data-pinned="${pinned ? '1' : '0'}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="${pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
                                <path d="M15 4.5l-6 6L7 9.5l-3 3 5 5 3-3-1-2 6-6zM9 15l-5 5"/>
                            </svg>
                            <span>${pinned ? 'Unpin' : 'Pin'}</span>
                        </button>
                        <button class="dropdown-item folder-btn" data-id="${c.id}" data-folder="${escAttr(folderName)}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            </svg>
                            <span>Folder...</span>
                        </button>
                        <button class="dropdown-item delete-btn" data-id="${c.id}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>
                            </svg>
                            <span>Delete</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderHistory(list) {
    if (!list) return;

    const pinnedList = list.filter(c => c.is_pinned === 1);
    const folderGroups = {};
    const unassignedList = [];

    list.forEach(c => {
        if (c.is_pinned === 1) {
            // Already handled in pinnedList
        } else if (c.folder_name) {
            if (!folderGroups[c.folder_name]) {
                folderGroups[c.folder_name] = [];
            }
            folderGroups[c.folder_name].push(c);
        } else {
            unassignedList.push(c);
        }
    });

    const pinnedSec = document.getElementById('sidebar-section-pinned');
    if (pinnedSec) {
        pinnedSec.style.display = pinnedList.length === 0 ? 'none' : 'flex';
    }
    const foldersSec = document.getElementById('sidebar-section-folders');
    const folderNames = Object.keys(folderGroups);
    if (foldersSec) {
        foldersSec.style.display = folderNames.length === 0 ? 'none' : 'flex';
    }

    if (DOM.pinnedChatsList && pinnedList.length > 0) {
        DOM.pinnedChatsList.innerHTML = pinnedList.map(c => renderItemHtml(c)).join('');
    }

    if (DOM.foldersList && folderNames.length > 0) {
        DOM.foldersList.innerHTML = folderNames.map(folderName => {
            const folderConvs = folderGroups[folderName];
            const isExpanded = localStorage.getItem(`folder_exp_${folderName}`) !== '0';
            const itemsHtml = folderConvs.map(c => renderItemHtml(c)).join('');

            return `
                <div class="sidebar-folder ${isExpanded ? 'expanded' : ''}" data-folder="${esc(folderName)}">
                    <div class="folder-header">
                        <svg class="folder-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <path d="M6 9l6 6 6-6" />
                        </svg>
                        <span class="folder-label">${esc(folderName)}</span>
                        <button class="folder-rename-btn" title="Rename Folder" data-folder="${esc(folderName)}">✎</button>
                    </div>
                    <div class="folder-contents" style="${isExpanded ? '' : 'display: none;'}">
                        ${itemsHtml}
                    </div>
                </div>
            `;
        }).join('');
    }

    if (DOM.historyList) {
        if (unassignedList.length === 0) {
            DOM.historyList.innerHTML = '<div class="history-empty">No recent chats</div>';
        } else {
            DOM.historyList.innerHTML = unassignedList.map(c => renderItemHtml(c)).join('');
        }
    }

    const containers = [DOM.pinnedChatsList, DOM.foldersList, DOM.historyList];
    containers.forEach(listContainer => {
        if (!listContainer) return;

        listContainer.querySelectorAll('.history-item').forEach(el => {
            el.addEventListener('click', (e) => {
                if (!e.target.closest('button')) {
                    loadConv(el.dataset.id);
                }
            });
        });

        listContainer.querySelectorAll('.history-item-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close other open dropdowns first
                document.querySelectorAll('.history-item-dropdown.show').forEach(d => {
                    if (d.id !== `dropdown-${btn.dataset.id}`) {
                        d.classList.remove('show');
                    }
                });
                const dropdown = document.getElementById(`dropdown-${btn.dataset.id}`);
                if (dropdown) {
                    dropdown.classList.toggle('show');
                }
            });
        });

        // Prevent dropdown click from bubbling up to the history item (loading conversation)
        listContainer.querySelectorAll('.history-item-dropdown').forEach(dropdown => {
            dropdown.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        listContainer.querySelectorAll('.rename-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dropdown = btn.closest('.history-item-dropdown');
                if (dropdown) dropdown.classList.remove('show');
                renameConv(btn.dataset.id, btn.dataset.title);
            });
        });

        listContainer.querySelectorAll('.pin-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dropdown = btn.closest('.history-item-dropdown');
                if (dropdown) dropdown.classList.remove('show');
                togglePin(btn.dataset.id, btn.dataset.pinned === '1');
            });
        });

        listContainer.querySelectorAll('.folder-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dropdown = btn.closest('.history-item-dropdown');
                if (dropdown) dropdown.classList.remove('show');
                promptFolderChange(btn.dataset.id, btn.dataset.folder);
            });
        });

        listContainer.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dropdown = btn.closest('.history-item-dropdown');
                if (dropdown) dropdown.classList.remove('show');
                deleteConv(btn.dataset.id);
            });
        });
    });

    if (DOM.foldersList && folderNames.length > 0) {
        DOM.foldersList.querySelectorAll('.folder-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.folder-rename-btn')) return;
                const folderDiv = header.closest('.sidebar-folder');
                const folderName = folderDiv.dataset.folder;
                const contents = folderDiv.querySelector('.folder-contents');
                const isExpanded = folderDiv.classList.toggle('expanded');
                contents.style.display = isExpanded ? '' : 'none';
                localStorage.setItem(`folder_exp_${folderName}`, isExpanded ? '1' : '0');
            });
        });

        DOM.foldersList.querySelectorAll('.folder-rename-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const folderName = btn.dataset.folder;
                promptRenameFolder(folderName);
            });
        });
    }
}

async function togglePin(id, isPinned) {
    try {
        await fetch(`/api/conversations/${id}/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_pinned: !isPinned })
        });
        toast(!isPinned ? 'Conversation pinned' : 'Conversation unpinned', 'success');
        loadHistory();
    } catch (e) {
        toast('Failed to pin conversation', 'error');
    }
}

async function renameConv(id, oldTitle) {
    const newTitle = prompt("Rename conversation to:", oldTitle);
    if (newTitle === null) return;
    const targetTitle = newTitle.trim();
    if (!targetTitle || targetTitle === oldTitle) return;

    try {
        await fetch(`/api/conversations/${id}/title`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: targetTitle })
        });
        toast('Conversation renamed', 'success');
        loadHistory();
    } catch (e) {
        toast('Failed to rename conversation', 'error');
    }
}

async function promptFolderChange(id, currentFolder) {
    const folders = new Set();
    State.conversations.forEach(c => { if (c.folder_name) folders.add(c.folder_name); });
    const folderList = Array.from(folders);

    let msg = `Enter folder name to move this conversation to.\n`;
    if (folderList.length > 0) {
        msg += `Existing folders: ${folderList.join(', ')}\n`;
    }
    msg += `(Leave empty to remove from folder)`;

    const folderName = prompt(msg, currentFolder || '');
    if (folderName === null) return;

    const targetFolder = folderName.trim() || null;
    try {
        await fetch(`/api/conversations/${id}/folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder_name: targetFolder })
        });
        toast(targetFolder ? `Moved to folder "${targetFolder}"` : 'Removed from folder', 'success');
        loadHistory();
    } catch (e) {
        toast('Failed to move conversation', 'error');
    }
}

async function promptRenameFolder(oldFolderName) {
    const newFolderName = prompt(`Rename folder "${oldFolderName}" to:`, oldFolderName);
    if (newFolderName === null) return;
    const targetName = newFolderName.trim();
    if (!targetName || targetName === oldFolderName) return;

    const convsToRename = State.conversations.filter(c => c.folder_name === oldFolderName);
    if (convsToRename.length === 0) return;

    toast(`Renaming folder...`, 'info');
    try {
        await Promise.all(convsToRename.map(c =>
            fetch(`/api/conversations/${c.id}/folder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder_name: targetName })
            })
        ));
        toast(`Folder renamed to "${targetName}"`, 'success');
        loadHistory();
    } catch (e) {
        toast('Failed to rename folder', 'error');
    }
}

function filterHistory() {
    const q = DOM.historySearch.value.toLowerCase();
    renderHistory(State.conversations.filter(c => (c.title || '').toLowerCase().includes(q) || (c.folder_name || '').toLowerCase().includes(q)));
}

async function loadConv(id, shouldPushState = true) {
    try {
        const r = await fetch(`/api/conversations/${id}`);
        const data = await r.json();
        State.conversationId = id;
        DOM.chatMessages.innerHTML = '';
        State.messageCount = 0;
        hideWelcome();

        if (DOM.timelineSteps) {
            DOM.timelineSteps.innerHTML = '';
        }

        const items = [];
        (data.messages || []).forEach(m => {
            if (m.role === 'user' || m.role === 'assistant') {
                items.push({ ...m, itemType: 'message', sortTime: new Date(m.timestamp) });
            }
        });
        (data.executions || []).forEach(e => {
            items.push({ ...e, itemType: 'execution', sortTime: new Date(e.timestamp) });
        });
        items.sort((a, b) => a.sortTime - b.sortTime);

        for (const item of items) {
            if (item.itemType === 'message') {
                if (item.role === 'user') {
                    hideWelcome();
                    const el = document.createElement('div');
                    el.className = 'message user';
                    el.innerHTML = `${USER_AVATAR_HTML}<div class="message-bubble">${esc(item.content || '')}</div>`;
                    DOM.chatMessages.appendChild(el);
                    addMessageCopyButton(el, item.content || '');
                    State.messageCount++;
                } else if (item.role === 'assistant') {
                    const el = mkAssistantMsg();
                    const b = el.querySelector('.message-bubble');
                    try { b.innerHTML = md(item.content || ''); addCopy(b); } catch (e) { b.textContent = item.content || ''; }
                    addMessageCopyButton(el, item.content || '');
                }
            } else if (item.itemType === 'execution') {
                const card = mkExecCard(item.description || 'Executing...', item.code || '');
                if (card._timer) { clearInterval(card._timer); card._timer = null; }
                card.classList.remove('running');
                const success = !!item.success;
                card.classList.add(success ? 'success' : 'error');
                const icon = card.querySelector('.exec-status-icon');
                if (icon) {
                    icon.className = 'exec-status-icon ' + (success ? 'success' : 'error');
                    icon.innerHTML = success
                        ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12" stroke-linecap="round" stroke-linejoin="round"/></svg>';
                }
                const prog = card.querySelector('.exec-progress');
                if (prog) prog.style.display = 'none';
                const dur = card.querySelector('.exec-duration');
                if (dur) {
                    dur.textContent = (typeof item.duration_ms === 'number' ? (item.duration_ms / 1000).toFixed(2) : '0.00') + 's';
                }
                const body = card.querySelector('.exec-body');
                if (body) {
                    const rd = document.createElement('div');
                    rd.className = 'exec-result' + (success ? '' : ' error-result');
                    const rt = item.result || '(no output)';
                    const tr = rt.length > 2000 ? rt.substring(0, 2000) + '\n...(truncated)' : rt;
                    rd.innerHTML = formatTerminalOutput(tr);
                    body.appendChild(rd);
                }

                const w = document.createElement('div');
                w.className = 'message assistant';
                w.innerHTML = `<div class="message-avatar assistant-avatar"><div class="proxima-cube proxima-cube-xs proxima-cube-static"><div class="proxima-eye"><div class="proxima-pupil"></div></div><div class="proxima-eye"><div class="proxima-pupil"></div></div></div></div><div class="message-bubble execution-bubble"></div>`;
                w.querySelector('.message-bubble').appendChild(card);
                DOM.chatMessages.appendChild(w);
                State.messageCount++;

                const opType = getOperationType(item.code, item.description);
                const duration = typeof item.duration_ms === 'number' ? (item.duration_ms / 1000) : 0.00;
                const stepEl = addTimelineStep(opType, item.description, item.code);
                completeTimelineStep(stepEl, success, duration, item.result);
            }
        }

        // Find last execution item to restore card state
        let lastExec = null;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].itemType === 'execution') {
                lastExec = items[i];
                break;
            }
        }
        if (lastExec) {
            State.lastTaskTitle = lastExec.description || '';
            State.lastTaskCompletedAt = new Date(lastExec.timestamp).getTime();
        } else {
            State.lastTaskTitle = '';
            State.lastTaskCompletedAt = null;
        }
        updateExecutionCard();

        scrollDown();
        if (shouldPushState) {
            window.history.pushState(null, '', `/c/${id}`);
        }
        renderHistory(State.conversations);
        toast('Loaded', 'info');
    } catch (e) { console.error(e); toast('Failed to load', 'error'); }
}

async function deleteConv(id) {
    try {
        await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
        State.conversations = State.conversations.filter(c => c.id !== id);
        renderHistory(State.conversations);
        if (State.conversationId === id) {
            State.conversationId = null;
            DOM.chatMessages.innerHTML = '';
            showWelcome();
            window.history.pushState(null, '', '/');
        }
        toast('Deleted', 'info');
    } catch (e) { toast('Failed to delete', 'error'); }
}


// Settings panel management
function openSettings() { State.settingsOpen = true; DOM.settingsModal.classList.add('visible'); loadSettings(); }
function closeSettings() { State.settingsOpen = false; DOM.settingsModal.classList.remove('visible'); }

async function loadSettings() {
    try { State.config = await (await fetch('/api/config')).json(); populateSettings(State.config); }
    catch (e) { toast('Failed to load settings', 'error'); }
}

function populateSettings(c) {
    const el = id => document.getElementById(id);
    // Prefer the persisted permission_mode from config; fall back to whatever
    // is currently selected in the UI. Keeps the settings dropdown and the
    // model-popup mode selector in sync.
    const mode = c.permission_mode || State.selectedMode || 'smart';
    el('setting-mode').value = mode;
    setMode(mode, false);
    const multiAgent = c.multi_agent === true;
    setMultiAgent(multiAgent, false);
    el('setting-max-iterations').value = c.max_tool_iterations || 50;
    el('setting-instructions').value = c.custom_instructions || '';
    el('setting-api-url').value = c.api_url || 'http://localhost:3210/v1';
    el('setting-api-key').value = c.api_key || '';
    // Always start the API key masked when (re)loading settings.
    const _keyEl = el('setting-api-key');
    const _keyTgl = el('toggle-api-key');
    if (_keyEl) _keyEl.type = 'password';
    if (_keyTgl) {
        _keyTgl.setAttribute('aria-pressed', 'false');
        _keyTgl.setAttribute('aria-label', 'Show API key');
        const s = _keyTgl.querySelector('.eye-show'), h = _keyTgl.querySelector('.eye-hide');
        if (s) s.style.display = '';
        if (h) h.style.display = 'none';
    }
    el('setting-model').value = c.model || 'claude';
    el('setting-temperature').value = c.temperature || 0.7;
    document.getElementById('temperature-value').textContent = c.temperature || 0.7;
    el('setting-safety').checked = c.safety_checks !== false;
    el('setting-web-misuse').checked = c.web_misuse_check !== false;
    el('setting-blocked').value = (c.blocked_patterns || []).join('\n');
    el('setting-debug').checked = c.debug === true;
    el('setting-sound').checked = c.sound === true;
    el('setting-port').value = c.port || 8500;
    el('setting-memory').checked = c.agent_memory_enabled !== false;
    document.querySelectorAll('.setting-toggle input').forEach(inp => {
        const t = inp.closest('.setting-toggle').querySelector('.toggle-text');
        if (t) t.textContent = inp.checked ? 'Enabled' : 'Disabled';
    });
}

async function saveSettings() {
    const el = id => document.getElementById(id);
    const bRaw = el('setting-blocked').value.trim();
    const config = {
        model: el('setting-model').value,
        permission_mode: el('setting-mode').value,
        api_url: el('setting-api-url').value,
        api_key: el('setting-api-key').value,
        temperature: parseFloat(el('setting-temperature').value),
        max_tool_iterations: parseInt(el('setting-max-iterations').value) || 50,
        custom_instructions: el('setting-instructions').value.trim(),
        safety_checks: el('setting-safety').checked,
        web_misuse_check: el('setting-web-misuse').checked,
        blocked_patterns: bRaw ? bRaw.split('\n').map(l => l.trim()).filter(Boolean) : [],
        debug: el('setting-debug').checked,
        sound: el('setting-sound').checked,
        port: parseInt(el('setting-port').value) || 8500,
        multi_agent: State.multiAgent || false,
        agent_memory_enabled: el('setting-memory').checked,
    };
    try {
        await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
        State.config = config;
        setModel(config.model, true);
        // Sync the execution-mode selector + notify the server so the next run
        // (and reconnects) use the saved mode.
        setMode(config.permission_mode, true);
        closeSettings();
        toast('Settings saved', 'success');
    } catch (e) { toast('Failed to save', 'error'); }
}

function initSettings() {
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const p = document.getElementById('tab-' + tab.dataset.tab);
            if (p) p.classList.add('active');
        });
    });

    const ts = document.getElementById('setting-temperature');
    const tv = document.getElementById('temperature-value');
    if (ts && tv) ts.addEventListener('input', () => tv.textContent = ts.value);

    // API key show/hide (eye) toggle
    const keyInput = document.getElementById('setting-api-key');
    const keyToggle = document.getElementById('toggle-api-key');
    if (keyInput && keyToggle) {
        keyToggle.addEventListener('click', () => {
            const show = keyInput.type === 'password';
            keyInput.type = show ? 'text' : 'password';
            keyToggle.setAttribute('aria-pressed', show ? 'true' : 'false');
            keyToggle.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
            const eyeShow = keyToggle.querySelector('.eye-show');
            const eyeHide = keyToggle.querySelector('.eye-hide');
            if (eyeShow) eyeShow.style.display = show ? 'none' : '';
            if (eyeHide) eyeHide.style.display = show ? '' : 'none';
        });
    }

    document.querySelectorAll('.setting-toggle input').forEach(inp => {
        inp.addEventListener('change', () => {
            const t = inp.closest('.setting-toggle').querySelector('.toggle-text');
            if (t) t.textContent = inp.checked ? 'Enabled' : 'Disabled';
        });
    });

    const clr = document.getElementById('clear-history-btn');
    if (clr) clr.addEventListener('click', async () => {
        if (!confirm('Delete ALL history?')) return;
        for (const c of State.conversations) { try { await fetch(`/api/conversations/${c.id}`, { method: 'DELETE' }); } catch (e) { } }
        State.conversations = [];
        renderHistory([]);
        toast('History cleared', 'info');
    });

    const rst = document.getElementById('reset-settings-btn');
    if (rst) rst.addEventListener('click', async () => {
        if (!confirm('Reset all settings?')) return;
        const defaults = { api_url: 'http://localhost:3210/v1', api_key: 'sk-14e37c6d4cf2-proxima', model: 'claude', max_tool_iterations: 50, temperature: 0.7 };
        try { await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(defaults) }); populateSettings(defaults); toast('Reset done', 'info'); } catch (e) { toast('Failed', 'error'); }
    });
}


// UI state synchronization
function syncUI() {
    if (State.agentRunning) {
        DOM.sendBtn.style.display = 'none';
        DOM.stopBtn.style.display = 'flex';
        showTyping();
    } else {
        DOM.sendBtn.style.display = 'flex';
        DOM.stopBtn.style.display = 'none';
        DOM.sendBtn.disabled = false;
        hideTyping(true);
    }
    DOM.chatInput.disabled = State.agentRunning;
    DOM.chatInput.placeholder = State.agentRunning ? '' : 'Tell me what to do...';
    if (!State.agentRunning) DOM.chatInput.focus();
}

// Typing indicator animation
const _typingLabels = [
    'Agent is working',
    'Thinking',
    'Analyzing task',
    'Processing steps',
    'Running tools',
    'Executing commands',
    'Synthesizing response'
];
let _typingIdx = 0;
let _typingTimer = null;

function showTyping() {
    _typingIdx = 0;
    const lbl = document.getElementById('typing-label');
    if (lbl) { lbl.textContent = _typingLabels[0] + '...'; lbl.style.opacity = '1'; }
    DOM.typingInd.classList.add('visible');
    clearInterval(_typingTimer);
    _typingTimer = setInterval(() => {
        _typingIdx = (_typingIdx + 1) % _typingLabels.length;
        if (lbl) {
            lbl.style.opacity = '0';
            setTimeout(() => {
                lbl.textContent = _typingLabels[_typingIdx] + '...';
                lbl.style.opacity = '1';
            }, 300);
        }
    }, 2500);
}

function hideTyping(force = false) {
    if (State.agentRunning && !force) return;
    DOM.typingInd.classList.remove('visible');
    clearInterval(_typingTimer);
    _typingTimer = null;
}
function scrollDown() { requestAnimationFrame(() => { DOM.chatMessages.scrollTop = DOM.chatMessages.scrollHeight; }); }


// Toast notifications
function toast(msg, type = 'info') {
    const identical = Array.from(DOM.toasts.querySelectorAll('.toast')).find(el => el.textContent === msg);
    if (identical) identical.remove();

    while (DOM.toasts.children.length >= 2) {
        DOM.toasts.children[0].remove();
    }

    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    DOM.toasts.appendChild(t);
    const duration = type === 'error' ? 4000 : 2000;
    setTimeout(() => {
        t.style.opacity = '0';
        t.style.transform = 'translateX(-100%)';
        t.style.transition = 'all 0.3s';
        setTimeout(() => t.remove(), 300);
    }, duration);
}


async function sendUserMsg() {
    const text = DOM.chatInput.value.trim();
    if (!text || !State.connected || State.agentRunning) return;

    // Snapshot attached files before clearing input
    const files = [...State.attachedFiles];
    const fileNames = files.map(f => f.name);

    // Show user message immediately (with file chips)
    addUserMsg(text, fileNames);
    DOM.chatInput.value = '';
    DOM.chatInput.style.height = 'auto';
    State.attachedFiles = [];
    renderFiles();
    State.agentRunning = true;
    syncUI();

    // Upload file (last one wins — one-shot design per attach.py)
    let filePath = null;
    if (files.length > 0) {
        const lastFile = files[files.length - 1];
        try {
            const res = await fetch('/api/upload', {
                method: 'POST',
                body: lastFile,
                headers: { 'X-Filename': encodeURIComponent(lastFile.name) },
            });
            if (res.ok) {
                const data = await res.json();
                filePath = data.path;
            } else {
                const err = await res.json().catch(() => ({}));
                toast(err.error || 'File upload failed', 'error');
            }
        } catch (e) {
            toast('File upload failed: ' + e.message, 'error');
        }
    }

    wsSend({
        type: 'message',
        content: text,
        model: State.selectedModel,
        mode: State.selectedMode,
        conversation_id: State.conversationId,
        file_path: filePath,
    });
}

function wsSend(data) {
    if (State.ws && State.ws.readyState === WebSocket.OPEN) State.ws.send(JSON.stringify(data));
}


// Utility and sanitization functions
// ── HTML escaping ──────────────────────────────────────────
// esc(): safe for ELEMENT TEXT (escapes & < >).
// escAttr(): ALSO escapes quotes — required inside HTML attributes, where the
// old esc() left " / ' intact and allowed attribute breakout (onmouseover=...).
function esc(t) {
    return String(t == null ? '' : t)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function escAttr(t) {
    return esc(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Strict HTML sanitizer for rendered markdown ─────────────
// The agent streams attacker-influenceable content (scraped web pages, file
// contents) into the chat, and marked.parse() passes raw HTML through. Without
// this, an <img onerror=...> / <script> in that content would execute in our
// origin — which can read the gateway API key and drive the host via /ws.
// We re-parse the generated HTML (inert via DOMParser) and keep ONLY an
// allowlist of markdown-producible tags + attributes, dropping every script,
// event handler, and dangerous URL. Even a compromised/malicious marked output
// is neutralised here.
const _SANITIZE_TAGS = new Set([
    'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'KBD', 'LI', 'OL', 'P', 'PRE', 'S',
    'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'
]);
const _SANITIZE_ATTRS = {
    A: ['href', 'title'], IMG: ['src', 'alt', 'title'], CODE: ['class'],
    SPAN: ['class'], DIV: ['class'], PRE: ['class'],
    TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'], OL: ['start']
};
function _safeHref(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    // Allow http(s), mailto, anchors and relative paths; block javascript:,
    // data:, vbscript:, file: and any other scheme.
    if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '';
    return u; // scheme-less relative
}
function _safeImg(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    if (/^(https?:|\/|\.\/|\.\.\/)/i.test(u)) return u;
    // Drop ALL data:/other-scheme images (svg data URIs can carry script).
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '';
    return u;
}
function _sanitizeNode(node) {
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 8) { child.remove(); continue; }  // comment
        if (child.nodeType !== 1) continue;                       // keep text/etc
        const tag = child.tagName;
        if (!_SANITIZE_TAGS.has(tag)) {
            // Disallowed element: unwrap (keep its text), drop the element + its
            // attributes (so <script>/<iframe>/<svg>/on* never survive).
            const kids = Array.from(child.childNodes);
            for (const k of kids) node.insertBefore(k, child);
            child.remove();
            for (const k of kids) if (k.nodeType === 1) _sanitizeNode(k);
            continue;
        }
        const allowed = _SANITIZE_ATTRS[tag] || [];
        for (const attr of Array.from(child.attributes)) {
            const name = attr.name.toLowerCase();
            if (!allowed.includes(name)) { child.removeAttribute(attr.name); continue; }
            if (name === 'href') child.setAttribute('href', _safeHref(attr.value));
            else if (name === 'src') child.setAttribute('src', _safeImg(attr.value));
        }
        _sanitizeNode(child);
    }
}
function sanitizeHtml(html) {
    try {
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        _sanitizeNode(doc.body);
        return doc.body.innerHTML;
    } catch (e) {
        // If anything goes wrong, fail safe to escaped text — never raw HTML.
        return esc(html);
    }
}

function fmtDate(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso), now = new Date(), m = Math.floor((now - d) / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ago';
        const dy = Math.floor(h / 24);
        if (dy < 7) return dy + 'd ago';
        return d.toLocaleDateString();
    } catch (e) { return ''; }
}


// Bound DOM and hotkey event listeners
function bindEvents() {
    DOM.sendBtn.addEventListener('click', sendUserMsg);
    DOM.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendUserMsg(); } });
    DOM.chatInput.addEventListener('input', () => { DOM.chatInput.style.height = 'auto'; DOM.chatInput.style.height = Math.min(DOM.chatInput.scrollHeight, 200) + 'px'; });
    DOM.stopBtn.addEventListener('click', () => { wsSend({ type: 'stop' }); toast('Stopping...', 'info'); });
    DOM.newSessionBtn.addEventListener('click', () => {
        if (State.agentRunning && !confirm('Agent running. New conversation?')) return;
        if (State.agentRunning) wsSend({ type: 'stop' });
        wsSend({ type: 'new_session' });
    });

    DOM.approveAllow.addEventListener('click', () => { wsSend({ type: 'approve', approved: true }); DOM.approvalModal.classList.remove('visible'); toast('Approved', 'success'); });
    DOM.approveDeny.addEventListener('click', () => { wsSend({ type: 'approve', approved: false }); DOM.approvalModal.classList.remove('visible'); toast('Denied', 'error'); });
    DOM.sidebarToggle.addEventListener('click', toggleSidebar);
    DOM.sidebarClose.addEventListener('click', closeSidebar);

    if (DOM.activityToggle) DOM.activityToggle.addEventListener('click', toggleActivityPanel);
    if (DOM.clearActivityLogs) DOM.clearActivityLogs.addEventListener('click', () => { if (DOM.activityLogs) DOM.activityLogs.innerHTML = ''; });

    DOM.historySearch.addEventListener('input', filterHistory);
    DOM.settingsBtn.addEventListener('click', openSettings);
    DOM.settingsClose.addEventListener('click', closeSettings);
    DOM.settingsSave.addEventListener('click', saveSettings);

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'n') { e.preventDefault(); DOM.newSessionBtn.click(); }
        if (e.ctrlKey && e.key === 'h') { e.preventDefault(); toggleSidebar(); }
        if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); toggleActivityPanel(); }
        if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
        if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); if (DOM.themeToggleBtn) DOM.themeToggleBtn.click(); }
        if (e.key === 'Escape') {
            closeModelPopup(); closeExportPopup();
            // If the approval modal is open, Escape must DENY (send the answer)
            // — not just hide it. Hiding without replying left the agent blocked
            // on request_approval for up to 300s with no feedback.
            if (DOM.approvalModal.classList.contains('visible')) {
                try { wsSend({ type: 'approve', approved: false }); } catch (_) { }
            }
            DOM.approvalModal.classList.remove('visible');
            if (State.settingsOpen) closeSettings(); if (State.sidebarOpen) closeSidebar();
        }
        if (e.key === '/' && document.activeElement !== DOM.chatInput && !State.settingsOpen) { e.preventDefault(); DOM.chatInput.focus(); }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.history-item-actions-wrapper')) {
            document.querySelectorAll('.history-item-dropdown.show').forEach(d => {
                d.classList.remove('show');
            });
        }
    });
}


// Model dropdown selection menu
function initModelDropdown() {
    DOM.modelTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = DOM.modelPopup.classList.contains('open');
        if (open) closeModelPopup();
        else openModelPopup();
    });

    document.querySelectorAll('.model-option').forEach(opt => {
        opt.addEventListener('click', () => {
            setModel(opt.dataset.value, true);
            closeModelPopup();
        });
    });

    const geminiGroup = document.getElementById('group-gemini-trigger');
    if (geminiGroup) {
        geminiGroup.addEventListener('click', (e) => {
            e.stopPropagation();
            showModelPage('gemini');
        });
    }

    const geminiBack = document.getElementById('model-gemini-back');
    if (geminiBack) {
        geminiBack.addEventListener('click', (e) => {
            e.stopPropagation();
            showModelPage('main');
        });
    }

    document.querySelectorAll('.mode-segment-btn').forEach(opt => {
        opt.addEventListener('click', () => {
            setMode(opt.dataset.mode, true);
        });
    });

    const multiAgentComposerBtn = document.getElementById('multi-agent-composer-btn');
    if (multiAgentComposerBtn) {
        multiAgentComposerBtn.addEventListener('click', () => {
            setMultiAgent(!State.multiAgent, true);
        });
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.model-dropdown')) closeModelPopup();
        if (!e.target.closest('#export-dropdown-container')) closeExportPopup();
    });

    // ── Default execution mode ──
    // Ensure Smart is visually selected on page load (before WS status
    // arrives). The server will override this if a different mode is saved
    // in config — but if none is saved, Smart is the correct default.
    setMode(State.selectedMode || 'full_auto', false);
}

function showModelPage(pageId) {
    document.querySelectorAll('.model-page').forEach(p => {
        p.classList.toggle('active', p.id === `model-page-${pageId}`);
    });
}

function openModelPopup() {
    showModelPage('main');
    DOM.modelPopup.classList.add('open');
    DOM.modelTrigger.classList.add('open');
}

function closeModelPopup() {
    DOM.modelPopup.classList.remove('open');
    DOM.modelTrigger.classList.remove('open');
}

function setModel(value, notify) {
    State.selectedModel = value;
    // Dynamic name resolution — covers both session models and API models
    const sessionNames = {
        auto: 'Auto',
        claude: 'Claude',
        chatgpt: 'ChatGPT',
        gemini: 'Gemini (Auto)',
        'gemini:3.1-pro': 'Gemini 3.1 Pro',
        'gemini:3.5-flash': 'Gemini 3.5 Flash',
        'gemini:3.1-flash-lite': 'Gemini 3.1 Lite',
        perplexity: 'Perplexity'
    };
    // Check API models first
    let displayName = sessionNames[value];
    if (!displayName) {
        const allModels = [...State.byokGlobalModels, ...(State._byokLocalModels || [])];
        const apiModel = allModels.find(m => m.id === value);
        if (apiModel) {
            // Show "model-name" (not provider name) for API models
            displayName = apiModel.model || (value.includes('@') ? value.split('@')[1] : value);
        } else if (value && value.includes('@')) {
            // Composite ID fallback: extract model portion
            displayName = value.split('@')[1];
        } else {
            displayName = value;
        }
    }
    DOM.modelTriggerText.textContent = displayName;

    document.querySelectorAll('.model-option').forEach(opt => {
        const sel = opt.dataset.value === value;
        opt.classList.toggle('selected', sel);
        const ck = opt.querySelector('.model-option-check');
        if (ck) {
            ck.innerHTML = sel ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>' : '';
        }
    });

    const isGeminiFamily = value && (value === 'gemini' || value.startsWith('gemini:'));
    const groupTrigger = document.getElementById('group-gemini-trigger');
    if (groupTrigger) {
        groupTrigger.classList.toggle('selected', isGeminiFamily);
    }

    if (notify) {
        wsSend({ type: 'set_model', model: value });
        toast(`Model: ${displayName}`, 'info');
    }
}

function setMode(value, notify) {
    State.selectedMode = value;
    document.querySelectorAll('.mode-segment-btn').forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.mode === value);
    });

    if (notify) {
        wsSend({ type: 'set_mode', mode: value });
        const names = { full_auto: 'Full Auto', smart: 'Smart', suggest: 'Suggest' };
        toast(`Mode: ${names[value] || value}`, 'info');
    }
}

function setMultiAgent(enabled, notify) {
    State.multiAgent = enabled;

    const btn = document.getElementById('multi-agent-composer-btn');
    if (btn) btn.classList.toggle('active', enabled);

    if (notify) {
        wsSend({ type: 'set_multi_agent', enabled: enabled });
        toast(`Multi-Agent: ${enabled ? 'ON' : 'OFF'}`, 'info');
    }
}

// UI theme management
function initTheme() {
    const savedTheme = localStorage.getItem('proxima_theme') || 'dark';
    setTheme(savedTheme);

    if (DOM.themeToggleBtn) {
        DOM.themeToggleBtn.addEventListener('click', () => {
            const current = document.body.classList.contains('theme-light') ? 'light' : 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            setTheme(next);
        });
    }
}

function setTheme(theme) {
    document.body.classList.remove('theme-light');

    if (DOM.themeIconSun) DOM.themeIconSun.style.display = 'none';
    if (DOM.themeIconMoon) DOM.themeIconMoon.style.display = 'none';

    if (theme === 'light') {
        document.body.classList.add('theme-light');
        if (DOM.themeIconMoon) DOM.themeIconMoon.style.display = 'block';
        if (DOM.themeToggleBtn) DOM.themeToggleBtn.title = 'Switch to Dark Mode (Alt+T)';
    } else { // dark
        if (DOM.themeIconSun) DOM.themeIconSun.style.display = 'block';
        if (DOM.themeToggleBtn) DOM.themeToggleBtn.title = 'Switch to Light Mode (Alt+T)';
    }
    localStorage.setItem('proxima_theme', theme);
}


function initResizers() {
    const sidebar = DOM.sidebar;
    const sidebarResizer = document.getElementById('sidebar-resizer');
    const activityPanel = DOM.activityPanel;
    const activityResizer = document.getElementById('activity-resizer');

    const savedSidebarWidth = localStorage.getItem('proxima_sidebar_width');
    if (savedSidebarWidth && sidebar) {
        sidebar.style.width = savedSidebarWidth + 'px';
    }
    const savedActivityWidth = localStorage.getItem('proxima_activity_width');
    if (savedActivityWidth && activityPanel) {
        activityPanel.style.width = savedActivityWidth + 'px';
    }

    // Sidebar Resize Drag Event
    if (sidebar && sidebarResizer) {
        sidebarResizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = sidebar.offsetWidth;

            sidebarResizer.classList.add('active');
            document.body.classList.add('resizing');

            function onMouseMove(moveEvent) {
                const deltaX = moveEvent.clientX - startX;
                const newWidth = Math.max(180, Math.min(450, startWidth + deltaX));
                sidebar.style.width = newWidth + 'px';
                localStorage.setItem('proxima_sidebar_width', newWidth);
            }

            function onMouseUp() {
                sidebarResizer.classList.remove('active');
                document.body.classList.remove('resizing');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // Activity Panel Resize Drag Event
    if (activityPanel && activityResizer) {
        activityResizer.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = activityPanel.offsetWidth;

            activityResizer.classList.add('active');
            document.body.classList.add('resizing');

            function onMouseMove(moveEvent) {
                const deltaX = startX - moveEvent.clientX;
                const newWidth = Math.max(240, Math.min(600, startWidth + deltaX));
                activityPanel.style.width = newWidth + 'px';
                localStorage.setItem('proxima_activity_width', newWidth);
            }

            function onMouseUp() {
                activityResizer.classList.remove('active');
                document.body.classList.remove('resizing');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }
}

// Application initialization
cacheDom();
initResizers();
initTheme();
restoreActivityPanel();
showWelcome();
bindEvents();
initSettings();
initFileUpload();
initModelDropdown();
initByok();
initExportDropdown();
updateExecutionCard();

// Periodically update execution card time elapsed when idle
setInterval(() => {
    if (!State.agentRunning) {
        updateExecutionCard();
    }
}, 5000);

const startMatch = window.location.pathname.match(/^\/c\/([\w-]+)$/);
if (startMatch) {
    const initialConvId = startMatch[1];
    setTimeout(() => {
        loadConv(initialConvId, false);
    }, 150);
}

connectWS();

// Listen to Back/Forward navigation
window.addEventListener('popstate', () => {
    const match = window.location.pathname.match(/^\/c\/([\w-]+)$/);
    if (match) {
        const id = match[1];
        if (id !== State.conversationId) {
            loadConv(id, false);
        }
    } else {
        if (State.conversationId !== null) {
            State.conversationId = null;
            DOM.chatMessages.innerHTML = '';
            showWelcome();
            syncUI();
            loadHistory();
        }
    }
});

// Restore sidebar state (default: open)
(function restoreSidebar() {
    const saved = localStorage.getItem('proxima_sidebar');
    const shouldOpen = saved === null || saved === '1'; // default open
    if (shouldOpen) {
        State.sidebarOpen = true;
        DOM.sidebar.classList.remove('collapsed');
        DOM.sidebarToggle.classList.add('active');
        loadHistory();
    } else {
        State.sidebarOpen = false;
        DOM.sidebar.classList.add('collapsed');
        DOM.sidebarToggle.classList.remove('active');
    }
    updateResizerVisibility();
})();


// BYOK (Bring Your Own Key) model management

const BYOK_PROVIDERS = [
    { id: 'chatgpt', name: 'OpenAI', placeholder: 'sk-...' },
    { id: 'claude', name: 'Anthropic', placeholder: 'sk-ant-...' },
    { id: 'gemini', name: 'Gemini AI', placeholder: 'AIza...' },
    { id: 'perplexity', name: 'Perplexity', placeholder: 'pplx-...' },
    { id: 'deepseek', name: 'DeepSeek', placeholder: 'sk-...' },
    { id: 'groq', name: 'Groq', placeholder: 'gsk_...' },
    { id: 'xai', name: 'xAI (Grok)', placeholder: 'xai-...' },
    { id: 'openrouter', name: 'OpenRouter', placeholder: 'sk-or-...' },
    { id: 'together', name: 'Together AI', placeholder: 'tg-...' },
    { id: 'fireworks', name: 'Fireworks', placeholder: 'fw_...' },
    { id: 'mistral', name: 'Mistral', placeholder: 'M...' },
    { id: 'nvidia', name: 'NVIDIA NIM', placeholder: 'nvapi-...' },
];

function initByok() {
    // Save the original session models HTML so we can restore later
    const container = document.getElementById('model-options-container');
    if (container) {
        State.byokSessionModelsHTML = container.innerHTML;
    }

    byokSync();
    State.byokSyncTimer = setInterval(byokSync, 10000);

    initByokCombo();
    initByokFormEvents();
}

// ── Gateway Sync ──────────────────────────────────────────
async function byokSync() {
    try {
        const r = await fetch('/api/byok/models');
        if (!r.ok) return;
        const data = await r.json();

        const oldEnabled = State.byokGlobalEnabled;
        const oldCount = State.byokGlobalModels.length + (State.byokHasLocal ? 1 : 0);

        State.byokGlobalEnabled = data.global_enabled || false;
        State.byokGlobalModels = (data.models || []).filter(m => m.source === 'global');
        State._byokLocalModels = (data.models || []).filter(m => m.source === 'local');
        State.byokHasLocal = data.has_local || false;

        const newCount = State.byokGlobalModels.length + State._byokLocalModels.length;

        // Rebuild model dropdown if anything changed
        if (oldEnabled !== State.byokGlobalEnabled || oldCount !== newCount) {
            byokRebuildModelDropdown();
        }

        if (State.settingsOpen) {
            byokRenderConfiguredList();
        }
    } catch {
        // Gateway/server down — do nothing
    }
}

// ── Dynamic Model Dropdown ────────────────────────────────
function byokRebuildModelDropdown() {
    const container = document.getElementById('model-options-container');
    if (!container) return;

    const allModels = [...(State._byokLocalModels || [])];
    const seenIds = new Set(allModels.map(m => m.id));

    for (const gm of State.byokGlobalModels) {
        if (!seenIds.has(gm.id)) {
            allModels.push(gm);
            seenIds.add(gm.id);
        }
    }

    if (allModels.length === 0) {
        // No API models — restore session models
        byokRestoreSessionModels();
        return;
    }

    const checkSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';

    let html = '';

    html += `
        <div class="model-option" data-value="auto">
            <div class="model-option-icon model-icon-auto">
                <div class="proxima-cube proxima-cube-xs">
                    <div class="proxima-eye"><div class="proxima-pupil"></div></div>
                    <div class="proxima-eye"><div class="proxima-pupil"></div></div>
                </div>
            </div>
            <div class="model-option-info">
                <div class="model-option-name">Auto</div>
                <div class="model-option-desc">Smart routing</div>
            </div>
            <div class="model-option-check" id="check-auto">${State.selectedModel === 'auto' ? checkSvg : ''}</div>
        </div>`;

    // Group models by provider name for clean grouped display
    const grouped = new Map();
    for (const m of allModels) {
        const provName = m.name || 'Unknown';
        if (!grouped.has(provName)) grouped.set(provName, []);
        grouped.get(provName).push(m);
    }

    // Provider icon colors (CSS class suffix)
    const providerColors = {
        'Gemini AI': '#4285f4', 'OpenAI': '#10a37f', 'Anthropic': '#d4a574',
        'Perplexity': '#20808d', 'DeepSeek': '#4d6bfe', 'Groq': '#f55036',
        'xAI (Grok)': '#1d9bf0', 'OpenRouter': '#6366f1', 'Together AI': '#ff6b35',
        'Fireworks': '#ff4500', 'Mistral': '#ff7000', 'NVIDIA NIM': '#76b900',
    };

    for (const [provName, models] of grouped) {
        const color = providerColors[provName] || '#888';
        html += `
        <div class="model-group-header" style="padding:8px 12px 4px;display:flex;align-items:center;gap:8px;pointer-events:none;">
            <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0;"></span>
            <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-secondary,#999);">${esc(provName)}</span>
            <span style="font-size:10px;color:var(--text-tertiary,#666);">(${models.length})</span>
        </div>`;

        for (const m of models) {
            const isSelected = State.selectedModel === m.id;
            const sourceClass = m.source === 'local' ? 'byok-dot-local' : 'byok-dot-global';
            // Extract just the model name from composite ID or model field
            const displayModel = m.model || (m.id.includes('@') ? m.id.split('@')[1] : m.id);
            html += `
        <div class="model-option" data-value="${esc(m.id)}" style="padding-left:28px;">
            <div class="model-option-icon byok-model-dot">
                <span class="byok-source-dot ${sourceClass}"></span>
            </div>
            <div class="model-option-info">
                <div class="model-option-name" style="font-size:13px;">${esc(displayModel)}</div>
            </div>
            <div class="model-option-check" id="check-${esc(m.id)}">${isSelected ? checkSvg : ''}</div>
        </div>`;
        }
    }

    container.innerHTML = html;

    // Hide the Gemini sub-page (not relevant for API models)
    const geminiPage = document.getElementById('model-page-gemini');
    if (geminiPage) geminiPage.style.display = 'none';

    container.querySelectorAll('.model-option').forEach(opt => {
        opt.addEventListener('click', () => {
            setModel(opt.dataset.value, true);
            closeModelPopup();
        });
    });

    // If current model is not in the new list, fall back to first available
    const validIds = ['auto', ...allModels.map(m => m.id)];
    if (!validIds.includes(State.selectedModel)) {
        setModel(allModels[0].id, true);
        toast('Model switched — previous selection no longer available', 'info');
    }
}

function byokRestoreSessionModels() {
    const container = document.getElementById('model-options-container');
    if (!container || !State.byokSessionModelsHTML) return;

    container.innerHTML = State.byokSessionModelsHTML;

    // Show Gemini sub-page again
    const geminiPage = document.getElementById('model-page-gemini');
    if (geminiPage) geminiPage.style.display = '';

    container.querySelectorAll('.model-option').forEach(opt => {
        opt.addEventListener('click', () => {
            setModel(opt.dataset.value, true);
            closeModelPopup();
        });
    });

    const geminiGroup = document.getElementById('group-gemini-trigger');
    if (geminiGroup) {
        geminiGroup.addEventListener('click', (e) => {
            e.stopPropagation();
            showModelPage('gemini');
        });
    }

    // If current model is an API model that no longer exists, fall back
    const sessionIds = ['auto', 'claude', 'chatgpt', 'gemini', 'perplexity',
        'gemini:3.1-pro', 'gemini:3.5-flash', 'gemini:3.1-flash-lite'];
    if (!sessionIds.includes(State.selectedModel)) {
        setModel('claude', true);
        toast('API models no longer available — switched to session model', 'info');
    }

    setModel(State.selectedModel, false);
}

// ── BYOK Combobox (Settings Tab) ──────────────────────────
function initByokCombo() {
    const input = document.getElementById('byok-provider-search');
    const dropdown = document.getElementById('byok-combo-dropdown');
    if (!input || !dropdown) return;

    function renderOptions(filter = '') {
        const q = filter.toLowerCase();
        const filtered = BYOK_PROVIDERS.filter(p =>
            p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
        );
        dropdown.innerHTML = filtered.map(p => `
            <div class="byok-combo-option" data-id="${p.id}">
                <span class="byok-combo-name">${esc(p.name)}</span>
                <span class="byok-combo-id">${esc(p.id)}</span>
            </div>
        `).join('') || '<div class="byok-combo-empty">No providers found</div>';

        dropdown.querySelectorAll('.byok-combo-option').forEach(opt => {
            opt.addEventListener('click', () => {
                selectByokProvider(opt.dataset.id);
                dropdown.classList.remove('open');
                input.value = '';
            });
        });
    }

    input.addEventListener('focus', () => {
        renderOptions(input.value);
        dropdown.classList.add('open');
    });

    input.addEventListener('input', () => {
        renderOptions(input.value);
        dropdown.classList.add('open');
    });

    input.addEventListener('keydown', (e) => {
        const opts = dropdown.querySelectorAll('.byok-combo-option');
        const active = dropdown.querySelector('.byok-combo-option.highlight');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!active && opts.length) { opts[0].classList.add('highlight'); opts[0].scrollIntoView({ block: 'nearest' }); }
            else if (active && active.nextElementSibling?.classList.contains('byok-combo-option')) {
                active.classList.remove('highlight');
                active.nextElementSibling.classList.add('highlight');
                active.nextElementSibling.scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (active && active.previousElementSibling?.classList.contains('byok-combo-option')) {
                active.classList.remove('highlight');
                active.previousElementSibling.classList.add('highlight');
                active.previousElementSibling.scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (active) active.click();
        } else if (e.key === 'Escape') {
            dropdown.classList.remove('open');
        }
    });

    dropdown.addEventListener('wheel', (e) => {
        e.preventDefault();
        dropdown.scrollTop += e.deltaY;
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#byok-combo-wrapper')) {
            dropdown.classList.remove('open');
        }
    });
}

function selectByokProvider(providerId) {
    const provider = BYOK_PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    State.byokSelectedProvider = providerId;

    const form = document.getElementById('byok-key-form');
    const nameEl = document.getElementById('byok-form-provider-name');
    const keyInput = document.getElementById('byok-key-input');
    const removeBtn = document.getElementById('byok-remove-btn');

    nameEl.textContent = provider.name;
    keyInput.placeholder = provider.placeholder;
    keyInput.value = '';
    keyInput.type = 'password';
    form.style.display = 'block';

    // Check if already configured
    const isConfigured = State._byokLocalModels?.find(m => m.id === providerId);
    removeBtn.style.display = isConfigured ? 'inline-flex' : 'none';

    keyInput.focus();
}

function initByokFormEvents() {
    const saveBtn = document.getElementById('byok-save-btn');
    const removeBtn = document.getElementById('byok-remove-btn');
    const cancelBtn = document.getElementById('byok-cancel-btn');
    const toggleBtn = document.getElementById('byok-key-toggle');

    if (saveBtn) saveBtn.addEventListener('click', async () => {
        const key = document.getElementById('byok-key-input').value.trim();
        const provider = State.byokSelectedProvider;
        if (!provider || !key) { toast('Enter an API key', 'error'); return; }
        try {
            const r = await fetch('/api/byok/keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, key }),
            });
            const data = await r.json();
            if (!r.ok) { toast(data.error || 'Failed to save', 'error'); return; }
            toast(`API key saved for ${BYOK_PROVIDERS.find(p => p.id === provider)?.name || provider}`, 'success');
            document.getElementById('byok-key-form').style.display = 'none';
            document.getElementById('byok-key-input').value = '';
            State.byokSelectedProvider = null;
            await byokSync();
        } catch { toast('Failed to save key', 'error'); }
    });

    if (removeBtn) removeBtn.addEventListener('click', async () => {
        const provider = State.byokSelectedProvider;
        if (!provider) return;
        if (!confirm(`Remove API key for ${BYOK_PROVIDERS.find(p => p.id === provider)?.name || provider}?`)) return;
        try {
            await fetch(`/api/byok/keys/${provider}`, { method: 'DELETE' });
            toast('Key removed', 'info');
            document.getElementById('byok-key-form').style.display = 'none';
            State.byokSelectedProvider = null;
            await byokSync();
        } catch { toast('Failed to remove', 'error'); }
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => {
        document.getElementById('byok-key-form').style.display = 'none';
        document.getElementById('byok-key-input').value = '';
        State.byokSelectedProvider = null;
    });

    if (toggleBtn) toggleBtn.addEventListener('click', () => {
        const inp = document.getElementById('byok-key-input');
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        toggleBtn.querySelector('.eye-show').style.display = show ? 'none' : '';
        toggleBtn.querySelector('.eye-hide').style.display = show ? '' : 'none';
    });
}

// ── Configured Key Lists ──────────────────────────────────
function byokRenderConfiguredList() {
    const localList = document.getElementById('byok-local-list');
    const globalList = document.getElementById('byok-global-list');
    const globalLabel = document.getElementById('byok-global-label');
    if (!localList || !globalList) return;

    const localModels = State._byokLocalModels || [];
    const globalModels = State.byokGlobalModels || [];

    if (localModels.length === 0) {
        localList.innerHTML = '<div class="byok-empty">No agent-local keys configured</div>';
    } else {
        localList.innerHTML = localModels.map(m => `
            <div class="byok-configured-item">
                <span class="byok-source-dot byok-dot-local"></span>
                <span class="byok-item-name">${esc(m.name)}</span>
                <span class="byok-item-model">${esc(m.model || 'auto')}</span>
                <button class="byok-item-edit" data-id="${escAttr(m.id)}" title="Edit">✏️</button>
                <button class="byok-item-delete" data-id="${escAttr(m.id)}" title="Remove">🗑️</button>
            </div>
        `).join('');

        localList.querySelectorAll('.byok-item-edit').forEach(btn => {
            btn.addEventListener('click', () => selectByokProvider(btn.dataset.id));
        });

        localList.querySelectorAll('.byok-item-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                const name = BYOK_PROVIDERS.find(p => p.id === id)?.name || id;
                if (!confirm(`Remove agent key for ${name}?`)) return;
                try {
                    await fetch(`/api/byok/keys/${id}`, { method: 'DELETE' });
                    toast(`Key removed for ${name}`, 'info');
                    await byokSync();
                } catch { toast('Failed to remove', 'error'); }
            });
        });
    }

    if (globalModels.length === 0) {
        globalLabel.style.display = 'none';
        globalList.innerHTML = '';
    } else {
        globalLabel.style.display = '';
        globalList.innerHTML = globalModels.map(m => `
            <div class="byok-configured-item byok-global-item">
                <span class="byok-source-dot byok-dot-global"></span>
                <span class="byok-item-name">${esc(m.name)}</span>
                <span class="byok-item-model">${esc(m.model || 'auto')}</span>
                <span class="byok-synced-badge">synced</span>
            </div>
        `).join('');
    }
}

// ── Conversation Export ───────────────────────────────────
function openExportPopup() {
    if (DOM.exportPopup) {
        DOM.exportPopup.classList.add('open');
    }
    if (DOM.exportBtn) {
        DOM.exportBtn.classList.add('open');
    }
}

function closeExportPopup() {
    if (DOM.exportPopup) {
        DOM.exportPopup.classList.remove('open');
    }
    if (DOM.exportBtn) {
        DOM.exportBtn.classList.remove('open');
    }
}

function initExportDropdown() {
    if (!DOM.exportBtn || !DOM.exportPopup) return;

    DOM.exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!State.conversationId) {
            toast('Please select or start a conversation first.', 'error');
            return;
        }
        const open = DOM.exportPopup.classList.contains('open');
        if (open) {
            closeExportPopup();
        } else {
            openExportPopup();
        }
    });

    DOM.exportPopup.querySelectorAll('.export-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const format = opt.dataset.format;
            if (format) {
                exportConversation(format);
            }
            closeExportPopup();
        });
    });
}

async function exportConversation(format) {
    if (!State.conversationId) {
        toast('Please select or start a conversation first.', 'error');
        return;
    }

    toast('Exporting conversation...', 'info');

    try {
        const r = await fetch(`/api/conversations/${State.conversationId}`);
        if (!r.ok) {
            throw new Error(`Server returned ${r.status}`);
        }
        const data = await r.json();

        // Merge messages and executions chronologically
        const items = [];
        (data.messages || []).forEach(m => {
            if (m.role === 'user' || m.role === 'assistant') {
                items.push({ ...m, itemType: 'message', sortTime: new Date(m.timestamp) });
            }
        });
        (data.executions || []).forEach(e => {
            items.push({ ...e, itemType: 'execution', sortTime: new Date(e.timestamp) });
        });
        items.sort((a, b) => a.sortTime - b.sortTime);

        const activeConv = State.conversations.find(c => c.id === State.conversationId);
        let title = activeConv ? activeConv.title : '';
        if (!title && data.messages && data.messages.length > 0) {
            const firstUserMsg = data.messages.find(m => m.role === 'user');
            title = firstUserMsg ? firstUserMsg.content.substring(0, 40).replace(/\n/g, ' ') : 'Conversation';
        }
        if (!title) title = 'Untitled Conversation';

        let content = '';
        const dateStr = new Date().toLocaleString();

        if (format === 'md') {
            // Markdown Format
            content += `# Proxima Agent Conversation: ${title}\n\n`;
            content += `- **Exported At**: ${dateStr}\n`;
            content += `- **Conversation ID**: ${State.conversationId}\n\n`;
            content += `---\n\n`;

            for (const item of items) {
                const timeStr = new Date(item.timestamp).toLocaleString();
                if (item.itemType === 'message') {
                    const roleName = item.role === 'user' ? 'User' : 'Assistant';
                    content += `### [${roleName}] — ${timeStr}\n\n`;
                    content += `${item.content || ''}\n\n`;
                    content += `---\n\n`;
                } else if (item.itemType === 'execution') {
                    const successLabel = item.success ? 'Success' : 'Error';
                    const duration = typeof item.duration_ms === 'number' ? (item.duration_ms / 1000).toFixed(2) : '0.00';
                    content += `### [Tool Execution] — ${timeStr}\n\n`;
                    content += `- **Operation**: ${item.description || 'Executing...'}\n`;
                    content += `- **Status**: ${successLabel} (${duration}s)\n\n`;
                    if (item.code) {
                        content += `**Code**:\n\`\`\`python\n${item.code}\n\`\`\`\n\n`;
                    }
                    if (item.result) {
                        content += `**Result**:\n\`\`\`\n${item.result}\n\`\`\`\n\n`;
                    }
                    content += `---\n\n`;
                }
            }
        } else {
            // Plain Text Format
            content += `================================================================================\n`;
            content += `PROXIMA AGENT CONVERSATION: ${title}\n`;
            content += `Exported At: ${dateStr}\n`;
            content += `Conversation ID: ${State.conversationId}\n`;
            content += `================================================================================\n\n`;

            for (const item of items) {
                const timeStr = new Date(item.timestamp).toLocaleString();
                if (item.itemType === 'message') {
                    const roleName = item.role === 'user' ? 'User' : 'Assistant';
                    content += `--------------------------------------------------------------------------------\n`;
                    content += `[${roleName}] — ${timeStr}\n`;
                    content += `--------------------------------------------------------------------------------\n`;
                    content += `${item.content || ''}\n\n`;
                } else if (item.itemType === 'execution') {
                    const successLabel = item.success ? 'Success' : 'Error';
                    const duration = typeof item.duration_ms === 'number' ? (item.duration_ms / 1000).toFixed(2) : '0.00';
                    content += `--------------------------------------------------------------------------------\n`;
                    content += `[Tool Execution] — ${timeStr}\n`;
                    content += `Tool: ${item.description || 'Executing...'}\n`;
                    content += `Status: ${successLabel} (${duration}s)\n`;
                    if (item.code) {
                        content += `Code:\n${item.code}\n`;
                    }
                    if (item.result) {
                        content += `Result:\n${item.result}\n`;
                    }
                    content += `\n`;
                }
            }
            content += `================================================================================\n`;
        }

        // Trigger the browser file download
        const blob = new Blob([content], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const sanitizedTitle = title.toLowerCase().replace(/[^a-z0-9_-]/g, '_').substring(0, 50);
        a.download = `proxima_${sanitizedTitle}_${State.conversationId}.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        toast('Conversation exported successfully', 'success');
    } catch (e) {
        console.error(e);
        toast('Failed to export conversation', 'error');
    }
}


// Initialize default mode segmentation on page boot (non-inline script for CSP compatibility).
try {
    document.querySelectorAll('.mode-segment-btn').forEach(function (opt) {
        opt.classList.toggle('selected', opt.dataset.mode === 'full_auto');
    });
} catch (_) { } // Non-fatal if elements are absent

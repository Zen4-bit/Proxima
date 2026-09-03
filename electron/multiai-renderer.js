// Proxima — Multi-AI Chat renderer logic.
// Client-side counterpart to electron/ipc/multiai.cjs. Vanilla JS, no
// framework, matching the rest of index-v2.html's style. Reuses the same
// CSS classes as the Settings panel (.settings-panel/.settings-sidebar/
// .settings-content/.header-btn) so this tab looks native to the app,
// not like a bolted-on tool with its own color scheme.

let multiaiState = {
    data: null,            // full store: { projects: [{id, name, chats: [...]}], uiPrefs: {...} }
    currentChatId: null,
    mode: 'classic',       // 'classic' | 'orchestrated'
    running: false,
    enabledProviders: [],
    personas: {},
    pendingAttachments: [], // [{name, text, isImage, dataUrl}] queued for the next send
    runningChats: new Set(), // chat ids with a run in flight (main process is the source of truth)
};

const MULTIAI_GEMINI_ENGINES = ['gemini', 'gemini:3.5-flash', 'gemini:3.1-pro', 'gemini:3.1-flash-lite', 'gemini:auto'];
const MULTIAI_KNOWN_PROVIDERS = ['chatgpt', 'claude', 'gemini', 'perplexity'];

// Attachments over this size are truncated before being folded into a prompt,
// so one large file can't blow out the request to a provider.
const MULTIAI_ATTACHMENT_MAX_CHARS = 40000;

function multiaiCurrentChat() {
    if (!multiaiState.data) return null;
    for (const project of multiaiState.data.projects) {
        const chat = project.chats.find(c => c.id === multiaiState.currentChatId);
        if (chat) return chat;
    }
    return null;
}

function multiaiDefaultChat() {
    return {
        id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: 'New chat',
        mode: 'classic',
        topic: '',
        discussMode: 'discuss',
        rounds: 1,
        brevity: 'max 4 sentences',
        participants: [],
        agents: [],             // [{id, name, route, provider, model, effort, persona, personaKey}] — see multiaiEnsureAgents
        personas: {},
        judgeProvider: '',
        judgeScope: 'all',
        strategy: 'crew',
        workflowStepsText: '',
        loopConfig: null,
        messages: [],
        createdAt: Date.now(),
        titleGenerated: false,
        cycle: 0,               // increments once per Send — the "C" in each message's C·R label/id.
        personaKeys: {},        // provider -> persona name picked in the assignment UI (chat.personas holds the resolved text sent to the backend).
        pendingContextRefs: [], // message ids queued via "Add as context", folded into the next outgoing prompt then cleared.
        agentConfig: { provider: '', root: '', maxTurns: 6 }, // Orchestrated "Agent (file tools)" strategy settings.
        engines: {},            // provider -> engine string (e.g. gemini -> 'gemini:3.1-pro'); only Gemini honours it today.
        contextMode: 'bounded', // 'bounded' (digest + window) | 'full' (entire transcript every turn) | 'delta' (only what's new; provider thread remembers)
        autoSummaryEvery: 0,    // delta mode: refresh the rolling summary after this many new messages (0 = manual)
        contextWindow: 10,      // recent messages each participant sees verbatim; older ones are condensed (see multiai-core).
        stopToken: 'DONE',      // convergence token; a round where everyone says it (or passes) ends the run early.
        stopWhenAllAgree: true,
        independentFirstRound: false, // round 1 of each Send runs in parallel, blind to the others' replies.
        charterMode: false,     // claim-status tags, HANDOFF → routing, rotating red-team seat (MULTI_AI_COWORKING_CHARTER).
    };
}

// ---- Message IDs & reference labels ---------------------------------------
// Every message gets an opaque unique id (for "add as context" / scroll-to
// lookups, robust across renames/reordering) plus a human-readable label
// built from cycle (increments each Send), round (round-robin turn, crew
// role position, workflow step, or loop turn), and a 2-letter provider code
// — e.g. "0103CG" reads as cycle 1, round 3, ChatGPT. The label doubles as
// the ledger's R# filter key; the raw id itself is never shown as its own
// column, per design.

const MULTIAI_PROVIDER_CODE = { chatgpt: 'CG', claude: 'CL', gemini: 'GM', perplexity: 'PX', codex: 'CX', 'claude-code': 'CC', 'claude-cli': 'CC', 'codex-cli': 'CX', human: 'US', external: 'EX' };

function multiaiGenMsgId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function multiaiProviderCode(p) {
    if (!p) return '--';
    const base = String(p).split(':')[0];
    return MULTIAI_PROVIDER_CODE[base] || base.slice(0, 2).toUpperCase();
}

function multiaiRefLabel(msg) {
    const c = msg.cycle || 1;
    const r = msg.round || 0;
    let code;
    if (msg.role === 'user') code = 'US';
    else if (msg.role === 'judge') code = 'JD';
    else if (msg.role === 'summary') code = 'SM';
    else if (msg.role === 'system') code = 'SY';
    else if (msg.role === 'error') code = 'ER';
    else code = msg.code || multiaiProviderCode(msg.provider);
    return `${String(c).padStart(2, '0')}${String(r).padStart(2, '0')}${code}`;
}

// Backfills ids on messages persisted before this feature existed, once per
// chat load, so every message — old or new — is reference/scroll-able.
function multiaiEnsureMessageIds(chat) {
    let changed = false;
    (chat.messages || []).forEach(m => {
        if (!m.id) { m.id = multiaiGenMsgId(); changed = true; }
    });
    if (changed) multiaiPersist();
}

function multiaiEscapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ---- Personas: a shared library for Classic participant assignment and ----
// Orchestrated crew roles, so the two don't duplicate the same idea. Custom
// personas loaded from the personas folder take precedence over a built-in
// of the same name.

const MULTIAI_BUILTIN_PERSONAS = {
    'Skeptic': 'You are deeply skeptical by default. Question assumptions, demand evidence for claims, and proactively point out weaknesses or risks that others in the conversation are gliding past.',
    'Optimist': 'You focus on possibilities and upside. Highlight opportunities and constructive paths forward, while still being honest about real constraints.',
    "Devil's Advocate": "You deliberately argue against whatever consensus is forming in the conversation, even positions you might personally agree with, in order to stress-test the reasoning.",
    'Pragmatist': 'You care above all about what is actually implementable. Push back on anything impractical, overengineered, or needlessly expensive, and favor the simplest workable solution.',
    'Domain Expert': 'You respond with the rigor and precision of a subject-matter expert. Reference relevant facts, standards, tradeoffs, or established practice where it applies, and flag when something is outside well-established knowledge.',
    'Concise Summarizer': 'You are extremely concise. Distill points to their essence in as few words as possible without losing the substance, favoring short direct sentences over elaboration.',
};

function multiaiAllPersonas() {
    return Object.assign({}, MULTIAI_BUILTIN_PERSONAS, multiaiState.personas || {});
}

function multiaiUiPrefs() {
    if (!multiaiState.data) return {};
    if (!multiaiState.data.uiPrefs) multiaiState.data.uiPrefs = {};
    return multiaiState.data.uiPrefs;
}

async function multiaiInit() {
    if (multiaiState.initDone) {
        multiaiRenderChatList();
        multiaiRenderChat();
        return;
    }
    multiaiState.initDone = true;

    const [data, providers, personas, routes] = await Promise.all([
        agentHub.multiaiLoad(),
        agentHub.multiaiEnabledProviders(),
        agentHub.multiaiListPersonas(),
        (agentHub.multiaiRoutes ? agentHub.multiaiRoutes() : Promise.resolve(null)).catch(() => null),
    ]);
    multiaiState.routes = routes || { apiMode: false, providers: {}, cli: {} };
    multiaiState.data = data && data.projects ? data : { projects: [{ id: 'default', name: 'General', chats: [] }] };
    if (!multiaiState.data.uiPrefs) multiaiState.data.uiPrefs = {};
    multiaiState.enabledProviders = providers || [];
    multiaiState.personas = personas || {};

    // Wire up live event streams from the main process.
    // Every message the main process produces (turns, judge, summary, REST
    // appends, system notes) arrives here, whichever chat is on screen. It is
    // already persisted by main; we mirror it into memory and dedupe by id.
    agentHub.onMultiaiMessage(({ chatId, message }) => {
        const chat = multiaiFindChat(chatId);
        if (!chat) return;
        message.id = message.id || multiaiGenMsgId();
        message.cycle = message.cycle || chat.cycle || 1;
        if ((chat.messages || []).some(m => m.id === message.id)) return;
        chat.messages = chat.messages || [];
        chat.messages.push(message);
        if (message.role === 'user' && (message.cycle || 0) > (chat.cycle || 0)) chat.cycle = message.cycle;
        if (chatId === multiaiState.currentChatId) {
            multiaiAppendFeedItem(message);
            multiaiRenderStatusLine(chat);
            multiaiRenderLedger(chat);
        }
    });
    agentHub.onMultiaiChatCreated(({ chat }) => {
        if (!chat || multiaiFindChat(chat.id)) return;
        multiaiState.data.projects[0].chats.push(chat);
        multiaiRenderChatList();
    });
    agentHub.onMultiaiThinking(({ chatId, provider, who }) => {
        if (chatId === multiaiState.currentChatId) multiaiSetThinking(provider, true, who);
    });
    agentHub.onMultiaiRoundStart(({ chatId, round, of }) => {
        if (chatId === multiaiState.currentChatId) {
            multiaiAppendSystemNote(`Round ${round} of ${of}`);
            multiaiState.currentRound = round;
            multiaiState.totalRounds = of;
            const chat = multiaiFindChat(chatId);
            if (chat) multiaiRenderStatusLine(chat);
        }
    });
    agentHub.onMultiaiDone(({ chatId }) => multiaiSetRunning(chatId, false));
    agentHub.onMultiaiOrchStep((step) => {
        if (step.chatId === multiaiState.currentChatId) multiaiRenderOrchStep(step);
    });
    agentHub.onMultiaiOrchDone(({ chatId }) => multiaiSetRunning(chatId, false));

    // Runs started before this renderer loaded (or from the REST API) are
    // still owned by the main process — pick up their state.
    try {
        const running = await agentHub.multiaiRunning();
        (running || []).forEach(id => multiaiState.runningChats.add(id));
    } catch { /* older main without the handler */ }

    if (!multiaiState.currentChatId) {
        const firstChat = multiaiState.data.projects[0]?.chats[0];
        if (firstChat) multiaiState.currentChatId = firstChat.id;
    }

    multiaiRenderChatList();
    multiaiRenderChat();
    multiaiRenderStrategyForm();
    multiaiApplySidebarState();
    multiaiApplyOptionsState();
    multiaiInitResizeHandles();

    // Topic textarea doubles as the Enter-to-send box. multiaiSend() is the
    // single submit path for both Enter and the Send button, so both always
    // honor whatever the Rounds field is currently set to.
    const topicEl = document.getElementById('multiai-topic');
    if (topicEl && !topicEl.dataset.wired) {
        topicEl.dataset.wired = '1';
        topicEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                multiaiSend();
            }
        });
    }
}

// Single submit path for Enter and the Send button — always dispatches to
// whichever mode is active, and always reads the live Rounds field so a
// submitted message runs the configured number of rounds, not just one.
function multiaiSend() {
    const chat = multiaiCurrentChat();
    if (chat && multiaiIsRunning(chat.id)) return;
    if (multiaiState.mode === 'classic') multiaiRunRound();
    else multiaiRunOrchestrated();
}

function multiaiIsRunning(chatId) {
    return !!chatId && multiaiState.runningChats.has(chatId);
}

// Debounced persist for typed fields (crew instructions, workflow steps),
// so each keystroke doesn't rewrite the store.
let _multiaiPersistTimer = null;
function multiaiPersistSoon() {
    if (_multiaiPersistTimer) clearTimeout(_multiaiPersistTimer);
    _multiaiPersistTimer = setTimeout(() => { _multiaiPersistTimer = null; multiaiPersist(); }, 400);
}

function multiaiLocalTitle(text, maxLen = 60) {
    const words = String(text || '').replace(/(^|\s)@[\w-]+/g, ' ').replace(/^[\s,:;-]+/, '').replace(/[*#>`_\[\]]/g, '').split(/\s+/).filter(Boolean);
    let name = words.slice(0, 8).join(' ') || 'New chat';
    if (name.length > maxLen) name = name.slice(0, maxLen - 1).trimEnd() + '…';
    return name;
}

function multiaiFindChat(chatId) {
    if (!multiaiState.data) return null;
    for (const project of multiaiState.data.projects) {
        const chat = project.chats.find(c => c.id === chatId);
        if (chat) return chat;
    }
    return null;
}

function multiaiPersist() {
    agentHub.multiaiSave(multiaiState.data);
}

// ---- Message context menu (right-click: add as context / copy reference) --
// One shared menu element, positioned at the click point, wired once at
// load. "Add as context" queues the message's id against the *currently
// open* chat — including a message found in a different chat, so a message
// can be pulled forward as context across chats, not just within one.

let multiaiCtxTargetId = null;

function multiaiShowMsgMenu(evt, msgId) {
    if (evt && evt.preventDefault) evt.preventDefault();
    multiaiCtxTargetId = msgId;
    const menu = document.getElementById('multiai-ctx-menu');
    if (menu) {
        menu.style.left = `${evt.clientX}px`;
        menu.style.top = `${evt.clientY}px`;
        menu.style.display = 'block';
    }
    return false;
}

function multiaiHideMsgMenu() {
    const menu = document.getElementById('multiai-ctx-menu');
    if (menu) menu.style.display = 'none';
    multiaiCtxTargetId = null;
}

if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('multiai-ctx-menu');
        if (menu && menu.style.display === 'block' && !menu.contains(e.target)) multiaiHideMsgMenu();
    });
}

function multiaiFindMessageById(id) {
    if (!multiaiState.data) return null;
    for (const project of multiaiState.data.projects) {
        for (const chat of project.chats) {
            const m = (chat.messages || []).find(mm => mm.id === id);
            if (m) return { chat, message: m };
        }
    }
    return null;
}

function multiaiCtxAddContext() {
    const id = multiaiCtxTargetId;
    multiaiHideMsgMenu();
    if (!id) return;
    const chat = multiaiCurrentChat();
    if (!chat) return;
    chat.pendingContextRefs = chat.pendingContextRefs || [];
    if (!chat.pendingContextRefs.includes(id)) chat.pendingContextRefs.push(id);
    multiaiPersist();
    multiaiRenderContextPreview();
    showToast('Added as context for your next message.');
}

function multiaiCtxCopyRef() {
    const id = multiaiCtxTargetId;
    multiaiHideMsgMenu();
    if (!id) return;
    const found = multiaiFindMessageById(id);
    const label = found ? multiaiRefLabel(found.message) : id;
    if (agentHub.copyToClipboard) agentHub.copyToClipboard(label);
    showToast(`Copied reference ${label}`);
}

function multiaiRenderContextPreview() {
    const chat = multiaiCurrentChat();
    const box = document.getElementById('multiai-context-preview');
    if (!box || !chat) return;
    const refs = chat.pendingContextRefs || [];
    if (!refs.length) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }
    box.style.display = 'flex';
    box.innerHTML = refs.map((id) => {
        const found = multiaiFindMessageById(id);
        const label = found ? multiaiRefLabel(found.message) : id;
        const who = found ? (found.message.who || found.message.provider || '') : '(message not found)';
        return `
            <div style="display: flex; align-items: center; gap: 6px; background: rgba(99,102,241,0.12); border: 1px solid rgba(99,102,241,0.35); border-radius: 14px; padding: 4px 10px; font-size: 0.76rem; color: #c7d2fe;">
                📌 ${multiaiEscape(label)}${who ? ' · ' + multiaiEscape(who) : ''}
                <button onclick="multiaiRemoveContextRef('${id}')" title="Remove reference" style="background: none; border: none; color: #a5b4fc; cursor: pointer; font-size: 0.85rem; padding: 0;">✕</button>
            </div>
        `;
    }).join('');
}

function multiaiRemoveContextRef(id) {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    chat.pendingContextRefs = (chat.pendingContextRefs || []).filter(r => r !== id);
    multiaiPersist();
    multiaiRenderContextPreview();
}

// Builds the text block folded into the outgoing prompt for referenced
// messages, notes it in the feed for visibility, and clears the pending
// queue (consumed once per send, same lifecycle as attachments).
function multiaiConsumeContextRefs(chat) {
    const refs = chat.pendingContextRefs || [];
    if (!refs.length) return '';

    const parts = [];
    const labels = [];
    refs.forEach(id => {
        const found = multiaiFindMessageById(id);
        if (!found) return;
        const label = multiaiRefLabel(found.message);
        labels.push(label);
        parts.push(`[${label}] ${found.message.who || found.message.provider || ''}: ${found.message.text || ''}`);
    });

    chat.pendingContextRefs = [];
    multiaiPersist();
    multiaiRenderContextPreview();

    if (!parts.length) return '';
    multiaiAppendSystemNote(`📌 Referenced: ${labels.join(', ')}`);
    return `\n\n[Referenced context]\n${parts.join('\n\n')}`;
}

// Smooth-scrolls the feed to a message and briefly highlights it — used by
// the ledger's row click, so the ledger and transcript stay linked without
// requiring the ledger to duplicate the full message text.
function multiaiScrollToMessage(id) {
    const el = document.getElementById('multiai-msg-' + id);
    if (!el) {
        showToast('That message isn\'t in the currently open chat.');
        return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'box-shadow 0.2s ease';
    el.style.boxShadow = '0 0 0 2px rgba(250,204,21,0.9)';
    setTimeout(() => { el.style.boxShadow = ''; }, 1600);
}

// ---- Chat list (auto-hide left panel) ------------------------------------

function multiaiRenderChatList() {
    const list = document.getElementById('multiai-chat-list');
    if (!list) return;
    const allChats = multiaiState.data.projects.flatMap(p => p.chats);
    if (allChats.length === 0) {
        list.innerHTML = '<div style="padding: 14px 22px; color: #6b7280; font-size: 0.8rem;">No chats yet.</div>';
        return;
    }
    list.innerHTML = allChats
        .slice()
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .map(c => `
            <div class="sidebar-item ${c.id === multiaiState.currentChatId ? 'active' : ''}"
                 style="display: flex; align-items: center; gap: 4px; padding: 9px 10px 9px 22px; font-size: 0.83rem; background: ${c.id === multiaiState.currentChatId ? 'rgba(255,255,255,0.06)' : 'transparent'};">
                <span onclick="multiaiOpenChat('${c.id}')"
                    style="flex: 1; min-width: 0; cursor: pointer; color: ${c.id === multiaiState.currentChatId ? '#fff' : '#9ca3af'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${multiaiIsRunning(c.id) ? '<span title="Running" style="color:#34d399;">●</span> ' : ''}${c.mode === 'orchestrated' ? '🧩' : '💬'} ${multiaiEscape(c.title || 'Untitled')}
                </span>
                <span class="multiai-chat-actions" style="display: flex; gap: 2px; flex-shrink: 0;">
                    <button onclick="event.stopPropagation(); multiaiRenameChat('${c.id}')" title="Rename chat" style="background: none; border: none; color: #6b7280; cursor: pointer; font-size: 0.78rem; padding: 2px 4px;">✏</button>
                    <button onclick="event.stopPropagation(); multiaiDeleteChat('${c.id}')" title="Delete chat" style="background: none; border: none; color: #6b7280; cursor: pointer; font-size: 0.78rem; padding: 2px 4px;">🗑</button>
                </span>
            </div>
        `).join('');
}

function multiaiRenameChat(chatId) {
    const chat = multiaiFindChat(chatId);
    if (!chat) return;
    const name = window.prompt('Rename chat', chat.title || '');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    chat.title = trimmed;
    multiaiPersist();
    multiaiRenderChatList();
    if (chatId === multiaiState.currentChatId) {
        document.getElementById('multiai-chat-title').textContent = chat.title;
    }
}

function multiaiRenameCurrentChat() {
    const chat = multiaiCurrentChat();
    if (chat) multiaiRenameChat(chat.id);
}

function multiaiDeleteChat(chatId) {
    const chat = multiaiFindChat(chatId);
    if (!chat) return;
    const ok = window.confirm(`Delete "${chat.title || 'this chat'}"? This can't be undone.`);
    if (!ok) return;
    if (multiaiIsRunning(chatId)) agentHub.multiaiStopRun({ chatId });
    for (const project of multiaiState.data.projects) {
        const idx = project.chats.findIndex(c => c.id === chatId);
        if (idx !== -1) { project.chats.splice(idx, 1); break; }
    }
    // Snapshot saves are upsert-only (so a stale snapshot can never wipe a
    // chat); deletion is an explicit call.
    agentHub.multiaiDeleteChat({ chatId });
    multiaiPersist();
    if (chatId === multiaiState.currentChatId) {
        const remaining = multiaiState.data.projects.flatMap(p => p.chats).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (remaining.length) {
            multiaiOpenChat(remaining[0].id);
        } else {
            multiaiState.currentChatId = null;
            multiaiNewChat();
        }
    } else {
        multiaiRenderChatList();
    }
}

function multiaiNewChat() {
    const chat = multiaiDefaultChat();
    if (!multiaiState.data.projects.length) {
        multiaiState.data.projects.push({ id: 'default', name: 'General', chats: [] });
    }
    multiaiState.data.projects[0].chats.push(chat);
    multiaiState.currentChatId = chat.id;
    multiaiState.currentRound = null;
    multiaiState.totalRounds = null;
    multiaiPersist();
    multiaiRenderChatList();
    multiaiRenderChat();
}

function multiaiOpenChat(chatId) {
    multiaiState.currentChatId = chatId;
    multiaiState.currentRound = null;
    multiaiState.totalRounds = null;
    const chat = multiaiCurrentChat();
    if (chat) multiaiState.mode = chat.mode || 'classic';
    multiaiRenderChatList();
    multiaiRenderChat();
}

// ---- Auto-title: ask the alphabetically-first involved provider to name --
// the chat from its first message. Fire-and-forget — the result replaces
// the interim (truncated-topic) title once it arrives, and is never added
// to the chat's messages or the ledger.

function multiaiPickTitleProvider(chat) {
    let candidates = [];
    if (chat.mode === 'classic' && (chat.participants || []).length) {
        candidates = chat.participants.slice();
    } else if (chat.strategy === 'crew' && (chat.crewAgents || []).length) {
        candidates = chat.crewAgents.map(a => a.provider).filter(Boolean);
    }
    if (!candidates.length) {
        candidates = multiaiState.enabledProviders.length ? multiaiState.enabledProviders.slice() : ['chatgpt', 'claude', 'gemini', 'perplexity'];
    }
    candidates.sort();
    return candidates[0];
}

// Titles are local and free by default (first words of the first message —
// what the old ProximaChatApp did). An AI title is on demand via the ✨
// button: it costs a provider round trip and used to fire on every first
// send, into the provider's shared thread, while round 1 was queued behind it.
function multiaiMaybeAutoTitle(chat, firstPrompt) {
    if (!chat || chat.titleGenerated) return;
    chat.titleGenerated = true;
    if (chat.title === 'New chat' || !chat.title) {
        chat.title = multiaiLocalTitle(firstPrompt);
        multiaiPersist();
        multiaiRenderChatList();
        if (chat.id === multiaiState.currentChatId) document.getElementById('multiai-chat-title').textContent = chat.title;
    }
}

async function multiaiAiTitle() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    const firstUser = (chat.messages || []).find(m => m.role === 'user');
    const firstPrompt = (firstUser && firstUser.text) || chat.topic;
    if (!firstPrompt) { showToast('Send a message first.'); return; }
    const provider = document.getElementById('multiai-judge-provider')?.value || multiaiPickTitleProvider(chat);
    if (!provider) return;
    showToast(`Asking ${multiaiProviderLabel(provider)} for a title…`);
    const prompt = `Reply with ONLY a short descriptive title (max 6 words, no quotes, no trailing punctuation) for a conversation that begins with this message:\n\n"${firstPrompt.slice(0, 1500)}"`;
    try {
        const result = await agentHub.multiaiGenerateTitle({ chatId: chat.id, provider, prompt });
        if (result && result.success && result.title) {
            let title = result.title.trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!?]+$/, '');
            if (title.length > 60) title = title.slice(0, 60);
            if (title) {
                chat.title = title;
                multiaiPersist();
                multiaiRenderChatList();
                if (chat.id === multiaiState.currentChatId) {
                    document.getElementById('multiai-chat-title').textContent = chat.title;
                }
            }
        }
    } catch (e) {
        showToast('Could not generate a title.');
    }
}

// ---- Side panels (chat list + ledger): plain collapsible panels ----------
// Two ordinary panels that sit in the normal layout — not hover-triggered
// overlays. Click the arrow in a panel's header to tuck it away as a slim
// labeled tab at that edge; click the tab to bring it back. This replaced
// an earlier hover-to-reveal design that was unreliable in practice (easy
// to miss the reveal zone, and the panel floated over the feed instead of
// behaving like a real side panel).

function multiaiApplyPanelState(panelId, railId, side, collapsed, widthPref, defaultWidth) {
    const panel = document.getElementById(panelId);
    const rail = document.getElementById(railId);
    if (!panel) return;

    if (collapsed) {
        panel.style.display = 'none';
        if (rail) rail.style.display = 'flex';
    } else {
        panel.style.display = 'flex';
        const w = (multiaiUiPrefs()[widthPref]) || defaultWidth;
        panel.style.width = `${w}px`;
        panel.style.flex = `0 0 ${w}px`;
        if (rail) rail.style.display = 'none';
    }
}

function multiaiApplySidebarState() {
    const prefs = multiaiUiPrefs();
    multiaiApplyPanelState('multiai-sidebar', 'multiai-sidebar-rail', 'left', !!prefs.chatListCollapsed, 'chatListWidth', 260);
    multiaiApplyPanelState('multiai-ledger-sidebar', 'multiai-ledger-rail', 'right', prefs.ledgerCollapsed !== false, 'ledgerWidth', 320);
}

function multiaiToggleChatListCollapsed() {
    const prefs = multiaiUiPrefs();
    prefs.chatListCollapsed = !prefs.chatListCollapsed;
    multiaiPersist();
    multiaiApplySidebarState();
}

function multiaiToggleLedgerCollapsed() {
    const prefs = multiaiUiPrefs();
    const wasCollapsed = prefs.ledgerCollapsed !== false;
    prefs.ledgerCollapsed = !wasCollapsed;
    multiaiPersist();
    multiaiApplySidebarState();
    if (wasCollapsed) {
        const chat = multiaiCurrentChat();
        if (chat) multiaiRenderLedger(chat);
    }
}

// Drag-to-resize for both side panels, wired once (the handles are static
// DOM nodes that survive chat switches and re-renders). Both panels sit in
// normal flex flow, so dragging the handle directly changes the panel's
// width like an ordinary split view — no overlay/positioning tricks to
// fight with.
function multiaiInitResizeHandles() {
    multiaiWireResize('multiai-sidebar-resize', 'multiai-sidebar', 'left', 200, 480, 'chatListWidth');
    multiaiWireResize('multiai-ledger-resize', 'multiai-ledger-sidebar', 'right', 220, 520, 'ledgerWidth');
}

function multiaiWireResize(handleId, panelId, side, minWidth, maxWidth, prefKey) {
    const handle = document.getElementById(handleId);
    const panel = document.getElementById(panelId);
    if (!handle || !panel || handle.dataset.wired) return;
    handle.dataset.wired = '1';

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('mouseenter', () => { handle.style.background = 'rgba(255,255,255,0.18)'; });
    handle.addEventListener('mouseleave', () => { if (!dragging) handle.style.background = 'transparent'; });

    handle.addEventListener('mousedown', (e) => {
        if (panel.style.display === 'none') return;
        dragging = true;
        startX = e.clientX;
        startWidth = panel.getBoundingClientRect().width;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
        e.stopPropagation();
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = side === 'left' ? (e.clientX - startX) : (startX - e.clientX);
        const newWidth = Math.max(minWidth, Math.min(maxWidth, Math.round(startWidth + delta)));
        panel.style.width = `${newWidth}px`;
        panel.style.flex = `0 0 ${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        handle.style.background = 'transparent';
        const finalWidth = parseInt(panel.style.width, 10);
        if (finalWidth) multiaiUiPrefs()[prefKey] = finalWidth;
        multiaiPersist();
    });
}

// ---- Expandable options drawer (main chat area) --------------------------
// Participants/mode/rounds/brevity/judge/strategy controls live here now,
// collapsed by default so the feed gets the room — click the summary row
// to expand. Replaces the earlier design that pinned them in the sidebar.

function multiaiToggleOptions() {
    const prefs = multiaiUiPrefs();
    prefs.optionsExpanded = !prefs.optionsExpanded;
    multiaiPersist();
    multiaiApplyOptionsState();
}

function multiaiApplyOptionsState() {
    const body = document.getElementById('multiai-options-body');
    const chevron = document.getElementById('multiai-options-chevron');
    const btn = document.getElementById('multiai-options-summary');
    const expanded = !!multiaiUiPrefs().optionsExpanded;
    if (body) body.style.display = expanded ? 'block' : 'none';
    if (chevron) chevron.style.transform = expanded ? 'rotate(180deg)' : 'rotate(0deg)';
    if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function multiaiRenderOptionsSummary(chat) {
    const el = document.getElementById('multiai-options-summary-text');
    if (!el || !chat) return;
    if (multiaiState.mode === 'classic') {
        const n = multiaiEnsureAgents(chat).length;
        const rounds = chat.rounds || 1;
        const extras = [];
        if (chat.contextMode === 'full') extras.push('full transcript');
        else if (chat.contextMode === 'delta') extras.push(`delta${parseInt(chat.autoSummaryEvery, 10) > 0 ? ' + rolling summary' : ''}`);
        if (chat.independentFirstRound) extras.push('blind R1');
        if (chat.charterMode) extras.push('charter');
        if (chat.stopWhenAllAgree !== false) extras.push(`stop on ${chat.stopToken || 'DONE'}`);
        const routes = multiaiState.routes || {};
        if (routes.apiMode) extras.push('API mode');
        if ((chat.agents || []).some(a => MULTIAI_CLI_PROVIDERS[a.provider])) extras.push('CLI agents');
        el.textContent = `⚙ ${n} participant${n === 1 ? '' : 's'} · ${chat.discussMode === 'debate' ? 'Debate' : 'Discuss'} · ${rounds} round${rounds === 1 ? '' : 's'} · ${chat.brevity || 'max 4 sentences'}${extras.length ? ' · ' + extras.join(' · ') : ''}`;
    } else {
        const strategy = chat.strategy || 'crew';
        let label = 'Crew';
        if (strategy === 'crew') {
            const n = (chat.crewAgents || []).length;
            label = `Crew · ${n} role${n === 1 ? '' : 's'}`;
        } else if (strategy === 'workflow') {
            label = 'Workflow';
        } else if (strategy === 'loop') {
            label = 'Loop';
        }
        el.textContent = `⚙ ${label}`;
    }
}

// ---- Main content ---------------------------------------------------

function multiaiRenderChat() {
    let chat = multiaiCurrentChat();
    if (!chat) {
        multiaiNewChat();
        return;
    }

    multiaiEnsureMessageIds(chat);
    multiaiState.ledgerFilters = {};

    document.getElementById('multiai-chat-title').textContent = chat.title || 'New chat';
    document.getElementById('multiai-topic').value = chat.topic || '';

    multiaiSetMode(chat.mode || 'classic', /*skipSave*/ true);

    document.getElementById('multiai-discuss-mode').value = chat.discussMode || 'discuss';
    document.getElementById('multiai-rounds').value = chat.rounds || 1;
    document.getElementById('multiai-brevity').value = chat.brevity || 'max 4 sentences';
    document.getElementById('multiai-strategy').value = chat.strategy || 'crew';
    const judgeScopeEl = document.getElementById('multiai-judge-scope');
    if (judgeScopeEl) judgeScopeEl.value = (chat.judgeScope === 'last') ? 'round' : (chat.judgeScope || 'all');
    const cm = document.getElementById('multiai-context-mode');
    if (cm) cm.value = chat.contextMode || 'bounded';
    const ase = document.getElementById('multiai-auto-summary');
    if (ase) ase.value = chat.autoSummaryEvery != null ? chat.autoSummaryEvery : 0;
    const cw = document.getElementById('multiai-context-window');
    if (cw) cw.value = chat.contextWindow != null ? chat.contextWindow : 10;
    const st = document.getElementById('multiai-stop-token');
    if (st) st.value = chat.stopToken || 'DONE';
    const sa = document.getElementById('multiai-stop-when-agree');
    if (sa) sa.checked = chat.stopWhenAllAgree !== false;
    const ind = document.getElementById('multiai-independent-first');
    if (ind) ind.checked = !!chat.independentFirstRound;
    const ch = document.getElementById('multiai-charter-mode');
    if (ch) ch.checked = !!chat.charterMode;

    multiaiRenderParticipants(chat);
    multiaiRenderPersonaAssignment(chat);
    multiaiRenderJudgeOptions(chat);
    multiaiRenderStrategyForm();
    multiaiRenderFeed(chat);
    multiaiRenderStatusLine(chat);
    multiaiRenderLedger(chat);
    multiaiRenderOptionsSummary(chat);
    multiaiApplyOptionsState();
    multiaiApplyModeLock(chat);
    multiaiApplyRunningUi();
    multiaiState.pendingAttachments = [];
    multiaiRenderAttachmentsPreview();
    multiaiRenderContextPreview();
}

// ---- Status line + ledger (PCA parity: round counter, running message log) --

function multiaiRenderStatusLine(chat) {
    const el = document.getElementById('multiai-status-line');
    if (!el) return;
    const participants = multiaiEnsureAgents(chat).map(a => a.name).join(', ');
    const msgCount = (chat.messages || []).length;
    const roundBadge = multiaiState.currentRound
        ? ` · round ${multiaiState.currentRound}${multiaiState.totalRounds ? ' of ' + multiaiState.totalRounds : ''}`
        : '';
    el.textContent = participants
        ? `${participants} · ${msgCount} message${msgCount === 1 ? '' : 's'}${roundBadge}`
        : '';
}

function multiaiRenderLedger(chat) {
    const body = document.getElementById('multiai-ledger-body');
    if (!body) return;

    multiaiPopulateLedgerFilters(chat);
    const filters = multiaiState.ledgerFilters || {};

    let messages = chat.messages || [];
    if (filters.roundKey) {
        messages = messages.filter(m => `${m.cycle || 1}-${m.round || 0}` === filters.roundKey);
    }
    if (filters.agent) {
        messages = messages.filter(m => (m.who || m.provider || '') === filters.agent);
    }

    body.innerHTML = messages.map((m) => {
        const time = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const snippet = (m.text || '').replace(/\s+/g, ' ').slice(0, 90);
        const roundLabel = `C${m.cycle || 1}·R${m.round || 0}`;
        return `
            <tr style="border-top: 1px solid rgba(255,255,255,0.06); cursor: pointer;" onclick="multiaiScrollToMessage('${m.id}')" oncontextmenu="return multiaiShowMsgMenu(event, '${m.id}')" title="Click to jump to this message in the transcript · right-click for more">
                <td style="padding: 5px 8px; color: #6b7280; white-space: nowrap;">${multiaiEscape(roundLabel)}</td>
                <td style="padding: 5px 8px; color: #93c5fd;">${multiaiEscape(m.who || m.provider || '')}</td>
                <td style="padding: 5px 8px; color: #6b7280; white-space: nowrap;">${time}</td>
                <td style="padding: 5px 8px; color: #d1d5db;">${multiaiEscape(snippet)}${(m.text || '').length > 90 ? '…' : ''}</td>
            </tr>
        `;
    }).join('') || '<tr><td colspan="4" style="padding: 10px; color: #6b7280;">No messages match the current filters.</td></tr>';
}

// Rebuilds the ledger's R#/Agent filter dropdowns from whatever's actually
// in this chat, preserving the current selection where it's still valid.
function multiaiPopulateLedgerFilters(chat) {
    const roundSel = document.getElementById('multiai-ledger-filter-round');
    const agentSel = document.getElementById('multiai-ledger-filter-agent');
    if (!roundSel || !agentSel || !chat) return;
    const messages = chat.messages || [];

    const roundKeys = [];
    const seenRound = new Set();
    messages.forEach(m => {
        const key = `${m.cycle || 1}-${m.round || 0}`;
        if (!seenRound.has(key)) { seenRound.add(key); roundKeys.push({ key, cycle: m.cycle || 1, round: m.round || 0 }); }
    });
    roundKeys.sort((a, b) => a.cycle - b.cycle || a.round - b.round);
    const prevRound = roundSel.value;
    roundSel.innerHTML = '<option value="">All rounds</option>' +
        roundKeys.map(k => `<option value="${k.key}">C${k.cycle}·R${k.round}</option>`).join('');
    if ([...roundSel.options].some(o => o.value === prevRound)) roundSel.value = prevRound;

    const agents = [];
    const seenAgent = new Set();
    messages.forEach(m => {
        const label = m.who || m.provider || '';
        if (label && !seenAgent.has(label)) { seenAgent.add(label); agents.push(label); }
    });
    const prevAgent = agentSel.value;
    agentSel.innerHTML = '<option value="">All agents</option>' +
        agents.map(a => `<option value="${multiaiEscapeAttr(a)}">${multiaiEscape(a)}</option>`).join('');
    if ([...agentSel.options].some(o => o.value === prevAgent)) agentSel.value = prevAgent;

    multiaiState.ledgerFilters = { roundKey: roundSel.value, agent: agentSel.value };
}

function multiaiOnLedgerFilterChange() {
    const roundSel = document.getElementById('multiai-ledger-filter-round');
    const agentSel = document.getElementById('multiai-ledger-filter-agent');
    multiaiState.ledgerFilters = { roundKey: roundSel ? roundSel.value : '', agent: agentSel ? agentSel.value : '' };
    const chat = multiaiCurrentChat();
    if (chat) multiaiRenderLedger(chat);
}

// ---- Agents (participants) -------------------------------------------
// A participant is an agent: name + route + provider + model + effort +
// persona. Several agents may share a provider ("Opus · high" and
// "Sonnet · low" through Claude Code; "GPT high"/"GPT low" through the
// OpenAI API). Route 'auto' follows the app's general Settings: API mode on
// with a key → API with the model chosen there (or the agent's own);
// otherwise the browser tab. CLI agents run locally on your subscription.

const MULTIAI_CLI_PROVIDERS = { 'claude-cli': 'Claude Code', 'codex-cli': 'Codex' };
const MULTIAI_EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MULTIAI_MODEL_HINTS = {
    'claude-cli': ['fable', 'opus', 'sonnet', 'haiku', 'opus[1m]', 'sonnet[1m]'],
    'codex-cli': ['gpt-5.5', 'gpt-5.5-codex', 'gpt-5.4'],
    gemini: ['3.5-flash', '3.1-pro', '3.1-flash-lite', 'auto'],
};

function multiaiSlug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function multiaiAgentCode(agent, taken) {
    const name = String(agent.name || '');
    const base = String(agent.provider || '').split(':')[0];
    const label = multiaiProviderLabel(base);
    let code;
    if (name && (name === label || name.startsWith(label + ' ') || name.startsWith(label + '·'))) code = multiaiProviderCode(base);
    else {
        const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
        if (words.length >= 2) code = (words[0][0] + words[1][0]).toUpperCase();
        else if (words.length === 1 && words[0].length >= 2) code = words[0].slice(0, 2).toUpperCase();
        else code = multiaiProviderCode(base);
    }
    if (taken) { let c = code, n = 2; while (taken.has(c)) c = `${code}${n++}`; taken.add(c); return c; }
    return code;
}

function multiaiDefaultAgentName(provider, model, effort) {
    const label = MULTIAI_CLI_PROVIDERS[provider] || multiaiProviderLabel(provider);
    const parts = [];
    if (model && !(provider === 'gemini' && model === 'gemini')) parts.push(String(model).replace(/^gemini:/, ''));
    if (effort) parts.push(effort);
    return parts.length ? `${label} · ${parts.join(' · ')}` : label;
}

// Migrates a chat's legacy participants list into agents (once) and keeps
// ids unique. Mirrors multiai-core.normalizeAgents.
function multiaiEnsureAgents(chat) {
    if (!chat) return [];
    if (!Array.isArray(chat.agents)) chat.agents = [];
    if (!chat.agents.length && (chat.participants || []).length) {
        chat.agents = chat.participants.map(p => {
            const base = String(p).split(':')[0];
            const engine = String(p).includes(':') ? String(p) : ((chat.engines && chat.engines[base]) || '');
            const a = { id: base, name: multiaiProviderLabel(base), route: 'auto', provider: base, model: engine && engine !== base ? engine.replace(/^gemini:/, '') : '', effort: '' };
            const key = (chat.personaKeys || {})[base];
            if (key) { a.personaKey = key; a.persona = multiaiAllPersonas()[key] || ''; }
            return a;
        });
    }
    const seen = new Set();
    chat.agents.forEach(a => {
        if (!a.provider) a.provider = 'chatgpt';
        if (MULTIAI_CLI_PROVIDERS[a.provider]) a.route = 'cli';
        if (!a.route) a.route = 'auto';
        if (!a.name) a.name = multiaiDefaultAgentName(a.provider, a.model, a.effort);
        if (!a.id) a.id = multiaiSlug(a.name) || a.provider;
        let id = a.id, n = 2;
        while (seen.has(id)) id = `${a.id}-${n++}`;
        a.id = id; seen.add(id);
    });
    // Keep the legacy field in sync for anything that still reads it.
    chat.participants = chat.agents.map(a => a.provider);
    return chat.agents;
}

function multiaiRouteLabel(agent) {
    const r = multiaiState.routes || { apiMode: false, providers: {}, cli: {} };
    if (MULTIAI_CLI_PROVIDERS[agent.provider]) {
        const ok = agent.provider === 'claude-cli' ? r.cli.claude : r.cli.codex;
        return ok ? `→ ${MULTIAI_CLI_PROVIDERS[agent.provider]} (local, subscription)` : `⚠ ${MULTIAI_CLI_PROVIDERS[agent.provider]} CLI not found`;
    }
    const p = r.providers[agent.provider] || {};
    const apiOk = r.apiMode && p.hasKey;
    if (agent.route === 'browser') return '→ browser tab';
    if (agent.route === 'api' && !apiOk) return `⚠ API mode is off or no ${multiaiProviderLabel(agent.provider)} key in Settings — will use the browser tab`;
    if (apiOk) return `→ API · ${agent.model || (p.model ? p.model + ' (Settings)' : 'model from Settings')}`;
    return '→ browser tab' + (agent.effort ? ' (effort ignored — API mode is off in Settings)' : '');
}

function multiaiRenderParticipants(chat) {
    const box = document.getElementById('multiai-participants');
    if (!box) return;
    const agents = multiaiEnsureAgents(chat);
    const routes = multiaiState.routes || { apiMode: false, providers: {}, cli: {} };
    const personaNames = Object.keys(multiaiAllPersonas());
    const providerOptions = ['chatgpt', 'claude', 'gemini', 'perplexity', 'claude-cli', 'codex-cli'];
    const inp = 'background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 6px; font-size: 0.76rem; box-sizing: border-box;';
    const takenCodes = new Set();
    const cards = agents.map((a, i) => {
        const isCli = !!MULTIAI_CLI_PROVIDERS[a.provider];
        const apiOk = routes.apiMode && (routes.providers[a.provider] || {}).hasKey;
        const hints = isCli ? MULTIAI_MODEL_HINTS[a.provider] : (apiOk ? ((routes.providers[a.provider] || {}).models || []) : (a.provider === 'gemini' ? MULTIAI_MODEL_HINTS.gemini : []));
        const effortOn = isCli || apiOk || a.route === 'api';
        return `
            <div style="flex: 1 1 300px; min-width: 280px; max-width: 420px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span title="Label code" style="font-size: 0.66rem; font-weight: 700; color: #6b7280; width: 26px; flex-shrink: 0;">${multiaiEscape(multiaiAgentCode(a, takenCodes))}</span>
                    <input value="${multiaiEscapeAttr(a.name)}" placeholder="Name" oninput="multiaiAgentField(${i}, 'name', this.value)" style="flex: 1; ${inp}">
                    <button onclick="multiaiAgentDuplicate(${i})" title="Duplicate this agent" style="background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 0.9rem;">⧉</button>
                    <button onclick="multiaiAgentRemove(${i})" title="Remove" style="background: none; border: none; color: #f87171; cursor: pointer; font-size: 0.9rem;">✕</button>
                </div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    <select title="Provider" onchange="multiaiAgentField(${i}, 'provider', this.value)" style="flex: 1 1 110px; ${inp}">
                        ${providerOptions.map(pv => `<option value="${pv}" ${a.provider === pv ? 'selected' : ''}>${MULTIAI_CLI_PROVIDERS[pv] || multiaiProviderLabel(pv)}</option>`).join('')}
                    </select>
                    <select title="Route: auto follows Settings (API mode on + key → API, else browser tab)" onchange="multiaiAgentField(${i}, 'route', this.value)" ${isCli ? 'disabled' : ''} style="flex: 1 1 90px; ${inp}">
                        ${['auto', 'browser', 'api', 'cli'].map(rt => `<option value="${rt}" ${(isCli ? 'cli' : a.route) === rt ? 'selected' : ''} ${rt === 'cli' && !isCli ? 'disabled' : ''}>${rt}</option>`).join('')}
                    </select>
                </div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    <input list="multiai-models-${i}" value="${multiaiEscapeAttr(a.model || '')}" placeholder="${isCli ? 'model alias' : (apiOk ? 'model (blank = Settings)' : (a.provider === 'gemini' ? 'engine (blank = default)' : 'model n/a in browser tab'))}" oninput="multiaiAgentField(${i}, 'model', this.value)" style="flex: 2 1 120px; ${inp}">
                    <datalist id="multiai-models-${i}">${hints.map(h => `<option value="${multiaiEscapeAttr(h)}">`).join('')}</datalist>
                    <select title="Reasoning effort (API and CLI routes)" onchange="multiaiAgentField(${i}, 'effort', this.value)" ${effortOn ? '' : 'disabled'} style="flex: 1 1 80px; ${inp}">
                        ${MULTIAI_EFFORTS.map(e => `<option value="${e}" ${(a.effort || '') === e ? 'selected' : ''}>${e || 'effort: default'}</option>`).join('')}
                    </select>
                </div>
                <select title="Persona" onchange="multiaiAgentPersona(${i}, this.value)" style="${inp} color: #9ca3af;">
                    <option value="">🎭 Persona: none</option>
                    ${personaNames.map(n => `<option value="${multiaiEscapeAttr(n)}" ${a.personaKey === n ? 'selected' : ''}>${multiaiEscape(n)}</option>`).join('')}
                </select>
                <div style="font-size: 0.7rem; color: #6b7280;">${multiaiEscape(multiaiRouteLabel(a))}</div>
            </div>`;
    }).join('');
    const quick = ['chatgpt', 'claude', 'gemini', 'perplexity', 'claude-cli', 'codex-cli'].map(pv => {
        const cliOk = pv === 'claude-cli' ? routes.cli.claude : (pv === 'codex-cli' ? routes.cli.codex : true);
        return `<button class="header-btn" onclick="multiaiAgentAdd('${pv}')" ${cliOk ? '' : 'disabled title="CLI not found on this machine"'} style="justify-content: center; font-size: 0.74rem; padding: 4px 8px; ${cliOk ? '' : 'opacity: 0.4;'}">+ ${MULTIAI_CLI_PROVIDERS[pv] || multiaiProviderLabel(pv)}</button>`;
    }).join('');
    const mode = routes.apiMode ? 'API mode ON in Settings — auto agents use API keys/models from there' : 'API mode OFF in Settings — auto agents use the browser tabs';
    box.style.display = 'block';
    box.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;">${cards || '<div style="font-size: 0.76rem; color: #6b7280;">No agents yet — add one below.</div>'}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">${quick}
            <button class="header-btn" onclick="multiaiRefreshRoutes()" title="Re-read Settings (API mode, keys, models) and CLI availability" style="justify-content: center; font-size: 0.74rem; padding: 4px 8px;">↻</button>
            <span style="font-size: 0.7rem; color: #6b7280;">${multiaiEscape(mode)}</span>
        </div>`;
}

function multiaiAgentAdd(provider) {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    multiaiEnsureAgents(chat);
    const isCli = !!MULTIAI_CLI_PROVIDERS[provider];
    const model = provider === 'codex-cli' ? 'gpt-5.5' : (provider === 'claude-cli' ? 'sonnet' : '');
    const a = { id: '', name: '', route: isCli ? 'cli' : 'auto', provider, model, effort: isCli ? 'high' : '' };
    a.name = multiaiDefaultAgentName(provider, model, a.effort);
    chat.agents.push(a);
    multiaiEnsureAgents(chat);
    multiaiPersist();
    multiaiRenderParticipants(chat);
    multiaiRenderJudgeOptions(chat);
    multiaiRenderOptionsSummary(chat);
    multiaiRenderStatusLine(chat);
}

function multiaiAgentDuplicate(i) {
    const chat = multiaiCurrentChat();
    if (!chat || !chat.agents || !chat.agents[i]) return;
    const src = chat.agents[i];
    const copy = Object.assign({}, src, { id: '', name: `${src.name} 2` });
    chat.agents.splice(i + 1, 0, copy);
    multiaiEnsureAgents(chat);
    multiaiPersist();
    multiaiRenderParticipants(chat);
    multiaiRenderJudgeOptions(chat);
    multiaiRenderOptionsSummary(chat);
    multiaiRenderStatusLine(chat);
}

function multiaiAgentRemove(i) {
    const chat = multiaiCurrentChat();
    if (!chat || !chat.agents) return;
    chat.agents.splice(i, 1);
    multiaiEnsureAgents(chat);
    multiaiPersist();
    multiaiRenderParticipants(chat);
    multiaiRenderJudgeOptions(chat);
    multiaiRenderOptionsSummary(chat);
    multiaiRenderStatusLine(chat);
}

function multiaiAgentField(i, field, value) {
    const chat = multiaiCurrentChat();
    if (!chat || !chat.agents || !chat.agents[i]) return;
    const a = chat.agents[i];
    const autoNamed = !a.name || a.name === multiaiDefaultAgentName(a.provider, a.model, a.effort);
    a[field] = value;
    if (field === 'provider') {
        const isCli = !!MULTIAI_CLI_PROVIDERS[value];
        a.route = isCli ? 'cli' : (a.route === 'cli' ? 'auto' : a.route);
        if (isCli) { a.model = value === 'codex-cli' ? 'gpt-5.5' : 'sonnet'; a.effort = a.effort || 'high'; }
        else if (value !== 'gemini') a.model = '';
    }
    if (field !== 'name' && autoNamed) { a.name = multiaiDefaultAgentName(a.provider, a.model, a.effort); a.id = ''; }
    if (field === 'name') a.id = '';   // re-slug from the new name (so @mentions follow the label)
    multiaiEnsureAgents(chat);
    if (field === 'name') multiaiPersistSoon(); else multiaiPersist();
    if (field !== 'name' && field !== 'model') { multiaiRenderParticipants(chat); multiaiRenderJudgeOptions(chat); }
    multiaiRenderOptionsSummary(chat);
    multiaiRenderStatusLine(chat);
}

function multiaiAgentPersona(i, personaName) {
    const chat = multiaiCurrentChat();
    if (!chat || !chat.agents || !chat.agents[i]) return;
    const a = chat.agents[i];
    if (!personaName) { delete a.personaKey; delete a.persona; }
    else { a.personaKey = personaName; a.persona = multiaiAllPersonas()[personaName] || ''; }
    multiaiPersist();
}

async function multiaiRefreshRoutes() {
    try { multiaiState.routes = await agentHub.multiaiRoutes(); } catch { /* older main */ }
    const chat = multiaiCurrentChat();
    if (chat) { multiaiRenderParticipants(chat); multiaiRenderOptionsSummary(chat); }
}

function multiaiProviderLabel(p) {
    const names = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', perplexity: 'Perplexity', codex: 'Codex', 'claude-code': 'Claude Code', 'claude-cli': 'Claude Code', 'codex-cli': 'Codex', human: 'You', external: 'External' };
    const base = String(p || '').split(':')[0];
    return names[base] || base;
}

// Legacy entry points kept for older call sites; agents carry personas now.
function multiaiToggleParticipant(provider, on) {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    multiaiEnsureAgents(chat);
    if (on) multiaiAgentAdd(provider);
    else { chat.agents = chat.agents.filter(a => a.provider !== provider); multiaiEnsureAgents(chat); multiaiPersist(); multiaiRenderParticipants(chat); }
}

function multiaiRenderPersonaAssignment() { /* personas live on the agent cards now */ }
function multiaiSetParticipantPersona() { /* see multiaiAgentPersona */ }
function multiaiSetEngine(provider, engine) {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    multiaiEnsureAgents(chat);
    const a = chat.agents.find(x => x.provider === provider);
    if (a) { a.model = engine && engine !== provider ? String(engine).replace(/^gemini:/, '') : ''; multiaiPersist(); multiaiRenderParticipants(chat); }
}

function multiaiRenderJudgeOptions(chat) {
    const sel = document.getElementById('multiai-judge-provider');
    if (!sel) return;
    const agents = multiaiEnsureAgents(chat);
    const providers = multiaiState.enabledProviders.length
        ? multiaiState.enabledProviders
        : ['chatgpt', 'claude', 'gemini', 'perplexity'];
    const opts = agents.map(a => `<option value="${multiaiEscapeAttr(a.id)}">${multiaiEscape(a.name)}</option>`)
        .concat(providers.filter(p => !agents.some(a => a.provider === p)).map(p => `<option value="${p}">${multiaiProviderLabel(p)} (tab)</option>`));
    sel.innerHTML = opts.join('');
    if (chat.judgeProvider && [...sel.options].some(o => o.value === chat.judgeProvider)) sel.value = chat.judgeProvider;
}

// Live-persists the classic-mode fields as they change (not just at Run
// time), so the collapsed options summary and any other tab reflect the
// current choice immediately.
function multiaiOnClassicFieldChange() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    multiaiReadClassicFields(chat);
    multiaiPersist();
    multiaiRenderOptionsSummary(chat);
}

// Mode (Classic vs Orchestrated) is only switchable while a chat is empty.
// A chat with messages already committed to one mode's data shape (a
// round-robin transcript vs. a task-pipeline run) — mixing them mid-thread
// would be confusing to read back and to hand to a judge/export. Starting a
// new chat is one click, so the lock costs little.
function multiaiSetMode(mode, skipSave) {
    const chat = multiaiCurrentChat();
    if (chat && !skipSave && (chat.messages || []).length && chat.mode && chat.mode !== mode) {
        showToast('Mode is locked once a chat has messages — start a new chat to switch.');
        multiaiApplyModeLock(chat);
        return;
    }

    multiaiState.mode = mode;
    if (chat && !skipSave) {
        chat.mode = mode;
        multiaiPersist();
    }

    document.getElementById('multiai-mode-classic').classList.toggle('active', mode === 'classic');
    document.getElementById('multiai-mode-orch').classList.toggle('active', mode === 'orchestrated');
    document.getElementById('multiai-classic-controls').style.display = mode === 'classic' ? 'block' : 'none';
    document.getElementById('multiai-orch-controls').style.display = mode === 'orchestrated' ? 'block' : 'none';
    if (chat) { multiaiRenderOptionsSummary(chat); multiaiApplyModeLock(chat); }
}

function multiaiApplyModeLock(chat) {
    const classicBtn = document.getElementById('multiai-mode-classic');
    const orchBtn = document.getElementById('multiai-mode-orch');
    if (!classicBtn || !orchBtn || !chat) return;
    const locked = (chat.messages || []).length > 0;
    const lockClassic = locked && chat.mode !== 'classic';
    const lockOrch = locked && chat.mode !== 'orchestrated';
    classicBtn.style.opacity = lockClassic ? '0.4' : '1';
    classicBtn.style.cursor = lockClassic ? 'not-allowed' : 'pointer';
    classicBtn.title = lockClassic ? 'Locked — this chat already has messages in Orchestrated mode. Start a new chat to use Classic.' : '';
    orchBtn.style.opacity = lockOrch ? '0.4' : '1';
    orchBtn.style.cursor = lockOrch ? 'not-allowed' : 'pointer';
    orchBtn.title = lockOrch ? 'Locked — this chat already has messages in Classic mode. Start a new chat to use Orchestrated.' : '';
}

function multiaiRenderFeed(chat) {
    const feed = document.getElementById('multiai-feed');
    if (!feed) return;
    feed.innerHTML = '';
    (chat.messages || []).forEach(m => multiaiAppendFeedItem(m, /*skipScroll*/ true));
    feed.scrollTop = feed.scrollHeight;
}

function multiaiAppendFeedItem(message, skipScroll) {
    const feed = document.getElementById('multiai-feed');
    if (!feed) return;
    if (!message.id) message.id = multiaiGenMsgId();
    const isError = message.role === 'error';
    const isJudge = message.role === 'judge';
    const isUser = message.role === 'user';
    const isSummary = message.role === 'summary';
    const isPass = message.role === 'pass';
    if (message.role === 'system') {
        // Persisted note (converged / stopped / directed turn): compact, centered.
        const note = document.createElement('div');
        note.id = 'multiai-msg-' + message.id;
        note.style.cssText = 'text-align: center; font-size: 0.72rem; color: #9ca3af; margin: 4px 0;';
        note.textContent = message.text || '';
        feed.appendChild(note);
        if (!skipScroll) feed.scrollTop = feed.scrollHeight;
        return;
    }
    const item = document.createElement('div');
    item.id = 'multiai-msg-' + message.id;
    item.oncontextmenu = (e) => multiaiShowMsgMenu(e, message.id);
    const border = isError ? 'border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.06);'
        : isJudge ? 'border-color: rgba(168,85,247,0.4); background: rgba(168,85,247,0.06);'
        : isSummary ? 'border-color: rgba(52,211,153,0.4); background: rgba(52,211,153,0.06);'
        : isUser ? 'border-color: rgba(99,102,241,0.35); background: rgba(99,102,241,0.08);'
        : isPass ? 'opacity: 0.55; background: rgba(255,255,255,0.02);'
        : 'background: rgba(255,255,255,0.03);';
    const color = isError ? '#f87171' : isJudge ? '#c084fc' : isSummary ? '#34d399' : isUser ? '#a5b4fc' : '#93c5fd';
    item.style.cssText = `border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 12px 14px; ${border}`;
    const attach = message.attachmentsText ? `<details style="margin-top: 6px; font-size: 0.76rem; color: #9ca3af;"><summary style="cursor: pointer;">📎 attached context (${message.attachmentsText.length.toLocaleString()} chars)</summary><pre style="white-space: pre-wrap; margin: 6px 0 0 0; font-family: inherit;">${multiaiEscape(message.attachmentsText)}</pre></details>` : '';
    item.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;">
            <div style="font-size: 0.72rem; font-weight: 700; color: ${color}; text-transform: uppercase; letter-spacing: 0.5px;">${multiaiEscape(message.who || message.provider || '')}${message.redTeam ? ' <span title="Held the red-team seat this round" style="color:#f87171; font-weight:600; letter-spacing:0;">· red team</span>' : ''}</div>
            <div title="Reference label — right-click this message for options" style="font-size: 0.62rem; color: #4b4b60; font-weight: 600; letter-spacing: 0.5px; flex-shrink: 0;">${multiaiRefLabel(message)}</div>
        </div>
        <div style="font-size: 0.87rem; color: #e5e7eb; white-space: pre-wrap; line-height: 1.5;">${multiaiEscape(message.text || '')}</div>${attach}
    `;
    feed.appendChild(item);
    if (!skipScroll) feed.scrollTop = feed.scrollHeight;
}

function multiaiAppendSystemNote(text) {
    const feed = document.getElementById('multiai-feed');
    if (!feed) return;
    const note = document.createElement('div');
    note.style.cssText = 'text-align: center; font-size: 0.72rem; color: #6b7280; margin: 4px 0;';
    note.textContent = text;
    feed.appendChild(note);
    feed.scrollTop = feed.scrollHeight;
}

function multiaiSetThinking(provider, on, who) {
    if (!on) return;
    multiaiAppendSystemNote(`${who || multiaiProviderLabel(provider)} is thinking…`);
}

function multiaiEscape(s) {
    const div = document.createElement('div');
    div.textContent = String(s == null ? '' : s);
    return div.innerHTML;
}

// Running state is per chat (the main process owns it); this updates the
// set and, if that chat is on screen, the controls. Switching chats never
// clears it — it used to, which let a second run start in the same thread.
function multiaiSetRunning(chatId, on) {
    if (!chatId) return;
    if (on) multiaiState.runningChats.add(chatId); else multiaiState.runningChats.delete(chatId);
    multiaiRenderChatList();
    if (chatId === multiaiState.currentChatId) multiaiApplyRunningUi();
}

function multiaiApplyRunningUi() {
    const chat = multiaiCurrentChat();
    const on = !!(chat && multiaiIsRunning(chat.id));
    multiaiState.running = on;
    const runBtn = document.getElementById('multiai-run-btn');
    const stopBtn = document.getElementById('multiai-stop-btn');
    const orchRunBtn = document.getElementById('multiai-orch-run-btn');
    const orchStopBtn = document.getElementById('multiai-orch-stop-btn');
    const sendBtn = document.getElementById('multiai-send-btn');
    if (runBtn) runBtn.style.display = on ? 'none' : 'inline-block';
    if (stopBtn) stopBtn.style.display = on ? 'inline-block' : 'none';
    if (orchRunBtn) orchRunBtn.style.display = on ? 'none' : 'inline-block';
    if (orchStopBtn) orchStopBtn.style.display = on ? 'inline-block' : 'none';
    // The main Send button doubles as Stop while a run is in flight, so
    // there's always one obvious control for "AIs are working" rather than
    // a disabled button with no way to interrupt from the input row.
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.textContent = on ? '■' : '➤';
        sendBtn.title = on ? 'Stop' : 'Send';
        sendBtn.onclick = on ? multiaiStop : multiaiSend;
        sendBtn.style.background = on ? 'rgba(239,68,68,0.15)' : '';
        sendBtn.style.borderColor = on ? 'rgba(239,68,68,0.4)' : '';
    }
}

function multiaiStop() {
    // Interrupts the run immediately: the main process races the in-flight
    // provider call against this stop signal and stops waiting on it the
    // moment it fires, rather than only checking between steps. The
    // underlying browser request can't be killed outright (no cancellable
    // request support in the provider layer), so it keeps running in the
    // background, but its eventual result is discarded.
    const chat = multiaiCurrentChat();
    if (chat) agentHub.multiaiStopRun({ chatId: chat.id });
    multiaiAppendSystemNote('Stopping…');
}

// ---- Classic mode actions --------------------------------------------

async function multiaiRunRound() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    const topicEl = document.getElementById('multiai-topic');
    const topic = topicEl.value.trim();
    if (!topic && !(chat.messages || []).length) {
        showToast('Enter a topic first.');
        return;
    }
    if (!multiaiEnsureAgents(chat).length) {
        showToast('Add at least one agent.');
        return;
    }
    const isFirstMessage = !(chat.messages || []).length;
    if (topic && !chat.topic) chat.topic = topic;   // the brief = first message; later sends are instructions
    multiaiReadClassicFields(chat);

    chat.cycle = (chat.cycle || 0) + 1;

    // Attachments and referenced messages ride along with the human message
    // (kept verbatim while it's in the context window, condensed after).
    const attachmentsBlock = multiaiConsumeAttachments(chat);
    const contextBlock = multiaiConsumeContextRefs(chat);
    const attachmentsText = (attachmentsBlock + contextBlock).trim();

    // Show what was actually sent, right away — inline in the feed and
    // ledger, the same as every participant's turn.
    if (topic || attachmentsText) {
        chat.messages = chat.messages || [];
        const userMsg = { id: multiaiGenMsgId(), who: 'You', text: topic || '(attachments only)', role: 'user', ts: Date.now(), cycle: chat.cycle, round: 0 };
        if (attachmentsText) userMsg.attachmentsText = attachmentsText;
        chat.messages.push(userMsg);
        multiaiAppendFeedItem(userMsg);
        multiaiRenderLedger(chat);
    }
    topicEl.value = '';

    if (isFirstMessage && topic) multiaiMaybeAutoTitle(chat, topic);

    multiaiPersist();
    multiaiRenderChatList();
    document.getElementById('multiai-chat-title').textContent = chat.title;
    multiaiRenderOptionsSummary(chat);
    multiaiApplyModeLock(chat);

    multiaiState.currentRound = null;
    multiaiState.totalRounds = chat.rounds;
    multiaiSetRunning(chat.id, true);
    try {
        // The main process reads participants/mode/brevity/personas/engines/
        // context settings from the store (persisted just above) and records
        // every produced message itself; `latestText` is only for @mentions.
        const result = await agentHub.multiaiRunRound({ chatId: chat.id, rounds: chat.rounds, latestText: topic });
        if (result && result.success === false && result.error) showToast(result.error);
    } catch (e) {
        showToast('Run failed: ' + (e.message || e));
    } finally {
        multiaiSetRunning(chat.id, false);
    }
}

// Reads every Classic option control into the chat (persisted by callers).
function multiaiReadClassicFields(chat) {
    chat.discussMode = document.getElementById('multiai-discuss-mode').value;
    chat.rounds = parseInt(document.getElementById('multiai-rounds').value, 10) || 1;
    chat.brevity = document.getElementById('multiai-brevity').value;
    const cm = document.getElementById('multiai-context-mode');
    if (cm) {
        const prev = chat.contextMode || 'bounded';
        chat.contextMode = ['bounded', 'full', 'delta'].includes(cm.value) ? cm.value : 'bounded';
        // Delta leans on a rolling summary; give it a sensible default the first time it's picked.
        if (chat.contextMode === 'delta' && prev !== 'delta' && !(parseInt(chat.autoSummaryEvery, 10) > 0)) {
            chat.autoSummaryEvery = 12;
            const ase = document.getElementById('multiai-auto-summary');
            if (ase) ase.value = 12;
        }
    }
    const ase = document.getElementById('multiai-auto-summary');
    if (ase) chat.autoSummaryEvery = Math.max(0, parseInt(ase.value, 10) || 0);
    const cw = document.getElementById('multiai-context-window');
    if (cw) chat.contextWindow = Math.max(0, parseInt(cw.value, 10) || 0);
    const st = document.getElementById('multiai-stop-token');
    if (st) chat.stopToken = (st.value || 'DONE').trim().split(/\s+/)[0] || 'DONE';
    const sa = document.getElementById('multiai-stop-when-agree');
    if (sa) chat.stopWhenAllAgree = !!sa.checked;
    const ind = document.getElementById('multiai-independent-first');
    if (ind) chat.independentFirstRound = !!ind.checked;
    const ch = document.getElementById('multiai-charter-mode');
    if (ch) chat.charterMode = !!ch.checked;
    const js = document.getElementById('multiai-judge-scope');
    if (js) chat.judgeScope = js.value;
    const jp = document.getElementById('multiai-judge-provider');
    if (jp && jp.value) chat.judgeProvider = jp.value;
}

async function multiaiJudge() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    const judgeProvider = document.getElementById('multiai-judge-provider').value;
    if (!judgeProvider) {
        showToast('No provider available to judge.');
        return;
    }
    if (multiaiIsRunning(chat.id)) { showToast('Wait for the current run to finish.'); return; }
    const scopeEl = document.getElementById('multiai-judge-scope');
    const scope = scopeEl ? scopeEl.value : 'all';
    chat.judgeProvider = judgeProvider;
    chat.judgeScope = scope;
    multiaiPersist();

    // Scope is resolved by the main process against (cycle, round) — "last
    // round" used to match by round number alone, which picked messages from
    // an earlier Send because rounds restart at 1 every cycle.
    multiaiSetRunning(chat.id, true);
    try {
        const result = await agentHub.multiaiJudge({ chatId: chat.id, judgeProvider, scope });
        if (result && result.success === false && result.error) showToast('Judge failed: ' + result.error);
    } finally {
        multiaiSetRunning(chat.id, false);
    }
}

// Pinned state summary: asks the judge provider for DECISIONS / OPEN
// QUESTIONS / CLAIMS TO VERIFY / NEXT STEP, stores it as a 'summary' message,
// and from then on every participant's prompt starts from it instead of the
// older transcript — the answer to "what is the state of the discussion".
async function multiaiSummarize() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    if (!(chat.messages || []).some(m => m.role === 'assistant')) { showToast('Nothing to summarize yet.'); return; }
    if (multiaiIsRunning(chat.id)) { showToast('Wait for the current run to finish.'); return; }
    const provider = document.getElementById('multiai-judge-provider')?.value;
    if (!provider) { showToast('No provider available to summarize.'); return; }
    multiaiSetRunning(chat.id, true);
    try {
        const result = await agentHub.multiaiSummarize({ chatId: chat.id, provider });
        if (result && result.success === false && result.error) showToast('Summary failed: ' + result.error);
    } finally {
        multiaiSetRunning(chat.id, false);
    }
}

function multiaiOpenPersonasFolder() {
    agentHub.multiaiOpenPersonasFolder();
}

// ---- Attachments --------------------------------------------------------
// Files are read client-side with FileReader (no IPC needed to look at a
// file the user picked). Text-like files get folded into the outgoing
// prompt verbatim (truncated if huge); anything else is attached for the
// user's own reference only, since the providers here are text-only.

const MULTIAI_TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log', '.yml', '.yaml', '.js', '.ts', '.py', '.html', '.css', '.xml'];

function multiaiIsTextFile(file) {
    if (file.type && file.type.startsWith('text/')) return true;
    if (file.type === 'application/json') return true;
    const name = (file.name || '').toLowerCase();
    return MULTIAI_TEXT_EXTENSIONS.some(ext => name.endsWith(ext));
}

function multiaiHandleFiles(fileList) {
    const files = Array.from(fileList || []);
    files.forEach(file => {
        const isImage = file.type && file.type.startsWith('image/');
        const isText = multiaiIsTextFile(file);
        const reader = new FileReader();
        reader.onload = () => {
            const entry = { name: file.name, isImage, isText };
            if (isText) entry.text = String(reader.result || '');
            if (isImage) entry.dataUrl = String(reader.result || '');
            multiaiState.pendingAttachments.push(entry);
            multiaiRenderAttachmentsPreview();
        };
        if (isImage) reader.readAsDataURL(file);
        else if (isText) reader.readAsText(file);
        else {
            // Unknown binary type: attach as a name-only reference.
            multiaiState.pendingAttachments.push({ name: file.name, isImage: false, isText: false });
            multiaiRenderAttachmentsPreview();
        }
    });
    // Allow re-selecting the same file again later.
    const input = document.getElementById('multiai-file-input');
    if (input) input.value = '';
}

function multiaiRenderAttachmentsPreview() {
    const box = document.getElementById('multiai-attachments-preview');
    if (!box) return;
    const items = multiaiState.pendingAttachments;
    if (!items.length) {
        box.style.display = 'none';
        box.innerHTML = '';
        return;
    }
    box.style.display = 'flex';
    box.innerHTML = items.map((a, i) => `
        <div style="display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 14px; padding: 4px 10px; font-size: 0.76rem; color: #d1d5db;">
            ${a.isImage ? '🖼' : a.isText ? '📄' : '📎'} ${multiaiEscape(a.name)}
            <button onclick="multiaiRemoveAttachment(${i})" title="Remove ${multiaiEscape(a.name)}" style="background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 0.85rem; padding: 0;">✕</button>
        </div>
    `).join('');
}

function multiaiRemoveAttachment(index) {
    multiaiState.pendingAttachments.splice(index, 1);
    multiaiRenderAttachmentsPreview();
}

// Builds the text block to fold into the outgoing prompt for this send, adds
// a short system note to the feed so attachments are visible in the
// transcript/ledger, and clears the pending queue. Returns '' when there's
// nothing attached.
function multiaiConsumeAttachments(chat) {
    const items = multiaiState.pendingAttachments;
    if (!items.length) return '';

    const parts = [];
    const names = [];
    items.forEach(a => {
        names.push(a.name);
        if (a.isText) {
            let text = a.text || '';
            if (text.length > MULTIAI_ATTACHMENT_MAX_CHARS) {
                text = text.slice(0, MULTIAI_ATTACHMENT_MAX_CHARS) + '\n…(truncated)';
            }
            parts.push(`--- ${a.name} ---\n${text}`);
        } else if (a.isImage) {
            parts.push(`--- ${a.name} ---\n[image attached — not sent to these text-only providers]`);
        } else {
            parts.push(`--- ${a.name} ---\n[file attached — content not sent, name only]`);
        }
    });

    multiaiAppendSystemNote(`📎 Attached: ${names.join(', ')}`);
    multiaiState.pendingAttachments = [];
    multiaiRenderAttachmentsPreview();

    return `\n\n[Attached files]\n${parts.join('\n\n')}`;
}

// ---- Export ---------------------------------------------------------------

async function multiaiExportMd() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    const lines = [`# ${chat.title || 'Multi-AI Chat'}`, '', `Mode: ${chat.mode}`, `Created: ${new Date(chat.createdAt || Date.now()).toLocaleString()}`,
        `Participants: ${(chat.participants || []).map(multiaiProviderLabel).join(', ') || '—'}`, ''];
    (chat.messages || []).forEach(m => {
        const time = m.ts ? new Date(m.ts).toLocaleString() : '';
        if (m.role === 'system') { lines.push(`> _${m.text || ''}_`, ''); return; }
        const heading = `${m.who || m.provider || 'Message'}  ·  ${multiaiRefLabel(m)}${time ? '  ·  ' + time : ''}`;
        lines.push(`## ${heading}`, '', m.text || '', '');
        if (m.attachmentsText) lines.push('<details><summary>Attached context</summary>', '', m.attachmentsText, '', '</details>', '');
    });
    const markdown = lines.join('\n');
    const result = await agentHub.multiaiExport({ title: chat.title, markdown });
    if (result && result.success) {
        showToast(`Exported to ${result.filePath}`);
    } else if (result && !result.canceled) {
        showToast('Export failed: ' + (result.error || 'unknown error'));
    }
}

// ---- Orchestrated mode actions -----------------------------------------

function multiaiOptionsWithSelected(options, value) {
    if (!value) return options;
    return options.replace(`value="${value}"`, `value="${value}" selected`);
}

function multiaiRenderStrategyForm() {
    const chat = multiaiCurrentChat();
    const strategySel = document.getElementById('multiai-strategy');
    const form = document.getElementById('multiai-strategy-form');
    if (!strategySel || !form) return;
    const strategy = strategySel.value || 'crew';
    if (chat) { chat.strategy = strategy; multiaiPersist(); }

    const providers = multiaiState.enabledProviders.length
        ? multiaiState.enabledProviders
        : ['chatgpt', 'claude', 'gemini', 'perplexity'];
    const providerOptions = providers.map(p => `<option value="${p}">${multiaiProviderLabel(p)}</option>`).join('');

    if (strategy === 'crew') {
        if (chat && !chat.crewAgents) {
            chat.crewAgents = [
                { role: 'Researcher', provider: 'perplexity', instruction: 'Research the topic thoroughly with facts and citations.' },
                { role: 'Writer', provider: 'claude', instruction: 'Write a detailed, well-structured response based on research.' },
                { role: 'Reviewer', provider: 'chatgpt', instruction: 'Review, improve and polish the output.' },
            ];
        }
        multiaiRenderCrewEditor(chat, form, providerOptions);
    } else if (strategy === 'workflow') {
        const savedText = chat?.workflowStepsText || '';
        form.innerHTML = `
            <div style="font-size: 0.78rem; color: #9ca3af; margin-bottom: 8px;">
                Enter one step per line as <code>provider: task</code> (provider optional). Saved with this chat.
            </div>
            <textarea id="multiai-workflow-steps" rows="4" placeholder="claude: outline the plan&#10;chatgpt: write the draft&#10;: polish and proofread"
                oninput="multiaiPersistWorkflowSteps(this.value)"
                style="width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px; font-family: inherit; font-size: 0.82rem;">${multiaiEscape(savedText)}</textarea>
        `;
    } else if (strategy === 'loop') {
        const loopConfig = chat?.loopConfig || {};
        form.innerHTML = `
            <div style="display: flex; gap: 14px; flex-wrap: wrap; align-items: center;">
                <label style="font-size: 0.8rem; color: #9ca3af;">Generator
                    <select id="multiai-loop-provider" onchange="multiaiPersistLoopConfig()" style="margin-left: 6px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px;">${multiaiOptionsWithSelected(providerOptions, loopConfig.provider)}</select>
                </label>
                <label style="font-size: 0.8rem; color: #9ca3af;">Reviewer
                    <select id="multiai-loop-review-provider" onchange="multiaiPersistLoopConfig()" style="margin-left: 6px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px;">${multiaiOptionsWithSelected(providerOptions, loopConfig.reviewProvider)}</select>
                </label>
                <label style="font-size: 0.8rem; color: #9ca3af;">Max turns
                    <input id="multiai-loop-max-turns" type="number" min="1" max="10" value="${loopConfig.maxTurns || 3}" onchange="multiaiPersistLoopConfig()" style="width: 50px; margin-left: 6px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px;">
                </label>
            </div>
            <div style="font-size: 0.74rem; color: #6b7280; margin-top: 8px;">Saved with this chat.</div>
        `;
    } else if (strategy === 'agent') {
        if (chat && !chat.agentConfig) chat.agentConfig = { provider: '', root: '', maxTurns: 6 };
        const cfg = chat?.agentConfig || { provider: '', root: '', maxTurns: 6 };
        form.innerHTML = `
            <div style="font-size: 0.76rem; color: #f59e0b; margin-bottom: 10px; background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.3); border-radius: 8px; padding: 8px 10px;">
                ⚠ Full read/write, no confirmation. The agent can create, overwrite, and delete files inside the folder below — point it at a dedicated folder, not anything you care about. It cannot reach anything outside that folder.
            </div>
            <div style="display: flex; gap: 14px; flex-wrap: wrap; align-items: center; margin-bottom: 8px;">
                <label style="font-size: 0.8rem; color: #9ca3af;">Provider
                    <select id="multiai-agent-provider" onchange="multiaiPersistAgentConfig()" style="margin-left: 6px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px;">${multiaiOptionsWithSelected(providerOptions, cfg.provider)}</select>
                </label>
                <label style="font-size: 0.8rem; color: #9ca3af;">Max turns
                    <input id="multiai-agent-max-turns" type="number" min="1" max="15" value="${cfg.maxTurns || 6}" onchange="multiaiPersistAgentConfig()" style="width: 50px; margin-left: 6px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px;">
                </label>
                <button class="header-btn" onclick="multiaiPickAgentFolder()">📁 Choose working folder…</button>
            </div>
            <div style="font-size: 0.78rem; color: ${cfg.root ? '#93c5fd' : '#6b7280'};">${cfg.root ? multiaiEscape(cfg.root) : 'No folder chosen yet — required before Run.'}</div>
        `;
    }
    if (chat) multiaiRenderOptionsSummary(chat);
}

function multiaiPersistAgentConfig() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    chat.agentConfig = chat.agentConfig || { provider: '', root: '', maxTurns: 6 };
    chat.agentConfig.provider = document.getElementById('multiai-agent-provider')?.value || '';
    chat.agentConfig.maxTurns = parseInt(document.getElementById('multiai-agent-max-turns')?.value, 10) || 6;
    multiaiPersist();
}

async function multiaiPickAgentFolder() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    const result = await agentHub.multiaiPickToolsFolder();
    if (result && result.success) {
        chat.agentConfig = chat.agentConfig || { provider: '', root: '', maxTurns: 6 };
        chat.agentConfig.root = result.path;
        multiaiPersist();
        multiaiRenderStrategyForm();
    }
}

function multiaiPersistWorkflowSteps(value) {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    chat.workflowStepsText = value;
    multiaiPersistSoon();
}

function multiaiPersistLoopConfig() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    chat.loopConfig = {
        provider: document.getElementById('multiai-loop-provider')?.value || '',
        reviewProvider: document.getElementById('multiai-loop-review-provider')?.value || '',
        maxTurns: parseInt(document.getElementById('multiai-loop-max-turns')?.value, 10) || 3,
    };
    multiaiPersist();
}

// Editable crew roster: role name, provider, instruction per row, laid out
// as a responsive card grid (wraps as the main content area is wider than
// the old sidebar). Lets you change who plays what role instead of being
// stuck with the hardcoded Researcher/Writer/Reviewer default.
function multiaiRenderCrewEditor(chat, form, providerOptions) {
    const agents = chat.crewAgents || [];
    const personaOptions = Object.keys(multiaiAllPersonas())
        .map(name => `<option value="${multiaiEscapeAttr(name)}">${multiaiEscape(name)}</option>`).join('');
    const rows = agents.map((a, i) => `
        <div style="flex: 1 1 260px; min-width: 240px; max-width: 360px; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 8px;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
                <input value="${multiaiEscape(a.role)}" placeholder="Role" oninput="multiaiCrewUpdateField(${i}, 'role', this.value)"
                    style="flex: 1; box-sizing: border-box; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px; font-size: 0.78rem;">
                <button onclick="multiaiCrewRemoveRole(${i})" title="Remove role"
                    style="background: none; border: none; color: #f87171; cursor: pointer; font-size: 0.9rem; flex-shrink: 0;">✕</button>
            </div>
            <select onchange="multiaiCrewUpdateField(${i}, 'provider', this.value)"
                style="width: 100%; box-sizing: border-box; margin-bottom: 6px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px; font-size: 0.78rem;">
                ${multiaiOptionsWithSelected(providerOptions, a.provider)}
            </select>
            <input value="${multiaiEscape(a.instruction)}" placeholder="Instruction" oninput="multiaiCrewUpdateField(${i}, 'instruction', this.value)"
                style="width: 100%; box-sizing: border-box; margin-bottom: 6px; background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px; font-size: 0.78rem;">
            <select onchange="multiaiCrewApplyPersona(${i}, this.value); this.selectedIndex = 0;"
                title="Fill Instruction from the shared persona library — same personas as Classic mode's assignment"
                style="width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.06); color: #9ca3af; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; padding: 4px 8px; font-size: 0.72rem;">
                <option value="">🎭 Apply a persona to Instruction…</option>
                ${personaOptions}
            </select>
        </div>
    `).join('');
    form.innerHTML = `
        <div style="font-size: 0.76rem; color: #9ca3af; margin-bottom: 8px;">
            Each role runs in order, passing its output to the next.
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px;">
            ${rows}
        </div>
        <button class="header-btn" onclick="multiaiCrewAddRole()">+ Add role</button>
    `;
}

function multiaiCrewApplyPersona(index, personaName) {
    const chat = multiaiCurrentChat();
    if (!chat || !chat.crewAgents || !chat.crewAgents[index] || !personaName) return;
    const text = multiaiAllPersonas()[personaName];
    if (text) {
        chat.crewAgents[index].instruction = text;
        multiaiPersist();
        multiaiRenderStrategyForm();
    }
}

function multiaiCrewUpdateField(index, field, value) {
    const chat = multiaiCurrentChat();
    if (!chat || !chat.crewAgents || !chat.crewAgents[index]) return;
    chat.crewAgents[index][field] = value;
    multiaiPersistSoon();
}

function multiaiCrewAddRole() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    chat.crewAgents = chat.crewAgents || [];
    const fallback = multiaiState.enabledProviders[0] || 'chatgpt';
    chat.crewAgents.push({ role: 'New role', provider: fallback, instruction: '' });
    multiaiPersist();
    multiaiRenderStrategyForm();
}

function multiaiCrewRemoveRole(index) {
    const chat = multiaiCurrentChat();
    if (!chat || !chat.crewAgents) return;
    chat.crewAgents.splice(index, 1);
    multiaiPersist();
    multiaiRenderStrategyForm();
}

async function multiaiRunOrchestrated() {
    const chat = multiaiCurrentChat();
    if (!chat) return;
    const topicEl = document.getElementById('multiai-topic');
    const task = topicEl.value.trim();
    if (!task) {
        showToast('Describe the task first.');
        return;
    }
    if (multiaiIsRunning(chat.id)) { showToast('A run is already in progress for this chat.'); return; }
    const isFirstMessage = !(chat.messages || []).length;
    if (!chat.topic) chat.topic = task;
    const strategy = document.getElementById('multiai-strategy').value;
    chat.strategy = strategy;

    chat.cycle = (chat.cycle || 0) + 1;

    const attachmentsBlock = multiaiConsumeAttachments(chat);
    const contextBlock = multiaiConsumeContextRefs(chat);
    const attachmentsText = (attachmentsBlock + contextBlock).trim();
    chat.messages = chat.messages || [];
    const userMsg = { id: multiaiGenMsgId(), who: 'You', text: task, role: 'user', ts: Date.now(), cycle: chat.cycle, round: 0 };
    if (attachmentsText) userMsg.attachmentsText = attachmentsText;
    chat.messages.push(userMsg);
    multiaiAppendFeedItem(userMsg);
    multiaiRenderLedger(chat);
    topicEl.value = '';

    if (isFirstMessage) multiaiMaybeAutoTitle(chat, task);

    multiaiPersist();
    multiaiRenderChatList();
    document.getElementById('multiai-chat-title').textContent = chat.title;
    multiaiApplyModeLock(chat);

    const effectiveTask = task + attachmentsBlock + contextBlock;
    const opts = { chatId: chat.id, strategy };

    if (strategy === 'crew') {
        opts.task = effectiveTask;
        if (chat.crewAgents && chat.crewAgents.length) opts.agents = chat.crewAgents;
    } else if (strategy === 'workflow') {
        const raw = (document.getElementById('multiai-workflow-steps')?.value || '').trim();
        chat.workflowStepsText = document.getElementById('multiai-workflow-steps')?.value || '';
        multiaiPersist();
        // "provider: task" only when the prefix is a real provider name —
        // "Summarize: the key points" is a task for the default provider.
        const steps = raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
            const m = line.match(/^([a-z][\w-]*(?::[\w.-]+)?)\s*:\s*(.+)$/i);
            if (m && MULTIAI_KNOWN_PROVIDERS.includes(m[1].toLowerCase().split(':')[0])) return { provider: m[1].toLowerCase(), task: m[2].trim() };
            return { task: line };
        });
        if (!steps.length) { showToast('Add at least one workflow step.'); return; }
        opts.input = effectiveTask;
        opts.steps = steps;
    } else if (strategy === 'loop') {
        multiaiPersistLoopConfig();
        opts.task = effectiveTask;
        opts.provider = document.getElementById('multiai-loop-provider')?.value;
        opts.reviewProvider = document.getElementById('multiai-loop-review-provider')?.value;
        opts.maxTurns = parseInt(document.getElementById('multiai-loop-max-turns')?.value, 10) || 3;
    } else if (strategy === 'agent') {
        multiaiPersistAgentConfig();
        const cfg = chat.agentConfig || {};
        if (!cfg.root) { showToast('Choose a working folder first.'); return; }
        if (!cfg.provider) { showToast('Choose a provider first.'); return; }
        opts.task = effectiveTask;
        opts.provider = cfg.provider;
        opts.root = cfg.root;
        opts.maxTurns = cfg.maxTurns || 6;
    }

    multiaiAppendSystemNote(`Running ${strategy}…`);
    multiaiSetRunning(chat.id, true);
    let result;
    try {
        result = await agentHub.multiaiRunOrchestrated(opts);
    } catch (e) {
        result = { success: false, error: e.message || String(e) };
    } finally {
        multiaiSetRunning(chat.id, false);
    }

    if (!result || result.success === false) {
        multiaiAppendFeedItem({ id: multiaiGenMsgId(), who: 'Orchestration error', text: (result && result.error) || 'Unknown error', role: 'error', cycle: chat.cycle, round: 0 });
    }
    // Every step's output/error is recorded by the main process and arrives
    // through onMultiaiMessage (for whichever chat it belongs to), so a run
    // in a background chat is no longer lost when you switch away.
}

// Orchestrated progress: only the transient "running…" notes are rendered
// here; the step results themselves are persisted messages from main.
function multiaiRenderOrchStep(step) {
    if (step.status !== 'running') return;
    const label = step.label || (step.role
        ? `${step.role}${step.provider ? ' · ' + multiaiProviderLabel(step.provider) : ''}`
        : step.step
            ? `Step ${step.step}${step.provider ? ' · ' + multiaiProviderLabel(step.provider) : ''}`
            : step.turn
                ? `Turn ${step.turn}${step.phase ? ' · ' + step.phase : ''}`
                : 'Step');
    multiaiAppendSystemNote(`${label} — running…`);
}

// ---- Help modal -----------------------------------------------------------

function multiaiOpenHelp() {
    const modal = document.getElementById('multiai-help-modal');
    if (modal) modal.style.display = 'flex';
}

function multiaiCloseHelp() {
    const modal = document.getElementById('multiai-help-modal');
    if (modal) modal.style.display = 'none';
}

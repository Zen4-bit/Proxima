// Proxima — Multi-AI Chat core (no Electron dependency).
// Everything here is pure logic so it can be unit-tested with plain node:
//   - createStore(): the chats.json store with atomic writes, a rolling
//     backup, corruption recovery and upsert-merge semantics (the renderer
//     saves whole snapshots; the main process appends single messages; both
//     must never clobber each other).
//   - buildClassicPrompt() / buildContext(): the bounded-context prompt each
//     participant receives. Old transcripts are condensed, recent ones are
//     verbatim, and a pinned "state summary" replaces everything before it,
//     so a long chat no longer re-sends its entire history every turn.
//   - Small helpers: stances for debates, @mention parsing for directed
//     turns, stop-token / PASS detection, local titles, tool-call parsing.

const DEFAULTS = Object.freeze({
    contextWindow: 10,          // recent messages sent verbatim
    digestCharsPerMessage: 400, // older assistant messages are condensed to this
    digestUserChars: 1500,      // the human's own messages are kept longer (they're instructions)
    digestMaxChars: 30000,      // total budget for the condensed block
    stopToken: 'DONE',
    providerResetEvery: 12,     // start a fresh provider-side thread after this many turns (bounded/full)
    providerResetEveryDelta: 40, // delta mode leans on the provider thread's memory, so rotate far less often
    contextMode: 'bounded',     // 'bounded' | 'full' | 'delta'
    independentRounds: 'all',   // 'off' | 'first' | 'all' — which rounds run blind (see independentMode)
    autoSummaryEvery: 0,        // in delta mode: refresh the rolling summary after this many new messages (0 = manual)
});

// What each participant is sent every turn:
//   bounded — pinned summary + condensed digest of older messages + last N verbatim (self-sufficient, bounded size)
//   full    — the entire readable transcript every turn (self-sufficient; grows without limit — the old PCA behaviour)
//   delta   — only the messages since this provider's last turn, relying on the provider-side thread to remember the
//             rest; a rolling summary rides in the Topic block, and the first turn on a fresh thread sends a full catch-up
const CONTEXT_MODES = ['bounded', 'full', 'delta'];

// Which rounds run blind — every participant answering at once, none of them
// shown what the others are saying in that same round:
//
//   off   — strict turn-taking: each seat sees everyone who spoke before it
//   first — round 1 only, then turn-taking
//   all   — every round (the default): each round sees every completed round
//           and nothing of its own
//
// Turn-taking makes a round asymmetric — the first seat answers the human, the
// last answers five peers — and the usual result is that later seats converge
// on whoever spoke first. Blind rounds remove the anchor and let a round be
// compared like for like; the discussion still happens, one round later.
//
// Charter mode is the cost: a HANDOFF can no longer pull a seat forward inside
// a round, so it applies to the next one instead.
const INDEPENDENT_MODES = ['off', 'first', 'all'];

function independentMode(chat) {
    const v = chat && chat.independentRounds;
    if (INDEPENDENT_MODES.includes(v)) return v;
    // Before this setting existed the only choice was a blind first round, off
    // by default. A chat that asked for that keeps exactly it; everything else
    // takes the new default.
    return chat && chat.independentFirstRound ? 'first' : DEFAULTS.independentRounds;
}

// Roles a participant produces during a round. A blind round hides all three:
// hiding only 'assistant' still leaked a peer's PASS and its workspace diff.
const ROUND_OUTPUT_ROLES = new Set(['assistant', 'pass', 'change']);

// ---- Agents ------------------------------------------------------------
// A participant is an *agent*: a name plus how to reach it. Several agents
// may share a provider (e.g. "Opus · high" and "Sonnet · low" both through
// Claude Code), so everything downstream is keyed by agent id, not provider.
//   route:   'auto'    → API mode when the app's Settings have it on with a key
//                         for this provider, otherwise the browser tab
//            'browser' → Proxima's provider tab (session login)
//            'api'     → the provider's API with the key from Settings
//            'cli'     → a local CLI on your subscription: claude-cli / codex-cli
//   provider: chatgpt | claude | gemini | perplexity (browser/api) or
//             claude-cli | codex-cli (cli)
//   model:    api/cli model id (or the Gemini engine string for the browser route)
//   effort:   '' | minimal | low | medium | high | xhigh | max (api/cli only)
const ROUTES = ['auto', 'browser', 'api', 'cli'];
const CLI_PROVIDERS = { 'claude-cli': { label: 'Claude Code', bin: 'claude' }, 'codex-cli': { label: 'Codex', bin: 'codex' }, 'gemini-cli': { label: 'Gemini CLI', bin: 'gemini' }, 'antigravity-cli': { label: 'Antigravity', bin: 'agy' } };
const EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// Workspace tools a CLI seat may use inside the chat's workspace folder.
const TOOLS = ['none', 'read', 'write', 'full'];

function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Two-letter code for labels: known providers keep their codes; anything else
// takes initials of the name ("Opus · high" → OH, "Sonnet low" → SL).
function agentCode(agent) {
    const name = String(agent.name || '');
    const base = String(agent.provider || '').split(':')[0];
    const label = PROVIDER_LABELS[base];
    // "ChatGPT", "ChatGPT · high", "Codex · gpt-5.5 · medium" → the provider's code
    if (name && label && (name === label || name.startsWith(label + ' ') || name.startsWith(label + '·'))) return PROVIDER_CODES[base];
    const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    if (words.length === 1 && words[0].length >= 2) return words[0].slice(0, 2).toUpperCase();
    return providerCode(base);
}

function defaultAgentName(provider, model, effort) {
    const base = String(provider || '').split(':')[0];
    const label = CLI_PROVIDERS[base] ? CLI_PROVIDERS[base].label : (PROVIDER_LABELS[base] || base);
    const parts = [];
    if (model && !(base === 'gemini' && model === 'gemini')) parts.push(String(model).replace(/^gemini:/, ''));
    if (effort) parts.push(effort);
    return parts.length ? `${label} · ${parts.join(' · ')}` : label;
}

// Accepts the legacy participants list (provider strings) or an agents list;
// returns normalized agents. Ids are stable slugs so personas/sessions can
// key on them across saves. Agents switched off in the roster
// (`enabled: false`) are left out unless `includeDisabled` is set: they take
// no turns, get no mentions and aren't listed to the others.
function normalizeAgents(chat, { includeDisabled = false } = {}) {
    const src = Array.isArray(chat.agents) && chat.agents.length ? chat.agents : (chat.participants || []);
    const out = [];
    const seen = new Set();
    for (const raw of src) {
        let a;
        if (typeof raw === 'string') {
            const base = raw.split(':')[0];
            const engine = raw.includes(':') ? raw : ((chat.engines && chat.engines[base]) || '');
            a = { id: base, name: PROVIDER_LABELS[base] || base, route: 'auto', provider: base, model: engine && engine !== base ? engine : '', effort: '', enabled: true };
        } else if (raw && typeof raw === 'object') {
            if (raw.enabled === false && !includeDisabled) continue;
            const provider = String(raw.provider || 'chatgpt').split(':')[0];
            a = {
                id: raw.id || '', name: raw.name || '', route: ROUTES.includes(raw.route) ? raw.route : 'auto',
                provider, model: raw.model || '', effort: EFFORTS.includes(raw.effort) ? raw.effort : '',
                persona: raw.persona || '', personaKey: raw.personaKey || '', enabled: raw.enabled !== false,
                tools: CLI_PROVIDERS[provider] && TOOLS.includes(raw.tools) ? raw.tools : 'none',
            };
            if (CLI_PROVIDERS[provider]) a.route = 'cli';
            if (!a.name) a.name = defaultAgentName(provider, a.model, a.effort);
            if (!a.id) a.id = slugify(a.name) || provider;
        } else continue;
        let id = a.id; let n = 2;
        while (seen.has(id)) id = `${a.id}-${n++}`;
        a.id = id; seen.add(id);
        a.code = agentCode(a);
        out.push(a);
    }
    // Label codes must tell agents apart: a second "CG" becomes "CG2".
    const codes = new Set();
    for (const a of out) {
        let code = a.code; let n = 2;
        while (codes.has(code)) code = `${a.code}${n++}`;
        a.code = code; codes.add(code);
    }
    return out;
}

// Resolve a participant reference (agent id, name, provider) inside a list.
function findAgent(agents, ref) {
    if (!ref) return null;
    const r = String(ref).toLowerCase().replace(/\s+/g, '');
    return agents.find(a => a.id === ref) ||
        agents.find(a => a.id.toLowerCase() === r) ||
        agents.find(a => String(a.name).toLowerCase().replace(/\s+/g, '') === r) ||
        agents.find(a => String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, '') === r.replace(/[^a-z0-9]+/g, '')) ||
        // a bare provider name matches only when exactly one agent uses that provider
        (function () { const hits = agents.filter(a => a.provider === r || providerLabel(a.provider).toLowerCase().replace(/\s+/g, '') === r); return hits.length === 1 ? hits[0] : null; })() ||
        null;
}

function asAgents(list) {
    return (list || []).map(p => typeof p === 'string' ? { id: p.split(':')[0], name: providerLabel(p), provider: p.split(':')[0], code: providerCode(p) } : p);
}

const KNOWN_PROVIDERS = ['chatgpt', 'claude', 'gemini', 'perplexity'];

const PROVIDER_LABELS = {
    chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', perplexity: 'Perplexity',
    codex: 'Codex', 'claude-code': 'Claude Code', 'claude-cli': 'Claude Code', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini CLI', human: 'You',
};

const PROVIDER_CODES = {
    chatgpt: 'CG', claude: 'CL', gemini: 'GM', perplexity: 'PX',
    codex: 'CX', 'claude-code': 'CC', 'claude-cli': 'CC', 'codex-cli': 'CX', 'gemini-cli': 'GC', human: 'US', external: 'EX',
};

function providerLabel(p) {
    if (!p) return '';
    const base = String(p).split(':')[0];
    return PROVIDER_LABELS[base] || base;
}

function providerCode(p) {
    if (!p) return '--';
    const base = String(p).split(':')[0];
    return PROVIDER_CODES[base] || base.slice(0, 2).toUpperCase();
}

function genMsgId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function genChatId() {
    return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Human-readable reference label: cycle (one per Send) · round · agent code.
function refLabel(msg) {
    const c = msg.cycle || 1;
    const r = msg.round || 0;
    let code;
    if (msg.role === 'user') code = 'US';
    else if (msg.role === 'judge') code = 'JD';
    else if (msg.role === 'summary') code = 'SM';
    else if (msg.role === 'system') code = 'SY';
    else if (msg.role === 'error') code = 'ER';
    else if (msg.role === 'change') code = 'CH';
    else code = msg.code || providerCode(msg.provider);
    return `${String(c).padStart(2, '0')}${String(r).padStart(2, '0')}${code}`;
}

// ---- Store ------------------------------------------------------------

function emptyStore() {
    return { projects: [{ id: 'default', name: 'General', chats: [] }], uiPrefs: {} };
}

function normalizeStore(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) return emptyStore();
    if (!data.projects.length) data.projects.push({ id: 'default', name: 'General', chats: [] });
    for (const p of data.projects) {
        if (!Array.isArray(p.chats)) p.chats = [];
        for (const c of p.chats) {
            if (!Array.isArray(c.messages)) c.messages = [];
            for (const m of c.messages) if (!m.id) m.id = genMsgId();
        }
    }
    if (!data.uiPrefs || typeof data.uiPrefs !== 'object') data.uiPrefs = {};
    if (!Array.isArray(data.deletedChatIds)) data.deletedChatIds = [];
    return data;
}

function findChatIn(store, chatId) {
    for (const p of store.projects) {
        const c = p.chats.find(x => x.id === chatId);
        if (c) return { project: p, chat: c };
    }
    return null;
}

// Upsert merge: `incoming` is the renderer's snapshot; `disk` may contain
// chats/messages appended by the main process (REST, run loops) that the
// renderer hasn't seen yet. Result keeps everything from both. Deletions are
// never inferred from a snapshot — they go through deleteChat() explicitly.
function mergeStores(disk, incoming) {
    const out = normalizeStore(incoming ? JSON.parse(JSON.stringify(incoming)) : emptyStore());
    if (!disk) return out;
    // Tombstones: a chat deleted on disk must not come back from a snapshot
    // taken before the delete.
    const dead = new Set((disk.deletedChatIds || []).concat(out.deletedChatIds || []));
    out.deletedChatIds = Array.from(dead).slice(-500);
    for (const p of out.projects) p.chats = p.chats.filter(c => !dead.has(c.id));
    for (const dp of disk.projects || []) {
        let op = out.projects.find(p => p.id === dp.id);
        if (!op) { op = { id: dp.id, name: dp.name, chats: [] }; out.projects.push(op); }
        for (const dc of dp.chats || []) {
            if (dead.has(dc.id)) continue;
            const loc = findChatIn(out, dc.id);
            if (!loc) { op.chats.push(dc); continue; }
            const oc = loc.chat;
            const seen = new Set((oc.messages || []).map(m => m.id));
            const extras = (dc.messages || []).filter(m => m.id && !seen.has(m.id));
            if (extras.length) {
                oc.messages = (oc.messages || []).concat(extras).sort((a, b) => (a.ts || 0) - (b.ts || 0) || 0);
            }
            if ((dc.cycle || 0) > (oc.cycle || 0)) oc.cycle = dc.cycle;
            // Provider thread bookkeeping is written only by the main process;
            // the disk copy is authoritative over any snapshot the renderer holds.
            if (dc.providerSessions) oc.providerSessions = dc.providerSessions;
        }
    }
    if (disk.uiPrefs && !Object.keys(out.uiPrefs || {}).length) out.uiPrefs = disk.uiPrefs;
    return out;
}

function createStore({ dir, fs, path, log }) {
    const logger = log || (() => { });
    const file = () => path.join(dir, 'chats.json');
    const tmpFile = () => path.join(dir, 'chats.json.tmp');
    const backupFile = () => path.join(dir, 'chats.backup.json');

    function readJson(p) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }

    function load() {
        fs.mkdirSync(dir, { recursive: true });
        const f = file();
        if (!fs.existsSync(f)) {
            // A crash between the two renames in save() leaves only the backup.
            if (fs.existsSync(backupFile())) {
                try { return normalizeStore(readJson(backupFile())); } catch { /* fall through */ }
            }
            return emptyStore();
        }
        try {
            return normalizeStore(readJson(f));
        } catch (e) {
            // Never silently replace a corrupt store with an empty one: park it
            // under a dated name and fall back to the last good backup.
            const parked = path.join(dir, `chats.corrupt-${Date.now()}.json`);
            try { fs.renameSync(f, parked); } catch { /* ignore */ }
            logger(`[MultiAI] chats.json unreadable (${e.message}); parked as ${path.basename(parked)}`);
            if (fs.existsSync(backupFile())) {
                try {
                    const data = normalizeStore(readJson(backupFile()));
                    logger('[MultiAI] Restored chats from chats.backup.json');
                    return data;
                } catch (e2) {
                    logger(`[MultiAI] Backup also unreadable: ${e2.message}`);
                }
            }
            return emptyStore();
        }
    }

    // Atomic: write tmp → rotate current to backup → rename tmp into place.
    function save(data) {
        fs.mkdirSync(dir, { recursive: true });
        const json = JSON.stringify(data, null, 2);
        fs.writeFileSync(tmpFile(), json, 'utf-8');
        if (fs.existsSync(file())) {
            try { fs.renameSync(file(), backupFile()); } catch { /* keep going; tmp is still valid */ }
        }
        fs.renameSync(tmpFile(), file());
        return { success: true };
    }

    // Renderer snapshot save: merge with disk so nothing appended by main
    // since the renderer's last load is lost.
    function saveSnapshot(incoming) {
        const merged = mergeStores(load(), incoming);
        save(merged);
        return merged;
    }

    function getChat(chatId) {
        const loc = findChatIn(load(), chatId);
        return loc ? loc.chat : null;
    }

    function listChats() {
        const data = load();
        return data.projects.flatMap(p => p.chats.map(c => ({
            id: c.id, title: c.title, mode: c.mode, strategy: c.strategy,
            participants: c.participants || [], agents: normalizeAgents(c).map(a => a.name), createdAt: c.createdAt || null,
            updatedAt: (c.messages || []).reduce((mx, m) => Math.max(mx, m.ts || 0), 0) || c.createdAt || null,
            messageCount: (c.messages || []).length, cycle: c.cycle || 0,
        })));
    }

    function createChat(fields) {
        const data = load();
        const chat = Object.assign({
            id: genChatId(), title: 'New chat', mode: 'classic', topic: '', discussMode: 'discuss',
            rounds: 1, brevity: 'max 4 sentences', participants: [], personas: {}, judgeProvider: '',
            judgeScope: 'all', strategy: 'crew', messages: [], createdAt: Date.now(), cycle: 0,
        }, fields || {});
        chat.messages = chat.messages || [];
        data.projects[0].chats.push(chat);
        save(data);
        return chat;
    }

    // `patch` is an object to merge, or a function(chat) that mutates in
    // place — use the function form for nested fields so concurrent callers
    // touching different keys don't overwrite each other.
    function updateChat(chatId, patch) {
        const data = load();
        const loc = findChatIn(data, chatId);
        if (!loc) return null;
        if (typeof patch === 'function') patch(loc.chat);
        else Object.assign(loc.chat, patch || {});
        save(data);
        return loc.chat;
    }

    function appendMessage(chatId, message) {
        const data = load();
        const loc = findChatIn(data, chatId);
        if (!loc) return null;
        const chat = loc.chat;
        const msg = Object.assign({}, message);
        if (!msg.id) msg.id = genMsgId();
        if (!msg.ts) msg.ts = Date.now();
        if (!msg.cycle) msg.cycle = chat.cycle || 1;
        if (msg.round == null) msg.round = 0;
        if ((chat.messages || []).some(m => m.id === msg.id)) return msg;
        chat.messages.push(msg);
        save(data);
        return msg;
    }

    function deleteChat(chatId) {
        const data = load();
        for (const p of data.projects) {
            const i = p.chats.findIndex(c => c.id === chatId);
            if (i !== -1) {
                p.chats.splice(i, 1);
                data.deletedChatIds = (data.deletedChatIds || []).filter(id => id !== chatId).concat([chatId]).slice(-500);
                save(data);
                return true;
            }
        }
        return false;
    }

    return { load, save, saveSnapshot, getChat, listChats, createChat, updateChat, appendMessage, deleteChat, file, backupFile };
}

// ---- Transcript / prompt building --------------------------------------

// Roles that other participants should actually read. Errors, stop notices,
// system notes and PASSes are UI bookkeeping, not conversation.
// 'change' = the diff a workspace seat produced in its turn (shown to the
// others, never counted as a reply for convergence).
const READABLE_ROLES = new Set(['user', 'assistant', 'judge', 'summary', 'change']);

function readable(messages) {
    return (messages || []).filter(m => READABLE_ROLES.has(m.role || 'assistant') && (m.text || '').trim());
}

function whoOf(m) {
    if (m.role === 'user') return m.who || 'You';
    if (m.role === 'judge') return m.who || 'Judge';
    if (m.role === 'change') return m.who || 'changes';
    if (m.role === 'summary') return 'State summary';
    return m.who || providerLabel(m.provider) || 'Participant';
}

function condense(text, max) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
}

// Splits a chat's readable messages into: the latest pinned summary (if any),
// a condensed digest of what came after it but before the window, and the
// recent window verbatim. Everything before the summary is dropped — the
// summary is the compaction point.
function buildContext(messages, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const all = readable(messages);
    let summaryMsg = null;
    for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role === 'summary') { summaryMsg = all[i]; break; }
    }
    const afterSummary = summaryMsg ? all.slice(all.indexOf(summaryMsg) + 1) : all;
    const window = Math.max(0, o.contextWindow | 0);
    const recent = window ? afterSummary.slice(-window) : [];
    const older = window ? afterSummary.slice(0, Math.max(0, afterSummary.length - window)) : afterSummary;

    // Digest oldest-first but trim from the oldest end when over budget,
    // always keeping the first human message (usually the brief).
    const lines = older.map(m => {
        const cap = m.role === 'user' ? o.digestUserChars : o.digestCharsPerMessage;
        return `[${refLabel(m)}] ${whoOf(m)}: ${condense(m.text, cap)}`;
    });
    let total = lines.reduce((n, l) => n + l.length + 1, 0);
    let dropped = 0;
    // Pin the opening human message when it leads the digest; drop the
    // oldest unpinned line until the block fits its budget.
    const pinned = (older.length && older[0].role === 'user') ? 1 : 0;
    while (total > o.digestMaxChars && lines.length > pinned) {
        total -= lines[pinned].length + 1;
        lines.splice(pinned, 1);
        dropped++;
    }

    const parts = [];
    if (summaryMsg) parts.push(`State summary (as of ${refLabel(summaryMsg)}):\n${summaryMsg.text.trim()}`);
    if (lines.length) {
        parts.push(`Earlier discussion (condensed${dropped ? `, ${dropped} older message${dropped === 1 ? '' : 's'} omitted` : ''}):\n${lines.join('\n')}`);
    }
    if (recent.length) {
        // Attachments / referenced context ride along with the human message
        // that carried them, verbatim while in the window, dropped once condensed.
        parts.push(`Recent messages (verbatim):\n${recent.map(m => `[${refLabel(m)}] ${whoOf(m)}: ${m.text.trim()}${m.attachmentsText ? '\n' + m.attachmentsText.trim() : ''}`).join('\n\n')}`);
    }
    return {
        text: parts.join('\n\n') || '(no messages yet)',
        summary: summaryMsg, digestCount: lines.length, recentCount: recent.length, dropped,
    };
}

// 'full' mode: everything readable, verbatim. Same shape as buildContext()
// so callers can treat them alike.
function buildFullContext(messages) {
    const all = readable(messages);
    return {
        text: all.length ? `Conversation so far (complete):\n${all.map(m => `[${refLabel(m)}] ${whoOf(m)}: ${m.text.trim()}${m.attachmentsText ? '\n' + m.attachmentsText.trim() : ''}`).join('\n\n')}` : '(no messages yet)',
        summary: null, digestCount: 0, recentCount: all.length, dropped: 0,
    };
}

// 'delta' mode: only what this provider hasn't seen. `sinceId` is the id of
// the last message that was in a prompt to this provider; its own replies are
// skipped (they're already in its thread as its answers). Returns catchUp=true
// when there's no usable anchor, in which case the caller sends the bounded
// context instead so a fresh provider thread starts with the whole picture.
function buildDeltaContext(messages, { sinceId, provider, agentId, contextOpts }) {
    const all = readable(messages);
    const idx = sinceId ? all.findIndex(m => m.id === sinceId) : -1;
    if (idx === -1) {
        const ctx = buildContext(messages, contextOpts);
        return Object.assign(ctx, { catchUp: true, lastId: all.length ? all[all.length - 1].id : null });
    }
    const base = String(provider || '').split(':')[0];
    const own = (m) => m.role === 'assistant' && (agentId ? m.agentId === agentId : String(m.provider || '').split(':')[0] === base);
    const fresh = all.slice(idx + 1).filter(m => !own(m));
    let summaryMsg = null;
    for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'summary') { summaryMsg = all[i]; break; }
    const parts = [];
    if (summaryMsg) parts.push(`Rolling state summary (as of ${refLabel(summaryMsg)}):\n${summaryMsg.text.trim()}`);
    parts.push(fresh.length
        ? `New messages since your last turn:\n${fresh.map(m => `[${refLabel(m)}] ${whoOf(m)}: ${m.text.trim()}${m.attachmentsText ? '\n' + m.attachmentsText.trim() : ''}`).join('\n\n')}`
        : 'No new messages from others since your last turn.');
    return { text: parts.join('\n\n'), summary: summaryMsg, digestCount: 0, recentCount: fresh.length, dropped: 0, catchUp: false, lastId: all.length ? all[all.length - 1].id : null };
}

function buildContextByMode(messages, { mode, contextOpts, delta }) {
    if (mode === 'full') return Object.assign(buildFullContext(messages), { catchUp: false, lastId: null });
    if (mode === 'delta') return buildDeltaContext(messages, Object.assign({ contextOpts }, delta || {}));
    return Object.assign(buildContext(messages, contextOpts), { catchUp: false, lastId: null });
}

// Full transcript, used only for one-off readers (judge, summarizer, export).
function renderFullTranscript(messages) {
    return readable(messages).map(m => `[${refLabel(m)}] ${whoOf(m)}: ${m.text.trim()}${m.attachmentsText ? '\n' + m.attachmentsText.trim() : ''}`).join('\n\n') || '(no messages yet)';
}

// The brief is the first human message; the latest instruction is the last.
function briefAndLatest(messages, fallbackTopic) {
    const users = (messages || []).filter(m => m.role === 'user' && (m.text || '').trim());
    const brief = users.length ? users[0].text.trim() : (fallbackTopic || '');
    const latest = users.length ? users[users.length - 1].text.trim() : (fallbackTopic || '');
    return { brief, latest };
}

// Debate stances. Two participants: for/against. More: a distinct, assigned
// stance each, so they don't all drift to the same position.
const STANCES = [
    'Argue FOR the primary proposal / first option.',
    'Argue AGAINST the primary proposal / first option; make the strongest case for the alternative.',
    'Act as the critical evaluator: do not take a side, stress-test both positions and name what evidence would settle it.',
    'Propose and defend a third option neither side has considered.',
];

function stanceFor(mode, index, count) {
    if (mode !== 'debate') return '';
    if (count === 2) return index === 0 ? 'You argue strongly FOR the first option.' : 'You argue strongly AGAINST the first option (for the alternative).';
    return STANCES[index % STANCES.length];
}

function buildClassicPrompt(args) {
    return buildClassicPromptWithMeta(args).prompt;
}

// Same, plus meta: which context mode was used, whether a delta turn fell back
// to a full catch-up, and the id of the last message included (the delta
// anchor to store for this provider).
// Charter mode (MULTI_AI_COWORKING_CHARTER §2, §4, §7): claim-status tags,
// an explicit handoff/open/complete trailer on every message, "agreement
// needs a reason", and a rotating red-team seat. Enforced by prompt plus the
// HANDOFF → routing in the run loop.
const CHARTER_RULES = [
    'Tag every factual or empirical claim you make: VERIFIED [who/how/path] only when you or a local agent actually ran or checked it; UNVERIFIED when it comes from memory or reasoning; ASSUMED [basis] when it is a working assumption. Agreement never upgrades a claim\'s status.',
    'Plain agreement is not a contribution: if you agree, add a distinct reason, a caveat, or a test that would settle it — otherwise reply PASS.',
    'End your message with exactly one trailer line: "HANDOFF → <participant>: <what you want from them>", or "OPEN → <question for the group>", or "COMPLETE → <what is now settled>".',
];

const RED_TEAM_BLOCK = 'This round you hold the RED-TEAM seat: your job is to find the strongest objection to the emerging consensus — a missing assumption, a test that would falsify it, a cheaper alternative — and state it plainly, even if you privately agree. Do not soften it.';

// What a seat is told about the chat's workspace (a git folder CLI seats
// may read or edit). `tools` is this seat's own level.
function workspaceBlock(workspace, tools) {
    if (!workspace || !workspace.root) return '';
    const where = `${workspace.root}${workspace.branch ? ` (git branch ${workspace.branch})` : ''}`;
    if (tools === 'write' || tools === 'full') {
        return `Workspace: ${where}. You have file tools${tools === 'full' ? ' and a shell' : ''} there. When the discussion calls for it, make the change directly in the files (minimal, focused, no commits — your turn is committed automatically and shown to everyone as a diff), then report exactly what you changed and why.`;
    }
    if (tools === 'read') {
        return `Workspace: ${where}. You have read-only file tools there: read, list and search files to verify claims, and cite paths.`;
    }
    return `Workspace: ${where}. Other participants may edit files there; their diffs appear in the transcript as "changes" entries. Review them concretely (file, line, what is wrong or good).`;
}

function buildClassicPromptWithMeta({ chatTitle, topic, latestUserMessage, mode, brevity, persona, participants, provider, agent, messages, contextOpts, stopToken, independent, contextMode, delta, charter, redTeam, workspace }) {
    const agents = asAgents(participants);
    const self = agent || findAgent(agents, provider) || { id: String(provider), name: providerLabel(provider), provider: String(provider).split(':')[0] };
    const base = String(self.provider || provider).split(':')[0];
    const idx = Math.max(0, agents.findIndex(a => a.id === self.id));
    const others = agents.filter(a => a.id !== self.id).map(a => a.name);
    const side = stanceFor(mode, idx, agents.length);
    const personaText = [persona, redTeam ? RED_TEAM_BLOCK : ''].filter(Boolean).join('\n\n');
    const personaBlock = personaText ? `[Your assigned persona / instructions — stay in character]\n${personaText}\n\n` : '';
    // A blind round hides what this round has produced so far, and nothing
    // else: earlier rounds of the same run stay visible, which is what makes
    // 'all' a discussion rather than N disconnected polls. (Scoping this to the
    // whole cycle, as it once did, would have been the same thing for a blind
    // round 1 and wrong for every round after it.)
    const visible = independent
        ? messages.filter(m => !(ROUND_OUTPUT_ROLES.has(m.role || 'assistant')
            && m.cycle === independent.cycle
            && (independent.round == null || m.round === independent.round)))
        : messages;
    const cmode = CONTEXT_MODES.includes(contextMode) ? contextMode : DEFAULTS.contextMode;
    const ctx = buildContextByMode(visible, { mode: cmode, contextOpts, delta: Object.assign({ provider: base, agentId: self.id }, delta || {}) });
    const token = stopToken || DEFAULTS.stopToken;
    const rules = [
        `Add your next contribution (${brevity || 'max 4 sentences'}). Be substantive and specific; build on or directly challenge points already made. Do not repeat yourself or restate what others said. Reply with only your message.`,
        `If you have nothing new to add this turn, reply with exactly: PASS`,
        `If you believe the group has fully converged and no further discussion is needed, begin your reply with the single word ${token} followed by your final position.`,
    ];
    if (independent) {
        rules.push(independent.round > 1
            ? `This round is independent: you can see every completed round, but NOT what the others are saying in round ${independent.round} — they are answering at the same time as you. Respond to the previous round; do not guess at this one.`
            : 'This round is independent: you have NOT been shown the other participants\' replies to the latest message — they are answering at the same time as you. Commit to your own position; do not guess at theirs.');
    }
    if (cmode === 'delta' && !ctx.catchUp) rules.push('You are continuing an ongoing thread: earlier messages are already in this conversation above — only the new ones are shown here.');
    if (charter) rules.push(...CHARTER_RULES);
    const ws = workspaceBlock(workspace, self.tools || 'none');
    const prompt = `${personaBlock}You are ${self.name}, one participant in a multi-AI conversation` +
        `${others.length ? ` with ${others.join(', ')}` : ''}${chatTitle ? ` titled "${chatTitle}"` : ''}.\n` +
        `Topic / brief: ${topic || '(see conversation)'}\n` +
        `${latestUserMessage && latestUserMessage !== topic ? `Latest instruction from the human: ${latestUserMessage}\n` : ''}` +
        `${side ? side + '\n' : ''}${ws ? ws + '\n' : ''}\n` +
        `${ctx.text}\n\n` +
        rules.join('\n');
    return { prompt, meta: { contextMode: cmode, catchUp: !!ctx.catchUp, lastId: ctx.lastId || null, redTeam: !!redTeam } };
}

// "HANDOFF → Claude: run the test" / "HANDOFF -> @gemini" → the named
// participant, or null. Only the trailer counts (last non-empty lines), so a
// quoted handoff earlier in the message doesn't reroute the round.
function parseHandoff(text, participants) {
    const lines = String(text || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
    const tail = lines.slice(-3).join('\n');
    const m = /HANDOFF\s*(?:→|->|=>)\s*@?([A-Za-z][\w.·-]*(?:\s+[\w.·-]+){0,2}?)\s*(?::|$)/im.exec(tail) || /HANDOFF\s*(?:→|->|=>)\s*@?([A-Za-z][\w.-]*)/i.exec(tail);
    if (!m) return null;
    const agents = asAgents(participants);
    const hit = findAgent(agents, m[1].trim()) || findAgent(agents, m[1].trim().split(/\s+/)[0]);
    return hit ? participants[agents.indexOf(hit)] : null;
}

// Which participant holds the red-team seat in a given round (rotates).
function redTeamFor(order, round) {
    if (!order || order.length < 2) return null;
    return order[(round - 1) % order.length];
}

// Messages (readable) since the last pinned summary — the trigger for the
// rolling auto-summary in delta mode.
function messagesSinceSummary(messages) {
    const all = readable(messages);
    let i = all.length - 1;
    while (i >= 0 && all[i].role !== 'summary') i--;
    return all.slice(i + 1);
}

function buildJudgePrompt({ topic, messages }) {
    return `You are an impartial judge. Topic: ${topic}\n\nTranscript:\n${renderFullTranscript(messages)}\n\n` +
        `Deliver a concise verdict: who made the stronger case and why, the single best point from each participant, ` +
        `and any unresolved question. Max 6 sentences.`;
}

function buildSummaryPrompt({ topic, messages }) {
    return `You are the note-taker for a multi-AI working session. Topic: ${topic}\n\nTranscript:\n${renderFullTranscript(messages)}\n\n` +
        `Write a state summary that will replace this transcript as context for the participants. Include, as short labelled sections: ` +
        `DECISIONS (what has been agreed, with who proposed it), OPEN QUESTIONS (unresolved disagreements, with each side's position), ` +
        `CLAIMS TO VERIFY (anything asserted but not verified), and NEXT STEP (the single most useful next contribution). ` +
        `Be faithful to the transcript; do not add opinions. Max 350 words.`;
}

function buildTitlePrompt(firstPrompt) {
    return `Reply with ONLY a short descriptive title (max 6 words, no quotes, no trailing punctuation) for a conversation that begins with this message:\n\n"${firstPrompt}"`;
}

// Local, zero-cost title from the first message (PCA behaviour).
function localTitle(text, maxLen = 60) {
    const words = String(text || '').replace(/(^|\s)@[\w-]+/g, ' ').replace(/^[\s,:;-]+/, '').replace(/[*#>`_\[\]]/g, '').split(/\s+/).filter(Boolean);
    let name = words.slice(0, 8).join(' ') || 'New chat';
    if (name.length > maxLen) name = name.slice(0, maxLen - 1).trimEnd() + '…';
    return name;
}

function cleanTitle(raw, maxLen = 60) {
    let t = String(raw || '').trim().split('\n')[0].replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!?]+$/, '').trim();
    if (t.length > maxLen) t = t.slice(0, maxLen);
    return t;
}

// "@claude kick off, others review after" → ['claude', ...rest].
// Mentioned participants go first in mention order; the rest follow in their
// configured order. "@claude only" / "only @claude" restricts to the mentioned set.
// Works on provider strings or agent objects; returns the same kind it was given.
function parseMentions(text, participants) {
    const t = String(text || '');
    const agents = asAgents(participants);
    const found = [];
    const re = /(^|[^\w@])@([a-z][\w.-]*)/gi;
    let m;
    while ((m = re.exec(t)) !== null) {
        const hit = findAgent(agents, m[2]);
        if (hit && !found.includes(hit)) found.push(hit);
    }
    const back = (a) => participants[agents.indexOf(a)];
    if (!found.length) return { order: participants.slice(), only: false, mentioned: [] };
    const only = /\bonly\b/i.test(t);
    const rest = agents.filter(a => !found.includes(a));
    const order = (only ? found : found.concat(rest)).map(back);
    return { order, only, mentioned: found.map(back) };
}

function isPass(text) {
    return /^\s*\**\s*PASS\s*\**\s*[.!]?\s*$/i.test(String(text || ''));
}

function startsWithToken(text, token) {
    const tok = (token || DEFAULTS.stopToken).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*[*_#>\\s]*${tok}\\b`, 'i').test(String(text || ''));
}

// Round outcome: converged when every participant that replied this round
// either said the stop token or passed, and at least one said the token.
function roundOutcome(roundMessages, token) {
    const replies = roundMessages.filter(m => m.role === 'assistant' || m.role === 'pass');
    if (!replies.length) return { converged: false, allPassed: false };
    const tokenCount = replies.filter(m => m.role === 'assistant' && startsWithToken(m.text, token)).length;
    const passCount = replies.filter(m => m.role === 'pass').length;
    const allPassed = passCount === replies.length;
    const converged = tokenCount > 0 && tokenCount + passCount === replies.length;
    return { converged, allPassed, tokenCount, passCount };
}

// Session naming: one provider-side thread per Multi-AI chat, plus an
// auxiliary thread for one-off calls (judge / summary / title) that is reset
// before each use so it never accumulates.
function sessionFor(chatId) { return `multiai:${chatId}`; }
function auxSessionFor(chatId) { return `multiai:${chatId}:aux`; }

function parseToolCall(text) {
    const m = /```tool\s*([\s\S]*?)```/i.exec(text || '');
    if (!m) return null;
    try {
        const obj = JSON.parse(m[1].trim());
        if (!obj || typeof obj.op !== 'string') return null;
        return obj;
    } catch {
        return null;
    }
}

// "provider: task" only when the prefix is an actual provider name;
// "Summarize: the key points" stays a task for the default provider.
function parseWorkflowLine(line, known) {
    const m = /^([a-z][\w-]*(?::[\w.-]+)?)\s*:\s*(.+)$/i.exec(line.trim());
    if (m) {
        const base = m[1].toLowerCase().split(':')[0];
        if ((known || KNOWN_PROVIDERS).includes(base)) return { provider: m[1].toLowerCase(), task: m[2].trim() };
    }
    return { task: line.trim() };
}

module.exports = {
    DEFAULTS, KNOWN_PROVIDERS, PROVIDER_LABELS, PROVIDER_CODES,
    INDEPENDENT_MODES, independentMode,
    providerLabel, providerCode, genMsgId, genChatId, refLabel,
    emptyStore, normalizeStore, findChatIn, mergeStores, createStore,
    CONTEXT_MODES, READABLE_ROLES, readable, buildContext, buildFullContext, buildDeltaContext, buildContextByMode,
    renderFullTranscript, briefAndLatest, messagesSinceSummary, stanceFor,
    buildClassicPrompt, buildClassicPromptWithMeta, buildJudgePrompt, buildSummaryPrompt, buildTitlePrompt,
    ROUTES, CLI_PROVIDERS, EFFORTS, TOOLS, slugify, agentCode, defaultAgentName, normalizeAgents, findAgent, asAgents, workspaceBlock,
    localTitle, cleanTitle, parseMentions, parseHandoff, redTeamFor, CHARTER_RULES, RED_TEAM_BLOCK, isPass, startsWithToken, roundOutcome,
    sessionFor, auxSessionFor, parseToolCall, parseWorkflowLine,
};

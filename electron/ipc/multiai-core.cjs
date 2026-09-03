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
    providerResetEvery: 12,     // start a fresh provider-side thread after this many turns
});

const KNOWN_PROVIDERS = ['chatgpt', 'claude', 'gemini', 'perplexity'];

const PROVIDER_LABELS = {
    chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', perplexity: 'Perplexity',
    codex: 'Codex', 'claude-code': 'Claude Code', human: 'You',
};

const PROVIDER_CODES = {
    chatgpt: 'CG', claude: 'CL', gemini: 'GM', perplexity: 'PX',
    codex: 'CX', 'claude-code': 'CC', human: 'US', external: 'EX',
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
    else if (msg.role === 'pass') code = providerCode(msg.provider);
    else code = providerCode(msg.provider);
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
            participants: c.participants || [], createdAt: c.createdAt || null,
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
const READABLE_ROLES = new Set(['user', 'assistant', 'judge', 'summary']);

function readable(messages) {
    return (messages || []).filter(m => READABLE_ROLES.has(m.role || 'assistant') && (m.text || '').trim());
}

function whoOf(m) {
    if (m.role === 'user') return m.who || 'You';
    if (m.role === 'judge') return m.who || 'Judge';
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

function buildClassicPrompt({ chatTitle, topic, latestUserMessage, mode, brevity, persona, participants, provider, messages, contextOpts, stopToken, independent }) {
    const base = String(provider).split(':')[0];
    const idx = Math.max(0, participants.indexOf(provider), participants.indexOf(base));
    const others = participants.filter(p => p !== provider && p !== base).map(providerLabel);
    const side = stanceFor(mode, idx, participants.length);
    const personaBlock = persona ? `[Your assigned persona / instructions — stay in character]\n${persona}\n\n` : '';
    const ctx = independent
        ? buildContext(messages.filter(m => m.role !== 'assistant' || m.cycle !== independent.cycle), contextOpts)
        : buildContext(messages, contextOpts);
    const token = stopToken || DEFAULTS.stopToken;
    const rules = [
        `Add your next contribution (${brevity || 'max 4 sentences'}). Be substantive and specific; build on or directly challenge points already made. Do not repeat yourself or restate what others said. Reply with only your message.`,
        `If you have nothing new to add this turn, reply with exactly: PASS`,
        `If you believe the group has fully converged and no further discussion is needed, begin your reply with the single word ${token} followed by your final position.`,
    ];
    if (independent) rules.push('This is an independent first round: you have NOT been shown the other participants\' replies to the latest message. Commit to your own position; do not guess at theirs.');
    return `${personaBlock}You are ${providerLabel(provider)}, one participant in a multi-AI conversation` +
        `${others.length ? ` with ${others.join(', ')}` : ''}${chatTitle ? ` titled "${chatTitle}"` : ''}.\n` +
        `Topic / brief: ${topic || '(see conversation)'}\n` +
        `${latestUserMessage && latestUserMessage !== topic ? `Latest instruction from the human: ${latestUserMessage}\n` : ''}` +
        `${side ? side + '\n' : ''}\n` +
        `${ctx.text}\n\n` +
        rules.join('\n');
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
function parseMentions(text, participants) {
    const t = String(text || '');
    const found = [];
    const re = /(^|[^\w@])@([a-z][\w-]*)/gi;
    let m;
    while ((m = re.exec(t)) !== null) {
        const name = m[2].toLowerCase();
        const hit = participants.find(p => p.split(':')[0] === name || providerLabel(p).toLowerCase().replace(/\s+/g, '') === name);
        if (hit && !found.includes(hit)) found.push(hit);
    }
    if (!found.length) return { order: participants.slice(), only: false, mentioned: [] };
    const only = /\bonly\b/i.test(t);
    const order = only ? found : found.concat(participants.filter(p => !found.includes(p)));
    return { order, only, mentioned: found };
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
    providerLabel, providerCode, genMsgId, genChatId, refLabel,
    emptyStore, normalizeStore, findChatIn, mergeStores, createStore,
    READABLE_ROLES, readable, buildContext, renderFullTranscript, briefAndLatest, stanceFor,
    buildClassicPrompt, buildJudgePrompt, buildSummaryPrompt, buildTitlePrompt,
    localTitle, cleanTitle, parseMentions, isPass, startsWithToken, roundOutcome,
    sessionFor, auxSessionFor, parseToolCall, parseWorkflowLine,
};

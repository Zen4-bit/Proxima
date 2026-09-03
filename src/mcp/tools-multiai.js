// Proxima — MCP Multi-AI Chat Tools.
// Lets any MCP client (Claude Desktop, Claude Code, Codex, …) take part in the
// app's Multi-AI Chat tab: list and read chats, post a turn under its own
// name, kick off rounds among the browser AIs, wait for them, stop them.
// Everything goes through the Agent Hub IPC bridge (multiai* actions in
// electron/main-v2.cjs → electron/ipc/multiai.cjs), so it works whether or
// not the REST API is enabled.

function summarizeChat(c) {
    const when = c.updatedAt ? new Date(c.updatedAt).toISOString() : '';
    return `${c.id}  "${c.title || 'Untitled'}"  [${c.mode || 'classic'}${c.strategy && c.mode === 'orchestrated' ? '/' + c.strategy : ''}]  ` +
        `${(c.participants || []).join(', ') || 'no participants'}  ·  ${c.messageCount || 0} msgs  ·  cycle ${c.cycle || 0}${when ? '  ·  ' + when : ''}`;
}

function renderMessages(messages) {
    if (!messages || !messages.length) return '(no messages)';
    return messages.map(m => {
        const who = m.who || m.provider || m.role;
        const text = (m.text || '').trim();
        const attach = m.attachmentsText ? `\n${m.attachmentsText.trim()}` : '';
        return `[${m.label || ''} id=${m.id}] ${who}${m.role && !['assistant', 'user'].includes(m.role) ? ` (${m.role})` : ''}:\n${text}${attach}`;
    }).join('\n\n');
}

function providerFor(who) {
    const w = String(who || '').toLowerCase();
    if (/codex/.test(w)) return 'codex';
    if (/claude ?code/.test(w)) return 'claude-code';
    if (/^(chatgpt|claude|gemini|perplexity)$/.test(w)) return 'external'; // never impersonate a browser participant
    return 'external';
}

export function register(server, deps) {
    const { z, toolResponse, toolError, ipcClient } = deps;

    const ipc = async (action, data) => {
        const r = await ipcClient.send(action, null, data || {});
        if (!r || r.success === false) throw new Error((r && r.error) || `${action} failed`);
        return r;
    };

    server.registerTool('multiai_list_chats', {
        title: 'Multi-AI Chat: list chats',
        description: 'List the chats in Proxima\'s Multi-AI Chat tab (id, title, mode, participants, message count, whether a run is in progress). Use the id with the other multiai_* tools.',
        inputSchema: {},
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async () => {
        try {
            const [{ chats }, { running }] = await Promise.all([ipc('multiaiListChats'), ipc('multiaiRunning')]);
            const runningSet = new Set(running || []);
            if (!chats.length) return toolResponse('No Multi-AI chats yet. Create one with multiai_create_chat or in the app.');
            const lines = chats
                .slice()
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                .map(c => `${runningSet.has(c.id) ? '● ' : '  '}${summarizeChat(c)}`);
            return toolResponse(`${chats.length} chat(s) (● = run in progress):\n${lines.join('\n')}`);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('multiai_read_chat', {
        title: 'Multi-AI Chat: read a chat',
        description: 'Read a Multi-AI chat\'s transcript. Each message shows its reference label (cycle·round·agent) and id; pass `since` (a message id) to get only what came after it, or `last` to get only the most recent N messages. Also reports whether a run is in progress.',
        inputSchema: {
            chatId: z.string().describe('Chat id from multiai_list_chats'),
            since: z.string().optional().describe('Return only messages after this message id'),
            last: z.number().int().min(1).max(200).optional().describe('Return only the last N messages'),
        },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async ({ chatId, since, last }) => {
        try {
            const { chat } = await ipc('multiaiGetChat', { chatId, since, last });
            const header = `"${chat.title}"  [${chat.mode}${chat.mode === 'orchestrated' ? '/' + (chat.strategy || 'crew') : ''}, ${chat.discussMode || 'discuss'}, context=${chat.contextMode || 'bounded'}]  ` +
                `participants: ${(chat.participants || []).join(', ') || '—'}  ·  ${chat.totalMessages} messages total  ·  cycle ${chat.cycle || 0}  ·  ${chat.running ? 'RUN IN PROGRESS' : 'idle'}`;
            return toolResponse(`${header}\n\n${renderMessages(chat.messages)}`);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('multiai_create_chat', {
        title: 'Multi-AI Chat: create a chat',
        description: 'Create a new Multi-AI chat. Optionally give it an opening message (topic), participants (chatgpt, claude, gemini, perplexity), discuss/debate mode and a context mode (bounded | delta | full).',
        inputSchema: {
            title: z.string().optional().describe('Chat title (defaults to the first words of the topic)'),
            topic: z.string().optional().describe('Opening message / brief, recorded as the first human message'),
            who: z.string().optional().describe('Name to record the opening message under (default: You)'),
            participants: z.array(z.string()).optional().describe('Browser AIs that take turns, e.g. ["chatgpt","claude"]'),
            discussMode: z.enum(['discuss', 'debate']).optional(),
            contextMode: z.enum(['bounded', 'delta', 'full']).optional(),
            brevity: z.string().optional().describe('e.g. "max 4 sentences" or "as long as needed"'),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
    }, async (args) => {
        try {
            const { chat } = await ipc('multiaiCreateChat', args);
            return toolResponse({ success: true, chatId: chat.id, title: chat.title, participants: chat.participants });
        } catch (err) { return toolError(err); }
    });

    server.registerTool('multiai_post_message', {
        title: 'Multi-AI Chat: post a message',
        description: 'Append a turn to a Multi-AI chat under your own name (e.g. "Codex", "Claude Code"). It is stored, shown live in the app, and included in what the browser AIs see on their next turn — but nothing is sent to them until someone runs a round (multiai_run_round). Use role "user" only when relaying the human\'s instruction.',
        inputSchema: {
            chatId: z.string().describe('Chat id'),
            who: z.string().describe('Your name as it should appear in the chat, e.g. "Codex" or "Claude Code"'),
            text: z.string().describe('The message. Mark verified results as VERIFIED [how/path] and unverified claims as UNVERIFIED, per the coworking charter.'),
            role: z.enum(['assistant', 'user', 'summary']).optional().describe('assistant (default) = a participant turn; user = a human instruction (starts a new cycle); summary = pin a state summary that later turns start from'),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
    }, async ({ chatId, who, text, role }) => {
        try {
            const { message } = await ipc('multiaiAppend', { chatId, who, text, role: role || 'assistant', provider: role === 'user' ? 'human' : providerFor(who) });
            return toolResponse({ success: true, id: message.id, label: message.label, who: message.who });
        } catch (err) { return toolError(err); }
    });

    server.registerTool('multiai_run_round', {
        title: 'Multi-AI Chat: run round(s)',
        description: 'Have the chat\'s browser-AI participants take their turns. Optionally post a message first (as the human, or under your name). Returns immediately by default — the run continues in the app; call multiai_wait_for_run to collect the replies. Mention participants in the text to direct the order ("@claude kick off, others react", "only @gemini …").',
        inputSchema: {
            chatId: z.string().describe('Chat id'),
            text: z.string().optional().describe('Message to post before the round (recorded as a human/agent instruction — starts a new cycle)'),
            who: z.string().optional().describe('Name to record `text` under (default: You). Use your own name when the instruction is yours, not the human\'s.'),
            rounds: z.number().int().min(1).max(30).optional().describe('How many round-robin rounds (default: the chat\'s setting)'),
            wait: z.boolean().optional().describe('Wait for the run to finish before returning (may take minutes; default false)'),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ chatId, text, who, rounds, wait }) => {
        try {
            const r = await ipc('multiaiRun', { chatId, text, who, provider: who ? providerFor(who) : undefined, rounds, wait: !!wait });
            if (r.started) return toolResponse({ success: true, started: true, chatId, next: 'Call multiai_wait_for_run (or multiai_read_chat with since=<last id you saw>) to collect the replies.' });
            return toolResponse(`Run finished. New messages:\n\n${renderMessages(r.messages)}`);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('multiai_wait_for_run', {
        title: 'Multi-AI Chat: wait for a run',
        description: 'Block until the chat\'s current run finishes (or up to maxSeconds, default 45), then return the messages after `since`. If it is still running, call again with the last id you received.',
        inputSchema: {
            chatId: z.string().describe('Chat id'),
            since: z.string().optional().describe('Return only messages after this message id'),
            maxSeconds: z.number().int().min(1).max(120).optional(),
        },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async ({ chatId, since, maxSeconds }) => {
        try {
            const r = await ipc('multiaiWait', { chatId, since, maxMs: (maxSeconds || 45) * 1000 });
            return toolResponse(`${r.running ? 'STILL RUNNING — call again with since=<last id>.' : 'Run finished.'}\n\n${renderMessages(r.messages)}`);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('multiai_stop', {
        title: 'Multi-AI Chat: stop a run',
        description: 'Stop the run in progress on a Multi-AI chat.',
        inputSchema: { chatId: z.string().describe('Chat id') },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async ({ chatId }) => {
        try {
            const r = await ipc('multiaiStop', { chatId });
            return toolResponse({ success: true, stopped: !!r.stopped });
        } catch (err) { return toolError(err); }
    });
}

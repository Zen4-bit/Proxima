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
        `${(c.agents && c.agents.length ? c.agents : (c.participants || [])).join(', ') || 'no agents'}  ·  ${c.messageCount || 0} msgs  ·  cycle ${c.cycle || 0}${when ? '  ·  ' + when : ''}`;
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
        description: 'List the chats in Proxima\'s Multi-AI Chat tab (id, title, mode, agents, message count, whether a run is in progress). Use the id with the other multiai_* tools.',
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
            const agents = (chat.agents || []).map(a => `${a.name} [${a.id}: ${a.route}${a.model ? ' ' + a.model : ''}${a.effort ? ' ' + a.effort : ''}${a.tools && a.tools !== 'none' ? ' tools=' + a.tools : ''}]`);
            const ws = chat.workspace && chat.workspace.root ? `  ·  workspace: ${chat.workspace.root}${chat.workspace.branch ? ' @ ' + chat.workspace.branch : ''}` : '';
            const header = `"${chat.title}"  [${chat.mode}${chat.mode === 'orchestrated' ? '/' + (chat.strategy || 'crew') : ''}, ${chat.discussMode || 'discuss'}, context=${chat.contextMode || 'bounded'}]  ` +
                `agents: ${agents.join(', ') || (chat.participants || []).join(', ') || '—'}${ws}  ·  ${chat.totalMessages} messages total  ·  cycle ${chat.cycle || 0}  ·  ${chat.running ? 'RUN IN PROGRESS' : 'idle'}`;
            return toolResponse(`${header}\n\n${renderMessages(chat.messages)}`);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('multiai_create_chat', {
        title: 'Multi-AI Chat: create a chat',
        description: 'Create a new Multi-AI chat. Optionally give it an opening message (topic), agents, discuss/debate mode, a context mode (bounded | delta | full) and a workspace. An agent is a name + provider + route + model + effort: several agents may share one provider ("GPT high" and "GPT low"). Routes: auto (follows the app\'s Settings — API mode on with a key → API, else the browser tab), browser, api, cli (claude-cli = Claude Code, codex-cli = Codex, gemini-cli = Gemini CLI — run locally on the user\'s subscriptions). Local models registered in Settings → API → Local / custom endpoint (Ollama, LM Studio, …) are providers too, by the name given there — API only, model id required. With a `workspace` (a git folder), CLI seats may get `tools`: read / write / full; writer turns are committed on a chat branch and shown as diffs. `participants` is the legacy shorthand: one browser-tab agent per provider.',
        inputSchema: {
            title: z.string().optional().describe('Chat title (defaults to the first words of the topic)'),
            topic: z.string().optional().describe('Opening message / brief, recorded as the first human message'),
            who: z.string().optional().describe('Name to record the opening message under (default: You)'),
            participants: z.array(z.string()).optional().describe('Legacy shorthand: one agent per provider, e.g. ["chatgpt","claude"] (ignored when `agents` is given)'),
            agents: z.array(z.object({
                name: z.string().optional().describe('Display name, e.g. "Opus · max" (default: provider · model · effort)'),
                provider: z.string().describe('chatgpt | claude | gemini | perplexity (browser tab / API), claude-cli | codex-cli | gemini-cli (local CLI), or the name of a local / custom endpoint registered in Settings → API (api only)'),
                route: z.enum(['auto', 'browser', 'api', 'cli']).optional().describe('auto (default) follows Settings; cli is implied for claude-cli/codex-cli'),
                model: z.string().optional().describe('API model id, CLI model (opus/sonnet aliases, a Codex model slug such as gpt-5.5, a Gemini CLI model id) or Gemini browser engine (3.1-pro); blank = the Settings / CLI default'),
                effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort — API and CLI routes only'),
                persona: z.string().optional().describe('Persona / system instructions for this agent'),
                enabled: z.boolean().optional().describe('false = on the roster but benched (takes no turns until the user ticks it)'),
                tools: z.enum(['none', 'read', 'write', 'full']).optional().describe('CLI seats only, needs `workspace`: none (default) | read (list/read/search files) | write (edit files; shell limited to git status/diff/log; each turn committed and shown as a diff) | full (edit + any shell command, no sandbox)'),
            })).optional().describe('The agents that take turns, in order'),
            workspace: z.object({ root: z.string().describe('Absolute path of a git repository') }).optional().describe('Folder that CLI seats with tools read or edit. Must be a git repo, clean or already on the chat branch (multiai/<chat>); Proxima never touches uncommitted work on another branch. Merge or delete the branch when done.'),
            discussMode: z.enum(['discuss', 'debate']).optional(),
            contextMode: z.enum(['bounded', 'delta', 'full']).optional(),
            brevity: z.string().optional().describe('e.g. "max 4 sentences" or "as long as needed"'),
            rounds: z.number().int().min(1).max(30).optional().describe('Default rounds per run'),
            charterMode: z.boolean().optional().describe('Coworking-charter rules: claim tags, HANDOFF → routing, rotating red-team seat'),
            independentFirstRound: z.boolean().optional().describe('Legacy: round 1 of each run is parallel and blind. Prefer independentRounds.'),
            independentRounds: z.enum(['off', 'first', 'all']).optional().describe("Which rounds run blind — every participant at once, none shown the others' replies from that same round. 'all' (default) | 'first' | 'off'"),
            stopWhenAllAgree: z.boolean().optional(),
            stopToken: z.string().optional().describe('Convergence token (default DONE)'),
            autoSummaryEvery: z.number().int().min(0).max(200).optional().describe('Delta mode: refresh the rolling summary every N messages'),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
    }, async (args) => {
        try {
            const { chat } = await ipc('multiaiCreateChat', args);
            return toolResponse({ success: true, chatId: chat.id, title: chat.title, workspace: chat.workspace || undefined, agents: (chat.agents || []).map(a => ({ id: a.id, name: a.name, provider: a.provider, route: a.route, model: a.model || undefined, effort: a.effort || undefined, tools: a.tools && a.tools !== 'none' ? a.tools : undefined })) });
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
        description: 'Have the chat\'s agents take their turns (browser tabs, API keys or local CLIs, per each agent\'s route). Optionally post a message first (as the human, or under your name). Returns immediately by default — the run continues in the app; call multiai_wait_for_run to collect the replies. Mention agents by id or name in the text to direct the order ("@claude kick off, others react", "only @opus-max …").',
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

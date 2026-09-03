// Proxima — Multi-AI Chat IPC Handlers.
// Adds a native "Multi-AI Chat" surface on top of the same browser-session
// providers Proxima already drives, with two logic modes:
//   - Classic: discuss/debate/personas/judge, ported from the standalone
//     ProximaChatApp (round-robin, one participant per turn).
//   - Orchestrated: role-based crew / sequential workflow / iterate-loop,
//     the same shapes as the MCP server's run_workflow/crew/run_loop tools,
//     but calling sendMessageToProvider directly in-process instead of
//     round-tripping through the MCP server's separate IPC bridge.
// History is stored in this app's own userData folder (multiai-chats.json),
// not an external file, so this is one integrated product rather than a
// second tool bolted on the side.

const { ipcMain, app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const sender = require('../providers/sender.cjs');

function dataDir() {
    const dir = path.join(app.getPath('userData'), 'multiai');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function personasDir() {
    const dir = path.join(dataDir(), 'personas');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function chatsFile() {
    return path.join(dataDir(), 'chats.json');
}

function loadChats() {
    try {
        return JSON.parse(fs.readFileSync(chatsFile(), 'utf-8'));
    } catch {
        return { projects: [{ id: 'default', name: 'General', chats: [] }] };
    }
}

function saveChats(data) {
    fs.writeFileSync(chatsFile(), JSON.stringify(data, null, 2), 'utf-8');
    return { success: true };
}

function listPersonas() {
    const dir = personasDir();
    const out = {};
    for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.md') || f.endsWith('.txt')) {
            try {
                out[f.replace(/\.(md|txt)$/, '')] = fs.readFileSync(path.join(dir, f), 'utf-8');
            } catch { /* skip unreadable file */ }
        }
    }
    return out;
}

function registerMultiAiHandlers(deps) {
    const { mainWindow, loadSettings } = deps;

    // ---- cancellation -------------------------------------------------
    // A "signal" per running chatId lets Stop interrupt a call that's
    // already in flight, instead of only taking effect between steps.
    // sendMessageToProvider itself isn't cancellable (no AbortController
    // support in the provider layer), so the underlying browser call keeps
    // running in the background — but the run loop stops waiting on it the
    // moment Stop is clicked, via Promise.race against the signal, and its
    // eventual result is simply discarded. That's a real, immediate stop
    // from the user's point of view, short of true request cancellation.
    const runSignals = new Map(); // chatId -> { cancelled, resolve, promise }

    function startSignal(chatId) {
        let resolveFn;
        const promise = new Promise((res) => { resolveFn = res; });
        const sig = { cancelled: false, resolve: resolveFn, promise };
        runSignals.set(chatId, sig);
        return sig;
    }

    function endSignal(chatId) {
        runSignals.delete(chatId);
    }

    // Races a provider call against the cancellation signal for this chat.
    // Returns { cancelled: true } immediately if Stop fires first, otherwise
    // { ok: true, value } or { ok: false, error }.
    async function raceProvider(chatId, providerPromise) {
        const sig = runSignals.get(chatId);
        const settled = providerPromise.then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error })
        );
        if (!sig) return settled;
        return Promise.race([
            settled,
            sig.promise.then(() => ({ cancelled: true })),
        ]);
    }

    function win() {
        const w = typeof mainWindow === 'function' ? mainWindow() : mainWindow;
        return (w && !w.isDestroyed()) ? w : null;
    }

    function emit(channel, payload) {
        const w = win();
        if (w) w.webContents.send(channel, payload);
    }

    function enabledProviders() {
        const settings = loadSettings();
        return Object.keys(settings.providers || {}).filter(p => settings.providers[p]?.enabled);
    }

    // ---- persistence -------------------------------------------------

    ipcMain.handle('multiai-load', () => loadChats());
    ipcMain.handle('multiai-save', (event, data) => saveChats(data));
    ipcMain.handle('multiai-list-personas', () => listPersonas());
    ipcMain.handle('multiai-open-personas-folder', () => {
        require('electron').shell.openPath(personasDir());
        return { success: true };
    });
    ipcMain.handle('multiai-enabled-providers', () => enabledProviders());

    ipcMain.handle('multiai-stop-run', (event, { chatId }) => {
        const sig = runSignals.get(chatId);
        if (sig) {
            sig.cancelled = true;
            sig.resolve();
        }
        return { success: true };
    });

    ipcMain.handle('multiai-export', async (event, { title, markdown }) => {
        const w = win();
        const safeName = (title || 'multiai-chat').replace(/[\\/:*?"<>|]/g, '_').trim() || 'multiai-chat';
        try {
            const result = await dialog.showSaveDialog(w || undefined, {
                title: 'Export Multi-AI Chat',
                defaultPath: path.join(app.getPath('documents'), `${safeName}.md`),
                filters: [{ name: 'Markdown', extensions: ['md'] }],
            });
            if (result.canceled || !result.filePath) return { success: false, canceled: true };
            fs.writeFileSync(result.filePath, markdown, 'utf-8');
            return { success: true, filePath: result.filePath };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // Fire-and-forget helper used to auto-name a chat from its first message.
    // Deliberately a one-off call, not part of the round-robin/orchestration
    // machinery above — its result becomes the chat title only, and is never
    // pushed into that chat's messages/ledger.
    ipcMain.handle('multiai-generate-title', async (event, { provider, prompt }) => {
        try {
            const result = await sender.sendMessageToProvider(provider, prompt);
            return { success: true, title: result.response };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // ---- File tools (Orchestrated "Agent" strategy) --------------------
    // None of the four providers have real API tool-calling wired up here —
    // sender.js is a plain text-in/text-out pipe into the browser-automation
    // layer, not a provider API with a `tools` schema. So this is a ReAct
    // loop built entirely on our side: the model is instructed to emit a
    // fenced ```tool {...}``` block when it wants a file operation, we parse
    // and execute that against ONE user-chosen folder (never anything else —
    // resolveInRoot refuses any path that resolves outside it), feed the
    // result back as the next turn, and repeat until the model replies with
    // plain text (no tool block), which is treated as its final answer.
    // Per explicit user choice this executes reads AND writes/deletes with
    // no confirmation step — the only safety boundary is the folder scope.

    ipcMain.handle('multiai-tools-pick-folder', async () => {
        const w = win();
        try {
            const result = await dialog.showOpenDialog(w || undefined, {
                title: 'Choose a working folder for Agent (file tools)',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
            return { success: true, path: result.filePaths[0] };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    function resolveInRoot(root, relPath) {
        const normalizedRoot = path.resolve(root);
        const target = path.resolve(normalizedRoot, relPath || '.');
        if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
            throw new Error('That path is outside the working folder — refused.');
        }
        return target;
    }

    function execToolOp(root, op, relPath, content) {
        const target = resolveInRoot(root, relPath);
        switch (op) {
            case 'list': {
                const stat = fs.statSync(target);
                if (!stat.isDirectory()) throw new Error('Not a directory.');
                const entries = fs.readdirSync(target, { withFileTypes: true });
                return entries.map(e => `${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`).join('\n') || '(empty)';
            }
            case 'read': {
                let text = fs.readFileSync(target, 'utf-8');
                if (text.length > 50000) text = text.slice(0, 50000) + '\n...(truncated)';
                return text;
            }
            case 'write': {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, content || '', 'utf-8');
                return `Wrote ${Buffer.byteLength(content || '', 'utf-8')} bytes.`;
            }
            case 'append': {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.appendFileSync(target, content || '', 'utf-8');
                return `Appended ${Buffer.byteLength(content || '', 'utf-8')} bytes.`;
            }
            case 'mkdir': {
                fs.mkdirSync(target, { recursive: true });
                return 'Directory created.';
            }
            case 'delete': {
                const normalizedRoot = path.resolve(root);
                if (target === normalizedRoot) throw new Error('Refusing to delete the working folder root itself.');
                fs.rmSync(target, { recursive: true, force: true });
                return 'Deleted.';
            }
            default:
                throw new Error(`Unknown op: ${op}`);
        }
    }

    function buildToolsPreamble() {
        return 'You have access to file tools scoped to one working folder — you cannot reach anything outside it. ' +
            'To use a tool, reply with ONLY a single fenced block like this and nothing else:\n\n' +
            '```tool\n{"op": "list", "path": "."}\n```\n\n' +
            'Available ops (path is always relative to the working folder root; use "." for the root itself):\n' +
            '- list {"path"} — list a directory\'s contents\n' +
            '- read {"path"} — read a text file\n' +
            '- write {"path", "content"} — create or overwrite a text file\n' +
            '- append {"path", "content"} — append to a text file\n' +
            '- mkdir {"path"} — create a directory\n' +
            '- delete {"path"} — delete a file or directory (irreversible)\n\n' +
            'After a tool result comes back, call another tool the same way, or reply with plain text and no tool ' +
            'block once you have your final answer — that plain-text reply ends the run.';
    }

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

    async function runAgentTools({ chatId, task, provider, root, maxTurns }) {
        if (!root) throw new Error('No working folder chosen.');
        const turns = Math.max(1, Math.min(15, maxTurns || 6));
        let transcript = `${buildToolsPreamble()}\n\nTASK: ${task}`;
        const steps = [];
        for (let t = 1; t <= turns; t++) {
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) {
                emit('multiai-orch-step', { chatId, status: 'cancelled', turn: t });
                break;
            }
            emit('multiai-orch-step', { chatId, status: 'running', turn: t, provider });
            const startMs = Date.now();
            let reply;
            try {
                reply = await chat(chatId, provider, transcript);
            } catch (e) {
                if (e.wasCancelled) emit('multiai-orch-step', { chatId, status: 'cancelled', turn: t });
                else emit('multiai-orch-step', { chatId, status: 'error', turn: t, error: e.message });
                break;
            }

            const toolCall = parseToolCall(reply);
            if (!toolCall) {
                const step = { turn: t, output: reply, elapsedMs: Date.now() - startMs, ok: true };
                steps.push(step);
                emit('multiai-orch-step', { chatId, status: 'done', ...step });
                return { finalOutput: reply, steps };
            }

            let resultText;
            try {
                resultText = execToolOp(root, toolCall.op, toolCall.path, toolCall.content);
            } catch (e) {
                resultText = `ERROR: ${e.message}`;
            }
            const step = { turn: t, output: `[tool: ${toolCall.op} ${toolCall.path || ''}]\n${resultText}`, elapsedMs: Date.now() - startMs, ok: true };
            steps.push(step);
            emit('multiai-orch-step', { chatId, status: 'done', ...step });

            transcript += `\n\nASSISTANT: ${reply}\n\nTOOL RESULT (${toolCall.op} ${toolCall.path || ''}):\n${resultText}\n\n` +
                'Continue with another tool call, or give your final answer as plain text with no tool block.';
        }
        return { finalOutput: (steps[steps.length - 1] && steps[steps.length - 1].output) || '(turn limit reached with no final answer)', steps };
    }

    // ---- Classic mode: discuss / debate / judge -----------------------
    // One provider per turn, round-robin, building on the transcript so far.
    // Mirrors ProximaChatApp's build_prompt()/run_round() logic exactly,
    // but calls sendMessageToProvider in-process instead of hitting :3210.

    function renderTranscript(messages) {
        return messages.map(m => `${m.who}: ${m.text}`).join('\n\n') || '(no messages yet)';
    }

    function buildClassicPrompt({ topic, mode, brevity, persona, participants, provider, transcript }) {
        let side = '';
        if (mode === 'debate') {
            const i = participants.indexOf(provider);
            if (participants.length === 2) {
                side = i === 0
                    ? 'You argue strongly FOR the first option.'
                    : 'You argue strongly AGAINST the first option (for the alternative).';
            } else {
                side = 'Take a distinct, well-defined stance and defend it.';
            }
        }
        const personaBlock = persona ? `[Your assigned persona / instructions — stay in character]\n${persona}\n\n` : '';
        return `${personaBlock}You are ${provider}, one participant in a multi-AI conversation. Topic: ${topic}\n` +
            `${side}\n\nConversation so far:\n${transcript}\n\n` +
            `Add your next contribution (${brevity || 'max 4 sentences'}). Be substantive and specific; ` +
            `build on or directly challenge points already made. Do not repeat yourself. Reply with only your message.`;
    }

    ipcMain.handle('multiai-run-round', async (event, opts) => {
        const { chatId, topic, mode, brevity, personas, participants, messages, rounds } = opts;
        const n = Math.max(1, Math.min(30, rounds || 1));
        const out = [];
        const sig = startSignal(chatId);
        outer:
        for (let r = 0; r < n; r++) {
            if (sig.cancelled) break;
            emit('multiai-round-start', { chatId, round: r + 1, of: n });
            for (const provider of participants) {
                if (sig.cancelled) break outer;
                emit('multiai-thinking', { chatId, provider });
                const persona = (personas && personas[provider]) || null;
                const transcript = renderTranscript([...messages, ...out]);
                const prompt = buildClassicPrompt({ topic, mode, brevity, persona, participants, provider, transcript });
                const raced = await raceProvider(chatId, sender.sendMessageToProvider(provider, prompt));
                if (raced.cancelled) {
                    const msg = { who: `${provider} (stopped)`, text: 'Stopped before this reply arrived.', provider, role: 'error', ts: Date.now() };
                    out.push(msg);
                    emit('multiai-message', { chatId, message: msg });
                    break outer;
                }
                if (raced.ok) {
                    const msg = { who: provider, text: raced.value.response, provider, role: 'assistant', ts: Date.now(), round: r + 1 };
                    out.push(msg);
                    emit('multiai-message', { chatId, message: msg });
                } else {
                    const msg = { who: `${provider} error`, text: raced.error.message, provider, role: 'error', ts: Date.now() };
                    out.push(msg);
                    emit('multiai-message', { chatId, message: msg });
                }
            }
        }
        endSignal(chatId);
        emit('multiai-done', { chatId });
        return { success: true, messages: out };
    });

    ipcMain.handle('multiai-judge', async (event, opts) => {
        const { chatId, topic, messages, judgeProvider } = opts;
        emit('multiai-thinking', { chatId, provider: judgeProvider });
        const transcript = renderTranscript(messages);
        const prompt = `You are an impartial judge. Topic: ${topic}\n\nTranscript:\n${transcript}\n\n` +
            `Deliver a concise verdict: who made the stronger case and why, the single best point from ` +
            `each participant, and any unresolved question. Max 6 sentences.`;
        try {
            const result = await sender.sendMessageToProvider(judgeProvider, prompt);
            const msg = { who: `Judge · ${judgeProvider}`, text: result.response, provider: judgeProvider, role: 'judge', ts: Date.now() };
            emit('multiai-message', { chatId, message: msg });
            emit('multiai-done', { chatId });
            return { success: true, message: msg };
        } catch (e) {
            emit('multiai-done', { chatId });
            return { success: false, error: e.message };
        }
    });

    // ---- Orchestrated mode: crew / workflow / loop ---------------------
    // Same shapes as the MCP server's run_workflow/crew/run_loop tools,
    // reusing their algorithms but calling sendMessageToProvider directly
    // (no need for the MCP server's separate IPC-bridge round-trip, since
    // this code already runs inside the process that owns the providers).

    async function chat(chatId, provider, prompt) {
        const raced = await raceProvider(chatId, sender.sendMessageToProvider(provider, prompt));
        if (raced.cancelled) {
            const err = new Error('Stopped before this reply arrived.');
            err.wasCancelled = true;
            throw err;
        }
        if (!raced.ok) throw raced.error;
        return raced.value.response;
    }

    async function runCrew({ chatId, task, agents }) {
        const list = agents && agents.length ? agents : [
            { role: 'Researcher', provider: 'perplexity', instruction: 'Research the topic thoroughly with facts and citations.' },
            { role: 'Writer', provider: 'claude', instruction: 'Write a detailed, well-structured response based on research.' },
            { role: 'Reviewer', provider: 'chatgpt', instruction: 'Review, improve and polish the output.' },
        ];
        let previousOutput = task;
        const steps = [];
        for (const agent of list) {
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) {
                emit('multiai-orch-step', { chatId, status: 'cancelled', role: agent.role });
                break;
            }
            emit('multiai-orch-step', { chatId, status: 'running', role: agent.role, provider: agent.provider });
            const prompt = `You are a ${agent.role}. ${agent.instruction || ''}\n\nTASK: ${task}\n\n` +
                `${previousOutput !== task ? `PREVIOUS AGENT OUTPUT:\n${previousOutput}\n\n` : ''}` +
                `Provide your best work as a ${agent.role}.`;
            const startMs = Date.now();
            try {
                const output = await chat(chatId, agent.provider, prompt);
                previousOutput = output;
                const step = { role: agent.role, provider: agent.provider, output, elapsedMs: Date.now() - startMs, ok: true };
                steps.push(step);
                emit('multiai-orch-step', { chatId, status: 'done', ...step });
            } catch (e) {
                if (e.wasCancelled) {
                    emit('multiai-orch-step', { chatId, status: 'cancelled', role: agent.role, provider: agent.provider });
                    break;
                }
                const step = { role: agent.role, provider: agent.provider, error: e.message, elapsedMs: Date.now() - startMs, ok: false };
                steps.push(step);
                emit('multiai-orch-step', { chatId, status: 'error', ...step });
            }
        }
        return { finalOutput: previousOutput, steps };
    }

    async function runWorkflow({ chatId, input, steps: stepDefs }) {
        let previousOutput = input || '';
        const fallback = enabledProviders()[0] || 'chatgpt';
        const steps = [];
        for (const [idx, def] of stepDefs.entries()) {
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) {
                emit('multiai-orch-step', { chatId, status: 'cancelled', step: idx + 1 });
                break;
            }
            const provider = def.provider || fallback;
            emit('multiai-orch-step', { chatId, status: 'running', step: idx + 1, task: def.task, provider });
            const prompt = `${def.task}\n\n${previousOutput ? `Input from previous step:\n${previousOutput}` : ''}`;
            const startMs = Date.now();
            try {
                const output = await chat(chatId, provider, prompt);
                previousOutput = output;
                const step = { step: idx + 1, task: def.task, provider, output, elapsedMs: Date.now() - startMs, ok: true };
                steps.push(step);
                emit('multiai-orch-step', { chatId, status: 'done', ...step });
            } catch (e) {
                if (e.wasCancelled) {
                    emit('multiai-orch-step', { chatId, status: 'cancelled', step: idx + 1, provider });
                    break;
                }
                const step = { step: idx + 1, task: def.task, provider, error: e.message, elapsedMs: Date.now() - startMs, ok: false };
                steps.push(step);
                emit('multiai-orch-step', { chatId, status: 'error', ...step });
                break;
            }
        }
        return { finalOutput: previousOutput, steps };
    }

    async function runLoop({ chatId, task, provider, reviewProvider, maxTurns }) {
        const primary = provider || enabledProviders()[0] || 'chatgpt';
        const reviewer = reviewProvider || (enabledProviders().find(p => p !== primary) || 'claude');
        const turns = Math.max(1, Math.min(10, maxTurns || 3));
        let current = task;
        const iterations = [];
        for (let t = 1; t <= turns; t++) {
            const sig = runSignals.get(chatId);
            if (sig && sig.cancelled) {
                emit('multiai-orch-step', { chatId, status: 'cancelled', turn: t });
                break;
            }
            emit('multiai-orch-step', { chatId, status: 'running', turn: t, phase: 'generate', provider: primary });
            const startMs = Date.now();
            let generated;
            try {
                generated = await chat(chatId, primary, t === 1
                    ? `Complete this task:\n\n${task}`
                    : `Revise this work based on the reviewer feedback below.\n\nORIGINAL TASK:\n${task}\n\nPREVIOUS ATTEMPT:\n${current}\n\nREVIEWER FEEDBACK:\n${iterations[iterations.length - 1].feedback}`);
            } catch (e) {
                if (e.wasCancelled) {
                    emit('multiai-orch-step', { chatId, status: 'cancelled', turn: t });
                } else {
                    emit('multiai-orch-step', { chatId, status: 'error', turn: t, error: e.message });
                }
                break;
            }
            current = generated;
            emit('multiai-orch-step', { chatId, status: 'running', turn: t, phase: 'review', provider: reviewer });
            let feedback = '';
            let converged = false;
            try {
                feedback = await chat(chatId, reviewer,
                    `Review this work against the original task. If it fully satisfies the task, reply with ` +
                    `"CONVERGED" as the first word, otherwise give specific, actionable feedback.\n\n` +
                    `ORIGINAL TASK:\n${task}\n\nWORK TO REVIEW:\n${current}`);
                converged = /^\s*CONVERGED/i.test(feedback);
            } catch (e) {
                if (e.wasCancelled) {
                    emit('multiai-orch-step', { chatId, status: 'cancelled', turn: t });
                    break;
                }
                feedback = `(review failed: ${e.message})`;
            }
            const iter = { turn: t, output: current, feedback, converged, elapsedMs: Date.now() - startMs };
            iterations.push(iter);
            emit('multiai-orch-step', { chatId, status: 'done', ...iter });
            if (converged) break;
        }
        return { finalOutput: current, converged: iterations[iterations.length - 1]?.converged || false, iterations };
    }

    ipcMain.handle('multiai-run-orchestrated', async (event, opts) => {
        const { chatId, strategy } = opts;
        startSignal(chatId);
        try {
            let result;
            if (strategy === 'crew') result = await runCrew(opts);
            else if (strategy === 'workflow') result = await runWorkflow(opts);
            else if (strategy === 'loop') result = await runLoop(opts);
            else if (strategy === 'agent') result = await runAgentTools(opts);
            else throw new Error(`Unknown strategy: ${strategy}`);
            endSignal(chatId);
            emit('multiai-orch-done', { chatId });
            return { success: true, ...result };
        } catch (e) {
            endSignal(chatId);
            emit('multiai-orch-done', { chatId });
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerMultiAiHandlers };

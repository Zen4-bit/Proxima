// Proxima — Variants: model × effort seats on the local CLIs.
// Shared by the app (electron/ipc/multiai.cjs → REST, WebSocket, the proxima
// MCP server via IPC) and the standalone variants MCP server
// (src/mcp/variants-server.js), which runs without the app. Plain Node — no
// Electron imports — so it works in both.
//
// A variant is resolved from:
//   - a library agent's name or id (the Multi-AI agent library, CLI routes only),
//   - shorthand  model[:effort]  → "opus:max" (Claude Code), "gpt-5.5:high"
//     (Codex; gpt*/o*/codex* names), "gemini-2.5-flash" (Gemini CLI),
//   - provider + model + effort given explicitly.

// The no-tools clause is the only thing preventing a tool-less seat from
// emitting fabricated <invoke> blocks and inventing tool results, so it is
// always sent — a caller-supplied `system` is appended to it, never substituted
// for it (see NO_TOOLS_CLAUSE below). Kept in step with DISCUSSION_SYSTEM_PROMPT
// in electron/providers/cli.cjs, including "Never run commands."
const NO_TOOLS_CLAUSE =
    'You have no tools and no filesystem. Do not narrate what you would do with tools, and never emit tool-call ' +
    'syntax or invent the results of a tool call. Never run commands.';

const ONE_SHOT_SYSTEM_PROMPT =
    'You are answering one question from another program through a local CLI. ' + NO_TOOLS_CLAUSE +
    ' Reply in plain text (light Markdown is fine). Answer directly and completely.';

const VARIANT_PREFIX = /^(cli|variant):\s*/i;

// Model ids and effort levels become argv elements for a spawned CLI, so they
// are validated here rather than trusted. `body.model` / `body.effort` arrive
// from callers we do not control — REST /v1/multiai/variants/ask,
// /v1/chat/completions, the WebSocket ask_variant action and the ask_variant
// MCP tool — i.e. potentially from another model. The class matches what the
// shorthand form already allowed, including Claude Code's `[1m]` suffix.
const SAFE_CLI_ARG = /^[A-Za-z0-9._:[\]-]+$/;

function safeCliArg(value, field) {
    const s = String(value);
    if (!SAFE_CLI_ARG.test(s)) throw err(400, `${field} may only contain letters, digits and . _ : - [ ]`);
    return s;
}

function err(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function providerForShorthand(model) {
    if (/^(gpt|o\d|codex)/i.test(model)) return 'codex-cli';
    if (/^gemini/i.test(model)) return 'gemini-cli';
    return 'claude-cli';
}

// Extract the user message and system text from an OpenAI-style body.
function fromChatBody(body) {
    body = body || {};
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const text = (c) => Array.isArray(c) ? c.map(p => (p && typeof p === 'object' && p.type === 'text') ? p.text : (typeof p === 'string' ? p : '')).join('\n') : String(c == null ? '' : c);
    const system = msgs.filter(m => m && m.role === 'system').map(m => text(m.content)).join('\n\n').trim();
    const turns = msgs.filter(m => m && m.role !== 'system');
    let message;
    if (turns.length <= 1) message = turns.length ? text(turns[0].content) : (body.message || body.prompt || '');
    else message = turns.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text(m.content)}`).join('\n\n') + '\n\nAssistant:';
    return { message: String(message || '').trim(), system: system || undefined };
}

function createVariants({ cli, core, loadLibrary, dataDir }) {
    function agentLibrary() {
        let lib = [];
        try { lib = loadLibrary() || []; } catch { lib = []; }
        if (!Array.isArray(lib)) lib = [];
        return core.normalizeAgents({ agents: lib.map(a => Object.assign({}, a, { enabled: true })) }, { includeDisabled: true })
            .map((a, i) => Object.assign(a, { uid: lib[i] && lib[i].uid }))
            .filter(a => core.CLI_PROVIDERS[a.provider]);
    }

    async function variants({ probe = false } = {}) {
        const info = await cli.discover({ force: probe });
        const library = agentLibrary().map(a => ({
            id: a.id, name: a.name, provider: a.provider, model: a.model || '', effort: a.effort || '', persona: !!a.persona,
        }));
        return { cli: info, library };
    }

    // Is this OpenAI `model` field one of ours? "cli:…" / "variant:…" always;
    // a bare library name or id also counts.
    function isVariantModel(model) {
        const m = String(model || '').trim();
        if (!m) return false;
        if (VARIANT_PREFIX.test(m)) return true;
        return !!core.findAgent(agentLibrary(), m);
    }

    function resolveVariant(body) {
        body = body || {};
        let agent = null;
        let ref = body.variant != null ? String(body.variant).trim() : '';
        ref = ref.replace(VARIANT_PREFIX, '');
        if (ref) {
            agent = core.findAgent(agentLibrary(), ref);
            if (!agent) {
                const m = /^([a-z0-9.\-\[\]]+)(?::([a-z]+))?$/i.exec(ref);
                if (m) agent = core.normalizeAgents({ agents: [{ provider: providerForShorthand(m[1]), model: m[1], effort: m[2] || '' }] })[0];
                else throw err(404, `Unknown variant "${ref}" — see the variants list`);
            }
        } else {
            const provider = String(body.provider || 'claude-cli');
            if (!core.CLI_PROVIDERS[provider]) throw err(400, `provider must be one of ${Object.keys(core.CLI_PROVIDERS).join(', ')}`);
            agent = core.normalizeAgents({ agents: [{ provider, model: body.model ? safeCliArg(body.model, 'model') : '', effort: body.effort ? safeCliArg(body.effort, 'effort') : '' }] })[0];
        }
        if (body.model && ref) agent.model = safeCliArg(body.model, 'model');
        if (body.effort !== undefined && body.effort !== null && body.effort !== '') agent.effort = safeCliArg(body.effort, 'effort');
        return agent;
    }

    async function askVariant(body) {
        body = body || {};
        const agent = resolveVariant(body);
        const message = String(body.message || '').trim();
        if (!message) throw err(400, 'message is required');
        const kind = core.CLI_PROVIDERS[agent.provider].bin;
        if (!cli.availability()[kind]) throw err(503, `${core.providerLabel(agent.provider)} is not installed (no \`${kind}\` on PATH)`);
        // A caller's own system prompt is appended, not substituted: every
        // OpenAI-compatible client sends one, and letting it replace the
        // no-tools clause puts the seat back into fabricating tool calls.
        const callerSystem = body.system ? String(body.system).trim() : '';
        const system = [
            callerSystem ? `${NO_TOOLS_CLAUSE}\n\n${callerSystem}` : ONE_SHOT_SYSTEM_PROMPT,
            agent.persona ? `\n[Persona]\n${agent.persona}` : '',
        ].join('');
        const started = Date.now();
        const timeoutMs = Math.max(30000, Math.min(20 * 60 * 1000, Number(body.timeoutMs) || 10 * 60 * 1000));
        const handle = cli.run(agent.provider, { model: agent.model || undefined, effort: agent.effort || undefined, prompt: message, systemPrompt: system, cwd: dataDir(), timeoutMs });
        const r = await handle.promise;
        return { variant: agent.name, id: agent.id, provider: agent.provider, model: r.model || agent.model || null, effort: agent.effort || null, text: r.text, ms: Date.now() - started, costUsd: r.costUsd || null };
    }

    // Fan-out: every seat answers or reports its own error.
    async function askVariants(body) {
        body = body || {};
        const list = Array.isArray(body.variants) ? body.variants : [];
        if (!list.length) throw err(400, 'variants[] is required');
        if (list.length > 8) throw err(400, 'at most 8 variants per call');
        const results = await Promise.all(list.map(async (v) => {
            try { return Object.assign({ ok: true }, await askVariant({ variant: v, message: body.message, system: body.system, timeoutMs: body.timeoutMs })); }
            catch (e) { return { ok: false, variant: String(v), error: e.message, status: e.status || 500 }; }
        }));
        return { results };
    }

    // OpenAI-style /v1/models entries for the library seats and the CLIs' own
    // models (from the cached discovery; nothing until it has run).
    function variantModels() {
        const out = [];
        const now = Math.floor(Date.now() / 1000);
        for (const a of agentLibrary()) {
            out.push({ id: `cli:${a.id}`, object: 'model', created: now, owned_by: 'proxima', provider: a.provider, status: 'enabled',
                description: `${a.name} — ${core.providerLabel(a.provider)} · ${a.model || 'default model'} · ${a.effort || 'default effort'}`, variant: a.name });
        }
        const d = cli.discovered && cli.discovered();
        if (d) {
            for (const [kind, provider] of [['claude', 'claude-cli'], ['codex', 'codex-cli'], ['gemini', 'gemini-cli']]) {
                const info = d[kind];
                if (!info || !info.available || info.loggedIn === false) continue;
                for (const m of info.models || []) {
                    out.push({ id: `cli:${m.id}`, object: 'model', created: now, owned_by: 'proxima', provider, status: 'enabled',
                        description: `${core.providerLabel(provider)} ${m.label && m.label !== m.id ? m.label : m.id}${m.efforts && m.efforts.length ? ` (effort: ${m.efforts.join('/')})` : ''} — add :effort, e.g. cli:${m.id}:${(m.efforts && m.efforts[m.efforts.length - 1]) || 'high'}` });
                }
            }
        }
        return out;
    }

    // OpenAI chat.completion envelope for an askVariant result.
    function completionFor(r, requestedModel) {
        return {
            id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
            model: requestedModel || `cli:${r.id}`,
            choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            proxima: { variant: r.variant, provider: r.provider, model: r.model, effort: r.effort, responseTimeMs: r.ms, costUsd: r.costUsd },
        };
    }

    return { agentLibrary, variants, resolveVariant, askVariant, askVariants, variantModels, isVariantModel, completionFor, fromChatBody, ONE_SHOT_SYSTEM_PROMPT };
}

module.exports = { createVariants, fromChatBody, providerForShorthand, ONE_SHOT_SYSTEM_PROMPT, VARIANT_PREFIX };

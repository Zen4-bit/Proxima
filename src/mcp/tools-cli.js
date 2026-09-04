// Proxima — MCP tools for the local-CLI "variants".
// A variant is a model × effort seat on a locally installed, subscription-
// authenticated CLI (Claude Code, Codex, Gemini CLI). These tools let any MCP
// client ask one variant, or fan a question out to several and compare —
// without API keys — and list what the CLIs on this machine actually offer
// (versions, models, effort levels, login state) plus the named variants in
// the Multi-AI agent library. They go through the Agent Hub IPC bridge, so
// the app's discovery cache, library and concurrency caps apply.

function fmtCli(kind, info) {
    if (!info) return `${kind}: unknown`;
    if (!info.available) return `${info.label || kind}: not installed`;
    const bits = [`${info.label || kind} ${info.version || ''}`.trim()];
    if (info.loggedIn === false) bits.push('NOT LOGGED IN — ' + (info.note || 'run it once and sign in'));
    if (info.efforts && info.efforts.length) bits.push(`efforts: ${info.efforts.join(', ')}`);
    if (info.defaultModel) bits.push(`default model: ${info.defaultModel}${info.defaultModelListed === false ? ' (⚠ not on its list)' : ''}`);
    if (info.defaultEffort) bits.push(`default effort: ${info.defaultEffort}`);
    const lines = [bits.join('  ·  ')];
    for (const m of info.models || []) {
        lines.push(`    - ${m.id}${m.label && m.label !== m.id ? ` (${m.label})` : ''}${m.efforts && m.efforts.length ? `  efforts: ${m.efforts.join('/')}` : ''}${m.defaultEffort ? `  default ${m.defaultEffort}` : ''}`);
    }
    for (const p of info.profiles || []) lines.push(`    - profile "${p.name}": ${p.model || '?'} · ${p.effort || 'default effort'}`);
    if (info.note && info.loggedIn !== false) lines.push(`    ${info.note}`);
    return lines.join('\n');
}

export function register(server, deps) {
    const { z, toolResponse, toolError, ipcClient } = deps;

    const ipc = async (action, data) => {
        const r = await ipcClient.send(action, null, data || {});
        if (!r || r.success === false) throw new Error((r && r.error) || `${action} failed`);
        return r;
    };

    const VARIANT_DESC = 'A library variant by name/id (e.g. "Opus max", "gpt-low"), or shorthand model[:effort] — "opus:max", "sonnet:low", "gpt-5.5:high", "gemini-3.1-pro". Model names starting with gpt/o-series/codex go to Codex, gemini* to Gemini CLI, anything else to Claude Code.';

    server.registerTool('cli_variants', {
        title: 'Local CLI variants',
        description: 'What the locally installed CLIs (Claude Code, Codex, Gemini CLI) offer on this machine — version, models, effort levels, defaults, login state — plus the named variants (model × effort seats) saved in Proxima\'s Multi-AI agent library. Use it before ask_variant / ask_variants to pick valid model and effort values. probe=true re-runs discovery (a second or two).',
        inputSchema: { probe: z.boolean().optional().describe('Re-probe the CLIs instead of using the cached discovery') },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async ({ probe }) => {
        try {
            const r = await ipc('multiaiVariants', { probe: !!probe });
            const cli = r.cli || {};
            const lib = r.library || [];
            const out = [
                'CLIs on this machine:',
                fmtCli('claude', cli.claude), fmtCli('codex', cli.codex), fmtCli('gemini', cli.gemini),
                '',
                lib.length ? `Library variants (use the name or id with ask_variant):\n${lib.map(v => `  - ${v.name} [${v.id}]: ${v.provider} · ${v.model || 'default model'} · ${v.effort || 'default effort'}${v.persona ? ' · persona' : ''}`).join('\n')}`
                    : 'Library variants: none yet — add CLI agents in the Multi-AI tab, or use shorthand like "opus:max" / "gpt-5.5:high".',
            ];
            return toolResponse(out.join('\n'));
        } catch (err) { return toolError(err); }
    });

    server.registerTool('ask_variant', {
        title: 'Ask a local CLI variant',
        description: 'Ask one question through a locally installed CLI on the user\'s subscription (Claude Code / Codex / Gemini CLI) at a chosen model and reasoning effort — no API key. One-shot, no tools, no memory between calls. Returns the answer, the model that ran and the time taken. See cli_variants for valid models and efforts.',
        inputSchema: {
            message: z.string().describe('The question or task'),
            variant: z.string().optional().describe(VARIANT_DESC),
            provider: z.enum(['claude-cli', 'codex-cli', 'gemini-cli']).optional().describe('Used when no variant is given (default claude-cli)'),
            model: z.string().optional().describe('Model alias/id — overrides the variant\'s model'),
            effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Reasoning effort — overrides the variant\'s effort (clamped to what the model supports)'),
            system: z.string().optional().describe('System prompt (default: a plain one-shot assistant prompt)'),
            timeoutSeconds: z.number().int().min(30).max(1200).optional().describe('Give up after this long (default 600)'),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ message, variant, provider, model, effort, system, timeoutSeconds }) => {
        try {
            const r = await ipc('multiaiAskVariant', { message, variant, provider, model, effort, system, timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined });
            return toolResponse(`[${r.variant} · ${r.provider} · ${r.model || 'default'}${r.effort ? ' · ' + r.effort : ''} · ${(r.ms / 1000).toFixed(1)}s${r.costUsd ? ' · $' + r.costUsd.toFixed(4) : ''}]\n${r.text}`);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('ask_variants', {
        title: 'Ask several local CLI variants',
        description: 'Send the SAME message to several local CLI variants in parallel (bounded by each CLI\'s concurrency cap) and get every answer side by side — e.g. ["opus:max","sonnet:low","gpt-5.5:high"] to compare models and effort levels on your subscriptions. Failures are reported per variant; the rest still return.',
        inputSchema: {
            message: z.string().describe('The question or task'),
            variants: z.array(z.string()).min(1).max(8).describe('Variants to ask — ' + VARIANT_DESC),
            system: z.string().optional().describe('System prompt for all of them'),
            timeoutSeconds: z.number().int().min(30).max(1200).optional(),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ message, variants, system, timeoutSeconds }) => {
        const results = await Promise.all(variants.map(async (v) => {
            try {
                const r = await ipc('multiaiAskVariant', { message, variant: v, system, timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined });
                return `## ${r.variant} — ${r.provider} · ${r.model || 'default'}${r.effort ? ' · ' + r.effort : ''} · ${(r.ms / 1000).toFixed(1)}s\n${r.text}`;
            } catch (err) {
                return `## ${v} — FAILED\n${err.message}`;
            }
        }));
        return toolResponse(results.join('\n\n'));
    });
}

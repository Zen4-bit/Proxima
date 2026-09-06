// Proxima — MCP local-CLI variant tools tests.
// cli_variants / ask_variant / ask_variants translate to the multiaiVariants /
// multiaiAskVariant IPC actions and render the results.

import test from 'node:test';
import assert from 'node:assert';
import { register } from '../../src/mcp/tools-cli.js';
import { makeHarness, textOf } from '../fixtures/mcp-harness.js';

function harness(reply) {
    const h = makeHarness({ ipcReply: reply });
    register(h.server, h.deps);
    return h;
}

const discovery = {
    claude: { available: true, label: 'Claude Code', version: '2.1.259', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: [{ id: 'opus', label: 'opus' }, { id: 'sonnet', label: 'sonnet' }], note: 'Aliases or full names.' },
    codex: { available: true, label: 'Codex', version: '0.142.5', efforts: ['low', 'medium', 'high', 'xhigh'], models: [{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }], defaultModel: 'gpt-5.6-sol', defaultModelListed: false, profiles: [{ name: 'fast', model: 'gpt-5.5', effort: 'low' }] },
    gemini: { available: true, label: 'Gemini CLI', version: '0.44.1', efforts: [], models: [], loggedIn: false, note: 'Not configured: run gemini once.' },
};

test('tools-cli: registers the 3 tools', () => {
    const h = harness();
    assert.deepEqual([...h.tools.keys()].sort(), ['ask_variant', 'ask_variants', 'cli_variants']);
});

test('cli_variants: renders CLIs (versions, models, efforts, defaults, login) and the library variants', async () => {
    const h = harness(() => ({ success: true, cli: discovery, library: [{ id: 'opus-max', name: 'Opus max', provider: 'claude-cli', model: 'opus', effort: 'max', persona: true }] }));
    const out = textOf(await h.tools.get('cli_variants').handler({ probe: true }));
    assert.deepEqual(h.ipcCalls[0], ['multiaiVariants', null, { probe: true }]);
    assert.match(out, /Claude Code 2\.1\.259.*efforts: low, medium, high, xhigh, max/);
    assert.match(out, /- gpt-5\.5 \(GPT-5\.5\)\s+efforts: low\/medium\/high\/xhigh\s+default medium/);
    assert.match(out, /default model: gpt-5\.6-sol \(⚠ not on its list\)/);
    assert.match(out, /profile "fast": gpt-5\.5 · low/);
    assert.match(out, /Gemini CLI 0\.44\.1.*NOT LOGGED IN/);
    assert.match(out, /- Opus max \[opus-max\]: claude-cli · opus · max · persona/);
});

test('ask_variant: forwards variant/provider/model/effort/system and renders the header + answer', async () => {
    const h = harness((action, _n, d) => ({ success: true, variant: d.variant || 'ad hoc', id: 'x', provider: 'codex-cli', model: d.model || 'gpt-5.5', effort: d.effort || null, text: `answer to ${d.message}`, ms: 4200, costUsd: null }));
    const out = textOf(await h.tools.get('ask_variant').handler({ message: 'why?', variant: 'gpt-5.5:high', effort: 'xhigh', system: 'Be brief.', timeoutSeconds: 90 }));
    assert.equal(h.ipcCalls[0][0], 'multiaiAskVariant');
    assert.deepEqual(h.ipcCalls[0][2], { message: 'why?', variant: 'gpt-5.5:high', provider: undefined, model: undefined, effort: 'xhigh', system: 'Be brief.', timeoutMs: 90000 });
    assert.match(out, /^\[gpt-5\.5:high · codex-cli · gpt-5\.5 · xhigh · 4\.2s\]\nanswer to why\?$/);
});

test('ask_variants: fans out, keeps going when one variant fails', async () => {
    const h = harness((action, _n, d) => d.variant === 'gemini-3.1-pro'
        ? { success: false, error: 'Gemini CLI is not logged in' }
        : { success: true, variant: d.variant, provider: 'claude-cli', model: d.variant.split(':')[0], effort: d.variant.split(':')[1] || null, text: `${d.variant} says hi`, ms: 1000 });
    const out = textOf(await h.tools.get('ask_variants').handler({ message: 'hi', variants: ['opus:max', 'gemini-3.1-pro', 'sonnet:low'] }));
    assert.equal(h.ipcCalls.length, 3);
    assert.match(out, /## opus:max — claude-cli · opus · max · 1\.0s\nopus:max says hi/);
    assert.match(out, /## gemini-3\.1-pro — FAILED\nGemini CLI is not logged in/);
    assert.match(out, /## sonnet:low — claude-cli · sonnet · low/);
});

// The harness calls handlers directly, so nothing here exercises the declared
// input schema — every constraint in the tool descriptions (effort is one of
// six values, timeoutSeconds 30-1200, variants 1-8) was asserted only by a
// human reading it. inputSchema is a raw zod *shape*, not a composed schema, so
// it has no .parse() of its own; the SDK wraps it in z.object() before
// validating, and so does this.
test('tool schemas: the declared input constraints actually reject bad arguments', async () => {
    const { z } = await import('zod');
    const h = harness(async () => ({ ok: true }));
    const parse = (name, args) => z.object(h.tools.get(name).meta.inputSchema).parse(args);

    assert.throws(() => parse('ask_variant', { variant: 'opus', message: 'hi', effort: 'turbo' }), /effort/i);
    assert.doesNotThrow(() => parse('ask_variant', { variant: 'opus', message: 'hi', effort: 'max' }));

    assert.throws(() => parse('ask_variant', { variant: 'opus', message: 'hi', timeoutSeconds: 5 }));
    assert.throws(() => parse('ask_variant', { variant: 'opus', message: 'hi', timeoutSeconds: 5000 }));
    assert.doesNotThrow(() => parse('ask_variant', { variant: 'opus', message: 'hi', timeoutSeconds: 600 }));

    assert.throws(() => parse('ask_variants', { message: 'hi', variants: [] }));
    assert.throws(() => parse('ask_variants', { message: 'hi', variants: Array(9).fill('opus') }));
    assert.doesNotThrow(() => parse('ask_variants', { message: 'hi', variants: Array(8).fill('opus') }));
});

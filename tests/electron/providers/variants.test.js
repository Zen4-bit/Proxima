// Proxima — variants module tests (shared by the app and the standalone MCP).
// Resolution of library names / shorthand / explicit seats, OpenAI-body
// extraction, /v1/models entries and the chat.completion envelope, with a
// fake CLI runner.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../../electron/ipc/multiai-core.cjs');
const { createVariants, fromChatBody, providerForShorthand } = require('../../../electron/providers/variants.cjs');

function fakeCli({ avail = { claude: true, codex: true, gemini: false }, discovered = null } = {}) {
    const calls = [];
    return {
        calls,
        availability: () => avail,
        discover: async () => discovered || {},
        discovered: () => discovered,
        run(provider, opts) {
            calls.push({ provider, opts });
            return { promise: Promise.resolve({ text: `${provider}:${opts.model || 'default'}:${opts.effort || 'none'}`, model: opts.model || null }), abort() { } };
        },
    };
}

function make(lib, cliOpts) {
    const cli = fakeCli(cliOpts);
    const v = createVariants({ cli, core, loadLibrary: () => lib, dataDir: () => '/tmp' });
    return { v, cli };
}

const LIB = [
    { uid: 'u1', name: 'Opus max', provider: 'claude-cli', model: 'opus', effort: 'max', persona: 'Be terse.' },
    { uid: 'u2', name: 'Claude tab', provider: 'claude', route: 'browser' },
    { uid: 'u3', name: 'GPT low', provider: 'codex-cli', model: 'gpt-5.5', effort: 'low' },
];

test('providerForShorthand: gpt/o*/codex → Codex, gemini* → Gemini CLI, else Claude Code', () => {
    assert.equal(providerForShorthand('gpt-5.5'), 'codex-cli');
    assert.equal(providerForShorthand('o3'), 'codex-cli');
    assert.equal(providerForShorthand('gemini-2.5-flash'), 'gemini-cli');
    assert.equal(providerForShorthand('opus'), 'claude-cli');
});

test('variants(): only CLI library agents are seats; discovery rides along', async () => {
    const { v } = make(LIB, { discovered: { claude: { available: true } } });
    const r = await v.variants();
    assert.deepEqual(r.library.map(x => [x.id, x.provider, x.persona]), [['opus-max', 'claude-cli', true], ['gpt-low', 'codex-cli', false]]);
    assert.deepEqual(r.cli, { claude: { available: true } });
});

test('resolveVariant + askVariant: name, "cli:" prefix, shorthand, explicit seat, overrides, persona as system', async () => {
    const { v, cli } = make(LIB);
    const a = await v.askVariant({ variant: 'Opus max', message: 'hi' });
    assert.deepEqual([a.variant, a.provider, a.model, a.effort, a.text], ['Opus max', 'claude-cli', 'opus', 'max', 'claude-cli:opus:max']);
    assert.ok(cli.calls[0].opts.systemPrompt.includes('[Persona]') && cli.calls[0].opts.systemPrompt.includes('Be terse.'));
    const b = await v.askVariant({ variant: 'cli:gpt-low', message: 'hi', effort: 'xhigh' });
    assert.deepEqual([b.provider, b.model, b.effort], ['codex-cli', 'gpt-5.5', 'xhigh']);
    const c = await v.askVariant({ variant: 'variant: sonnet:low', message: 'hi', system: 'Custom.' });
    assert.deepEqual([c.provider, c.model, c.effort], ['claude-cli', 'sonnet', 'low']);
    assert.ok(cli.calls[2].opts.systemPrompt.startsWith('Custom.'));
    const d = await v.askVariant({ provider: 'codex-cli', model: 'gpt-5.4', message: 'hi' });
    assert.equal(d.model, 'gpt-5.4');
    await assert.rejects(v.askVariant({ variant: 'no such seat here', message: 'hi' }), /Unknown variant/);
    await assert.rejects(v.askVariant({ variant: 'gemini-2.5-flash', message: 'hi' }), /Gemini CLI is not installed/);
    await assert.rejects(v.askVariant({ variant: 'opus', message: '  ' }), /message is required/);
    await assert.rejects(v.askVariant({ provider: 'chatgpt', message: 'hi' }), /provider must be/);
});

test('askVariants: every seat reports; a failure does not sink the others', async () => {
    const { v } = make(LIB);
    const r = await v.askVariants({ message: 'hi', variants: ['opus:max', 'gemini-2.5-flash', 'GPT low'] });
    assert.deepEqual(r.results.map(x => x.ok), [true, false, true]);
    assert.match(r.results[1].error, /Gemini CLI is not installed/);
    await assert.rejects(v.askVariants({ message: 'hi', variants: [] }), /variants\[\] is required/);
});

test('isVariantModel / variantModels / completionFor: OpenAI-compatible surface', async () => {
    const discovered = { claude: { available: true, models: [{ id: 'opus' }, { id: 'sonnet' }] }, codex: { available: true, models: [{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'high'] }] }, gemini: { available: true, loggedIn: false, models: [{ id: 'gemini-x' }] } };
    const { v } = make(LIB, { discovered });
    assert.equal(v.isVariantModel('cli:opus:max'), true);
    assert.equal(v.isVariantModel('Opus max'), true, 'a library seat name counts');
    assert.equal(v.isVariantModel('gpt-low'), true, 'so does its id');
    assert.equal(v.isVariantModel('gemini:3.1-pro'), false, 'provider:engine syntax stays with the browser route');
    assert.equal(v.isVariantModel('auto'), false);
    const ids = v.variantModels().map(m => m.id);
    assert.deepEqual(ids, ['cli:opus-max', 'cli:gpt-low', 'cli:opus', 'cli:sonnet', 'cli:gpt-5.5'], "library seats, then the CLIs' models; a CLI that is not logged in is skipped");
    assert.match(v.variantModels()[4].description, /effort: low\/high.*cli:gpt-5\.5:high/);
    const r = await v.askVariant({ variant: 'cli:opus:max', message: 'hi' });
    const c = v.completionFor(r, 'cli:opus:max');
    assert.equal(c.object, 'chat.completion');
    assert.equal(c.choices[0].message.content, 'claude-cli:opus:max');
    assert.equal(c.proxima.effort, 'max');
});

test('fromChatBody: last user turn, system messages, multi-turn transcript, content parts', () => {
    assert.deepEqual(fromChatBody({ messages: [{ role: 'user', content: 'hi' }] }), { message: 'hi', system: undefined });
    assert.deepEqual(fromChatBody({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), { message: 'hi', system: 'Be brief.' });
    const multi = fromChatBody({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] });
    assert.equal(multi.message, 'User: a\n\nAssistant: b\n\nUser: c\n\nAssistant:');
    assert.equal(fromChatBody({ message: 'plain' }).message, 'plain');
});

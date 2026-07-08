// Proxima — MCP Content Tools Tests.
// Verifies registration of compare, content, debate, and verify tools, including multi-agent aggregates and lazy resolution of BYOK providers.

import test from 'node:test';
import assert from 'node:assert';
import { register } from '../../src/mcp/tools-content.js';
import { registerModule, textOf } from '../fixtures/mcp-harness.js';

test('tools-content: registers exactly content, compare, debate, verify', () => {
    const { tools } = registerModule(register);
    assert.deepEqual([...tools.keys()].sort(), ['compare', 'content', 'debate', 'verify']);
});

test('content: summarize action builds a summarize prompt and returns the reply', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('content').handler({ action: 'summarize', input: 'a long article', detail: 'key points' });
    assert.match(textOf(res), /reply:/);
    assert.match(h.smartChatCalls[0].msg, /Summarize this: a long article/);
    assert.match(h.smartChatCalls[0].msg, /Focus on: key points/);
});

test('content: extract action uses the body over the input', async () => {
    const h = registerModule(register);
    await h.tools.get('content').handler({ action: 'extract', input: 'ignored', detail: 'emails', body: 'the source text' });
    assert.match(h.smartChatCalls[0].msg, /Extract emails from: the source text/);
});

test('content: no enabled providers → clear message, no model call', async () => {
    const h = registerModule(register, { enabled: [] });
    const res = await h.tools.get('content').handler({ action: 'write', input: 'x' });
    assert.match(textOf(res), /No providers available/);
    assert.equal(h.smartChatCalls.length, 0);
});

test('compare: builds a "vs" prompt including the context', async () => {
    const h = registerModule(register);
    await h.tools.get('compare').handler({ item1: 'React', item2: 'Vue', context: 'a dashboard' });
    assert.match(h.smartChatCalls[0].msg, /Compare React vs Vue for a dashboard/);
});

test('debate: with fewer than 2 providers, one AI covers all perspectives', async () => {
    const h = registerModule(register, { enabled: ['claude'] });
    const res = await h.tools.get('debate').handler({ topic: 'AI safety', sides: 3 });
    assert.match(textOf(res), /reply:claude/);
    // numSides is clamped to enabled.size (1) in the single-provider prompt.
    assert.match(h.smartChatCalls[0].msg, /Debate this topic from 1 different perspectives/);
});

test('debate: with 2+ providers, each argues a distinct assigned stance', async () => {
    const h = registerModule(register, { enabled: ['claude', 'gemini'] });
    const res = await h.tools.get('debate').handler({ topic: 'remote work', sides: 2 });
    const parsed = JSON.parse(textOf(res));
    assert.deepEqual(Object.keys(parsed).sort(), ['claude', 'gemini']);
    assert.match(parsed.claude.stance, /FOR/);
    assert.match(parsed.gemini.stance, /AGAINST/);
});

test('debate: includes an enabled BYOK provider not yet in allProviders (lazy resolve)', async () => {
    const h = registerModule(register, {
        enabled: ['claude', 'deepseek'],
        deps: { allProviders: { claude: { name: 'claude' } } },
    });
    const res = await h.tools.get('debate').handler({ topic: 'x', sides: 2 });
    const parsed = JSON.parse(textOf(res));
    assert.deepEqual(Object.keys(parsed).sort(), ['claude', 'deepseek']);
});

test('verify: a single provider is returned under a NAME banner', async () => {
    const h = registerModule(register, { enabled: ['claude'] });
    const res = await h.tools.get('verify').handler({ question: 'is the earth round?' });
    assert.match(textOf(res), /=== CLAUDE ===/);
    assert.match(textOf(res), /reply:claude/);
    // The verify prompt asks for a confidence rating.
    assert.match(h.smartChatCalls[0].msg, /CONFIDENCE/);
});

test('verify: multiple providers are aggregated under separate banners', async () => {
    const h = registerModule(register, { enabled: ['claude', 'gemini'] });
    const res = await h.tools.get('verify').handler({ question: 'q', providers: ['Claude', 'GEMINI'] });
    assert.match(textOf(res), /=== CLAUDE ===/);
    assert.match(textOf(res), /=== GEMINI ===/);
});

test('verify: aggregates an enabled BYOK provider not yet in allProviders', async () => {
    const h = registerModule(register, {
        enabled: ['claude', 'deepseek'],
        deps: { allProviders: { claude: { name: 'claude' } } },
    });
    const res = await h.tools.get('verify').handler({ question: 'q' });
    assert.match(textOf(res), /=== CLAUDE ===/);
    assert.match(textOf(res), /=== DEEPSEEK ===/);
});

test('verify: no enabled providers → "No providers enabled"', async () => {
    const h = registerModule(register, { enabled: [] });
    const res = await h.tools.get('verify').handler({ question: 'q' });
    assert.match(textOf(res), /No providers enabled/);
});

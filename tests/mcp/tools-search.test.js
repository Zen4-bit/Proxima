// Proxima — MCP Search Tools Tests.
// Verifies registration of search tools, deep_search and get_ui_reference prompts, and web_scrape SSRF loopback/schema gating.

import test from 'node:test';
import assert from 'node:assert';
import { register } from '../../src/mcp/tools-search.js';
import { registerModule, textOf } from '../fixtures/mcp-harness.js';

test('tools-search: registers exactly the 4 documented search tools', () => {
    const { tools } = registerModule(register);
    assert.deepEqual([...tools.keys()].sort(), ['ddg_search', 'deep_search', 'get_ui_reference', 'web_scrape']);
});

test('deep_search: builds a typed prompt (github + language) and returns the reply', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('deep_search').handler({ query: 'http client', type: 'github', language: 'Python' });
    assert.equal(textOf(res), 'reply:chatgpt');
    assert.match(h.smartChatCalls[0].msg, /GitHub/);
    assert.match(h.smartChatCalls[0].msg, /Python/);
});

test('deep_search: no enabled providers → clear "no providers" message', async () => {
    const h = registerModule(register, { enabled: [] });
    const res = await h.tools.get('deep_search').handler({ query: 'x' });
    assert.match(textOf(res), /No providers available/);
    assert.equal(h.smartChatCalls.length, 0);
});

test('get_ui_reference: with no code emits a design-concept prompt', async () => {
    const h = registerModule(register);
    await h.tools.get('get_ui_reference').handler({ description: 'landing page', style: 'glassmorphism' });
    assert.match(h.smartChatCalls[0].msg, /DESIGN CONCEPT/);
    assert.match(h.smartChatCalls[0].msg, /glassmorphism/);
});

test('get_ui_reference: with existing code emits a design-analysis + updated-code prompt', async () => {
    const h = registerModule(register);
    await h.tools.get('get_ui_reference').handler({ description: 'improve', code: '<div>hi</div>' });
    assert.match(h.smartChatCalls[0].msg, /DESIGN ANALYSIS/);
    assert.match(h.smartChatCalls[0].msg, /<div>hi<\/div>/);
});

test('web_scrape: blocks a non-http(s) scheme (SSRF guard)', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('web_scrape').handler({ url: 'file:///etc/passwd' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Blocked: scheme not allowed/);
});

test('web_scrape: blocks a loopback address (SSRF guard, no network)', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('web_scrape').handler({ url: 'http://127.0.0.1:1/secret' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Blocked: private\/internal address/);
});

test('web_scrape: blocks an invalid URL string', async () => {
    const h = registerModule(register);
    const res = await h.tools.get('web_scrape').handler({ url: 'not a url' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /Blocked:/);
});

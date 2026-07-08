// Proxima — REST Route Handler Tests.
// Verifies routing logic, session and BYOK models endpoints, function catalogs, stats, validation errors, and static HTML pages.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRouteHandler } = require('../../../electron/api/routes.cjs');

function makeHandler(over = {}) {
    const calls = { json: [], error: [] };
    const deps = {
        API_PREFIX: '/v1',
        VERSION: '5.0.0',
        MODEL_ALIASES: { gpt: 'chatgpt' },
        sendJSON: (res, code, obj) => calls.json.push({ code, obj }),
        sendError: (res, code, msg, type) => calls.error.push({ code, msg, type }),
        getEnabled: () => ['chatgpt', 'claude'],
        resolveModel: (m) => m,
        resolveModels: () => ({ mode: 'single', providers: ['chatgpt'] }),
        pickBestProvider: () => 'chatgpt',
        extractMessage: (body) => body.message || '',
        queryProvider: async () => ({ text: 'ok', responseTimeMs: 1 }),
        queryMultiple: async () => ({ results: {}, timings: {} }),
        formatChatResponse: (r, p) => ({ provider: p, text: r.text }),
        formatAllResponse: (m) => ({ all: m }),
        sendStreamResponse: () => {},
        sendStreamToolCallResponse: () => {},
        getFormattedStats: () => ({ totalRequests: 0 }),
        handleMCPRequest: () => async () => ({ providers: {} }),
        loadApiKey: () => null,
        getDocsPage: () => '<html>docs</html>',
        getAPIKeyPage: () => '<html>key</html>',
        getCLIDocsPage: () => '<html>cli</html>',
        getWSDocsPage: () => '<html>ws</html>',
        scrapeUrl: async () => ({ markdown: '# x', url: 'u', statusCode: 200, metadata: {} }),
        searchDDG: async () => ({ results: [], totalResults: 0, searchTimeMs: 1 }),
        formatResultsMarkdown: () => 'results',
        buildToolCallingPrompt: () => 'tp',
        parseToolCallResponse: () => ({ isToolCall: false }),
        formatToolCallResponse: () => ({}),
        byok: {
            keys: {
                isEnabled: () => false,
                getKey: () => null,
                getModels: () => [],
                getSelectedModel: () => null,
                getStatus: () => ({}),
                KNOWN_PROVIDERS: ['chatgpt', 'claude', 'gemini', 'perplexity'],
                saveKey: () => {},
                removeKey: () => {},
                setEnabled: () => {},
            },
            models: { DEFAULT_MODELS: {} },
            brain: { recall: {}, experience: {}, skills: {}, sessions: {}, getStats: () => ({}) },
            callProvider: async () => ({ text: 'hi', responseTimeMs: 1 }),
        },
        ...over,
    };
    if (over.byok) deps.byok = { ...deps.byok, ...over.byok };
    return { handle: createRouteHandler(deps), calls };
}

function mockRes() {
    return { headersSent: false, _ended: undefined, writeHead() { this.headersSent = true; }, write() {}, end(v) { this._ended = v; } };
}

test('unknown route returns 404', async () => {
    const { handle, calls } = makeHandler();
    await handle('GET', '/v1/nonexistent', {}, mockRes());
    assert.equal(calls.error[0].code, 404);
    assert.match(calls.error[0].msg, /Not found/);
});

test('GET /v1/models (session mode) lists enabled + disabled + auto', async () => {
    const { handle, calls } = makeHandler();
    await handle('GET', '/v1/models', {}, mockRes());
    const body = calls.json[0].obj;
    assert.equal(body.mode, 'session');
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes('chatgpt'));
    assert.ok(ids.includes('auto'));
    // perplexity is not enabled → present but disabled
    const px = body.data.find((m) => m.id === 'perplexity');
    assert.equal(px.status, 'disabled');
});

test('GET /v1/models (BYOK mode) lists per-model entries and mode "api"', async () => {
    const { handle, calls } = makeHandler({
        byok: {
            keys: {
                isEnabled: () => true,
                getModels: (p) => (p === 'chatgpt' ? [{ id: 'gpt-4o', enabled: true }] : []),
                getSelectedModel: () => null,
                getStatus: () => ({}),
                KNOWN_PROVIDERS: ['chatgpt', 'claude', 'gemini', 'perplexity'],
            },
            models: { DEFAULT_MODELS: { claude: 'claude-3' } },
        },
    });
    await handle('GET', '/v1/models', {}, mockRes());
    const body = calls.json[0].obj;
    assert.equal(body.mode, 'api');
    assert.ok(body.data.some((m) => m.id === 'gpt-4o' && m.provider === 'chatgpt'));
});

test('GET /v1/functions returns the function catalog', async () => {
    const { handle, calls } = makeHandler();
    await handle('GET', '/v1/functions', {}, mockRes());
    const body = calls.json[0].obj;
    assert.equal(body.object, 'list');
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some((f) => f.function === 'scrape'));
});

test('GET /v1/stats returns formatted stats with a timestamp', async () => {
    const { handle, calls } = makeHandler();
    await handle('GET', '/v1/stats', {}, mockRes());
    assert.equal(calls.json[0].obj.totalRequests, 0);
    assert.ok(calls.json[0].obj.timestamp);
});

test('POST /v1/chat/completions with no message → 400', async () => {
    const { handle, calls } = makeHandler();
    await handle('POST', '/v1/chat/completions', {}, mockRes());
    assert.equal(calls.error[0].code, 400);
    assert.match(calls.error[0].msg, /No message provided/);
});

test('POST /v1/chat/completions with a nonexistent filePath → 400', async () => {
    const { handle, calls } = makeHandler();
    await handle('POST', '/v1/chat/completions', { message: 'hi', filePath: '/no/such/file-xyz.png' }, mockRes());
    assert.equal(calls.error[0].code, 400);
    assert.match(calls.error[0].msg, /File not found/);
});

test('function "scrape" without a url → 400', async () => {
    const { handle, calls } = makeHandler();
    await handle('POST', '/v1/chat/completions', { function: 'scrape' }, mockRes());
    assert.equal(calls.error[0].code, 400);
    assert.match(calls.error[0].msg, /url required/);
});

test('function "translate" without a target language → 400', async () => {
    const { handle, calls } = makeHandler();
    await handle('POST', '/v1/chat/completions', { function: 'translate', text: 'hello' }, mockRes());
    assert.equal(calls.error[0].code, 400);
    assert.match(calls.error[0].msg, /"to" field required/);
});

test('POST /v1/conversations/new requires a provider', async () => {
    const { handle, calls } = makeHandler();
    await handle('POST', '/v1/conversations/new', {}, mockRes());
    assert.equal(calls.error[0].code, 400);
    assert.match(calls.error[0].msg, /provider/i);
});

test('GET / serves the docs HTML page', async () => {
    const { handle } = makeHandler();
    const res = mockRes();
    await handle('GET', '/', {}, res);
    assert.equal(res._ended, '<html>docs</html>');
});

test('GET /cli, /ws, /api-key serve their pages', async () => {
    const { handle } = makeHandler();
    const cliRes = mockRes(); await handle('GET', '/cli', {}, cliRes);
    const wsRes = mockRes(); await handle('GET', '/ws', {}, wsRes);
    const keyRes = mockRes(); await handle('GET', '/api-key', {}, keyRes);
    assert.equal(cliRes._ended, '<html>cli</html>');
    assert.equal(wsRes._ended, '<html>ws</html>');
    assert.equal(keyRes._ended, '<html>key</html>');
});

test('POST /v1/byok/keys requires provider and key', async () => {
    const { handle, calls } = makeHandler();
    await handle('POST', '/v1/byok/keys', { provider: 'chatgpt' }, mockRes());
    assert.equal(calls.error[0].code, 400);
});

test('POST /v1/byok/keys saves a valid key', async () => {
    let saved = null;
    const { handle, calls } = makeHandler({
        byok: { keys: { isEnabled: () => false, saveKey: (p, k) => { saved = { p, k }; }, getStatus: () => ({}), KNOWN_PROVIDERS: [] } },
    });
    await handle('POST', '/v1/byok/keys', { provider: 'chatgpt', key: 'sk-x' }, mockRes());
    assert.deepEqual(saved, { p: 'chatgpt', k: 'sk-x' });
    assert.equal(calls.json[0].obj.success, true);
});

test('POST /v1/brain/recall requires key and text', async () => {
    const { handle, calls } = makeHandler();
    await handle('POST', '/v1/brain/recall', { key: 'k' }, mockRes());
    assert.equal(calls.error[0].code, 400);
});

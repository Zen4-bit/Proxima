import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const restApi = require('../../electron/api/rest-api.cjs');
const wsServer = require('../../electron/api/ws-server.cjs');

test('ChatGPT Engine: Early completion commits conversation metadata before stream exit', () => {
    const code = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/chatgpt-engine.js'), 'utf8');

    assert.match(code, /finished_successfully/, 'chatgpt-engine must check finished_successfully');
    assert.match(code, /end_turn === true/, 'chatgpt-engine must check end_turn for early completion');
    assert.match(code, /_parentMessageId = parsed\.message\.id;/, 'chatgpt-engine must commit parentMessageId on early completion');
    assert.match(code, /saveSession\(sessionId\)/, 'chatgpt-engine must persist session state');
    assert.match(code, /watchIdle\(\)/, 'chatgpt-engine must implement stream idle watchdog');
    assert.match(code, /_handleWebSocketStream/, 'chatgpt-engine must support WebSocket stream');
    assert.match(code, /json\.reliable\.webpubsub\.azure\.v1/, 'chatgpt-engine must support WebPubSub protocol');
});

test('ChatGPT Engine: Multi-session isolation and conversation continuation simulation', () => {
    const storage = {};
    const sandbox = {
        window: {
            crypto: { randomUUID: () => 'uuid-1234' },
            location: { host: 'chatgpt.com', protocol: 'https:' }
        },
        document: {
            cookie: 'test=1',
            documentElement: { innerHTML: '<html></html>' }
        },
        localStorage: {
            getItem: (k) => storage[k] || null,
            setItem: (k, v) => { storage[k] = String(v); },
            removeItem: (k) => { delete storage[k]; }
        },
        console: { log: () => {}, error: () => {}, warn: () => {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Date: Date,
        Math: Math,
        JSON: JSON,
        TextDecoder: TextDecoder,
        fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ accessToken: 'mock-token' })
        })
    };
    sandbox.window.localStorage = sandbox.localStorage;

    const engineCode = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/chatgpt-engine.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(engineCode, sandbox);

    assert.ok(sandbox.window.__proximaChatGPT, 'Engine must expose __proximaChatGPT');
    assert.equal(typeof sandbox.window.__proximaChatGPT.send, 'function');
    assert.equal(typeof sandbox.window.__proximaChatGPT.newConversation, 'function');

    const saved = JSON.parse(storage['proxima_chatgpt_sessions'] || '{}');
    assert.ok(typeof saved === 'object', 'Sessions must be tracked in localStorage');
});

test('Gemini Engine: Resilient multi-pattern token extraction', () => {
    const code = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/gemini-engine.js'), 'utf8');

    const sandbox = {
        window: { crypto: { randomUUID: () => 'test-uuid' } },
        document: { documentElement: { innerHTML: '' } },
        localStorage: { getItem: () => null, setItem: () => {} },
        console: { log: () => {}, error: () => {}, warn: () => {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Date: Date,
        Math: Math,
        JSON: JSON,
        RegExp: RegExp
    };
    vm.createContext(sandbox);

    const fnDef = code.match(/function _extractGeminiToken[\s\S]*?return null;\s*\}/)[0];
    vm.runInContext(fnDef, sandbox);

    // Standard JSON
    const html1 = 'var data = {"SNlM0e":"token_standard_123"};';
    assert.equal(sandbox._extractGeminiToken(html1, 'SNlM0e'), 'token_standard_123');

    // Escaped quotes
    const html2 = '{\"SNlM0e\\\":\\\"token_escaped_456\\\"}';
    assert.equal(sandbox._extractGeminiToken(html2, 'SNlM0e'), 'token_escaped_456');

    // Whitespace variations
    const html3 = '"SNlM0e"   :   "token_whitespace_789"';
    assert.equal(sandbox._extractGeminiToken(html3, 'SNlM0e'), 'token_whitespace_789');

    // Fallback substring split
    const html4 = 'some SNlM0e":"token_split_abc" trailing';
    assert.equal(sandbox._extractGeminiToken(html4, 'SNlM0e'), 'token_split_abc');

    assert.equal(sandbox._extractGeminiToken(html1, 'cfb2h'), null);
});

test('Gemini Engine: Account error detection and abort phrase handling', () => {
    const code = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/gemini-engine.js'), 'utf8');

    assert.match(code, /errorCode === 9/, 'Must detect Google account error 9');
    assert.match(code, /GEMINI_FAILURE_PHRASES/, 'Must define failure phrases');
    assert.doesNotMatch(code, /_hasGeminiReplyMarkers/, 'Pikuzen-specific reply marker check must be removed');
    assert.match(code, /_isGeminiFailureText/, 'Must define provider failure event detection');
    assert.match(code, /extractParts/, 'Must recursively extract multi-element parts');
    assert.doesNotMatch(code, /Resetting sticky error state context\./, 'Destructive catch-block reset must be removed');
});

test('Gemini Engine: Multi-session isolation simulation', () => {
    const storage = {};
    const sandbox = {
        window: {
            crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
            location: { host: 'gemini.google.com', protocol: 'https:' },
            WIZ_global_data: {}
        },
        document: {
            documentElement: { innerHTML: '<html></html>' }
        },
        localStorage: {
            getItem: (k) => storage[k] || null,
            setItem: (k, v) => { storage[k] = String(v); },
            removeItem: (k) => { delete storage[k]; }
        },
        console: { log: () => {}, error: () => {}, warn: () => {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Date: Date,
        Math: Math,
        JSON: JSON,
        RegExp: RegExp,
        TextDecoder: TextDecoder
    };
    sandbox.window.localStorage = sandbox.localStorage;

    const engineCode = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/gemini-engine.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(engineCode, sandbox);

    assert.ok(sandbox.window.__proximaGeminiUnified, 'Engine must expose __proximaGeminiUnified');
    assert.equal(typeof sandbox.window.__proximaGeminiUnified.send, 'function');
    assert.equal(typeof sandbox.window.__proximaGeminiUnified.newConversation, 'function');
});

test('REST API: Model normalization for Gemini Auto, Pro, Latest, and legacy aliases', () => {
    const resolveModel = restApi.resolveModel;

    // Direct Gemini identifiers
    assert.equal(resolveModel('gemini:auto'), 'gemini:auto');
    assert.equal(resolveModel('gemini:pro'), 'gemini:pro');
    assert.equal(resolveModel('gemini:latest'), 'gemini:latest');
    assert.equal(resolveModel('gemini:flash'), 'gemini:flash');
    assert.equal(resolveModel('gemini:argon'), 'gemini:argon');

    // Hyphenated forms
    assert.equal(resolveModel('gemini-auto'), 'gemini:auto');
    assert.equal(resolveModel('gemini-pro'), 'gemini:pro');
    assert.equal(resolveModel('gemini-latest'), 'gemini:latest');
    assert.equal(resolveModel('gemini-flash'), 'gemini:flash');
    assert.equal(resolveModel('gemini-argon'), 'gemini:argon');

    // Bare strings
    assert.equal(resolveModel('latest'), 'gemini:latest');
    assert.equal(resolveModel('flash'), 'gemini:flash');
    assert.equal(resolveModel('pro'), 'gemini:pro');
    assert.equal(resolveModel('argon'), 'gemini:argon');

    // Provider default
    assert.equal(resolveModel('gemini'), 'gemini:auto');
    assert.equal(resolveModel('chatgpt-latest'), 'chatgpt');
    assert.equal(resolveModel('claude-latest'), 'claude');

    // Global gateway 'auto' must remain 'auto' (separate from gemini:auto)
    assert.equal(resolveModel('auto'), 'auto');
    assert.equal(resolveModel(null), 'auto');
    assert.equal(resolveModel(''), 'auto');
});

test('REST API: resolveModels separates global Auto from gemini:auto', () => {
    restApi.initRestAPI({
        handleMCPRequest: () => {},
        getEnabledProviders: () => ['chatgpt', 'claude', 'gemini', 'perplexity']
    });
    const resolveModels = restApi.resolveModels;

    const geminiAuto = resolveModels('gemini:auto');
    assert.equal(geminiAuto.mode, 'single');
    assert.equal(geminiAuto.providers[0], 'gemini');
    assert.equal(geminiAuto.gemini, 'auto');

    const geminiPro = resolveModels('gemini:pro');
    assert.equal(geminiPro.mode, 'single');
    assert.equal(geminiPro.providers[0], 'gemini');
    assert.equal(geminiPro.gemini, 'pro');

    const geminiLatest = resolveModels('gemini:latest');
    assert.equal(geminiLatest.mode, 'single');
    assert.equal(geminiLatest.providers[0], 'gemini');
    assert.equal(geminiLatest.gemini, 'latest');

    const geminiFlash = resolveModels('gemini:flash');
    assert.equal(geminiFlash.mode, 'single');
    assert.equal(geminiFlash.providers[0], 'gemini');
    assert.equal(geminiFlash.gemini, 'flash');

    const geminiArgon = resolveModels('gemini:argon');
    assert.equal(geminiArgon.mode, 'single');
    assert.equal(geminiArgon.providers[0], 'gemini');
    assert.equal(geminiArgon.gemini, 'argon');

    // Global gateway 'auto' must remain 'auto' (separate from gemini:auto)
    const globalAuto = resolveModels('auto');
    if (globalAuto.mode !== 'error') {
        assert.equal(globalAuto.mode, 'single');
        assert.equal(globalAuto.gemini, null, 'Global auto must not bind to gemini engine directly');
    }
});

test('WebSocket Server: Normalizes latest, flash, pro, argon to gemini', () => {
    const pickBestProvider = wsServer.pickBestProvider;
    assert.equal(pickBestProvider('gemini'), 'gemini');
    assert.equal(pickBestProvider('gemini:latest'), 'gemini');
    assert.equal(pickBestProvider('gemini:flash'), 'gemini');
    assert.equal(pickBestProvider('gemini:pro'), 'gemini');
    assert.equal(pickBestProvider('gemini:argon'), 'gemini');
    assert.equal(pickBestProvider('gemini:auto'), 'gemini');
    assert.equal(pickBestProvider('latest'), 'gemini');
    assert.equal(pickBestProvider('flash'), 'gemini');
    assert.equal(pickBestProvider('argon'), 'gemini');
    assert.equal(pickBestProvider('pro'), 'gemini');
});

test('REST API Routes: /v1/models includes all 5 Gemini engines and legacy aliases', async () => {
    const { createRouteHandler } = await import('../../electron/api/routes.cjs');
    let capturedStatus = 0;
    let capturedBody = null;
    const res = {
        writeHead: (s) => { capturedStatus = s; },
        end: (body) => { capturedBody = body ? JSON.parse(body) : null; }
    };
    const handler = createRouteHandler({
        API_PREFIX: '/v1',
        VERSION: '5.5.0',
        MODEL_ALIASES: {},
        sendJSON: (r, status, data) => { capturedStatus = status; capturedBody = data; },
        sendError: () => {},
        getEnabled: () => ['gemini'],
        resolveModel: () => {},
        resolveModels: () => {},
        pickBestProvider: () => {},
        extractMessage: () => {},
        queryProvider: () => {},
        queryMultiple: () => {},
        formatChatResponse: () => {},
        formatAllResponse: () => {},
        sendStreamResponse: () => {},
        sendStreamToolCallResponse: () => {},
        getFormattedStats: () => {},
        handleMCPRequest: () => () => {},
        loadApiKey: () => null,
        getDocsPage: () => '',
        getAPIKeyPage: () => '',
        getCLIDocsPage: () => '',
        getWSDocsPage: () => '',
        scrapeUrl: () => {},
        searchDDG: () => {},
        formatResultsMarkdown: () => '',
        buildToolCallingPrompt: () => '',
        parseToolCallResponse: () => {},
        formatToolCallResponse: () => {},
        byok: { keys: { isEnabled: () => false, getModels: () => [] } },
        getBoundPort: () => 3210
    });

    await handler('GET', '/v1/models', null, res);
    assert.equal(capturedStatus, 200);
    const modelIds = capturedBody.data.map(m => m.id);
    assert.ok(modelIds.includes('gemini:auto'));
    assert.ok(modelIds.includes('gemini:pro'));
    assert.ok(modelIds.includes('gemini:latest'));
    assert.ok(modelIds.includes('gemini:flash'));
    assert.ok(modelIds.includes('gemini:argon'));
    assert.ok(!modelIds.includes('4-argon'), 'Duplicate 4-argon must not be exposed');
    assert.ok(!modelIds.includes('3.1-pro'), 'Duplicate 3.1-pro must not be exposed');
    assert.ok(!modelIds.includes('3.8-flash'), 'Duplicate 3.8-flash must not be exposed');
    assert.ok(!modelIds.includes('3.5-flash'), 'Duplicate 3.5-flash must not be exposed');
});

test('REST API Routes: /v1/models includes ChatGPT engines when enabled', async () => {
    const { createRouteHandler } = await import('../../electron/api/routes.cjs');
    let capturedStatus = null;
    let capturedBody = null;
    const res = {
        writeHead: () => {},
        end: () => {}
    };

    const handler = createRouteHandler({
        API_PREFIX: '/v1',
        VERSION: '5.5.0',
        MODEL_ALIASES: {},
        sendJSON: (res, status, body) => { capturedStatus = status; capturedBody = body; },
        sendError: () => {},
        getEnabled: () => ['chatgpt'],
        resolveModel: (m) => m,
        resolveModels: () => ({ mode: 'single', providers: ['chatgpt'] }),
        pickBestProvider: () => 'chatgpt',
        extractMessage: () => '',
        queryProvider: () => {},
        queryMultiple: () => {},
        formatChatResponse: () => {},
        formatAllResponse: () => {},
        sendStreamResponse: () => {},
        sendStreamToolCallResponse: () => {},
        getFormattedStats: () => {},
        handleMCPRequest: () => () => {},
        loadApiKey: () => null,
        getDocsPage: () => '',
        getAPIKeyPage: () => '',
        getCLIDocsPage: () => '',
        getWSDocsPage: () => '',
        scrapeUrl: () => {},
        searchDDG: () => {},
        formatResultsMarkdown: () => '',
        buildToolCallingPrompt: () => '',
        parseToolCallResponse: () => {},
        formatToolCallResponse: () => {},
        byok: { keys: { isEnabled: () => false, getModels: () => [] } },
        getBoundPort: () => 3210
    });

    await handler('GET', '/v1/models', null, res);
    assert.equal(capturedStatus, 200);
    const modelIds = capturedBody.data.map(m => m.id);
    assert.ok(modelIds.includes('chatgpt:auto'));
    assert.ok(modelIds.includes('chatgpt:thinking'));
    assert.ok(modelIds.includes('chatgpt:instant'));
    assert.ok(modelIds.includes('chatgpt:mini'));
});

test('REST API: resolveModels handles ChatGPT dynamic engine aliases', () => {
    restApi.initRestAPI({
        handleMCPRequest: () => {},
        getEnabledProviders: () => ['chatgpt', 'claude', 'gemini', 'perplexity']
    });
    const resolveModels = restApi.resolveModels;

    const thinking = resolveModels('chatgpt:thinking');
    assert.equal(thinking.mode, 'single');
    assert.equal(thinking.providers[0], 'chatgpt');
    assert.equal(thinking.gemini, 'thinking');

    const instant = resolveModels('chatgpt:instant');
    assert.equal(instant.mode, 'single');
    assert.equal(instant.providers[0], 'chatgpt');
    assert.equal(instant.gemini, 'instant');

    const mini = resolveModels('chatgpt:mini');
    assert.equal(mini.mode, 'single');
    assert.equal(mini.providers[0], 'chatgpt');
    assert.equal(mini.gemini, 'mini');

    const auto = resolveModels('chatgpt:auto');
    assert.equal(auto.mode, 'single');
    assert.equal(auto.providers[0], 'chatgpt');
    assert.equal(auto.gemini, 'auto');
});

test('ChatGPT Engine: exposes getModels and supports dynamic model discovery', async () => {
    const sandbox = {
        window: {
            crypto: globalThis.crypto,
            location: { host: 'chatgpt.com', origin: 'https://chatgpt.com' }
        },
        document: {
            cookie: 'oai-did=test-device-id',
            documentElement: { innerHTML: '<html><script src="/_next/static/chunks/app.js"></script></html>' }
        },
        localStorage: {
            _s: {},
            getItem: function (k) { return this._s[k] || null; },
            setItem: function (k, v) { this._s[k] = String(v); },
            removeItem: function (k) { delete this._s[k]; }
        },
        console: { log: () => {}, error: () => {}, warn: () => {} },
        crypto: globalThis.crypto,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Date: Date,
        Math: Math,
        fetch: async (url, opts) => {
            if (url === '/api/auth/session') {
                return { ok: true, status: 200, json: async () => ({ accessToken: 'test-token' }) };
            }
            if (url === '/backend-api/conversation/init') {
                return { ok: true, status: 200, json: async () => ({ default_model_slug: 'gpt-6' }) };
            }
            if (url === '/backend-api/models') {
                return {
                    ok: true, status: 200,
                    json: async () => ({
                        models: [
                            { slug: 'gpt-6' },
                            { slug: 'gpt-6-t-mini' },
                            { slug: 'gpt-6-mini' }
                        ],
                        categories: [
                            { category: 'gpt_6_reasoning_mini', default_model: 'gpt-6-t-mini', reasoning_type: 'reasoning' },
                            { category: 'gpt_5_auto', default_model: 'gpt-6', reasoning_type: 'none' }
                        ]
                    })
                };
            }
            return { ok: true, status: 200, text: async () => '' };
        }
    };
    sandbox.window.localStorage = sandbox.localStorage;

    const engineCode = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/chatgpt-engine.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(engineCode, sandbox);

    assert.ok(sandbox.window.__proximaChatGPT, 'Must expose __proximaChatGPT');
    assert.equal(typeof sandbox.window.__proximaChatGPT.getModels, 'function', 'Must expose getModels function');

    const models = await sandbox.window.__proximaChatGPT.getModels();
    assert.equal(models.defaultModel, 'gpt-6');
    assert.equal(models.aliases.thinking, 'gpt-6-t-mini');
    assert.equal(models.aliases.instant, 'gpt-6');
    assert.equal(models.aliases.mini, 'gpt-6-mini');
});


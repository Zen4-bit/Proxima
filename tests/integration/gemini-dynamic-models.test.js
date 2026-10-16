import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const restApi = require('../../electron/api/rest-api.cjs');
const { createRouteHandler } = require('../../electron/api/routes.cjs');
import { getAvailableModelsList } from '../../src/mcp/helpers.js';

function createMockResponse(bodyStreamOrText, status = 200, headers = {}) {
    const isStream = bodyStreamOrText && typeof bodyStreamOrText.getReader === 'function';
    return {
        ok: status >= 200 && status < 300,
        status: status,
        headers: {
            get: (h) => headers[h.toLowerCase()] || (isStream ? 'text/event-stream' : 'application/json')
        },
        text: async () => typeof bodyStreamOrText === 'string' ? bodyStreamOrText : '',
        json: async () => typeof bodyStreamOrText === 'string' ? JSON.parse(bodyStreamOrText) : {},
        body: isStream ? bodyStreamOrText : {
            getReader: () => {
                const chunks = [new TextEncoder().encode(bodyStreamOrText || '')];
                let idx = 0;
                return {
                    read: async () => {
                        if (idx >= chunks.length) return { done: true, value: undefined };
                        return { done: false, value: chunks[idx++] };
                    },
                    cancel: async () => {},
                    releaseLock: () => {}
                };
            }
        }
    };
}

function createGeminiStreamChunk(replyText, convId = 'c_1234567890abcdef', respId = 'r_1234567890abcdef', choiceId = 'rc_1234567890abcdef') {
    // Mimic Google StreamGenerate chunk protocol
    const inner = [
        null,
        [convId, respId],
        { '26': 'mock_context_token_abcdef123456' },
        null,
        [[choiceId, [replyText]]]
    ];
    const envelope = [["wrb.fr", null, JSON.stringify(inner)]];
    return ')]}\'\n\n' + JSON.stringify(envelope) + '\n';
}

function setupGeminiEngine(customFetch, domOptions = {}) {
    const storage = {};
    let currentAccountEmail = domOptions.email || 'py317234@gmail.com';
    let currentPath = domOptions.pathname || '/u/0';

    const getElements = () => {
        if (typeof domOptions.elements === 'function') return domOptions.elements();
        return domOptions.elements || [];
    };

    const documentMock = {
        querySelector: (sel) => {
            if (sel.includes('@') || sel.includes('aria-label')) {
                return {
                    getAttribute: (attr) => attr === 'aria-label' ? `Google Account: ${typeof currentAccountEmail === 'function' ? currentAccountEmail() : currentAccountEmail}` : null
                };
            }
            if (sel === '[data-test-id="bard-mode-menu-button"]') {
                return domOptions.hasMenuButton !== false ? {
                    getAttribute: (attr) => attr === 'aria-controls' ? 'bard-mode-menu' : null,
                    dispatchEvent: () => {}
                } : null;
            }
            if (sel === '[role="menu"]' || sel === '#bard-mode-menu') {
                return {
                    querySelectorAll: (subSel) => getElements()
                };
            }
            return null;
        },
        getElementById: (id) => {
            if (id === 'bard-mode-menu') {
                return {
                    querySelectorAll: (subSel) => getElements()
                };
            }
            return null;
        },
        dispatchEvent: () => {},
        documentElement: {
            innerHTML: domOptions.html || '<html><script>"SNlM0e":"test_snlm0e_token","cfb2h":"boq_assistant-bard-web-server_20261014.00_p0"</script></html>'
        }
    };

    const sandbox = {
        window: {
            crypto: globalThis.crypto,
            location: {
                pathname: currentPath,
                host: 'gemini.google.com'
            },
            WIZ_global_data: domOptions.wiz || {
                tokens: ['SNlM0e', 'test_snlm0e_token', 'cfb2h', 'boq_assistant-bard-web-server_20261014.00_p0']
            }
        },
        document: documentMock,
        localStorage: {
            getItem: (k) => storage[k] || null,
            setItem: (k, v) => { storage[k] = String(v); },
            removeItem: (k) => { delete storage[k]; }
        },
        navigator: {
            userAgent: 'Mozilla/5.0 Test',
            language: 'en-US'
        },
        console: { log: () => {}, error: () => {}, warn: () => {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Date: Date,
        Math: Math,
        JSON: JSON,
        RegExp: RegExp,
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        URLSearchParams: URLSearchParams,
        AbortController: globalThis.AbortController,
        ReadableStream: globalThis.ReadableStream,
        Array: Array,
        btoa: (str) => Buffer.from(String(str), 'binary').toString('base64'),
        atob: (b64) => Buffer.from(String(b64), 'base64').toString('binary'),
        fetch: customFetch || (async () => createMockResponse(createGeminiStreamChunk('Hello from Gemini')))
    };

    sandbox.window.localStorage = sandbox.localStorage;
    sandbox.window.document = sandbox.document;

    const engineCode = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/gemini-engine.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(engineCode, sandbox);

    return {
        api: sandbox.window.__proximaGemini,
        unified: sandbox.window.__proximaGeminiUnified,
        sandbox,
        setAccount: (email, pathname) => {
            currentAccountEmail = email;
            if (pathname) sandbox.window.location.pathname = pathname;
        }
    };
}

// Convert cross-realm VM objects to standard objects
function toPlain(obj) {
    return JSON.parse(JSON.stringify(obj));
}

test('Gemini Engine: Dynamic model discovery from live DOM menu items', async () => {
    const mockElements = [
        {
            innerText: '3.5 Flash-Lite\nFastest answers for quick tasks',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-8c46e95b1a07cecc' : null
        },
        {
            innerText: '3.8 Flash\nAll-around help for everyday tasks',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-56fdd199312815e2' : null
        },
        {
            innerText: '3.1 Pro\nAdvanced reasoning and complex queries',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-e6fa609c3fa255c0' : null
        },
        {
            innerText: '4 Argon\nMost capable pro model for deep tasks',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-95a4c0abcba24364' : null
        }
    ];

    const { api } = setupGeminiEngine(null, { elements: mockElements });
    const models = await api.getAvailableModels();

    assert.ok(Array.isArray(models), 'Must return array of models');
    assert.equal(models.length, 5, 'Must contain Auto + 4 discovered models');

    assert.equal(models[0].slug, 'auto');
    assert.equal(models[0].name, 'Auto (3.5 Flash-Lite)', 'Auto must adopt name of fastest model');
    assert.deepEqual(toPlain(models[0].supported_thinking_levels), ['low', 'medium', 'high']);

    assert.equal(models[1].slug, '3-5-flash-lite');
    assert.equal(models[1].workspaceId, '8c46e95b1a07cecc');
    assert.equal(models[1].tag, 'Fast');

    assert.equal(models[2].slug, '3-8-flash');
    assert.equal(models[2].workspaceId, '56fdd199312815e2');
    assert.equal(models[2].tag, 'All-Around');

    assert.equal(models[3].slug, '3-1-pro');
    assert.equal(models[3].workspaceId, 'e6fa609c3fa255c0');
    assert.equal(models[3].tag, 'Reasoning');

    assert.equal(models[4].slug, '4-argon');
    assert.equal(models[4].workspaceId, '95a4c0abcba24364');
    assert.equal(models[4].tag, 'Pro');
});

test('Gemini Engine: Zero hardcoding — dynamically extracts unknown future models and slugs', async () => {
    const mockElements = [
        {
            innerText: '5 Quantum Ultra\nNext-generation super reasoning engine',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-aabbccddeeff0011' : null
        }
    ];

    const { api } = setupGeminiEngine(null, { elements: mockElements });
    const models = await api.getAvailableModels();

    assert.equal(models.length, 2, 'Auto + 1 future model');
    assert.equal(models[1].slug, '5-quantum-ultra', 'Slug must be dynamically derived without hardcoded tables');
    assert.equal(models[1].workspaceId, 'aabbccddeeff0011');
    assert.equal(models[1].name, '5 Quantum Ultra');
    assert.deepEqual(toPlain(models[1].supported_thinking_levels), ['low', 'medium', 'high']);
});

test('Gemini Engine: Account-scoped caching and cross-account isolation', async () => {
    let currentAccount = 'account_alpha@gmail.com';
    const elementsAlpha = [
        {
            innerText: '3.5 Flash-Lite\nFast answers',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-8c46e95b1a07cecc' : null
        }
    ];
    const elementsBeta = [
        {
            innerText: '4 Argon Pro\nPro capabilities',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-95a4c0abcba24364' : null
        }
    ];

    let currentElements = elementsAlpha;
    const { api, setAccount } = setupGeminiEngine(null, {
        email: () => currentAccount,
        elements: () => currentElements
    });

    const modelsAlpha = await api.getAvailableModels();
    assert.equal(modelsAlpha.length, 2);
    assert.equal(modelsAlpha[1].slug, '3-5-flash-lite');

    currentAccount = 'account_beta@gmail.com';
    currentElements = elementsBeta;
    setAccount('account_beta@gmail.com');

    // Detect new account ID and avoid returning cached models from prior account
    const modelsBeta = await api.getAvailableModels();
    assert.equal(modelsBeta.length, 2);
    assert.equal(modelsBeta[1].slug, '4-argon-pro', 'Account Beta must receive its own models, no leak from Alpha');

    currentAccount = 'account_alpha@gmail.com';
    currentElements = elementsAlpha;
    setAccount('account_alpha@gmail.com');

    const modelsAlpha2 = await api.getAvailableModels();
    assert.equal(modelsAlpha2[1].slug, '3-5-flash-lite', 'Account Alpha recovers its cached models');
});

test('Gemini Engine: Thinking levels retain safe workspaceId string in x-goog-ext-525001261-jspb', async () => {
    const mockElements = [
        {
            innerText: '3.1 Pro\nAdvanced reasoning',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-e6fa609c3fa255c0' : null
        }
    ];

    let capturedHeaders = null;
    const customFetch = async (url, opts) => {
        capturedHeaders = opts.headers;
        return createMockResponse(createGeminiStreamChunk('Thinking level test response'));
    };

    const { api } = setupGeminiEngine(customFetch, { elements: mockElements });

    await api.send('Test message', '3-1-pro', null, 'sess-1', { thinking_level: 'low' });
    assert.ok(capturedHeaders['x-goog-ext-525001261-jspb'], 'Must include extension header');
    const parsedLow = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(parsedLow[4], 'e6fa609c3fa255c0', 'Low thinking level must retain plain workspaceId string');

    await api.send('Test message', '3-1-pro', null, 'sess-1', { thinking_level: 'medium' });
    const parsedMed = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(parsedMed[4], 'e6fa609c3fa255c0', 'Medium thinking level must retain plain workspaceId string');

    await api.send('Test message', '3-1-pro', null, 'sess-1', { thinking_level: 'high' });
    const parsedHigh = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(parsedHigh[4], 'e6fa609c3fa255c0', 'High thinking level must retain plain workspaceId string');

    await api.send('Test message', '3-1-pro', null, 'sess-1', { thinking_level: 'default' });
    const parsedDef = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(parsedDef[4], 'e6fa609c3fa255c0', 'Default thinking level must retain plain workspaceId string');
});

test('Gemini Engine: Explicit selection of unavailable model strictly errors out without silent replacement', async () => {
    const mockElements = [
        {
            innerText: '3.5 Flash-Lite\nFastest answers',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-8c46e95b1a07cecc' : null
        }
    ];

    const { api } = setupGeminiEngine(null, { elements: mockElements });

    await assert.rejects(
        async () => {
            await api.send('Hello', 'nonexistent-model-xyz');
        },
        (err) => {
            assert.match(err.message, /Model 'nonexistent-model-xyz' is not available in the current Google account/);
            assert.match(err.message, /Currently available models: \[3\.5 Flash-Lite\]/);
            assert.match(err.message, /Call 'list_available_models' to view available models and usage instructions/);
            return true;
        }
    );
});

test('Gemini Engine: Rejects invalid thinking levels', async () => {
    const mockElements = [
        {
            innerText: '3.1 Pro\nReasoning',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-e6fa609c3fa255c0' : null
        }
    ];

    const { api } = setupGeminiEngine(null, { elements: mockElements });

    await assert.rejects(
        async () => {
            await api.send('Hello', '3-1-pro', null, 'sess-1', { thinking_level: 'ultra_deep' });
        },
        (err) => {
            assert.match(err.message, /Unsupported thinking_level 'ultra_deep'/);
            return true;
        }
    );
});

test('Gemini Engine: Auto fallback cooldown triggers on 429 quota exhaustion', async () => {
    const mockElements = [
        {
            innerText: '3.5 Flash-Lite\nFastest answers',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-8c46e95b1a07cecc' : null
        },
        {
            innerText: '3.8 Flash\nAll-around help',
            getAttribute: (a) => a === 'data-test-id' ? 'bard-mode-option-56fdd199312815e2' : null
        }
    ];

    let failFirst = true;
    let usedWorkspace = null;

    const customFetch = async (url, opts) => {
        const header = opts.headers['x-goog-ext-525001261-jspb'];
        if (header) {
            const parsed = JSON.parse(header);
            usedWorkspace = parsed[4];
        }
        if (failFirst) {
            failFirst = false;
            return createMockResponse('Usage limit exceeded', 429);
        }
        return createMockResponse(createGeminiStreamChunk('Fallback model reply'));
    };

    const { api } = setupGeminiEngine(customFetch, { elements: mockElements });

    // 429 quota exhaustion triggers fallback to alternate candidate
    const res = await api.send('Auto test message', 'auto');
    assert.equal(res, 'Fallback model reply');
    assert.equal(usedWorkspace, '56fdd199312815e2', 'Should have fallen back to second candidate (3.8 Flash)');
});

test('REST API: Model Resolver parses Gemini engine models and preserves thinking level suffixes', () => {
    assert.equal(restApi.resolveModel('gemini'), 'gemini:auto');
    assert.equal(restApi.resolveModel('gemini:auto'), 'gemini:auto');
    assert.equal(restApi.resolveModel('gemini:3-8-flash'), 'gemini:3-8-flash');
    assert.equal(restApi.resolveModel('gemini:3-1-pro'), 'gemini:3-1-pro');
    assert.equal(restApi.resolveModel('gemini:3-1-pro:high'), 'gemini:3-1-pro:high');
    assert.equal(restApi.resolveModel('gemini:3-8-flash:low'), 'gemini:3-8-flash:low');

    const res = restApi.resolveModels('gemini:3-1-pro:medium', 'mock-byok-key');
    assert.equal(res.mode, 'single');
    assert.deepEqual(res.providers, ['gemini']);
    assert.equal(res.gemini, '3-1-pro:medium');
});

test('REST API: /v1/chat/completions validates thinking_level and reasoning_effort', async () => {
    let capturedThinkingLevel = null;
    let capturedError = null;
    let capturedStatus = 0;

    const mockQueryProvider = async (provider, prompt, filePath, runGemini, onChunk, convId, byokKey, streamRes, byokModelId, runChatgpt, resolvedThinkingLevel) => {
        capturedThinkingLevel = resolvedThinkingLevel;
        return { text: 'Mock completion' };
    };

    const handler = createRouteHandler({
        API_PREFIX: '/v1',
        VERSION: '5.5.0',
        MODEL_ALIASES: {},
        sendJSON: (r, status, data) => { capturedStatus = status; },
        sendError: (r, status, msg, code) => {
            capturedStatus = status;
            capturedError = { message: msg, code };
        },
        getEnabled: () => ['gemini'],
        resolveModel: restApi.resolveModel,
        resolveModels: () => ({ mode: 'single', providers: ['gemini'], gemini: 'auto' }),
        queryProvider: mockQueryProvider,
        formatChatResponse: (res) => res,
        extractMessage: (b) => b.message,
        byok: {
            keys: {
                isEnabled: () => false,
                getKey: () => null
            }
        }
    });

    const runRequest = async (body) => {
        capturedThinkingLevel = null;
        capturedError = null;
        capturedStatus = 0;
        const req = {
            method: 'POST',
            url: '/v1/chat/completions',
            headers: { 'content-type': 'application/json' },
            _proximaBody: body,
            once: () => {},
            removeListener: () => {}
        };
        const res = {
            writeHead: (s) => { capturedStatus = s; },
            end: () => {}
        };
        await handler('POST', '/v1/chat/completions', body, res, req);
    };

    await runRequest({ model: 'gemini', message: 'Hi', thinking_level: 'high' });
    assert.equal(capturedStatus, 200);
    assert.equal(capturedThinkingLevel, 'high');

    await runRequest({ model: 'gemini', message: 'Hi', reasoning_effort: 'low' });
    assert.equal(capturedStatus, 200);
    assert.equal(capturedThinkingLevel, 'low');

    await runRequest({ model: 'gemini', message: 'Hi', reasoning_effort: 'auto' });
    assert.equal(capturedStatus, 200);
    assert.equal(capturedThinkingLevel, 'default');

    await runRequest({ model: 'gemini', message: 'Hi', thinking_level: 'medium', reasoning_effort: 'medium' });
    assert.equal(capturedStatus, 200);
    assert.equal(capturedThinkingLevel, 'medium');

    await runRequest({ model: 'gemini', message: 'Hi', thinking_level: 'low', reasoning_effort: 'high' });
    assert.equal(capturedStatus, 400);
    assert.match(capturedError.message, /Conflicting parameters/);

    await runRequest({ model: 'gemini', message: 'Hi', thinking_level: 'super_extra' });
    assert.equal(capturedStatus, 400);
    assert.match(capturedError.message, /Unsupported thinking_level/);

    await runRequest({ model: 'gemini', message: 'Hi', reasoning_effort: 'extreme' });
    assert.equal(capturedStatus, 400);
    assert.match(capturedError.message, /Unsupported reasoning_effort/);
});

test('MCP: getAvailableModelsList exposes discovered Gemini models with thinking support', async () => {
    const mockIpcClient = {
        send: async (action, provider, data) => {
            if (action === 'getByokStatus') return { success: true, enabled: false, providers: [] };
            if (action === 'getProviderModels' && provider === 'gemini') {
                return {
                    success: true,
                    models: [
                        { id: 'gemini:auto', slug: 'auto', name: 'Auto (3.5 Flash-Lite)', status: 'ready', tag: 'Auto Fast', supported_thinking_levels: ['low', 'medium', 'high'] },
                        { id: 'gemini:3-5-flash-lite', slug: '3-5-flash-lite', name: '3.5 Flash-Lite', status: 'ready', tag: 'Fast', supported_thinking_levels: ['low', 'medium', 'high'] },
                        { id: 'gemini:3-1-pro', slug: '3-1-pro', name: '3.1 Pro', status: 'ready', tag: 'Reasoning', supported_thinking_levels: ['low', 'medium', 'high'] }
                    ]
                };
            }
            return { success: true, models: [] };
        }
    };

    const list = await getAvailableModelsList({
        ipcClient: mockIpcClient,
        getEnabledProviders: () => new Set(['gemini']),
        refresh: false
    });

    assert.ok(list.providers.gemini);
    const geminiModels = list.providers.gemini.models;
    assert.equal(geminiModels.length, 3);
    assert.equal(geminiModels[0].name, 'Auto (3.5 Flash-Lite)');
    assert.deepEqual(toPlain(geminiModels[0].supported_thinking_levels), ['low', 'medium', 'high']);

    assert.deepEqual(geminiModels[1].exact_usage, {
        tool: 'ask_gemini',
        arguments: {
            message: 'Your prompt here',
            model: '3-5-flash-lite',
            thinking_level: 'optional: low | medium | high'
        }
    });
});

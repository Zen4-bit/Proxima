import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const restApi = require('../../electron/api/rest-api.cjs');
import { getAvailableModelsList } from '../../src/mcp/helpers.js';

function setupChatGPTEngine(customFetch) {
    const storage = {};
    const sandbox = {
        window: {
            crypto: { randomUUID: () => 'uuid-' + Math.random().toString(36).substring(2, 9) },
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
        navigator: {
            hardwareConcurrency: 8,
            userAgent: 'Mozilla/5.0 Test',
            language: 'en-US',
            languages: ['en-US']
        },
        screen: { width: 1920, height: 1080 },
        performance: { now: () => Date.now() },
        crypto: globalThis.crypto,
        Int32Array: Int32Array,
        Uint8Array: Uint8Array,
        Array: Array,
        console: { log: () => {}, error: () => {}, warn: () => {} },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        Date: Date,
        Math: Math,
        JSON: JSON,
        TextDecoder: TextDecoder,
        TextEncoder: TextEncoder,
        AbortController: AbortController,
        ReadableStream: globalThis.ReadableStream,
        btoa: (str) => Buffer.from(String(str), 'binary').toString('base64'),
        atob: (b64) => Buffer.from(String(b64), 'base64').toString('binary'),
        fetch: customFetch || (async () => ({
            ok: true,
            status: 200,
            json: async () => ({ accessToken: 'mock-token' })
        }))
    };
    sandbox.window.crypto = globalThis.crypto;
    sandbox.window.localStorage = sandbox.localStorage;

    const engineCode = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/chatgpt-engine.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(engineCode, sandbox);

    return { api: sandbox.window.__proximaChatGPT, sandbox, storage };
}

// Convert cross-realm VM objects to standard realm objects for deepStrictEqual
function toPlain(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function createSSEStream(lines) {
    const encoder = new TextEncoder();
    let idx = 0;
    return new ReadableStream({
        pull(controller) {
            if (idx < lines.length) {
                controller.enqueue(encoder.encode(lines[idx++] + '\n\n'));
            } else {
                controller.close();
            }
        }
    });
}

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

test('ChatGPT Engine: 5.6+ integer version parsing and comparison', () => {
    const { api } = setupChatGPTEngine();

    assert.equal(typeof api._parseModelVersion, 'function', '_parseModelVersion must be exposed for testing');
    assert.equal(typeof api._isAllowedModelSlug, 'function', '_isAllowedModelSlug must be exposed for testing');

    assert.deepEqual(toPlain(api._parseModelVersion('gpt-5-6-mini')), { major: 5, minor: 6 });
    assert.deepEqual(toPlain(api._parseModelVersion('gpt-5-10')), { major: 5, minor: 10 });
    assert.deepEqual(toPlain(api._parseModelVersion('gpt-6')), { major: 6, minor: 0 });
    assert.deepEqual(toPlain(api._parseModelVersion('gpt-6-t-mini')), { major: 6, minor: 0 });
    assert.deepEqual(toPlain(api._parseModelVersion('gpt-4o')), { major: 4, minor: 0 });
    assert.deepEqual(toPlain(api._parseModelVersion('gpt-5-2')), { major: 5, minor: 2 });
    assert.equal(api._parseModelVersion('unknown-model'), null);

    // Minimum integer version threshold (>= 5.6)
    assert.equal(api._isAllowedModelSlug('gpt-5-6-mini'), true, '5.6 mini must be allowed');
    assert.equal(api._isAllowedModelSlug('gpt-5-7'), true, '5.7 must be allowed');
    assert.equal(api._isAllowedModelSlug('gpt-5-10'), true, '5.10 must be allowed (integer comparison avoids 5.1 decimal float bug)');
    assert.equal(api._isAllowedModelSlug('gpt-6'), true, '6.0 must be allowed');
    assert.equal(api._isAllowedModelSlug('gpt-6-thinking-mini'), true, '6.0 thinking mini must be allowed');

    assert.equal(api._isAllowedModelSlug('gpt-5-5'), false, '5.5 must be rejected (< 5.6)');
    assert.equal(api._isAllowedModelSlug('gpt-5-2-instant'), false, '5.2 must be rejected (< 5.6)');
    assert.equal(api._isAllowedModelSlug('gpt-4o'), false, '4.0 must be rejected (< 5.6)');
    assert.equal(api._isAllowedModelSlug('gpt-4-5'), false, '4.5 must be rejected (< 5.6)');

    // Exclude research models
    assert.equal(api._isAllowedModelSlug('gpt-5-6-research'), false, '5.6 research must be excluded');
    assert.equal(api._isAllowedModelSlug('gpt-6-research-mini'), false, '6.0 research must be excluded');
    assert.equal(api._isAllowedModelSlug('gpt-5-8-deep-research'), false, 'research in slug must be excluded');
});

test('ChatGPT Engine: Versioned model slug formatting and tags', () => {
    const { api } = setupChatGPTEngine();

    assert.equal(api.formatModelSlug('gpt-5-6-mini'), 'GPT-5.6 Mini');
    assert.equal(api.formatModelSlug('gpt-6'), 'GPT-6');
    assert.equal(api.formatModelSlug('gpt-6-t-mini'), 'GPT-6 Thinking Mini');
    assert.equal(api.formatModelSlug('gpt-6-instant'), 'GPT-6 Instant');
    assert.equal(api.formatModelSlug('gpt-5-6'), 'GPT-5.6');

    const miniTag = toPlain(api.getModelTagInfo('gpt-5-6-mini', false));
    assert.equal(miniTag.tag, 'Fast', 'mini must have Fast tag');

    const thinkingTag = toPlain(api.getModelTagInfo('gpt-6-thinking', false));
    assert.equal(thinkingTag.tag, 'Reasoning', 'thinking must have Reasoning tag');

    const errorTag = toPlain(api.getModelTagInfo('gpt-5-6-mini', true));
    assert.equal(errorTag.tag, 'Limit / Error', 'error model must have Limit / Error tag');
});

test('ChatGPT Engine: Dynamic model discovery and lowestFast ranking', async () => {
    const mockInitResponse = {
        models: [
            { slug: 'gpt-4o', title: 'GPT-4o' },
            { slug: 'gpt-5-2', title: 'GPT-5.2' },
            { slug: 'gpt-5-6-research', title: 'GPT-5.6 Research' },
            { slug: 'gpt-5-6-mini', title: 'GPT-5.6 Mini' },
            { slug: 'gpt-6', title: 'GPT-6' },
            { slug: 'gpt-6-t-mini', title: 'GPT-6 Thinking Mini' }
        ],
        account: { id: 'account_user_premium' }
    };

    const customFetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ accessToken: 'mock-token', user: { id: 'account_user_premium' } })
            };
        }
        if (u.includes('/backend-api/conversation/init') || u.includes('/backend-api/models')) {
            return {
                ok: true,
                status: 200,
                json: async () => mockInitResponse
            };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const { api } = setupChatGPTEngine(customFetch);
    const meta = await api.getModelsMetadata();

    assert.ok(meta, 'getModelsMetadata must return metadata');
    assert.deepEqual(toPlain(meta.availableSlugs), ['gpt-5-6-mini', 'gpt-6', 'gpt-6-t-mini'], 'Eligible slugs must filter < 5.6 and research');
    assert.equal(meta.lowestFastModel, 'gpt-5-6-mini', 'Fastest 5.6+ mini must be lowestFastModel');

    const modelsList = await api.getAvailableModels();
    assert.equal(modelsList.length, 4, 'Must return Auto + 3 discovered models');
    assert.equal(modelsList[0].slug, 'auto');
    assert.equal(modelsList[1].slug, 'gpt-5-6-mini');
    assert.equal(modelsList[1].name, 'GPT-5.6 Mini');
});

test('ChatGPT Engine: Account-scoped caching isolates different accounts', async () => {
    let currentAccount = 'user_account_A';

    const customFetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ accessToken: 'mock-token', user: { id: currentAccount } })
            };
        }
        if (u.includes('/backend-api/conversation/init') || u.includes('/backend-api/models')) {
            if (currentAccount === 'user_account_A') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        models: [{ slug: 'gpt-5-6-mini' }, { slug: 'gpt-6' }]
                    })
                };
            } else {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        models: [{ slug: 'gpt-5-7-mini' }, { slug: 'gpt-7' }]
                    })
                };
            }
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const { api } = setupChatGPTEngine(customFetch);

    const metaA = await api.getModelsMetadata();
    assert.deepEqual(toPlain(metaA.availableSlugs), ['gpt-5-6-mini', 'gpt-6'], 'Account A should see gpt-5-6-mini, gpt-6');

    // Clear session token cache for account switch
    currentAccount = 'user_account_B';
    api._resetTokenCache();
    const metaB = await api.getModelsMetadata();
    assert.deepEqual(toPlain(metaB.availableSlugs), ['gpt-5-7-mini', 'gpt-7'], 'Account B should see gpt-5-7-mini, gpt-7 without leaking A');

    currentAccount = 'user_account_A';
    api._resetTokenCache();
    const metaA2 = await api.getModelsMetadata();
    assert.deepEqual(toPlain(metaA2.availableSlugs), ['gpt-5-6-mini', 'gpt-6'], 'Account A should retrieve its own cache');
});

test('ChatGPT Engine: Discovery failure throws clear error without hardcoded guesses', async () => {
    const customFetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ accessToken: 'mock-token' })
            };
        }
        if (u.includes('/backend-api/conversation/init') || u.includes('/backend-api/models')) {
            return {
                ok: false,
                status: 503,
                text: async () => 'Service Unavailable'
            };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const { api } = setupChatGPTEngine(customFetch);

    await assert.rejects(
        async () => { await api.getModelsMetadata(); },
        (err) => {
            assert.match(err.message, /ChatGPT model discovery failed/i, 'Must throw clear discovery error');
            return true;
        }
    );
});

test('ChatGPT Engine: Zero eligible >= 5.6 models throws clear error', async () => {
    const customFetch = async (url) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ accessToken: 'mock-token' })
            };
        }
        if (u.includes('/backend-api/conversation/init') || u.includes('/backend-api/models')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    models: [{ slug: 'gpt-4o' }, { slug: 'gpt-5-2' }] // Both < 5.6
                })
            };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const { api } = setupChatGPTEngine(customFetch);

    await assert.rejects(
        async () => { await api.getModelsMetadata(); },
        (err) => {
            assert.match(err.message, /No eligible models \(>= 5\.6\) found/i, 'Must reject with no eligible models error');
            return true;
        }
    );
});

test('ChatGPT Engine: Auto chooses lowestFastModel and falls back on quota limit', async () => {
    const mockInitResponse = {
        models: [
            { slug: 'gpt-5-6-mini', title: 'GPT-5.6 Mini' },
            { slug: 'gpt-6-t-mini', title: 'GPT-6 Thinking Mini' },
            { slug: 'gpt-6', title: 'GPT-6' }
        ]
    };

    let sentPayload = null;
    let failFirstAttempt = false;

    const customFetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ accessToken: 'mock-token' })
            };
        }
        if (u.includes('/backend-api/conversation/init') || u.includes('/backend-api/models')) {
            return {
                ok: true,
                status: 200,
                json: async () => mockInitResponse
            };
        }
        if (u.includes('/backend-api/sentinel/chat-requirements')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ token: 'mock-sentinel' })
            };
        }
        if (u.includes('/backend-api/f/conversation') || u.includes('/backend-api/conversation')) {
            sentPayload = JSON.parse(opts.body);
            if (failFirstAttempt) {
                return {
                    ok: false,
                    status: 429,
                    text: async () => 'Usage limit reached for model'
                };
            }
            return createMockResponse(createSSEStream([
                'data: {"message":{"id":"msg-1","author":{"role":"assistant"},"content":{"parts":["Hello from model"]},"status":"finished_successfully","end_turn":true},"conversation_id":"conv-1"}',
                'data: [DONE]'
            ]));
        }
        return createMockResponse('{}');
    };

    const { api } = setupChatGPTEngine(customFetch);

    const res1 = await api.send('Test auto selection', 'auto');
    assert.equal(res1, 'Hello from model');
    assert.equal(sentPayload.model, 'gpt-5-6-mini', 'Auto must route to lowest fast mini');

    await api.send('Test explicit', 'gpt-6');
    assert.equal(sentPayload.model, 'gpt-6', 'Explicit selection must route to requested slug');

    await assert.rejects(
        async () => { await api.send('Test bad model', 'gpt-7-pro'); },
        (err) => {
            assert.match(err.message, /Model 'gpt-7-pro' is not available in the current account/, 'Must reject unowned explicit model');
            assert.match(err.message, /Call 'list_available_models' for current models and exact usage instructions/);
            return true;
        }
    );

    // Quota limit cooldown and fallback
    failFirstAttempt = true;
    await assert.rejects(
        async () => { await api.send('Fail trigger', 'gpt-5-6-mini'); },
        (err) => {
            assert.match(err.message, /ChatGPT API error \(429\)/);
            return true;
        }
    );

    failFirstAttempt = false;
    await api.send('Fallback test', 'auto');
    assert.equal(sentPayload.model, 'gpt-6', 'Auto must fall back to next fast candidate when lowestFast is in cooldown');
});

test('ChatGPT Engine: Preserves history, conversation IDs, and session isolation', async () => {
    let capturedBodies = [];

    const customFetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ accessToken: 'mock-token' })
            };
        }
        if (u.includes('/backend-api/conversation/init') || u.includes('/backend-api/models')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    models: [{ slug: 'gpt-5-6-mini' }]
                })
            };
        }
        if (u.includes('/backend-api/sentinel/chat-requirements')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ token: 'mock-sentinel' })
            };
        }
        if (u.includes('/backend-api/f/conversation/prepare')) {
            return {
                ok: true,
                status: 200,
                json: async () => ({ conduit_token: 'mock-conduit' })
            };
        }
        if (u.includes('/backend-api/f/conversation') || u.includes('/backend-api/conversation')) {
            capturedBodies.push(JSON.parse(opts.body));
            return createMockResponse(createSSEStream([
                'data: {"message":{"id":"msg-resp-' + capturedBodies.length + '","author":{"role":"assistant"},"content":{"parts":["Turn response"]},"status":"finished_successfully","end_turn":true},"conversation_id":"conv-persisted"}',
                'data: [DONE]'
            ]));
        }
        return createMockResponse('{}');
    };

    const { api } = setupChatGPTEngine(customFetch);

    await api.send('Turn 1', 'auto', null, 'session-A');
    const b1 = capturedBodies[0];
    assert.equal(b1.history_and_training_disabled, false, 'history_and_training_disabled must remain false');
    assert.equal(b1.is_do_not_remember, false, 'is_do_not_remember must remain false');
    assert.ok(!b1.conversation_id, 'First turn conversation_id starts omitted/null');

    await api.send('Turn 2', 'auto', null, 'session-A');
    const b2 = capturedBodies[1];
    assert.equal(b2.conversation_id, 'conv-persisted', 'Second turn must carry conversation_id');
    assert.equal(b2.parent_message_id, 'msg-resp-1', 'Second turn must chain parent_message_id');

    await api.send('Turn 1 for Session B', 'auto', null, 'session-B');
    const b3 = capturedBodies[2];
    assert.ok(!b3.conversation_id, 'Session B must have fresh conversation_id, isolated from session-A');
});

test('REST API: Model resolver correctly parses discovered ChatGPT engine slugs', () => {
    assert.equal(restApi.resolveModel('gpt-5-6-mini'), 'chatgpt:gpt-5-6-mini');
    assert.equal(restApi.resolveModel('chatgpt:gpt-6-thinking-mini'), 'chatgpt:gpt-6-thinking-mini');
    assert.equal(restApi.resolveModel('chatgpt'), 'chatgpt');
    assert.equal(restApi.resolveModel('chatgpt:auto'), 'chatgpt:auto');

    const r = restApi.resolveModels('gpt-5-6-mini', 'mock-key');
    assert.equal(r.mode, 'single');
    assert.deepEqual(r.providers, ['chatgpt']);
    assert.equal(r.chatgpt, 'gpt-5-6-mini');
});

test('MCP: getAvailableModelsList returns all active session providers with exact usage instructions', async () => {
    const mockIpcClient = {
        send: async (action, provider, data) => {
            if (action === 'getByokStatus') return { success: true, enabled: false, providers: [] };
            if (action === 'getProviderModels' && provider === 'chatgpt') {
                return {
                    success: true,
                    models: [
                        { id: 'chatgpt:auto', slug: 'auto', name: 'Auto (GPT-5.6 Mini)', status: 'ready', tag: 'Auto Fast' },
                        { id: 'chatgpt:gpt-5-6-mini', slug: 'gpt-5-6-mini', name: 'GPT-5.6 Mini', status: 'ready', tag: 'Fast' },
                        { id: 'chatgpt:gpt-6', slug: 'gpt-6', name: 'GPT-6', status: 'ready', tag: 'Pro' }
                    ]
                };
            }
            return { success: true, models: [] };
        }
    };

    const res = await getAvailableModelsList({
        ipcClient: mockIpcClient,
        getEnabledProviders: () => new Set(['chatgpt', 'gemini', 'claude', 'perplexity']),
        refresh: false
    });

    assert.equal(res.mode, 'session');
    assert.ok(res.providers.chatgpt);
    assert.ok(res.providers.gemini);
    assert.ok(res.providers.claude);
    assert.ok(res.providers.perplexity);

    assert.equal(res.providers.chatgpt.models.length, 3);
    assert.equal(res.providers.chatgpt.models[1].slug, 'gpt-5-6-mini');
    assert.deepEqual(res.providers.chatgpt.models[1].exact_usage, {
        tool: 'ask_chatgpt',
        arguments: { message: 'Your prompt here', model: 'gpt-5-6-mini' }
    });

    assert.equal(res.providers.gemini.models.length, 5);
    assert.equal(res.providers.gemini.models[1].slug, 'flash');
    assert.deepEqual(res.providers.gemini.models[1].exact_usage, {
        tool: 'ask_gemini',
        arguments: { message: 'Your prompt here', model: 'flash' }
    });

    assert.equal(res.providers.claude.models[0].exact_usage.tool, 'ask_claude');
    assert.equal(res.providers.perplexity.models[0].exact_usage.tool, 'ask_perplexity');
});

test('ChatGPT Engine: Explicit selection of unavailable model returns formatted error guiding caller to list_available_models', async () => {
    const customFetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return { ok: true, status: 200, json: async () => ({ accessToken: 'mock-token', user: { email: 'test@example.com', id: 'acc-1' } }) };
        }
        if (u.includes('/backend-api/models') || u.includes('/backend-api/conversation/init')) {
            return {
                ok: true, status: 200,
                json: async () => ({
                    models: [
                        { slug: 'gpt-5-6-mini', title: 'GPT-5.6 Mini' },
                        { slug: 'gpt-6-mini', title: 'GPT-6 Mini' }
                    ]
                })
            };
        }
        if (u.includes('/backend-api/sentinel/chat-requirements')) {
            return { ok: true, status: 200, json: async () => ({ token: 'mock-sentinel' }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const { api } = setupChatGPTEngine(customFetch);
    await assert.rejects(
        async () => {
            await api.send('Hello', 'gpt-6'); // gpt-6 not in discovered account models
        },
        (err) => {
            assert.ok(err.message.includes("Model 'gpt-6' is not available in the current account"));
            assert.ok(err.message.includes("Currently available models: gpt-5-6-mini, gpt-6-mini"));
            assert.ok(err.message.includes("Call 'list_available_models' for current models and exact usage instructions."));
            return true;
        }
    );
});

test('ChatGPT Engine: getAvailableModels(true) triggers force refresh and cache invalidation', async () => {
    let fetchCount = 0;
    const customFetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/api/auth/session')) {
            return { ok: true, status: 200, json: async () => ({ accessToken: 'mock-token', user: { email: 'refresh@example.com', id: 'acc-refresh' } }) };
        }
        if (u.includes('/backend-api/models') || u.includes('/backend-api/conversation/init')) {
            fetchCount++;
            return {
                ok: true, status: 200,
                json: async () => ({
                    models: [{ slug: 'gpt-5-6-mini', title: 'GPT-5.6 Mini' }]
                })
            };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    };

    const { api } = setupChatGPTEngine(customFetch);
    const m1 = await api.getAvailableModels();
    assert.equal(m1.length, 2); // auto + gpt-5-6-mini
    const countAfterFirst = fetchCount;

    // Cached call - fetchCount should not increase
    await api.getAvailableModels();
    assert.equal(fetchCount, countAfterFirst, 'Should use cache without forceRefresh');

    // Force refresh call - fetchCount must increase
    await api.getAvailableModels(true);
    assert.ok(fetchCount > countAfterFirst, 'Should refetch when forceRefresh is true');
});


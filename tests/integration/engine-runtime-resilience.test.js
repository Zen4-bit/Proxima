import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ReadableStream } from 'node:stream/web';

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

function loadChatGPTEngine(customFetch, initialStorage = {}) {
    const storage = { ...initialStorage };
    const sandbox = {
        window: {
            crypto: globalThis.crypto
        },
        crypto: globalThis.crypto,
        AbortController: globalThis.AbortController,
        ReadableStream: globalThis.ReadableStream,
        document: {
            cookie: 'oai-did=device-1234',
            documentElement: { innerHTML: '<html></html>' }
        },
        navigator: {
            hardwareConcurrency: 8,
            userAgent: 'Mozilla/5.0 Test',
            language: 'en-US',
            languages: ['en-US']
        },
        screen: { width: 1920, height: 1080 },
        performance: { now: () => Date.now() },
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
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        Int32Array: Int32Array,
        Uint8Array: Uint8Array,
        Array: Array,
        btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
        atob: (str) => Buffer.from(str, 'base64').toString('binary'),
        fetch: async (url, opts) => {
            const res = await customFetch(url, opts);
            if (res && res.status !== 404) return res;
            if (url === '/backend-api/conversation/init') {
                return createMockResponse(JSON.stringify({ default_model_slug: 'gpt-6' }));
            }
            if (url === '/backend-api/models') {
                return createMockResponse(JSON.stringify({
                    models: [{ slug: 'gpt-6' }, { slug: 'gpt-6-mini' }, { slug: 'gpt-6-t-mini' }],
                    categories: [{ category: 'gpt_6_reasoning', default_model: 'gpt-6-t-mini', reasoning_type: 'reasoning' }]
                }));
            }
            return res;
        }
    };
    sandbox.window.localStorage = sandbox.localStorage;

    const code = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/chatgpt-engine.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    return {
        engine: sandbox.window.__proximaChatGPT,
        storage: storage,
        sandbox: sandbox
    };
}

function loadGeminiEngine(customFetch, initialStorage = {}, wizGlobalData = null) {
    const storage = { ...initialStorage };
    const defaultWiz = {
        tokens: ['SNlM0e', 'test_snlm0e_token', 'cfb2h', 'boq_assistant-bard-web-server_20261014.00_p0']
    };
    const sandbox = {
        window: {
            crypto: globalThis.crypto,
            WIZ_global_data: wizGlobalData ? Object.assign({}, defaultWiz, wizGlobalData) : defaultWiz
        },
        crypto: globalThis.crypto,
        AbortController: globalThis.AbortController,
        ReadableStream: globalThis.ReadableStream,
        document: {
            documentElement: {
                innerHTML: '<html><script>"SNlM0e":"test_snlm0e_token","cfb2h":"boq_assistant-bard-web-server_20261014.00_p0"</script></html>'
            }
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
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        URLSearchParams: URLSearchParams,
        Array: Array,
        btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
        atob: (str) => Buffer.from(str, 'base64').toString('binary'),
        fetch: customFetch
    };
    sandbox.window.localStorage = sandbox.localStorage;

    const code = fs.readFileSync(path.join(process.cwd(), 'electron/providers/engines/gemini-engine.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);

    return {
        engine: sandbox.window.__proximaGeminiUnified,
        geminiLegacy: sandbox.window.__proximaGemini,
        storage: storage,
        sandbox: sandbox
    };
}

test('ChatGPT: Stale conversation 404 -> one recovery attempt -> successful continuation on replacement conversation', async () => {
    const fetchCalls = [];
    const customFetch = async (url, opts) => {
        fetchCalls.push({ url, opts });
        if (url === '/api/auth/session') {
            return createMockResponse(JSON.stringify({ accessToken: 'valid-test-token' }));
        }
        if (url === '/backend-api/sentinel/chat-requirements') {
            return createMockResponse(JSON.stringify({ token: 'req-token', proofofwork: { required: false } }));
        }
        if (url === '/backend-api/conversation') {
            const body = JSON.parse(opts.body);
            // First call has stale conversation_id -> return specific 404 conversation_not_found
            if (body.conversation_id === 'stale-conv-id') {
                return createMockResponse(JSON.stringify({
                    detail: { message: "Conversation not found", code: "conversation_not_found", can_retry: false }
                }), 404);
            }
            // Recovery call must NOT have conversation_id
            if (!body.conversation_id) {
                const sseLines = [
                    'data: ' + JSON.stringify({ conversation_id: 'replacement-conv-101' }),
                    'data: ' + JSON.stringify({
                        message: {
                            id: 'msg-rec-1',
                            author: { role: 'assistant' },
                            content: { parts: ['Recovered answer from ChatGPT'] },
                            status: 'finished_successfully',
                            end_turn: true
                        }
                    }),
                    'data: [DONE]'
                ];
                return createMockResponse(createSSEStream(sseLines), 200, { 'content-type': 'text/event-stream' });
            }
            // Follow-up call continuing the replacement conversation
            if (body.conversation_id === 'replacement-conv-101') {
                const sseLines = [
                    'data: ' + JSON.stringify({ conversation_id: 'replacement-conv-101' }),
                    'data: ' + JSON.stringify({
                        message: {
                            id: 'msg-rec-2',
                            author: { role: 'assistant' },
                            content: { parts: ['Follow up response continuing conversation'] },
                            status: 'finished_successfully',
                            end_turn: true
                        }
                    }),
                    'data: [DONE]'
                ];
                return createMockResponse(createSSEStream(sseLines), 200, { 'content-type': 'text/event-stream' });
            }
        }
        return createMockResponse('Not found', 404);
    };

    const initialStorage = {
        'proxima_chatgpt_sessions': JSON.stringify({
            'default': { conversationId: 'stale-conv-id', parentMessageId: 'old-parent-id' }
        })
    };

    const { engine, storage } = loadChatGPTEngine(customFetch, initialStorage);

    const res1 = await engine.send('Hello after stale restore', 'auto', null, 'default');
    assert.match(res1, /System Notice: Previous ChatGPT conversation was not found or expired on the server/, 'Must prepend recovery notice');
    assert.match(res1, /Recovered answer from ChatGPT/, 'Must return actual answer');

    const savedSessions = JSON.parse(storage['proxima_chatgpt_sessions']);
    assert.equal(savedSessions['default'].conversationId, 'replacement-conv-101');
    assert.equal(savedSessions['default'].parentMessageId, 'msg-rec-1');

    const res2 = await engine.send('Second question', 'auto', null, 'default');
    assert.doesNotMatch(res2, /System Notice/, 'Follow up should not have recovery notice');
    assert.match(res2, /Follow up response continuing conversation/, 'Must receive follow up response');
});

test('ChatGPT: Default-session reset before any session has been activated', () => {
    const initialStorage = {
        'proxima_chatgpt_sessions': JSON.stringify({
            'default': { conversationId: 'stale-default-id', parentMessageId: 'parent-1' },
            'other': { conversationId: 'other-id', parentMessageId: 'parent-2' }
        })
    };

    const { engine, storage } = loadChatGPTEngine(async () => createMockResponse(''), initialStorage);

    // Call newConversation() with no arguments before activateSession() was called
    engine.newConversation();

    const saved = JSON.parse(storage['proxima_chatgpt_sessions']);
    assert.equal(saved['default'], undefined, 'Default session must be deleted from storage');
    assert.ok(saved['other'], 'Other session must remain completely intact');
});

test('ChatGPT: Unrelated failures (e.g. 500) and other sessions remain unaffected', async () => {
    const customFetch = async (url, opts) => {
        if (url === '/api/auth/session') return createMockResponse(JSON.stringify({ accessToken: 'valid-test-token' }));
        if (url === '/backend-api/sentinel/chat-requirements') return createMockResponse(JSON.stringify({ token: 't' }));
        if (url === '/backend-api/conversation') {
            return createMockResponse('Internal Server Error', 500);
        }
        return createMockResponse('Not found', 404);
    };

    const initialStorage = {
        'proxima_chatgpt_sessions': JSON.stringify({
            'session-a': { conversationId: 'conv-a', parentMessageId: 'p-a' },
            'session-b': { conversationId: 'conv-b', parentMessageId: 'p-b' }
        })
    };

    const { engine, storage } = loadChatGPTEngine(customFetch, initialStorage);

    await assert.rejects(
        async () => { await engine.send('Test message', 'auto', null, 'session-a'); },
        /ChatGPT API error \(500\)/
    );

    const saved = JSON.parse(storage['proxima_chatgpt_sessions']);
    assert.equal(saved['session-a'].conversationId, 'conv-a', 'Session A state must be preserved on non-404 error');
    assert.equal(saved['session-b'].conversationId, 'conv-b', 'Session B state must remain intact');
});

test('ChatGPT: Failed recovery stops at retry bound without infinite looping', async () => {
    let convAttempts = 0;
    const customFetch = async (url, opts) => {
        if (url === '/api/auth/session') return createMockResponse(JSON.stringify({ accessToken: 'valid-test-token' }));
        if (url === '/backend-api/sentinel/chat-requirements') return createMockResponse(JSON.stringify({ token: 't' }));
        if (url === '/backend-api/conversation') {
            convAttempts++;
            if (convAttempts === 1) {
                // First call: 404 conversation_not_found
                return createMockResponse(JSON.stringify({
                    detail: { message: "Conversation not found", code: "conversation_not_found" }
                }), 404);
            }
            // Recovery call also fails with 500
            return createMockResponse('Server crashed during recovery', 500);
        }
        return createMockResponse('Not found', 404);
    };

    const initialStorage = {
        'proxima_chatgpt_sessions': JSON.stringify({
            'default': { conversationId: 'stale-id', parentMessageId: 'p-1' }
        })
    };

    const { engine, storage } = loadChatGPTEngine(customFetch, initialStorage);

    await assert.rejects(
        async () => { await engine.send('Test message', 'auto', null, 'default'); },
        /ChatGPT recovery failed \(500\)/
    );

    assert.equal(convAttempts, 2, 'Must stop at exactly 1 initial + 1 recovery attempt');

    const saved = JSON.parse(storage['proxima_chatgpt_sessions']);
    assert.equal(saved['default'], undefined, 'Known-invalid ID must not be restored');
});

test('Gemini: Metadata-only, interrupted and timed-out streams preserve previous valid state', async () => {
    let callCount = 0;
    const customFetch = async (url, opts) => {
        callCount++;
        // Emit 177-byte header frame without text chunks, then close/stall
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([null, ["c_1234567890abcdef1234", "r_1234567890abcdef1234"], null, null, null, null, null, null, null, null])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    const initialStorage = {
        'proxima_sessions': JSON.stringify({
            'default': {
                conversationId: 'c_valid_123',
                responseId: 'r_valid_456',
                choiceId: 'rc_valid_789',
                contextToken: 'ctx_valid',
                sessionUuid: 'UUID-ORIG'
            }
        })
    };

    const { engine, storage } = loadGeminiEngine(customFetch, initialStorage);

    await assert.rejects(
        async () => { await engine.send('Hello', 'latest', null, 'default'); },
        /Could not extract reply from Gemini/
    );

    const saved = JSON.parse(storage['proxima_sessions']);
    assert.equal(saved['default'].conversationId, 'c_valid_123');
    assert.equal(saved['default'].responseId, 'r_valid_456');
    assert.equal(saved['default'].choiceId, 'rc_valid_789');
});

test('Gemini: Successful turns commit continuation IDs transactionally', async () => {
    const customFetch = async (url, opts) => {
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_new_101", "r_new_202"],
                    { "26": "ctx_token_999" },
                    null,
                    [["rc_choice_303", ["Here is the successful answer."]]]
                ])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    const { engine, storage } = loadGeminiEngine(customFetch);

    const reply = await engine.send('Tell me a fact', 'auto', null, 'session-test');
    assert.equal(reply, 'Here is the successful answer.');

    const saved = JSON.parse(storage['proxima_sessions']);
    assert.equal(saved['session-test'].conversationId, 'c_new_101');
    assert.equal(saved['session-test'].responseId, 'r_new_202');
    assert.equal(saved['session-test'].choiceId, 'rc_choice_303');
    assert.equal(saved['session-test'].contextToken, 'ctx_token_999');
});

test('Gemini: Valid answers without Pikuzen markers discussing error phrases are preserved', async () => {
    const customFetch = async (url, opts) => {
        const explanationText = 'When your server returns "Sorry, something went wrong", you should inspect the server error logs and check for 500 status codes.';
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_turn_1", "r_turn_1"],
                    null,
                    null,
                    [["rc_c1", [explanationText]]]
                ])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    const { engine } = loadGeminiEngine(customFetch);

    const reply = await engine.send('Why does it say "Sorry, something went wrong"?', 'pro', null, 'default');
    assert.match(reply, /When your server returns "Sorry, something went wrong"/);
    assert.doesNotMatch(reply, /<<<REPLY/, 'Must not require Pikuzen markers');
});

test('Gemini: Genuine provider aborts fail even when partial text exists', async () => {
    const customFetch = async (url, opts) => {
        // Frame 1 had partial text, Frame 2 emitted an explicit Google server abort phrase
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_abort_1", "r_abort_1"],
                    null,
                    null,
                    [["rc_c1", ["Partial text generated before abort"]]]
                ])]
            ]),
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_abort_1", "r_abort_1"],
                    null,
                    null,
                    [["rc_c2", ["Sorry, something went wrong."]]]
                ])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    const initialStorage = {
        'proxima_sessions': JSON.stringify({
            'default': { conversationId: 'c_prior', responseId: 'r_prior' }
        })
    };

    const { engine, storage } = loadGeminiEngine(customFetch, initialStorage);

    await assert.rejects(
        async () => { await engine.send('Do heavy task', 'auto', null, 'default'); },
        /Gemini stream aborted by Google server mid-generation/
    );

    const saved = JSON.parse(storage['proxima_sessions']);
    assert.equal(saved['default'].conversationId, 'c_prior');
});

test('Gemini: Routing resolves workspace fallback for latest, flash, pro, and argon when fast discovery is empty', async () => {
    let capturedHeaders = null;
    const customFetch = async (url, opts) => {
        capturedHeaders = opts.headers;
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_ws_1", "r_ws_1"],
                    null,
                    null,
                    [["rc_c1", ["OK, routing succeeded."]]]
                ])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    // No fast workspaces discovered in WIZ_global_data
    const { engine } = loadGeminiEngine(customFetch, {}, {});

    await engine.send('Test routing latest', 'latest', null, 'default');
    let ext525 = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(ext525[4], '8c46e95b1a07cecc', 'latest must route to verified 3.5 Flash-Lite workspace');
    assert.equal(ext525[14], 6, 'latest must use modelId 6');

    await engine.send('Test routing flash', 'flash', null, 'default');
    ext525 = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(ext525[4], '56fdd199312815e2', 'flash must route to verified Flash workspace');
    assert.equal(ext525[14], 1, 'flash must use modelId 1');

    await engine.send('Test routing pro', 'pro', null, 'default');
    ext525 = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(ext525[4], 'e6fa609c3fa255c0', 'pro must route to verified Pro workspace');
    assert.equal(ext525[14], 3, 'pro must use modelId 3');

    await engine.send('Test routing argon', 'argon', null, 'default');
    ext525 = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(ext525[4], '95a4c0abcba24364', 'argon must route to verified Argon workspace');
    assert.equal(ext525[14], 8, 'argon must use modelId 8');
});

test('Gemini: Routing adopts discovered fast workspace when present', async () => {
    let capturedHeaders = null;
    const customFetch = async (url, opts) => {
        capturedHeaders = opts.headers;
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_ws_2", "r_ws_2"],
                    null,
                    null,
                    [["rc_c1", ["OK, routing succeeded."]]]
                ])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    // Fast workspace discovered in WIZ_global_data
    const wizData = {
        data: 'fast=discovered_fast_abc123","thinking=discovered_thinking_xyz456'
    };
    const { engine } = loadGeminiEngine(customFetch, {}, wizData);

    await engine.send('Test routing', 'latest', null, 'default');

    const ext525 = JSON.parse(capturedHeaders['x-goog-ext-525001261-jspb']);
    assert.equal(ext525[4], 'discovered_fast_abc123', 'Must route to discovered fast workspace');
});

test('Gemini: Code 37 extension rejection triggers resilient fallback and succeeds', async () => {
    let callCount = 0;
    const capturedHeaders = [];
    const customFetch = async (url, opts) => {
        callCount++;
        capturedHeaders.push(opts.headers);
        if (callCount === 1) {
            // First call with specialized flash engine returns Google code 37 extension rejection
            return createMockResponse(')]}\'\n\n36\n[["wrb.fr",null,"[{\\"37\\":[0]}]]"]\n', 200, { 'content-type': 'application/x-www-form-urlencoded' });
        }
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_fallback_1", "r_fallback_1"],
                    null,
                    null,
                    [["rc_fb1", ["Successful fallback response without rejected workspace"]]]
                ])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    const { engine } = loadGeminiEngine(customFetch);
    const reply = await engine.send('Hello', 'flash', null, 'default');
    assert.equal(reply, 'Successful fallback response without rejected workspace');
    assert.equal(callCount, 2, 'Must attempt specialized engine then fallback exactly once');
    assert.ok(capturedHeaders[0]['x-goog-ext-525001261-jspb'], 'First call had workspace header');
    assert.equal(capturedHeaders[1]['x-goog-ext-525001261-jspb'], undefined, 'Fallback call omitted workspace header');
});

test('Gemini: Aborted stream triggers resilient fallback to default model and succeeds', async () => {
    let callCount = 0;
    const customFetch = async (url, opts) => {
        callCount++;
        if (callCount === 1) {
            // Specialized call aborted mid-generation by Google
            const lines = [
                ")]}'\n",
                JSON.stringify([
                    ["wrb.fr", null, JSON.stringify([
                        null,
                        ["c_ab_1", "r_ab_1"],
                        null,
                        null,
                        [["rc_ab1", ["An error occurred"]]]
                    ])]
                ])
            ];
            return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
        }
        const lines = [
            ")]}'\n",
            JSON.stringify([
                ["wrb.fr", null, JSON.stringify([
                    null,
                    ["c_ab_2", "r_ab_2"],
                    null,
                    null,
                    [["rc_ab2", ["Recovered after server abort"]]]
                ])]
            ])
        ];
        return createMockResponse(lines.join('\n'), 200, { 'content-type': 'application/x-www-form-urlencoded' });
    };

    const { engine } = loadGeminiEngine(customFetch);
    const reply = await engine.send('Hello', 'pro', null, 'default');
    assert.equal(reply, 'Recovered after server abort');
    assert.equal(callCount, 2);
});


// Proxima — REST API Route Dispatch.
// Maps HTTP request paths to local AI gateway operations and provider execution handlers.

const TOOL_DEBUG = process.env.PROXIMA_TOOL_DEBUG === '1';

function createRouteHandler(deps) {
    const {
        API_PREFIX, VERSION, MODEL_ALIASES,
        sendJSON, sendError, getEnabled, resolveModel, resolveModels, pickBestProvider, extractMessage,
        queryProvider, queryMultiple, formatChatResponse, formatAllResponse, sendStreamResponse, sendStreamToolCallResponse,
        getFormattedStats, handleMCPRequest: getHandler, loadApiKey,
        getDocsPage, getAPIKeyPage, getCLIDocsPage, getWSDocsPage,
        scrapeUrl, searchDDG, formatResultsMarkdown,
        buildToolCallingPrompt, parseToolCallResponse, formatToolCallResponse,
        byok,
    } = deps;

    return async function handleRoute(method, pathname, body, res) {
        const handleMCPRequest = getHandler();
        const conversationId = (body && (body.conversationId || body.conversation_id || body.sessionId || body.session_id)) || null;

        if (method === 'POST' && pathname === `${API_PREFIX}/chat/completions`) {
            const fn = (body.function || '').toLowerCase().trim();

            const fs = require('fs');
            const filePath = body.filePath || null;
            if (filePath && !fs.existsSync(filePath)) {
                return sendError(res, 400, `File not found at local path: ${filePath}`);
            }

            let modelInput = body.model || 'auto';
            if (filePath && (modelInput === 'auto' || modelInput === 'all')) {
                modelInput = 'gemini';
            }

            const resolved = resolveModels(modelInput, body._byokKey);
            if (resolved.mode === 'error') return sendError(res, 404, resolved.error, 'model_not_found');

            const wantStream = body.stream === true;

            let gemini = resolved.gemini || null;
            if (!resolved.byokModelId && resolved.mode === 'single' && resolved.providers[0] === 'gemini') {
                if (!body.model || body.model === 'auto' || body.model === 'gemini') {
                    gemini = filePath ? '3.1-pro' : '3.5-flash';
                }
            }

            async function run(prompt, defaultModel, extraFields = {}) {
                let runModelInput = body.model || defaultModel || 'auto';
                if (filePath && runModelInput === 'auto') {
                    runModelInput = 'gemini';
                }
                const r = resolveModels(runModelInput, body._byokKey);
                if (r.mode === 'error') return sendError(res, 404, r.error);
                
                let runGemini = r.gemini || null;
                if (!r.byokModelId && r.mode === 'single' && r.providers[0] === 'gemini' && (!body.model || body.model === 'auto')) {
                    runGemini = filePath ? '3.1-pro' : '3.5-flash';
                }

                try {
                    if (r.mode === 'single') {
                        let onChunk = null;
                        let streamedAny = false;
                        if (wantStream && r.providers[0] === 'gemini') {
                            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...(res._proximaCors || {}) });
                            const id = `chatcmpl-${Date.now()}`;
                            const created = Math.floor(Date.now() / 1000);
                            onChunk = (chunk) => {
                                if (res.destroyed || res.writableEnded) return;
                                streamedAny = true;
                                res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: r.providers[0], choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
                            };
                        }

                        const result = await queryProvider(r.providers[0], prompt, filePath, runGemini, onChunk, conversationId, body._byokKey, null, r.byokModelId);

                        if (wantStream) {
                            if (r.providers[0] !== 'gemini') {
                                sendStreamResponse(res, result.text, r.providers[0]);
                            } else {
                                const id = `chatcmpl-${Date.now()}`;
                                const created = Math.floor(Date.now() / 1000);
                                // Send full response text as a chunk for non-streaming BYOK Gemini fallback.
                                if (!streamedAny && result.text) {
                                    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: r.providers[0], choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }] })}\n\n`);
                                }
                                res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: r.providers[0], choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                                res.write('data: [DONE]\n\n'); 
                                res.end();
                            }
                        } else {
                            sendJSON(res, 200, { ...formatChatResponse(result, r.providers[0]), ...extraFields });
                        }
                    } else {
                        const multi = await queryMultiple(r.providers, prompt, body._byokKey, filePath);
                        sendJSON(res, 200, { ...formatAllResponse(multi), ...extraFields });
                    }
                } catch (e) {
                    if (res.headersSent) {
                        // Emit terminal SSE error if headers have already been sent.
                        try { res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } catch { try { res.end(); } catch { } }
                    } else {
                        sendError(res, 500, e.message);
                    }
                }
            }

            if (fn === 'search') {
                const q = body.query || extractMessage(body);
                if (!q) return sendError(res, 400, 'message or query required');
                return run(q, 'perplexity', { function: 'search' });
            }

            if (fn === 'translate') {
                const text = body.text || extractMessage(body);
                const to = body.to || body.targetLanguage;
                if (!text) return sendError(res, 400, 'message or text required');
                if (!to) return sendError(res, 400, '"to" field required');
                const from = body.from || body.sourceLanguage || '';
                return run(`Translate the following${from ? ` from ${from}` : ''} to ${to}. Only output the translation:\n\n${text}`, 'auto', { function: 'translate', original: text, to });
            }

            if (fn === 'brainstorm') {
                const topic = body.topic || extractMessage(body);
                if (!topic) return sendError(res, 400, 'message or topic required');
                return run(`Brainstorm creative ideas for: ${topic}\n\nProvide diverse, practical suggestions.`, 'auto', { function: 'brainstorm', topic });
            }

            if (fn === 'code') {
                const action = body.action || 'generate';
                let prompt;
                switch (action) {
                    case 'generate': { const desc = body.description || extractMessage(body); if (!desc) return sendError(res, 400, 'description required'); prompt = `Generate ${body.language || 'JavaScript'} code:\n${desc}\n\nProvide clean, production-ready code.`; break; }
                    case 'review': if (!body.code) return sendError(res, 400, 'code required'); prompt = `Review this ${body.language || ''} code for bugs, performance, security:\n\`\`\`${body.language || ''}\n${body.code}\n\`\`\``; break;
                    case 'debug': if (!body.code && !body.error) return sendError(res, 400, 'code or error required'); prompt = 'Debug:\n'; if (body.code) prompt += `\`\`\`${body.language || ''}\n${body.code}\n\`\`\`\n`; if (body.error) prompt += `Error: ${body.error}\n`; prompt += 'Identify the bug, explain, and fix.'; break;
                    case 'explain': if (!body.code) return sendError(res, 400, 'code required'); prompt = `Explain this ${body.language || ''} code:\n\`\`\`${body.language || ''}\n${body.code}\n\`\`\``; break;
                    default: return sendError(res, 400, `Unknown action: ${action}`);
                }
                return run(prompt, 'claude', { function: 'code', action });
            }

            if (fn === 'analyze') {
                const url = body.url; const content = url || extractMessage(body);
                if (!content) return sendError(res, 400, 'message, url, or content required');
                const prompt = url ? `Analyze this URL: ${url}${body.question ? `\nQuestion: ${body.question}` : ''}${body.focus ? `\nFocus: ${body.focus}` : ''}` : `Analyze: ${content}${body.question ? `\nQuestion: ${body.question}` : ''}`;
                return run(prompt, url ? 'perplexity' : 'auto', { function: 'analyze' });
            }

            if (fn === 'security_audit') {
                const code = body.code || extractMessage(body);
                if (!code) return sendError(res, 400, 'code required');
                const prompt = `You are a senior security engineer. Perform a thorough security audit of this code${body.language ? ` (${body.language})` : ''}.\n\nCODE:\n${code}\n\nCheck for: injection, auth flaws, data exposure, input validation, crypto issues, config problems.\n\nFor each: Severity (CRITICAL/HIGH/MEDIUM/LOW), Location, Description, Fix.\nEnd with security score (0-100).`;
                return run(prompt, 'claude', { function: 'security_audit' });
            }

            if (fn === 'debate') {
                const topic = body.topic || extractMessage(body);
                if (!topic) return sendError(res, 400, 'topic required');
                const sides = body.sides || 2;
                const r2 = resolveModels(body.model || 'all');
                if (r2.mode === 'error') return sendError(res, 404, r2.error);
                if (r2.providers.length < 2) return run(`Debate from ${sides} perspectives:\n\nTopic: ${topic}`, 'auto', { function: 'debate', topic });

                const stances = ['FOR / supportive', 'AGAINST / critical', 'NEUTRAL / analytical', 'ALTERNATIVE / unconventional'];
                const results = {}, timings = {};
                await Promise.all(r2.providers.slice(0, sides).map(async (p, i) => {
                    let runEngine2 = (r2.geminis && r2.geminis[i]) || null;
                    if (p === 'gemini' && (!body.model || body.model === 'auto')) {
                        runEngine2 = filePath ? '3.1-pro' : '3.5-flash';
                    }
                    try { const r = await queryProvider(p, `You are debating. Position: ${stances[i]}.\n\nTopic: ${topic}\n\nPresent strongest arguments.`, filePath, runEngine2, null, null, body._byokKey); results[p] = { stance: stances[i], response: r.text }; timings[p] = r.responseTimeMs; }
                    catch (e) { results[p] = { stance: stances[i], error: e.message }; }
                }));
                return sendJSON(res, 200, { id: `proxima-${Date.now()}`, object: 'chat.completion', model: 'debate', topic, perspectives: results, timings, proxima: { function: 'debate', providers: r2.providers.slice(0, sides) } });
            }

            if (fn === 'scrape') {
                const url = body.url || extractMessage(body);
                if (!url) return sendError(res, 400, 'url required');
                try {
                    const result = await scrapeUrl(url, { timeout: body.timeout || 15000 });
                    return sendJSON(res, 200, { id: `proxima-${Date.now()}`, object: 'chat.completion', model: 'scraper', choices: [{ index: 0, message: { role: 'assistant', content: result.markdown }, finish_reason: 'stop' }], proxima: { function: 'scrape', url: result.url, statusCode: result.statusCode, metadata: result.metadata } });
                } catch (e) { return sendError(res, 500, `Scrape failed: ${e.message}`); }
            }

            if (fn === 'ddg_search' || (fn === 'search' && body.engine === 'duckduckgo')) {
                const query = extractMessage(body);
                if (!query) return sendError(res, 400, 'message required');
                try {
                    const results = await searchDDG(query, { maxResults: body.maxResults || 8 });
                    return sendJSON(res, 200, { id: `proxima-${Date.now()}`, object: 'chat.completion', model: 'duckduckgo', choices: [{ index: 0, message: { role: 'assistant', content: formatResultsMarkdown(results) }, finish_reason: 'stop' }], proxima: { function: 'ddg_search', query, totalResults: results.totalResults, searchTimeMs: results.searchTimeMs, results: results.results } });
                } catch (e) { return sendError(res, 500, `Search failed: ${e.message}`); }
            }

            if (fn === 'crew') {
                const task = extractMessage(body);
                if (!task) return sendError(res, 400, 'message required');
                const agents = body.agents || [
                    { role: 'Researcher', model: 'perplexity', instruction: 'Research thoroughly.' },
                    { role: 'Writer', model: 'claude', instruction: 'Write detailed response.' },
                    { role: 'Reviewer', model: 'chatgpt', instruction: 'Review and improve.' }
                ];
                if (!Array.isArray(agents)) {
                    return sendError(res, 400, '"agents" must be an array.');
                }
                const MAX_CREW_AGENTS = 8;
                if (agents.length === 0) {
                    return sendError(res, 400, '"agents" must contain at least one agent.');
                }
                if (agents.length > MAX_CREW_AGENTS) {
                    return sendError(res, 400, `Too many crew agents (${agents.length}); max ${MAX_CREW_AGENTS}.`);
                }
                const crewResults = {}, crewTimings = {};
                let prev = task;
                for (const agent of agents) {
                    const p = pickBestProvider(resolveModel(agent.model || 'auto'));
                    if (!p) { crewResults[agent.role] = { error: `${agent.model} not available` }; continue; }
                    const prompt = `You are a ${agent.role}. ${agent.instruction || ''}\n\nTASK: ${task}\n\n${prev !== task ? `PREVIOUS OUTPUT:\n${prev}\n\n` : ''}`;
                    let runEngineCrew = null;
                    if (p === 'gemini') {
                        const resolvedAgent = resolveModels(agent.model || 'auto');
                        runEngineCrew = resolvedAgent.gemini || (filePath ? '3.1-pro' : '3.5-flash');
                    }
                    try { const r = await queryProvider(p, prompt, filePath, runEngineCrew, null, null, body._byokKey); crewResults[agent.role] = { provider: p, response: r.text, responseTimeMs: r.responseTimeMs }; crewTimings[agent.role] = r.responseTimeMs; prev = r.text; }
                    catch (e) { crewResults[agent.role] = { provider: p, error: e.message }; }
                }
                const final = crewResults[agents[agents.length - 1].role]?.response || 'Crew failed.';
                return sendJSON(res, 200, { id: `proxima-${Date.now()}`, object: 'chat.completion', model: 'crew', choices: [{ index: 0, message: { role: 'assistant', content: final }, finish_reason: 'stop' }], proxima: { function: 'crew', task, agents: Object.keys(crewResults), pipeline: crewResults, timings: crewTimings, totalTimeMs: Object.values(crewTimings).reduce((a, b) => a + b, 0) } });
            }

            if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
                try {
                    const provider = resolved.mode === 'single' ? resolved.providers[0] : pickBestProvider();
                    if (!provider) return sendError(res, 503, 'No provider available');

                    const isByokActive = !!(body._byokKey || (byok.keys.isEnabled() ? byok.keys.getKey(provider) : null));

                    if (isByokActive) {
                        if (TOOL_DEBUG) console.log('[TOOL-CALL/BYOK] Native Tool Calling | Provider:', provider, '| Tools:', body.tools.length);
                        const result = await queryProvider(provider, body.messages, filePath, gemini, null, conversationId, body._byokKey, body.tools, resolved.byokModelId);
                        
                        if (result.toolCalls && result.toolCalls.length > 0) {
                            if (TOOL_DEBUG) console.log('[TOOL-CALL/BYOK] [OK] Native tool_calls, count:', result.toolCalls.length);
                            if (wantStream) {
                                sendStreamToolCallResponse(res, result.toolCalls, provider);
                            } else {
                                sendJSON(res, 200, formatToolCallResponse(result.toolCalls, provider, result.responseTimeMs));
                            }
                        } else {
                            if (TOOL_DEBUG) console.log('[TOOL-CALL/BYOK] [FAIL] No native tool calls returned, sending as text');
                            if (wantStream) sendStreamResponse(res, result.text, provider);
                            else sendJSON(res, 200, formatChatResponse(result, provider));
                        }
                    } else {
                        const toolPrompt = buildToolCallingPrompt(body);
                        if (!toolPrompt) return sendError(res, 400, 'No message provided');
                        if (TOOL_DEBUG) console.log('[TOOL-CALL/Legacy] Provider:', provider, '| Tools:', body.tools.length);
                        const result = await queryProvider(provider, toolPrompt, filePath, gemini, null, conversationId, body._byokKey, null, resolved.byokModelId);
                        if (TOOL_DEBUG) console.log('[TOOL-CALL/Legacy] Response text (first 300):', JSON.stringify(result.text?.slice(0, 300)));
                        const parsed = parseToolCallResponse(result.text);
                        if (TOOL_DEBUG) console.log('[TOOL-CALL/Legacy] Parsed:', parsed.isToolCall, '| toolCalls:', parsed.toolCalls?.length || 0);
                        if (parsed.isToolCall) {
                            if (TOOL_DEBUG) console.log('[TOOL-CALL/Legacy] [OK] Returning tool_calls to client, stream:', wantStream);
                            if (wantStream) {
                                sendStreamToolCallResponse(res, parsed.toolCalls, provider);
                            } else {
                                sendJSON(res, 200, formatToolCallResponse(parsed.toolCalls, provider, result.responseTimeMs));
                            }
                        } else {
                            if (TOOL_DEBUG) console.log('[TOOL-CALL/Legacy] [FAIL] No tool call detected, returning as text');
                            if (wantStream) sendStreamResponse(res, result.text, provider);
                            else sendJSON(res, 200, formatChatResponse(result, provider));
                        }
                    }
                } catch (e) { console.error('[TOOL-CALL] Error:', e.message); sendError(res, 500, e.message); }
                return;
            }

            const message = extractMessage(body);
            if (!message) return sendError(res, 400, 'No message provided');
            try {
                if (resolved.mode === 'single') {
                    const provider = resolved.providers[0];
                    const isByokActive = !!(body._byokKey || (byok.keys.isEnabled() ? byok.keys.getKey(provider) : null));
                    const inputMessage = isByokActive ? (body.messages || message) : message;

                    let onChunk = null;
                    let streamedAny = false;
                    if (wantStream && provider === 'gemini') {
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...(res._proximaCors || {}) });
                        const id = `chatcmpl-${Date.now()}`;
                        const created = Math.floor(Date.now() / 1000);
                        onChunk = (chunk) => {
                            if (res.destroyed || res.writableEnded) return;
                            streamedAny = true;
                            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: provider, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
                        };
                    }

                    const result = await queryProvider(provider, inputMessage, filePath, gemini, onChunk, conversationId, body._byokKey, null, resolved.byokModelId);

                    if (wantStream) {
                        if (provider !== 'gemini') {
                            sendStreamResponse(res, result.text, provider);
                        } else {
                            const id = `chatcmpl-${Date.now()}`;
                            const created = Math.floor(Date.now() / 1000);
                            if (!streamedAny && result.text) {
                                res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: provider, choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }] })}\n\n`);
                            }
                            res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: provider, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                            res.write('data: [DONE]\n\n');
                            res.end();
                        }
                    } else {
                        sendJSON(res, 200, formatChatResponse(result, provider));
                    }
                } else sendJSON(res, 200, formatAllResponse(await queryMultiple(resolved.providers, message, body._byokKey, filePath)));
            } catch (e) {
                if (res.headersSent) {
                    try { res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`); res.write('data: [DONE]\n\n'); res.end(); } catch { try { res.end(); } catch { } }
                } else {
                    sendError(res, 500, e.message);
                }
            }
            return;
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/models`) {
            const isByokMode = byok.keys.isEnabled();
            const enabled = getEnabled();
            const models = [];

            if (isByokMode) {
                for (const p of enabled) {
                    const providerModels = byok.keys.getModels(p);
                    if (providerModels.length > 0) {
                        for (const m of providerModels) {
                            models.push({
                                id: m.id,
                                object: 'model',
                                created: Math.floor(Date.now() / 1000),
                                owned_by: 'proxima',
                                provider: p,
                                status: m.enabled ? 'enabled' : 'disabled',
                            });
                        }
                    } else {
                        models.push({
                            id: p,
                            object: 'model',
                            created: Math.floor(Date.now() / 1000),
                            owned_by: 'proxima',
                            provider: p,
                            status: 'enabled',
                            selectedModel: byok.keys.getSelectedModel(p) || byok.models.DEFAULT_MODELS[p] || p,
                        });
                    }
                }

                byok.keys.KNOWN_PROVIDERS.filter(p => !enabled.includes(p)).forEach(p =>
                    models.push({ id: p, object: 'model', owned_by: 'proxima', status: 'disabled' })
                );
            } else {
                for (const p of enabled) {
                    models.push({
                        id: p,
                        object: 'model',
                        created: Math.floor(Date.now() / 1000),
                        owned_by: 'proxima',
                        status: 'enabled',
                        aliases: Object.entries(MODEL_ALIASES).filter(([_, v]) => v === p).map(([k]) => k).filter(k => k !== p),
                    });
                }
                ['chatgpt', 'claude', 'gemini', 'perplexity'].filter(p => !enabled.includes(p)).forEach(p =>
                    models.push({ id: p, object: 'model', owned_by: 'proxima', status: 'disabled' })
                );
            }

            if (enabled.includes('gemini')) {
                models.push({ id: '3.5-flash', object: 'model', owned_by: 'proxima', status: 'enabled', description: 'Gemini 3.5 Flash engine' });
                models.push({ id: '3.1-pro', object: 'model', owned_by: 'proxima', status: 'enabled', description: 'Gemini 3.1 Pro engine' });
                models.push({ id: '3.1-flash-lite', object: 'model', owned_by: 'proxima', status: 'enabled', description: 'Gemini 3.1 Flash-Lite engine' });
                models.push({ id: 'gemini:auto', object: 'model', owned_by: 'proxima', status: 'enabled', description: 'Gemini Auto engine' });
            }

            models.push({ id: 'auto', object: 'model', owned_by: 'proxima', status: enabled.length > 0 ? 'enabled' : 'disabled', description: 'Auto-picks best available' });
            return sendJSON(res, 200, { object: 'list', mode: isByokMode ? 'api' : 'session', data: models });
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/functions`) {
            const functions = [
                {
                    function: null,
                    name: 'chat',
                    description: 'Default chat completion. Omit the "function" field to chat with a model.',
                    fields: { model: 'auto|claude|chatgpt|gemini|perplexity|all (or array of models)', message: 'string (or use messages[])', stream: 'boolean (optional)', filePath: 'local file path for multimodal/Gemini routing (optional)' }
                },
                {
                    function: 'search',
                    name: 'Web search',
                    description: 'AI web search (defaults to Perplexity). Set engine:"duckduckgo" to route to ddg_search.',
                    fields: { query: 'string (or message)', engine: '"duckduckgo" for direct results (optional)', model: 'provider override (optional)' }
                },
                {
                    function: 'translate',
                    name: 'Translate',
                    description: 'Translate text into a target language.',
                    fields: { text: 'string (or message)', to: 'target language (required)', from: 'source language (optional)' }
                },
                {
                    function: 'brainstorm',
                    name: 'Brainstorm',
                    description: 'Generate diverse, practical ideas for a topic.',
                    fields: { topic: 'string (or message)', model: 'provider override (optional)' }
                },
                {
                    function: 'code',
                    name: 'Code assistant',
                    description: 'Generate, review, debug, or explain code (defaults to Claude).',
                    fields: { action: 'generate|review|debug|explain (default generate)', description: 'for generate (or message)', code: 'for review/debug/explain', error: 'for debug (optional)', language: 'programming language (optional)' }
                },
                {
                    function: 'analyze',
                    name: 'Analyze',
                    description: 'Analyze a URL or text content. URLs route to Perplexity.',
                    fields: { url: 'URL to analyze (optional)', message: 'text/content (or content)', question: 'specific question (optional)', focus: 'focus area (optional)' }
                },
                {
                    function: 'security_audit',
                    name: 'Security audit',
                    description: 'Senior-engineer security review of code with severity ratings and a 0-100 score (defaults to Claude).',
                    fields: { code: 'string (or message)', language: 'programming language (optional)' }
                },
                {
                    function: 'debate',
                    name: 'Multi-AI debate',
                    description: 'Have multiple providers argue distinct stances on a topic.',
                    fields: { topic: 'string (or message)', sides: 'number of perspectives, default 2', model: 'providers to use, default "all" (or array)' }
                },
                {
                    function: 'scrape',
                    name: 'Scrape URL',
                    description: 'Fetch a URL and return clean markdown (no provider call).',
                    fields: { url: 'string (or message)', timeout: 'ms, default 15000 (optional)' }
                },
                {
                    function: 'ddg_search',
                    name: 'DuckDuckGo search',
                    description: 'Direct DuckDuckGo results, no AI provider call.',
                    fields: { message: 'query string (or query)', maxResults: 'number, default 8 (optional)' }
                },
                {
                    function: 'crew',
                    name: 'Multi-agent crew',
                    description: 'Run a sequential multi-agent pipeline (role-based); each agent feeds the next.',
                    fields: { message: 'task string', agents: 'array of { role, model, instruction } (optional, defaults to Researcher→Writer→Reviewer)' }
                }
            ];
            return sendJSON(res, 200, {
                object: 'list',
                endpoint: `${API_PREFIX}/chat/completions`,
                method: 'POST',
                description: 'All functions are invoked via POST /v1/chat/completions using the "function" field.',
                data: functions
            });
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/stats`) return sendJSON(res, 200, { ...getFormattedStats(), timestamp: new Date().toISOString() });

        if (method === 'POST' && pathname === `${API_PREFIX}/conversations/new`) {
            const requested = (body && (body.provider || body.model)) || null;
            if (!requested) {
                return sendError(res, 400, 'A "provider" (or "model") is required: chatgpt, claude, gemini, or perplexity.');
            }
            const target = pickBestProvider(requested);
            if (!target) {
                return sendError(res, 400, `Unknown or disabled provider: ${requested}`);
            }
            try { const r = await handleMCPRequest({ action: 'newConversation', provider: target, data: {} }); return sendJSON(res, 200, { success: true, provider: target, result: r }); }
            catch (e) { return sendError(res, 500, e.message); }
        }

        if (method === 'GET' && (pathname === `${API_PREFIX}/openapi.json` || pathname === '/openapi.json')) {
            try { return sendJSON(res, 200, JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8'))); }
            catch (e) { return sendError(res, 500, 'OpenAPI spec not found'); }
        }

        if (method === 'POST' && pathname.startsWith('/api/ask/')) {
            const model = resolveModel(pathname.split('/').pop()); const message = extractMessage(body);
            if (!message) return sendError(res, 400, 'message required');
            if (model === 'all') { try { const r = await queryMultiple(getEnabled(), message, body._byokKey); return sendJSON(res, 200, { success: true, responses: r.results, timings: r.timings }); } catch (e) { return sendError(res, 500, e.message); } }
            const p = pickBestProvider(model); if (!p) return sendError(res, 503, 'not available');
            try { const r = await queryProvider(p, message, null, null, null, conversationId, body._byokKey); return sendJSON(res, 200, { success: true, provider: p, response: r.text, responseTimeMs: r.responseTimeMs }); }
            catch (e) { return sendError(res, 500, e.message); }
        }

        if (method === 'GET' && pathname === '/api/status') {
            const r = await handleMCPRequest({ action: 'getStatus', provider: 'all', data: {} });
            return sendJSON(res, 200, { success: true, server: 'Proxima API', version: VERSION, enabledProviders: getEnabled(), providers: r.providers || {}, stats: getFormattedStats() });
        }

        if (method === 'GET' && (pathname === '/' || pathname === '/docs')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(getDocsPage(getEnabled, getFormattedStats)); }
        if (method === 'GET' && pathname === '/cli') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(getCLIDocsPage()); }
        if (method === 'GET' && (pathname === '/ws' || pathname === '/websocket')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(getWSDocsPage()); }
        if (method === 'GET' && pathname === '/api-key') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(getAPIKeyPage(loadApiKey)); }

        if (method === 'GET' && pathname === `${API_PREFIX}/byok/keys`) {
            return sendJSON(res, 200, { providers: byok.keys.getStatus(), enabled: byok.keys.isEnabled() });
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/byok/keys`) {
            const { provider, key } = body;
            if (!provider || !key) return sendError(res, 400, '"provider" and "key" are required.');
            try {
                byok.keys.saveKey(provider, key);
                return sendJSON(res, 200, { success: true, provider, message: `BYOK key saved for ${provider}.` });
            } catch (e) {
                return sendError(res, 400, e.message);
            }
        }

        if (method === 'DELETE' && pathname.startsWith(`${API_PREFIX}/byok/keys/`)) {
            const provider = pathname.split('/').pop();
            try {
                byok.keys.removeKey(provider);
                return sendJSON(res, 200, { success: true, provider, message: `BYOK key removed for ${provider}.` });
            } catch (e) {
                return sendError(res, 400, e.message);
            }
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/byok/enabled`) {
            return sendJSON(res, 200, { enabled: byok.keys.isEnabled() });
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/byok/enabled`) {
            const { enabled } = body;
            if (typeof enabled !== 'boolean') return sendError(res, 400, '"enabled" (boolean) is required.');
            try {
                byok.keys.setEnabled(enabled);
                return sendJSON(res, 200, { success: true, enabled: byok.keys.isEnabled() });
            } catch (e) {
                return sendError(res, 500, e.message);
            }
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/byok/test`) {
            const { provider, key } = body;
            if (!provider || !key) return sendError(res, 400, '"provider" and "key" are required.');
            try {
                const result = await byok.callProvider(provider, key, 'Say "hello" in one word.', {});
                return sendJSON(res, 200, { success: true, provider, response: result.text.slice(0, 100), responseTimeMs: result.responseTimeMs });
            } catch (e) {
                return sendJSON(res, 200, { success: false, provider, error: e.message });
            }
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/byok/models`) {
            const enabled = byok.keys.isEnabled();
            const status = byok.keys.getStatus();
            const providers = [];
            const models = [];

            if (enabled) {
                const PROVIDER_NAMES = {
                    chatgpt: 'OpenAI', claude: 'Anthropic', gemini: 'Gemini AI',
                    perplexity: 'Perplexity', deepseek: 'DeepSeek', groq: 'Groq',
                    xai: 'xAI (Grok)', openrouter: 'OpenRouter', together: 'Together AI',
                    fireworks: 'Fireworks', mistral: 'Mistral', nvidia: 'NVIDIA NIM',
                };

                for (const [provider, info] of Object.entries(status)) {
                    if (info.configured) {
                        const modelList = byok.keys.getModels(provider);
                        const defaultModel = byok.keys.getSelectedModel(provider) || byok.models.DEFAULT_MODELS[provider] || provider;
                        const providerName = PROVIDER_NAMES[provider] || provider;

                        providers.push({
                            id: provider,
                            name: providerName,
                            defaultModel,
                            models: modelList,
                        });

                        const enabledModels = modelList.filter(m => m.enabled !== false);
                        if (enabledModels.length > 0) {
                            for (const m of enabledModels) {
                                models.push({
                                    id: `${provider}@${m.id}`,
                                    name: providerName,
                                    model: m.id,
                                });
                            }
                        } else {
                            models.push({
                                id: provider,
                                name: providerName,
                                model: defaultModel,
                            });
                        }
                    }
                }
            }

            return sendJSON(res, 200, { enabled, providers, models });
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/byok/models/add`) {
            const { provider, model } = body;
            if (!provider || !model) return sendError(res, 400, '"provider" and "model" are required.');
            try {
                const added = byok.keys.addModel(provider, model);
                return sendJSON(res, 200, { success: true, added, provider, model });
            } catch (e) {
                return sendJSON(res, 400, { success: false, error: e.message });
            }
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/byok/models/remove`) {
            const { provider, model } = body;
            if (!provider || !model) return sendError(res, 400, '"provider" and "model" are required.');
            try {
                byok.keys.removeModel(provider, model);
                return sendJSON(res, 200, { success: true, provider, model });
            } catch (e) {
                return sendJSON(res, 400, { success: false, error: e.message });
            }
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/byok/models/toggle`) {
            const { provider, model, enabled: toggleEnabled } = body;
            if (!provider || !model || typeof toggleEnabled !== 'boolean') return sendError(res, 400, '"provider", "model", and "enabled" (boolean) are required.');
            try {
                byok.keys.toggleModel(provider, model, toggleEnabled);
                return sendJSON(res, 200, { success: true, provider, model, enabled: toggleEnabled });
            } catch (e) {
                return sendJSON(res, 400, { success: false, error: e.message });
            }
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/brain/stats`) {
            return sendJSON(res, 200, byok.brain.getStats());
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/brain/recall`) {
            return sendJSON(res, 200, { facts: byok.brain.recall.list() });
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/brain/recall`) {
            const { key, text, confidence, category } = body;
            if (!key || !text) return sendError(res, 400, '"key" and "text" are required.');
            const result = byok.brain.recall.save(key, text, {
                confidence: confidence || 0.70,
                category: category || 'general',
            });
            return sendJSON(res, 200, result);
        }

        if (method === 'DELETE' && pathname.startsWith(`${API_PREFIX}/brain/recall/`)) {
            const key = decodeURIComponent(pathname.split('/').pop());
            const result = byok.brain.recall.remove(key);
            return sendJSON(res, 200, result);
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/brain/recall/pending`) {
            return sendJSON(res, 200, { pending: byok.brain.recall.listPending() });
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/brain/recall/approve`) {
            const { key } = body;
            if (!key) return sendError(res, 400, '"key" is required.');
            const result = byok.brain.recall.approve(key);
            return sendJSON(res, 200, result);
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/brain/recall/reject`) {
            const { key } = body;
            if (!key) return sendError(res, 400, '"key" is required.');
            const result = byok.brain.recall.reject(key);
            return sendJSON(res, 200, result);
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/brain/experience`) {
            return sendJSON(res, 200, { entries: byok.brain.experience.list() });
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/brain/experience`) {
            const { trigger, fix, tags, context, source } = body;
            if (!trigger || !fix) return sendError(res, 400, '"trigger" and "fix" are required.');
            const result = byok.brain.experience.save({ trigger, fix, tags: tags || [], context, source });
            return sendJSON(res, 200, result);
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/brain/skills`) {
            return sendJSON(res, 200, { skills: byok.brain.skills.list() });
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/brain/skills`) {
            const { name, description, tags, content } = body;
            if (!name || !description || !content) {
                return sendError(res, 400, '"name", "description", and "content" are required.');
            }
            const result = byok.brain.skills.save(name, description, tags || [], content, 'api');
            return sendJSON(res, 200, result);
        }

        if (method === 'DELETE' && pathname.startsWith(`${API_PREFIX}/brain/skills/`)) {
            const name = decodeURIComponent(pathname.split('/').pop());
            const result = byok.brain.skills.remove(name);
            return sendJSON(res, 200, result);
        }

        if (method === 'POST' && pathname === `${API_PREFIX}/brain/search`) {
            const { query, maxResults } = body;
            if (!query) return sendError(res, 400, '"query" is required.');
            try {
                const results = await byok.brain.sessions.search(query, { maxResults: maxResults || 5 });
                return sendJSON(res, 200, { results });
            } catch (e) {
                return sendError(res, 500, `Search failed: ${e.message}`);
            }
        }

        if (method === 'GET' && pathname === `${API_PREFIX}/brain/sessions`) {
            try {
                const sessions = byok.brain.sessions.listSessions();
                return sendJSON(res, 200, { sessions });
            } catch (e) {
                return sendJSON(res, 200, { sessions: [], note: 'Session index not initialized' });
            }
        }

        sendError(res, 404, `Not found: ${method} ${pathname}`);
    };
}

module.exports = { createRouteHandler };

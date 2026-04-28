/**
 * Proxima — Perplexity Engine v4.1.0
 * Runs inside perplexity.ai BrowserView context. Sends queries via
 * /rest/sse/perplexity_ask and parses SSE blocks[].markdown_block.answer.
 * ⚠️ NOTE: parsed.text contains step JSON, NOT the answer — always use blocks[].
 */
(function () {
    if (window.__proximaPerplexity) return;

    var TIMEOUT = 600000;
    var _sessionToken = null;
    var _lastBackendUuid = null;
    var _totalTokens = 0;
    var MAX_TOKENS_BEFORE_NEW_CHAT = 180000;

    // ─── Session Token ──────────────────────────────

    function _getSessionToken() {
        if (_sessionToken) return _sessionToken;

        // Next.js apps store session data in __NEXT_DATA__
        try {
            if (window.__NEXT_DATA__ && window.__NEXT_DATA__.props) {
                var props = window.__NEXT_DATA__.props;
                var token = _deepFind(props, 'read_write_token');
                if (token) { _sessionToken = token; return token; }
                token = _deepFind(props, 'readWriteToken');
                if (token) { _sessionToken = token; return token; }
            }
        } catch (e) { }


        try {
            var cookies = document.cookie.split(';');
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                if (c.startsWith('pplx_token=') || c.startsWith('next-auth.session-token=')) {
                    _sessionToken = c.split('=').slice(1).join('=');
                    return _sessionToken;
                }
            }
        } catch (e) { }


        try {
            if (window.__pplx && window.__pplx.token) {
                _sessionToken = window.__pplx.token;
                return _sessionToken;
            }
        } catch (e) { }

        return null;
    }


    function _deepFind(obj, key, depth) {
        if (!depth) depth = 0;
        if (depth > 8 || !obj || typeof obj !== 'object') return null;
        if (obj[key] && typeof obj[key] === 'string') return obj[key];
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var result = _deepFind(obj[keys[i]], key, depth + 1);
            if (result) return result;
        }
        return null;
    }


    function _uuid() {
        return crypto.randomUUID();
    }

    // ─── SSE Stream Parser ──────────────────────────

    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var answer = '';
        var backendUuid = null;

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line.startsWith('data:')) continue;
                var data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;

                try {
                    var parsed = JSON.parse(data);


                    if (parsed.backend_uuid) {
                        backendUuid = parsed.backend_uuid;
                    }

                    // Answer lives in blocks[].markdown_block.answer
                    if (parsed.blocks && Array.isArray(parsed.blocks)) {
                        for (var bi = 0; bi < parsed.blocks.length; bi++) {
                            var block = parsed.blocks[bi];


                            if (block.markdown_block && block.markdown_block.answer &&
                                typeof block.markdown_block.answer === 'string') {
                                var blockAnswer = block.markdown_block.answer;
                                if (blockAnswer.length > answer.length) {
                                    answer = blockAnswer;
                                }
                            }


                            if (block.markdown_block && block.markdown_block.chunks &&
                                Array.isArray(block.markdown_block.chunks)) {
                                var chunked = block.markdown_block.chunks.join('');
                                if (chunked.length > answer.length) {
                                    answer = chunked;
                                }
                            }
                        }
                    }


                    if (parsed.answer && typeof parsed.answer === 'string' &&
                        parsed.answer.length > answer.length && parsed.answer.length < 50000) {
                        answer = parsed.answer;
                    }

                    // ⚠️ parsed.text is intentionally ignored — it's serialized step JSON, not answer

                } catch (e) {}
            }
        }

        reader.releaseLock();


        if (backendUuid) {
            _lastBackendUuid = backendUuid;
        }

        // Track token usage if provided in response
        if (parsed.usage && parsed.usage.total_tokens) {
            _totalTokens += parsed.usage.total_tokens;
            console.log('[Proxima Perplexity] Token usage: ' + _totalTokens + ' (this turn: ' + parsed.usage.total_tokens + ')');
        } else {
            // Estimate tokens from character count (~4 chars per token)
            if (answer.length > 0) {
                var estimatedTokens = Math.floor(answer.length / 4);
                _totalTokens += estimatedTokens;
            }
        }

        // Check if we should reset due to token limit
        if (_totalTokens >= MAX_TOKENS_BEFORE_NEW_CHAT) {
            console.log('[Proxima Perplexity] Token limit reached (' + _totalTokens + '), auto-resetting conversation');
            _totalTokens = 0;
            _lastBackendUuid = null;
        }

        answer = answer.replace(/\[\d+\]/g, '').trim();

        return answer;
    }

    // ─── Send Message ───────────────────────────────

    async function send(message) {
        var sessionToken = _getSessionToken();
        var frontendUuid = _uuid();

        var params = {
            last_backend_uuid: _lastBackendUuid || _uuid(),
            read_write_token: sessionToken || '',
            attachments: [],
            language: navigator.language || 'en-US',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
            search_focus: 'internet',
            sources: ['web'],
            frontend_uuid: frontendUuid,
            mode: 'copilot',
            model_preference: 'turbo',
            is_related_query: false,
            is_sponsored: false,
            prompt_source: 'user',
            query_source: _lastBackendUuid ? 'followup' : 'home',
            is_incognito: false,
            time_from_first_type: Math.floor(Math.random() * 5000) + 1000,
            local_search_enabled: false,
            use_schematized_api: true,
            send_back_text_in_streaming_api: true,
            supported_block_use_cases: [
                'answer_modes', 'media_items', 'knowledge_cards', 'inline_entity_cards',
                'place_widgets', 'finance_widgets', 'prediction_market_widgets', 'sports_widgets',
                'flight_status_widgets', 'news_widgets', 'shopping_widgets', 'search_result_widgets',
                'inline_images', 'inline_assets', 'placeholder_cards', 'diff_blocks',
                'inline_knowledge_cards', 'entity_group_v2', 'refinement_filters',
                'answer_tabs', 'preserve_latex', 'in_context_suggestions',
                'pending_followups', 'inline_claims', 'unified_assets'
            ],
            client_coordinates: null,
            mentions: [],
            skip_search_enabled: true,
            is_nav_suggestions_disabled: false,
            source: 'default',
            always_search_override: false,
            override_no_search: false,
            extended_context: false,
            version: '2.18'
        };

        var body = JSON.stringify({
            params: params,
            query_str: message
        });

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

        var headers = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'x-perplexity-request-endpoint': 'https://www.perplexity.ai/rest/sse/perplexity_ask',
            'x-perplexity-request-reason': 'perplexity-query-state-provider',
            'x-perplexity-request-try-number': '1',
            'x-request-id': frontendUuid
        };

        var res = await fetch('/rest/sse/perplexity_ask', {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: body,
            signal: controller.signal
        });

        if (!res.ok) {
            clearTimeout(timeoutId);
            var errBody = await res.text().catch(function () { return ''; });
            if (res.status === 401 || res.status === 403) {
                _sessionToken = null;
                throw new Error('Not logged in to Perplexity');
            }
            if (res.status === 429) throw new Error('Perplexity rate limited');
            throw new Error('Perplexity API error (' + res.status + '): ' + errBody.substring(0, 300));
        }

        var result = await _parseStream(res);
        clearTimeout(timeoutId);

        if (!result || result.length === 0) {
            throw new Error('Perplexity returned empty response');
        }

        return result;
    }


    function newConversation() {
        _lastBackendUuid = null;
        _sessionToken = null;
        _totalTokens = 0;
        console.log('[Proxima Perplexity] Conversation reset');
    }

    window.__proximaPerplexity = { send: send, newConversation: newConversation };
    console.log('[Proxima] Perplexity engine loaded');
})();

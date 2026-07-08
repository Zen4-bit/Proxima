/**
 * Proxima — Perplexity Engine
 * Runs inside perplexity.ai BrowserView context. Sends queries via
 * /rest/sse/perplexity_ask and parses SSE blocks[].markdown_block.answer.
 * ⚠️ NOTE: parsed.text contains step JSON, NOT the answer — always use blocks[].
 */
(function () {
    if (window.__proximaPerplexity) return;

    var TIMEOUT = 360000;
    var _sessionToken = null;
    var _lastBackendUuid = null;

    // Each gateway conversation gets its OWN Perplexity follow-up thread, keyed
    // by the conversationId the gateway passes as sessionId. A single global
    // _lastBackendUuid previously leaked one conversation's context into every
    // other conversation (cross-contamination). We now isolate per session and
    // persist across reloads so resuming a thread keeps its continuation.
    var _currentSessionId = null;
    var _sessions = {};
    try {
        var _savedPplxSessions = localStorage.getItem('proxima_perplexity_sessions');
        if (_savedPplxSessions) {
            _sessions = JSON.parse(_savedPplxSessions);
        }
    } catch (e) { }

    // Bound the persisted session map (oldest-inserted evicted first; the
    // active session is never removed).
    var MAX_SESSIONS = 200;
    function _pruneSessions() {
        var keys = Object.keys(_sessions);
        for (var i = 0; i < keys.length && Object.keys(_sessions).length > MAX_SESSIONS; i++) {
            if (keys[i] !== _currentSessionId) delete _sessions[keys[i]];
        }
    }

    function activateSession(sessionId) {
        if (!sessionId) sessionId = 'default';
        if (sessionId !== _currentSessionId) {
            _currentSessionId = sessionId;
            if (!_sessions[sessionId]) {
                _sessions[sessionId] = { backendUuid: null };
            }
            // Load this session's continuation thread (null → fresh thread).
            _lastBackendUuid = _sessions[sessionId].backendUuid || null;
        }
    }

    function saveSession() {
        if (!_currentSessionId) return;
        if (!_sessions[_currentSessionId]) _sessions[_currentSessionId] = {};
        _sessions[_currentSessionId].backendUuid = _lastBackendUuid;
        try {
            _pruneSessions();
            localStorage.setItem('proxima_perplexity_sessions', JSON.stringify(_sessions));
        } catch (e) { }
    }

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

    // Strip Perplexity's bracketed source markers (e.g. [1], [2]) from PROSE
    // only — NEVER from inside code, where [0]/[2] are real array indices /
    // regex. Markdown always wraps code in fenced ```...``` or inline `...`, so
    // we protect those regions and strip citation markers everywhere else.
    function _stripCitations(text) {
        if (!text) return text;
        var parts = text.split(/(```[\s\S]*?```|`[^`]*`)/g);
        for (var i = 0; i < parts.length; i += 2) { // even indices = non-code text
            parts[i] = parts[i].replace(/\[\d+\]/g, '');
        }
        return parts.join('');
    }

    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var answer = '';
        var backendUuid = null;

        try {
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


                        // Top-level `answer` is a fallback for when blocks[] isn't
                        // present. Adopt it only when it's longer than what we have
                        // (no arbitrary length cap — a long real answer must not be
                        // silently dropped).
                        if (parsed.answer && typeof parsed.answer === 'string' &&
                            parsed.answer.length > answer.length) {
                            answer = parsed.answer;
                        }

                        // ⚠️ parsed.text is intentionally ignored — it's serialized step JSON, not answer

                    } catch (e) { }
                }
            }
        } finally {
            // Always release the stream lock, even if a mid-stream network drop
            // makes reader.read() throw — otherwise the response body stays
            // locked and leaks.
            try { reader.releaseLock(); } catch (e) { }
        }


        if (backendUuid) {
            _lastBackendUuid = backendUuid;
        }


        answer = _stripCitations(answer).trim();

        return answer;
    }

    async function uploadFileToPerplexity(fileBase64, filename, mimeType) {
        var bytes;
        try {
            var binaryString = atob(fileBase64);
            bytes = new Uint8Array(binaryString.length);
            for (var i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
        } catch (e) {
            throw new Error('Failed to decode base64 file data: ' + e.message);
        }
        var size = bytes.byteLength || bytes.length;

        var fileKey = crypto.randomUUID();
        var initPayload = {
            files: {}
        };
        initPayload.files[fileKey] = {
            filename: filename,
            content_type: mimeType,
            source: "default",
            file_size: size,
            force_image: false,
            skip_parsing: false
        };

        var initHeaders = {
            'Content-Type': 'application/json',
            'x-app-apiclient': 'default',
            'x-app-apiversion': '2.18',
            'x-perplexity-request-endpoint': 'https://www.perplexity.ai/rest/uploads/batch_create_upload_urls?version=2.18&source=default',
            'x-perplexity-request-reason': 'ask-input-inner-home',
            'x-perplexity-request-try-number': '1',
            'x-request-id': crypto.randomUUID()
        };

        var initRes = await fetch('/rest/uploads/batch_create_upload_urls?version=2.18&source=default', {
            method: 'POST',
            credentials: 'include',
            headers: initHeaders,
            body: JSON.stringify(initPayload)
        });

        if (!initRes.ok) {
            var errText = await initRes.text();
            throw new Error('Perplexity upload initialization failed (' + initRes.status + '): ' + errText);
        }

        var initData = await initRes.json();
        var result = initData.results && initData.results[fileKey];
        if (!result) {
            throw new Error('Perplexity upload URL creation failed: fileKey not found in results');
        }
        if (result.rate_limited) {
            throw new Error('Perplexity upload rate limit reached. Please try again later or upgrade to a Pro account.');
        }
        if (result.error) {
            throw new Error('Perplexity upload URL creation failed: ' + result.error);
        }

        var s3BucketUrl = result.s3_bucket_url;
        var s3ObjectUrl = result.s3_object_url;
        var fields = result.fields || {};

        var formData = new FormData();
        for (var key in fields) {
            if (fields.hasOwnProperty(key)) {
                formData.append(key, fields[key]);
            }
        }
        formData.append('file', new Blob([bytes], { type: mimeType }), filename);

        var uploadRes = await fetch(s3BucketUrl, {
            method: 'POST',
            body: formData
        });

        if (!uploadRes.ok) {
            var errText = await uploadRes.text();
            throw new Error('S3 upload failed (' + uploadRes.status + '): ' + errText);
        }

        return s3ObjectUrl;
    }

    async function send(message, engine, attachments, sessionId) {
        // Isolate this conversation's follow-up thread before building params.
        activateSession(sessionId);

        var sessionToken = _getSessionToken();
        var frontendUuid = _uuid();

        var params = {
            last_backend_uuid: _lastBackendUuid || _uuid(),
            read_write_token: sessionToken || '',
            attachments: (attachments && attachments.imageToken) ? [attachments.imageToken] : [],
            language: navigator.language || 'en-US',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
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

        var headers = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'x-perplexity-request-endpoint': 'https://www.perplexity.ai/rest/sse/perplexity_ask',
            'x-perplexity-request-reason': 'perplexity-query-state-provider',
            'x-perplexity-request-try-number': '1',
            'x-request-id': frontendUuid
        };

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

        try {
            var res = await fetch('/rest/sse/perplexity_ask', {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: body,
                signal: controller.signal
            });

            if (!res.ok) {
                var errBody = await res.text().catch(function () { return ''; });
                if (res.status === 401 || res.status === 403) {
                    _sessionToken = null;
                    throw new Error('Not logged in to Perplexity');
                }
                if (res.status === 429) throw new Error('Perplexity rate limited');
                throw new Error('Perplexity API error (' + res.status + '): ' + errBody.substring(0, 300));
            }

            var result = await _parseStream(res);

            // Persist the (possibly updated) continuation uuid for THIS session so
            // a later turn on the same conversation resumes its own thread.
            saveSession();

            if (!result || result.length === 0) {
                throw new Error('Perplexity returned empty response');
            }

            return result;
        } finally {
            // Always clear the abort timer — on success, on !res.ok, AND on a
            // mid-stream parse throw (previously leaked a 360s timer on throw).
            clearTimeout(timeoutId);
        }
    }


    function newConversation(sessionId) {
        if (sessionId) {
            delete _sessions[sessionId];
            if (_currentSessionId === sessionId) {
                _currentSessionId = null;
                _lastBackendUuid = null;
            }
        } else if (_currentSessionId) {
            // No id given → reset the ACTIVE session only (mirrors the Claude /
            // Gemini engines), so other conversations keep their own threads.
            delete _sessions[_currentSessionId];
            _currentSessionId = null;
            _lastBackendUuid = null;
        } else {
            // Nothing active yet — clear the loose global as a safety net.
            _lastBackendUuid = null;
        }
        // Token is account-level (not per-conversation); drop it so it is
        // re-fetched fresh on the next send.
        _sessionToken = null;
        try {
            localStorage.setItem('proxima_perplexity_sessions', JSON.stringify(_sessions));
        } catch (e) { }
        console.log('[Proxima Perplexity] Conversation reset:', sessionId || _currentSessionId || 'current');
    }

    window.__proximaPerplexity = { send: send, newConversation: newConversation, uploadFileToPerplexity: uploadFileToPerplexity };
    console.log('[Proxima] Perplexity engine loaded');
})();

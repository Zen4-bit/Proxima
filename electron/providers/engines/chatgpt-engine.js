// Proxima — ChatGPT Engine.
// Performs SSE message streaming, multi-session state isolation, and handles proof-of-work challenges.

(function () {
    if (window.__proximaChatGPT) return;

    var TIMEOUT = 360000;

    var _conversationId = null;
    var _parentMessageId = null;
    var _cachedToken = null;
    var _tokenExpiry = 0;

    var _currentSessionId = null;
    var _sessions = {};
    try {
        var saved = localStorage.getItem('proxima_chatgpt_sessions');
        if (saved) {
            _sessions = JSON.parse(saved);
            console.log('[Proxima ChatGPT] Restored', Object.keys(_sessions).length, 'sessions from localStorage');
        }
    } catch (e) {
        console.error('[Proxima ChatGPT] Failed to restore sessions:', e);
    }

    var MAX_SESSIONS = 200;
    function _pruneSessions() {
        var keys = Object.keys(_sessions);
        for (var i = 0; i < keys.length && Object.keys(_sessions).length > MAX_SESSIONS; i++) {
            if (keys[i] !== _currentSessionId) delete _sessions[keys[i]];
        }
    }

    function activateSession(sessionId) {
        if (!sessionId) sessionId = 'default';
        _currentSessionId = sessionId;
        if (!_sessions[sessionId]) {
            _sessions[sessionId] = { conversationId: null, parentMessageId: null };
        }
        var sess = _sessions[sessionId];
        _conversationId = sess.conversationId;
        _parentMessageId = sess.parentMessageId;
        return sess;
    }

    function saveSession(sessionId) {
        if (!sessionId) sessionId = 'default';
        var sess = _sessions[sessionId];
        if (sess) {
            sess.conversationId = _conversationId;
            sess.parentMessageId = _parentMessageId;
        }
        try {
            _pruneSessions();
            localStorage.setItem('proxima_chatgpt_sessions', JSON.stringify(_sessions));
        } catch (e) { }
    }

    var SHA3 = (function () {
        var RC = [
            [0x00000001, 0x00000000], [0x00008082, 0x00000000], [0x0000808a, 0x80000000],
            [0x80008000, 0x80000000], [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
            [0x80008081, 0x80000000], [0x00008009, 0x80000000], [0x0000008a, 0x00000000],
            [0x00000088, 0x00000000], [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
            [0x8000808b, 0x00000000], [0x0000008b, 0x80000000], [0x00008089, 0x80000000],
            [0x00008003, 0x80000000], [0x00008002, 0x80000000], [0x00000080, 0x80000000],
            [0x0000800a, 0x00000000], [0x8000000a, 0x80000000], [0x80008081, 0x80000000],
            [0x00008080, 0x80000000], [0x80000001, 0x00000000], [0x80008008, 0x80000000]
        ];
        var ROTL = [
            [0, 0], [1, 0], [62, 0], [28, 0], [27, 0], [36, 0], [44, 0], [6, 0], [55, 0], [20, 0],
            [3, 0], [10, 0], [43, 0], [25, 0], [39, 0], [41, 0], [45, 0], [15, 0], [21, 0], [8, 0],
            [18, 0], [2, 0], [61, 0], [56, 0], [14, 0]
        ];
        var PI = [0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13, 14, 24, 9, 19, 4];

        function rot64(lo, hi, n) {
            if (n === 0) return [lo, hi];
            if (n < 32) return [(lo << n) | (hi >>> (32 - n)), (hi << n) | (lo >>> (32 - n))];
            n -= 32;
            return [(hi << n) | (lo >>> (32 - n)), (lo << n) | (hi >>> (32 - n))];
        }

        function keccakf(state) {
            var s = new Int32Array(50);
            for (var i = 0; i < 50; i++) s[i] = state[i];
            for (var round = 0; round < 24; round++) {
                var C = new Int32Array(10);
                for (var x = 0; x < 5; x++) {
                    C[x * 2] = s[x * 2] ^ s[(x + 5) * 2] ^ s[(x + 10) * 2] ^ s[(x + 15) * 2] ^ s[(x + 20) * 2];
                    C[x * 2 + 1] = s[x * 2 + 1] ^ s[(x + 5) * 2 + 1] ^ s[(x + 10) * 2 + 1] ^ s[(x + 15) * 2 + 1] ^ s[(x + 20) * 2 + 1];
                }
                for (var x = 0; x < 5; x++) {
                    var px = ((x + 4) % 5), nx = ((x + 1) % 5);
                    var d = rot64(C[nx * 2], C[nx * 2 + 1], 1);
                    var tlo = C[px * 2] ^ d[0], thi = C[px * 2 + 1] ^ d[1];
                    for (var y = 0; y < 25; y += 5) { s[(y + x) * 2] ^= tlo; s[(y + x) * 2 + 1] ^= thi; }
                }
                var B = new Int32Array(50);
                for (var i = 0; i < 25; i++) {
                    var r = rot64(s[i * 2], s[i * 2 + 1], ROTL[i][0] % 64);
                    B[PI[i] * 2] = r[0]; B[PI[i] * 2 + 1] = r[1];
                }
                for (var y = 0; y < 25; y += 5) {
                    for (var x = 0; x < 5; x++) {
                        s[(y + x) * 2] = B[(y + x) * 2] ^ (~B[(y + (x + 1) % 5) * 2] & B[(y + (x + 2) % 5) * 2]);
                        s[(y + x) * 2 + 1] = B[(y + x) * 2 + 1] ^ (~B[(y + (x + 1) % 5) * 2 + 1] & B[(y + (x + 2) % 5) * 2 + 1]);
                    }
                }
                s[0] ^= RC[round][0]; s[1] ^= RC[round][1];
            }
            for (var i = 0; i < 50; i++) state[i] = s[i];
        }

        function sha3_512(message) {
            var rate = 72;
            var msgBytes = new TextEncoder().encode(message);
            var padLen = rate - (msgBytes.length % rate);
            var padded = new Uint8Array(msgBytes.length + padLen);
            padded.set(msgBytes);
            padded[msgBytes.length] = 0x06;
            padded[padded.length - 1] |= 0x80;
            var state = new Int32Array(50);
            for (var offset = 0; offset < padded.length; offset += rate) {
                for (var i = 0; i < rate; i += 4) {
                    var idx = (i / 4);
                    if (idx < 50) {
                        state[idx] ^= (padded[offset + i]) | (padded[offset + i + 1] << 8) | (padded[offset + i + 2] << 16) | (padded[offset + i + 3] << 24);
                    }
                }
                keccakf(state);
            }
            var hash = new Uint8Array(64);
            for (var i = 0; i < 64; i += 4) {
                var w = state[i / 4];
                hash[i] = w & 0xff; hash[i + 1] = (w >> 8) & 0xff; hash[i + 2] = (w >> 16) & 0xff; hash[i + 3] = (w >> 24) & 0xff;
            }
            return Array.from(hash).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        }

        return { sha3_512: sha3_512 };
    })();

    async function _solvePOW(seed, difficulty, scripts, dpl) {
        function encode(arr) {
            var json = JSON.stringify(arr);
            return btoa(String.fromCharCode.apply(null, new TextEncoder().encode(json)));
        }
        var startTime = performance.now();
        var navKeys = Object.keys(Object.getPrototypeOf(navigator));
        var pickRandom = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

        var config = [
            navigator.hardwareConcurrency + screen.width + screen.height,
            new Date().toString(),
            (performance.memory && performance.memory.jsHeapSizeLimit) || 4294705152,
            0,
            navigator.userAgent,
            pickRandom(scripts || [null]),
            dpl || '',
            navigator.language,
            navigator.languages.join(','),
            0,
            pickRandom(navKeys) + '-' + navigator[pickRandom(navKeys)],
            pickRandom(Object.keys(document)),
            pickRandom(Object.keys(window)),
            performance.now(),
            crypto.randomUUID()
        ];

        for (var i = 1; i < 100000; i++) {
            // Yield to the event loop periodically to keep the UI responsive.
            if (i % 2000 === 0) await new Promise(function (r) { setTimeout(r, 10); });
            config[3] = i;
            config[9] = Math.round(performance.now() - startTime);
            var encoded = encode(config);
            var hash = SHA3.sha3_512(seed + encoded);
            if (hash.substring(0, difficulty.length) <= difficulty) {
                return encoded;
            }
        }
        return null;
    }

    async function _getToken() {
        if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
        var res = await fetch('/api/auth/session', { credentials: 'include' });
        if (res.status === 429) throw new Error('Too many requests');
        if (res.status === 403) throw new Error('Cloudflare check required');
        if (!res.ok) throw new Error('Session failed (' + res.status + ')');
        var data = await res.json();
        if (!data.accessToken) throw new Error('Not logged in to ChatGPT');
        _cachedToken = data.accessToken;
        _tokenExpiry = Date.now() + 300000;
        return _cachedToken;
    }

    var _cachedScripts = null;
    var _cachedDpl = null;

    async function _getScriptsAndDpl() {
        if (_cachedScripts) return { scripts: _cachedScripts, dpl: _cachedDpl };
        try {
            var html = await fetch('/', { credentials: 'include' }).then(function (r) { return r.text(); });
            _cachedScripts = [];
            var m;
            var re = /src="([^"]*)"/g;
            while ((m = re.exec(html)) !== null) _cachedScripts.push(m[1]);
            var dplMatch = html.match(/dpl=([a-zA-Z0-9_-]+)/);
            _cachedDpl = dplMatch ? dplMatch[1] : '';
        } catch (e) {
            _cachedScripts = [null];
            _cachedDpl = '';
        }
        return { scripts: _cachedScripts, dpl: _cachedDpl };
    }

    async function _getRequirementsAndPOW(token) {
        var reqRes = await fetch('/backend-api/sentinel/chat-requirements', {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ conversation_mode_kind: 'primary_assistant' })
        });

        if (!reqRes.ok) return {};
        var req = await reqRes.json();
        var result = { requirementsToken: req.token || null };

        if (req.proofofwork && req.proofofwork.required) {
            var sd = await _getScriptsAndDpl();
            var powToken = await _solvePOW(req.proofofwork.seed, req.proofofwork.difficulty, sd.scripts, sd.dpl);
            if (powToken) result.proofToken = 'gAAAAAB' + powToken;
        }

        return result;
    }

    async function _parseSSEStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var buffer = '';

        try {
            while (true) {
                var chunk = await reader.read();
                if (chunk.done) break;

                buffer += decoder.decode(chunk.value, { stream: true });
                var lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (!line.startsWith('data: ')) continue;
                    var data = line.slice(6).trim();
                    if (data === '[DONE]') continue;

                    try {
                        var parsed = JSON.parse(data);

                        if (parsed.conversation_id) {
                            _conversationId = parsed.conversation_id;
                        }

                        var parts = parsed && parsed.message && parsed.message.content && parsed.message.content.parts;
                        if (parts && parts.length > 0 && parsed.message.author && parsed.message.author.role === 'assistant') {
                            fullText = parts.join('');

                            if (parsed.message.id) {
                                _parentMessageId = parsed.message.id;
                            }
                        }
                    } catch (e) { }
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (e) { }
        }
        return fullText;
    }

    async function uploadFileToChatGPT(fileBase64, filename, mimeType) {
        var token = await _getToken();

        var deviceId = '';
        try {
            var cookies = document.cookie.split(';');
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                if (c.startsWith('oai-did=')) { deviceId = c.substring(8); break; }
            }
        } catch (e) { }

        var binStr = atob(fileBase64);
        var size = binStr.length;
        var bytes = new Uint8Array(size);
        for (var i = 0; i < size; i++) {
            bytes[i] = binStr.charCodeAt(i);
        }

        var headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'OAI-Language': 'en-US'
        };
        if (deviceId) headers['OAI-Device-Id'] = deviceId;

        var initPayload = {
            file_name: filename,
            file_size: size,
            use_case: "multimodal"
        };

        var initRes = await fetch('/backend-api/files', {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(initPayload)
        });

        if (!initRes.ok) {
            var errText = await initRes.text();
            throw new Error('ChatGPT file upload initialization failed (' + initRes.status + '): ' + errText);
        }

        var initData = await initRes.json();
        if (initData.status !== 'success' || !initData.upload_url || !initData.file_id) {
            throw new Error('Invalid response from files API');
        }

        var uploadUrl = initData.upload_url;
        var fileId = initData.file_id;

        console.log('[Proxima ChatGPT API] Upload metadata created. Transferring binary bytes to Azure Blob...');

        var uploadHeaders = {
            'Content-Type': mimeType,
            'x-ms-blob-type': 'BlockBlob'
        };

        var finalRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: uploadHeaders,
            body: bytes
        });

        if (!finalRes.ok) {
            var errText = await finalRes.text();
            throw new Error('Azure Blob upload failed (' + finalRes.status + '): ' + errText);
        }

        console.log('[Proxima ChatGPT API] Azure Blob transfer complete. Finalizing upload on ChatGPT backend...');

        var finalizeRes = await fetch('/backend-api/files/' + fileId + '/uploaded', {
            method: 'POST',
            credentials: 'include',
            headers: headers
        });

        if (!finalizeRes.ok) {
            var errText = await finalizeRes.text();
            throw new Error('ChatGPT file upload finalization failed (' + finalizeRes.status + '): ' + errText);
        }

        console.log('[Proxima ChatGPT API] Upload finalized! File ID:', fileId);
        return fileId;
    }

    async function send(message, engine, attachments, sessionId) {
        activateSession(sessionId);

        var token = await _getToken();

        var deviceId = '';
        try {
            var cookies = document.cookie.split(';');
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                if (c.startsWith('oai-did=')) { deviceId = c.substring(8); break; }
            }
        } catch (e) { }

        var powData = await _getRequirementsAndPOW(token);

        var headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'Accept': 'text/event-stream',
            'OAI-Language': 'en-US'
        };

        if (deviceId) headers['OAI-Device-Id'] = deviceId;
        if (powData.requirementsToken) headers['Openai-Sentinel-Chat-Requirements-Token'] = powData.requirementsToken;
        if (powData.proofToken) headers['Openai-Sentinel-Proof-Token'] = powData.proofToken;

        var messageContent;
        var messageMetadata = {};

        if (attachments && attachments.imageToken) {
            var fileId = attachments.imageToken;
            var mimeType = attachments.mimeType || 'image/png';
            var fileSize = attachments.fileSize || 0;
            var isImage = mimeType.startsWith('image/');

            if (isImage) {
                messageContent = {
                    content_type: 'multimodal_text',
                    parts: [
                        message,
                        {
                            content_type: 'image_asset_pointer',
                            asset_pointer: 'file-service://' + fileId,
                            size_bytes: fileSize,
                            width: 500,
                            height: 500
                        }
                    ]
                };
            } else {
                messageContent = {
                    content_type: 'multimodal_text',
                    parts: [
                        message,
                        {
                            content_type: 'file_asset_pointer',
                            asset_pointer: 'file-service://' + fileId,
                            size_bytes: fileSize
                        }
                    ]
                };
            }
            messageMetadata = {};
        } else {
            messageContent = {
                content_type: 'text',
                parts: [message]
            };
        }

        var payload = {
            action: 'next',
            messages: [{
                id: crypto.randomUUID(),
                author: { role: 'user' },
                content: messageContent,
                metadata: messageMetadata
            }],
            model: 'auto',
            parent_message_id: _parentMessageId || crypto.randomUUID(),
            timezone_offset_min: new Date().getTimezoneOffset(),
            history_and_training_disabled: false,
            conversation_mode: { kind: 'primary_assistant' },
            force_paragen: false,
            force_nulligen: false,
            force_rate_limit: false,
            websocket_request_id: crypto.randomUUID()
        };

        if (_conversationId) {
            payload.conversation_id = _conversationId;
            console.log('[Proxima ChatGPT] Continuing conversation:', _conversationId);
        } else {
            console.log('[Proxima ChatGPT] Starting new conversation');
        }

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

        var res = await fetch('/backend-api/conversation', {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        // Refresh expired session token and retry the conversation request once.
        if (res.status === 401) {
            clearTimeout(timeoutId);
            var newToken = await _getToken();
            headers['Authorization'] = 'Bearer ' + newToken;
            var retryController = new AbortController();
            var retryTimeoutId = setTimeout(function () { retryController.abort(); }, TIMEOUT);
            res = await fetch('/backend-api/conversation', {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(payload),
                signal: retryController.signal
            });
            if (!res.ok) {
                clearTimeout(retryTimeoutId);
                var err = await res.text().catch(function () { return ''; });
                throw new Error('ChatGPT API error (' + res.status + '): ' + err.substring(0, 300));
            }
            var retryContentType = res.headers.get('content-type') || '';
            if (retryContentType.startsWith('application/json')) {
                clearTimeout(retryTimeoutId);
                throw new Error('WebSocket mode not supported');
            }
            var result;
            try { result = await _parseSSEStream(res); }
            finally { clearTimeout(retryTimeoutId); }
            saveSession(sessionId);
            return result;
        }

        if (!res.ok) {
            clearTimeout(timeoutId);
            var err = await res.text().catch(function () { return ''; });
            throw new Error('ChatGPT API error (' + res.status + '): ' + err.substring(0, 300));
        }

        var resContentType = res.headers.get('content-type') || '';
        if (resContentType.startsWith('application/json')) {
            clearTimeout(timeoutId);
            throw new Error('WebSocket mode not supported');
        }

        var result;
        try { result = await _parseSSEStream(res); }
        finally { clearTimeout(timeoutId); }
        saveSession(sessionId);
        return result;
    }

    function newConversation(sessionId) {
        if (sessionId) {
            delete _sessions[sessionId];
        } else if (_currentSessionId) {
            delete _sessions[_currentSessionId];
        }
        _conversationId = null;
        _parentMessageId = null;
        _currentSessionId = null;
        try {
            localStorage.setItem('proxima_chatgpt_sessions', JSON.stringify(_sessions));
        } catch (e) { }
        console.log('[Proxima ChatGPT] Conversation reset:', sessionId || 'current');
    }

    window.__proximaChatGPT = { send: send, newConversation: newConversation, uploadFileToChatGPT: uploadFileToChatGPT };
    console.log('[Proxima] ChatGPT engine loaded');
    _getToken().catch(function () { });
    _getScriptsAndDpl().catch(function () { });
})();

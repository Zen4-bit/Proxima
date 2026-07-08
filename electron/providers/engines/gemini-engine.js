// Proxima — Unified Gemini Engine.
// Performs StreamGenerate request routing, Scotty file uploads, and session management.

(function () {
    if (window.__proximaGeminiUnified) return;

    var TIMEOUT = 360000;
    var TOKEN_TTL = 300000;
    var _tokens = null;
    var _tokensFetchedAt = 0;

    function generateUuid() {
        return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    var _conversationId = '';
    var _responseId = '';
    var _choiceId = '';
    var _contextToken = '';
    var _sessionUuid = generateUuid().toUpperCase();
    var _workspaces = { fast: [], thinking: [] };

    var _sessions = {};
    var _currentSessionId = null;
    try {
        var saved = localStorage.getItem('proxima_sessions');
        if (saved) {
            _sessions = JSON.parse(saved);
            console.log('[Proxima API] Restored', Object.keys(_sessions).length, 'sessions from localStorage');
        }
    } catch (e) {
        console.error('[Proxima API] Failed to restore sessions:', e);
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
            _sessions[sessionId] = {
                conversationId: '',
                responseId: '',
                choiceId: '',
                contextToken: '',
                sessionUuid: generateUuid().toUpperCase()
            };
        }
        var sess = _sessions[sessionId];
        if (!sess.sessionUuid) {
            sess.sessionUuid = generateUuid().toUpperCase();
        }
        _conversationId = sess.conversationId;
        _responseId = sess.responseId;
        _choiceId = sess.choiceId;
        _contextToken = sess.contextToken || '';
        _sessionUuid = sess.sessionUuid;
        return sess;
    }

    function saveSession(sessionId) {
        if (!sessionId) sessionId = 'default';
        var sess = _sessions[sessionId];
        if (sess) {
            sess.conversationId = _conversationId;
            sess.responseId = _responseId;
            sess.choiceId = _choiceId;
            sess.contextToken = _contextToken;
            sess.sessionUuid = _sessionUuid;
        }
        try {
            _pruneSessions();
            localStorage.setItem('proxima_sessions', JSON.stringify(_sessions));
        } catch (e) { }
    }

    function _detectWorkspaces() {
        try {
            if (window.WIZ_global_data) {
                for (var key in window.WIZ_global_data) {
                    var val = window.WIZ_global_data[key];
                    if (typeof val === 'string' && val.indexOf('thinking=') !== -1) {
                        var parts = val.replace(/\\u003d/g, '=').split('","');
                        parts.forEach(function (part) {
                            var cleanPart = part.replace(/"/g, '');
                            if (cleanPart.indexOf('thinking=') === 0) {
                                _workspaces.thinking = cleanPart.replace('thinking=', '').split(',');
                            } else if (cleanPart.indexOf('fast=') === 0) {
                                _workspaces.fast = cleanPart.replace('fast=', '').split(',');
                            }
                        });
                    }
                }
            }

            if (_workspaces.fast.length === 0) {
                var html = document.documentElement.innerHTML;
                var m3Idx = html.indexOf('m3eQte');
                if (m3Idx !== -1) {
                    var m3Snippet = html.substring(m3Idx, m3Idx + 400);
                    var startIdx = m3Snippet.indexOf('[[');
                    var endIdx = m3Snippet.indexOf(']]');
                    if (startIdx !== -1 && endIdx !== -1) {
                        var content = m3Snippet.substring(startIdx + 2, endIdx);
                        var rawConfig = content
                            .replace(/\\\\u003d/g, '=')
                            .replace(/\\u003d/g, '=')
                            .replace(/\\\\/g, '')
                            .replace(/\\"/g, '"');

                        var parts = rawConfig.split('","');
                        parts.forEach(function (part) {
                            var cleanPart = part.replace(/"/g, '');
                            if (cleanPart.indexOf('thinking=') === 0) {
                                _workspaces.thinking = cleanPart.replace('thinking=', '').split(',');
                            } else if (cleanPart.indexOf('fast=') === 0) {
                                _workspaces.fast = cleanPart.replace('fast=', '').split(',');
                            }
                        });
                    }
                }
            }

            console.log('[Proxima API] Detected Workspaces:', JSON.stringify(_workspaces));
        } catch (e) {
            console.error('[Proxima API] Workspace detection error:', e);
        }
    }

    async function _getTokens(forceRefresh) {
        var isExpired = (Date.now() - _tokensFetchedAt) > TOKEN_TTL;
        if (_tokens && !forceRefresh && !isExpired) return _tokens;

        // Extract from active page context to avoid multi-account mismatch
        var at = null;
        var bl = null;
        try {
            // 1. Try WIZ_global_data
            if (window.WIZ_global_data) {
                for (var key in window.WIZ_global_data) {
                    var val = window.WIZ_global_data[key];
                    if (Array.isArray(val)) {
                        var foundAt = null;
                        var foundBl = null;
                        function searchArray(arr) {
                            for (var i = 0; i < arr.length; i++) {
                                if (typeof arr[i] === 'string') {
                                    if (arr[i] === 'SNlM0e' && typeof arr[i+1] === 'string') {
                                        foundAt = arr[i+1];
                                    } else if (arr[i] === 'cfb2h' && typeof arr[i+1] === 'string') {
                                        foundBl = arr[i+1];
                                    }
                                }
                                if (Array.isArray(arr[i])) searchArray(arr[i]);
                            }
                        }
                        searchArray(val);
                        if (foundAt) at = foundAt;
                        if (foundBl) bl = foundBl;
                    }
                }
            }

            // 2. Try raw HTML of the current document
            var html = document.documentElement.innerHTML;
            if (!at) {
                var atMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/) || html.match(/SNlM0e":"([^"]+)"/);
                if (atMatch) at = atMatch[1];
            }
            if (!bl) {
                var blMatch = html.match(/"cfb2h"\s*:\s*"([^"]+)"/) || html.match(/cfb2h":"([^"]+)"/) || html.match(/boq_assistant-bard-web-server_[a-zA-Z0-9_\.\-]+/);
                if (blMatch) bl = blMatch[1] || blMatch[0];
            }
        } catch (e) {
            console.error('[Proxima API] Failed to extract tokens from page context:', e);
        }

        // Return immediately if extraction succeeded
        if (at && bl) {
            console.log('[Proxima API] Dynamically extracted active tokens from page memory. AT:', at.substring(0, 15) + '...', 'BL:', bl);
            _tokens = { at: at, bl: bl };
            _tokensFetchedAt = Date.now();
            return _tokens;
        }

        console.log('[Proxima API] Mismatch/Missing tokens in memory. Fetching fallback tokens from /faq...');
        var controller = new AbortController();
        var tid = setTimeout(function () { controller.abort(); }, 30000);

        var res = await fetch('/faq', { credentials: 'include', signal: controller.signal });
        clearTimeout(tid);

        if (!res.ok) throw new Error('Gemini page fetch failed (' + res.status + ')');
        var html = await res.text();

        if (html.indexOf('$authuser') === -1) {
            throw new Error('Not logged into Google');
        }

        try {
            at = html.split('SNlM0e')[1].split('":"')[1].split('"')[0];
        } catch (e) { throw new Error('Failed to extract SNlM0e token'); }

        try {
            bl = html.split('cfb2h')[1].split('":"')[1].split('"')[0];
        } catch (e) { throw new Error('Failed to extract cfb2h token'); }

        _tokens = { at: at, bl: bl };
        _tokensFetchedAt = Date.now();
        return _tokens;
    }

    function _parseResponse(rawText, commitIds) {
        var cleanText = rawText.replace(/^\)\]}'?\s*\n?/, '');
        var lines = cleanText.split('\n').filter(function (l) { return l.trim().length > 0; });

        var allItems = [];
        var dataIndices = [];

        for (var li = 0; li < lines.length; li++) {
            try {
                var arr = JSON.parse(lines[li]);
                if (Array.isArray(arr) && arr.length > 0) {
                    for (var ai = 0; ai < arr.length; ai++) {
                        var item = arr[ai];
                        if (!Array.isArray(item)) continue;
                        for (var idx = 0; idx < Math.min(item.length, 6); idx++) {
                            if (typeof item[idx] === 'string' && item[idx].length > 50) {
                                try {
                                    JSON.parse(item[idx]);
                                    allItems.push(item);
                                    dataIndices.push(idx);
                                    break;
                                } catch (e) { }
                            }
                        }
                    }
                }
            } catch (e) { }
        }

        if (allItems.length === 0) {
            var jsonStrings = [];
            function deepSearch(obj) {
                if (typeof obj === 'string' && obj.length > 50) {
                    try { JSON.parse(obj); jsonStrings.push(obj); } catch (e) { }
                } else if (Array.isArray(obj)) {
                    for (var i = 0; i < obj.length; i++) deepSearch(obj[i]);
                }
            }
            for (var i = 0; i < lines.length; i++) {
                try { deepSearch(JSON.parse(lines[i])); } catch (e) { }
            }
            if (jsonStrings.length > 0) {
                for (var j = 0; j < jsonStrings.length; j++) {
                    allItems.push([null, null, jsonStrings[j]]);
                    dataIndices.push(2);
                }
            }
        }

        if (allItems.length === 0) {
            console.error('[Proxima API] Parse error: Raw response length is ' + rawText.length + '. Content: ' + rawText.substring(0, 500));
            throw new Error('Failed to parse Gemini response');
        }

        var extracted = { conversationId: null, responseId: null, choiceId: null, contextToken: null };
        var _answerFrameSeen = false;

        for (var ci = 0; ci < allItems.length; ci++) {
            try {
                var innerC = JSON.parse(allItems[ci][dataIndices[ci] || 2]);
                var hasChoice = innerC[4] && innerC[4][0]
                    && typeof innerC[4][0][0] === 'string' && innerC[4][0][0].length > 5;

                if (hasChoice) {
                    if (innerC[1] && Array.isArray(innerC[1])) {
                        if (typeof innerC[1][0] === 'string' && innerC[1][0].length > 5) {
                            extracted.conversationId = innerC[1][0];
                        }
                        if (typeof innerC[1][1] === 'string' && innerC[1][1].length > 5) {
                            extracted.responseId = innerC[1][1];
                        }
                    }
                    extracted.choiceId = innerC[4][0][0];
                    _answerFrameSeen = true;
                } else if (!_answerFrameSeen && innerC[1] && Array.isArray(innerC[1])) {
                    if (typeof innerC[1][0] === 'string' && innerC[1][0].length > 5) {
                        extracted.conversationId = innerC[1][0];
                    }
                    if (typeof innerC[1][1] === 'string' && innerC[1][1].length > 5) {
                        extracted.responseId = innerC[1][1];
                    }
                }

                if (innerC[2] && typeof innerC[2] === 'object' && !Array.isArray(innerC[2])
                    && typeof innerC[2]['26'] === 'string' && innerC[2]['26'].length > 5) {
                    extracted.contextToken = innerC[2]['26'];
                }
            } catch (e) { }
        }

        if (commitIds) {
            if (extracted.conversationId) _conversationId = extracted.conversationId;
            if (extracted.responseId) _responseId = extracted.responseId;
            if (extracted.choiceId) _choiceId = extracted.choiceId;
            if (extracted.contextToken) _contextToken = extracted.contextToken;
        }

        var replyText = '';

        for (var i = 0; i < allItems.length; i++) {
            var item = allItems[i];
            var idx = dataIndices[i] || 2;
            try {
                var inner = JSON.parse(item[idx]);
                var paths = [
                    function () { return (Array.isArray(inner[0]) && typeof inner[0][0] === 'string') ? inner[0][0] : ''; },
                    function () { return (inner[4] && inner[4][0] && inner[4][0][1] && inner[4][0][1][0]) || ''; },
                    function () { return (inner[4] && inner[4][0] && inner[4][0][1]) || ''; },
                    function () { return (Array.isArray(inner[1]) && typeof inner[1][0] === 'string') ? inner[1][0] : ''; },
                    function () { return (inner[0] && inner[0][1] && inner[0][1][0]) || ''; },
                    function () { return (inner[3] && inner[3][0] && inner[3][0][0]) || ''; },
                    function () { return (inner[3] && inner[3][1] && inner[3][1][0]) || '' }
                ];

                for (var pi = 0; pi < paths.length; pi++) {
                    try {
                        var candidate = paths[pi]();
                        if (typeof candidate === 'string' && candidate.length > 0 && candidate.length > replyText.length && !/^[rc]_[a-f0-9]{16,}$/.test(candidate) && !/^(https?:)?\/\/[^\s]+$/.test(candidate.trim())) {
                            replyText = candidate;
                        }
                    } catch (e) { }
                }

                if (!replyText) {
                    function findLongest(obj, depth) {
                        if (depth > 8) return '';
                        if (typeof obj === 'string') return obj;
                        var longest = '';
                        if (Array.isArray(obj)) {
                            for (var k = 0; k < obj.length; k++) {
                                var s = findLongest(obj[k], depth + 1);
                                if (typeof s === 'string' && s.length > longest.length) longest = s;
                            }
                        }
                        return longest;
                    }
                    var longest = findLongest(inner, 0);
                    if (longest.length > 0 && longest.length > replyText.length && !/^[rc]_[a-f0-9]{16,}$/.test(longest) && !/^(https?:)?\/\/[^\s]+$/.test(longest.trim())) replyText = longest;
                }
            } catch (e) { }
        }

        if (!replyText) {
            if (commitIds) {
                console.error('[Proxima API] Parse error: ReplyText empty. Raw response: ' + rawText.substring(0, 500));
            }
            throw new Error('Could not extract reply from Gemini');
        }
        return replyText;
    }

    async function uploadFileToGoogle(fileBase64, filename, mimeType) {
        console.log('[Proxima Gemini API] Initializing resumable upload for:', filename);

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

        var pushId = 'feeds/mcudyrk2a4khkz';

        var initHeaders = {
            'Push-ID': pushId,
            'X-Tenant-Id': 'bard-storage',
            'X-Client-Pctx': 'CgcSBWjK7pYx',
            'X-Goog-Upload-Header-Content-Length': size.toString(),
            'X-Goog-Upload-Protocol': 'resumable',
            'X-Goog-Upload-Command': 'start',
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
        };

        var initRes = await fetch('https://push.clients6.google.com/upload/', {
            method: 'POST',
            headers: initHeaders,
            body: 'File name: ' + filename
        });

        if (!initRes.ok) {
            var errText = await initRes.text();
            throw new Error('Scotty upload initialization failed (' + initRes.status + '): ' + errText);
        }

        var uploadUrl = initRes.headers.get('x-goog-upload-url');
        if (!uploadUrl) {
            throw new Error('Upload Session URL not returned in headers');
        }

        console.log('[Proxima Gemini API] Resumable session created. Transferring binary bytes...');

        var uploadHeaders = {
            'Push-ID': pushId,
            'X-Tenant-Id': 'bard-storage',
            'X-Client-Pctx': 'CgcSBWjK7pYx',
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0',
            'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
            'Content-Length': size.toString()
        };

        var finalRes = await fetch(uploadUrl, {
            method: 'POST',
            headers: uploadHeaders,
            body: bytes
        });

        if (!finalRes.ok) {
            var errText = await finalRes.text();
            throw new Error('Scotty upload finalization failed (' + finalRes.status + '): ' + errText);
        }

        var token = (await finalRes.text()).trim();
        console.log('[Proxima Gemini API] Upload successful! Token retrieved:', token);
        return token;
    }

    async function _processStreamResponse(res) {
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var rawText = '';
        window.__proximaGeminiStream = { response: '', status: 'streaming', updates: [] };

        try {
            while (true) {
                var chunk = await reader.read();
                if (chunk.done) break;
                var chunkStr = decoder.decode(chunk.value, { stream: true });
                rawText += chunkStr;
                var updateText = window.__proximaGeminiStream.response || '';
                if (chunkStr.indexOf('\n') !== -1) {
                    try {
                        var parsed = _parseResponse(rawText, false);
                        if (parsed) {
                            window.__proximaGeminiStream.response = parsed;
                            updateText = parsed;
                        }
                    } catch (e) {
                        updateText = 'error: ' + e.message;
                    }
                }
                var _updates = window.__proximaGeminiStream.updates;
                _updates.push({
                    time: Date.now(),
                    chunkLength: chunk.value.length,
                    parsedLength: updateText.length,
                    text: updateText.substring(0, 30)
                });
                if (_updates.length > 50) _updates.shift();
            }
            window.__proximaGeminiStream.status = 'done';
        } catch (err) {
            window.__proximaGeminiStream.status = 'error';
            window.__proximaGeminiStream.error = err.message;
            throw err;
        }

        return _parseResponse(rawText, true);
    }

    async function send(message, engine, attachments, sessionId, _isRetry) {
        activateSession(sessionId);
        _detectWorkspaces();

        try {
            engine = engine || 'auto';

            // Warm up conversation with a simple greeting if first message is large (bypasses safety filters)
            if (!_conversationId && message.length > 500 && !_isRetry) {
                console.log('[Proxima API] New conversation with large prompt detected. Warming up conversation first...');
                try {
                    await send("Hello!", engine, null, sessionId, true);
                    console.log('[Proxima API] Conversation warmed up successfully. Sending actual prompt...');
                } catch (warmupErr) {
                    console.warn('[Proxima API] Warmup failed, attempting direct send anyway...', warmupErr.message);
                    newConversation(sessionId);
                }
            }

            var workspaceId = 'fbb127bbb056c959';
            if (engine.indexOf(':') !== -1) {
                workspaceId = engine.split(':')[1];
            } else if (engine === '3.5-flash') {
                workspaceId = _workspaces.fast[0] || '56fdd199312815e2';
            } else if (engine === '3.1-pro') {
                workspaceId = _workspaces.thinking[0] || '9d8ca3786ebdfbea';
            } else if (engine === '3.1-flash-lite') {
                workspaceId = (document.documentElement.innerHTML.indexOf('8c46e95b1a07cecc') !== -1) ? '8c46e95b1a07cecc' : (_workspaces.fast[0] || '8c46e95b1a07cecc');
            } else {
                workspaceId = _workspaces.fast[0] || 'fbb127bbb056c959';
            }

            var profiles = {
                '9d8ca3786ebdfbea': { modelId: 3, customIndex11: 1, inner79: 3 },
                'e6fa609c3fa255c0': { modelId: 3, customIndex11: 1, inner79: 3 },
                '56fdd199312815e2': { modelId: 1, customIndex11: 2, inner79: 1 },
                'fbb127bbb056c959': { modelId: 1, customIndex11: 2, inner79: 1 },
                '797f3d0293f288ad': { modelId: 1, customIndex11: 2, inner79: 1 },
                '8c46e95b1a07cecc': { modelId: 6, customIndex11: 2, inner79: 6 }
            };

            var profile = profiles[workspaceId];
            if (!profile) {
                if (engine === '3.5-flash' || engine.indexOf('fast:') === 0) {
                    profile = { modelId: 1, customIndex11: 2, inner79: 1 };
                } else if (engine === '3.1-pro' || engine.indexOf('thinking:') === 0) {
                    profile = { modelId: 3, customIndex11: 1, inner79: 3 };
                } else if (engine === '3.1-flash-lite' || engine.indexOf('lite:') === 0) {
                    profile = { modelId: 6, customIndex11: 2, inner79: 6 };
                } else {
                    profile = { modelId: 1, customIndex11: 2, inner79: 1 };
                }
            }

            var modelId = profile.modelId;
            var customIndex11 = profile.customIndex11;
            var modelIdentifier = profile.inner79;

            console.log('[Proxima API] Query routing - Engine:', engine, 'Workspace:', workspaceId, 'ModelId:', modelId);

            var tokens = await _getTokens();
            var reqId = Math.floor(900000 * Math.random()) + 100000;

            var queryParams = new URLSearchParams({
                bl: tokens.bl,
                rt: 'c',
                _reqid: reqId.toString()
            });

            var attachmentsArray = null;
            if (attachments && attachments.imageToken) {
                var mime = attachments.mimeType || 'image/png';
                var typeCode = 3;
                if (mime.startsWith('image/')) {
                    typeCode = 1;
                } else if (mime.startsWith('video/')) {
                    typeCode = 2;
                } else if (mime.startsWith('audio/')) {
                    typeCode = 4;
                }

                attachmentsArray = [
                    [
                        [
                            attachments.imageToken,
                            typeCode,
                            null,
                            mime
                        ],
                        attachments.filename || 'file',
                        null,
                        null,
                        null,
                        null,
                        null,
                        null,
                        [0]
                    ]
                ];
                console.log('[Proxima API] Sending message with attachment - Code:', typeCode, 'Mime:', mime);
            }

            // Drop partial continuation state if conversation ID is missing to prevent API errors.
            if (!_conversationId) {
                _responseId = '';
                _choiceId = '';
                _contextToken = '';
            }

            var innerReq = new Array(81).fill(null);
            innerReq[0] = [message, 0, null, attachmentsArray, null, null, 0];
            innerReq[1] = ["en-GB"];
            innerReq[2] = [_conversationId || "", _responseId || "", _choiceId || "", null, null, null, null, null, null, _contextToken || ""];

            innerReq[6] = [1];
            innerReq[7] = 1;
            innerReq[10] = 1;
            innerReq[11] = 0;
            innerReq[17] = _conversationId ? [[1]] : [[0]];
            innerReq[18] = 0;
            innerReq[27] = 1;
            innerReq[30] = [4];
            innerReq[41] = [1];
            innerReq[53] = 0;
            var requestUuid = generateUuid().toUpperCase();
            innerReq[59] = requestUuid;
            innerReq[68] = 2;
            innerReq[79] = modelIdentifier;
            innerReq[80] = 1;

            var body = new URLSearchParams({
                at: tokens.at,
                'f.req': JSON.stringify([null, JSON.stringify(innerReq)])
            });

            var headers = {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1',
                'x-goog-ext-73010989-jspb': '[0]',
                'x-goog-ext-73010990-jspb': '[0,0,0]',
                'x-goog-ext-525001261-jspb': JSON.stringify([1, null, null, null, workspaceId, null, null, 0, [4, 5, 6, 8], null, null, customIndex11, null, null, modelId, 1, _sessionUuid]),
                'x-goog-ext-525005358-jspb': JSON.stringify([requestUuid, 1])
            };

            var url = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + queryParams;

            var controller = new AbortController();
            var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

            var res = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: body,
                signal: controller.signal
            });

            if (res.status === 400) {
                clearTimeout(timeoutId);
                _tokens = null;
                _tokensFetchedAt = 0;
                var freshTokens = await _getTokens(true);

                var retryRequestUuid = generateUuid().toUpperCase();
                innerReq[59] = retryRequestUuid;

                var retryBody = new URLSearchParams({
                    at: freshTokens.at,
                    'f.req': JSON.stringify([null, JSON.stringify(innerReq)])
                });

                var retryParams = new URLSearchParams({
                    bl: freshTokens.bl,
                    rt: 'c',
                    _reqid: (Math.floor(900000 * Math.random()) + 100000).toString()
                });

                var retryHeaders = Object.assign({}, headers);
                retryHeaders['x-goog-ext-525005358-jspb'] = JSON.stringify([retryRequestUuid, 1]);

                var retryUrl = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + retryParams;
                var retryController = new AbortController();
                var retryTimeoutId = setTimeout(function () { retryController.abort(); }, TIMEOUT);

                res = await fetch(retryUrl, {
                    method: 'POST',
                    credentials: 'include',
                    headers: retryHeaders,
                    body: retryBody,
                    signal: retryController.signal
                });

                if (!res.ok) {
                    if (res.status === 400 && _conversationId) {
                        console.log('[Proxima API] Old conversation ID invalid on current account. Resetting session...');
                        newConversation(sessionId);
                        clearTimeout(retryTimeoutId);
                        return await send(message, engine, attachments, sessionId)
                            .then(function (newResult) {
                                var notice = "*[System Notice: Gemini account changed or session expired. Resuming this conversation in a new provider session.]*\n\n";
                                return notice + newResult;
                            });
                    }
                    clearTimeout(retryTimeoutId);
                    var err = await res.text().catch(function () { return ''; });
                    throw new Error('Gemini API error (' + res.status + '): ' + err.substring(0, 300));
                }

                var result;
                try {
                    result = await _processStreamResponse(res);
                } finally {
                    clearTimeout(retryTimeoutId);
                }
                saveSession(sessionId);
                return result;
            }

            if (!res.ok) {
                clearTimeout(timeoutId);
                var err = await res.text().catch(function () { return ''; });
                throw new Error('Gemini API error (' + res.status + '): ' + err.substring(0, 300));
            }

            // Treat empty responses on HTTP-OK as expired conversations; self-heal by starting a new one.
            try {
                var result = await _processStreamResponse(res);
                saveSession(sessionId);
                clearTimeout(timeoutId);
                return result;
            } catch (parseErr) {
                clearTimeout(timeoutId);
                if (!_isRetry && (_conversationId || _responseId || _choiceId || _contextToken)) {
                    console.log('[Proxima API] Continued conversation unparseable/expired. Starting a fresh conversation and retrying once...');
                    newConversation(sessionId);
                    return await send(message, engine, attachments, sessionId, true);
                }
                throw parseErr;
            }
        } catch (err) {
            console.error('[Proxima API] Chat processing failed. Resetting sticky error state context.', err.message);
            newConversation(sessionId);
            throw err;
        }
    }

    function newConversation(sessionId) {
        if (sessionId) {
            delete _sessions[sessionId];
            if (_currentSessionId === sessionId) _currentSessionId = null;
        } else if (_currentSessionId) {
            delete _sessions[_currentSessionId];
            _currentSessionId = null;
        }
        _conversationId = '';
        _responseId = '';
        _choiceId = '';
        _contextToken = '';
        _sessionUuid = generateUuid().toUpperCase();
        try {
            localStorage.setItem('proxima_sessions', JSON.stringify(_sessions));
        } catch (e) { }
        try {
            if (window.history && window.history.replaceState) {
                window.history.replaceState(null, '', '/app');
            }
        } catch (historyErr) {
            console.warn('[Proxima API] Failed to update history state:', historyErr.message);
        }
        console.log('[Proxima API] Conversation reset:', sessionId || 'current');
    }

    window.__proximaGeminiUnified = { send: send, newConversation: newConversation };
    window.__proximaGemini = {
        send: function (msg, engine, attachments, sessionId) { return send(msg, engine || 'auto', attachments, sessionId); },
        newConversation: newConversation,
        uploadFileToGoogle: uploadFileToGoogle
    };

    console.log('[Proxima] Upgraded Unified Multimodal Gemini Engine Loaded');
})();

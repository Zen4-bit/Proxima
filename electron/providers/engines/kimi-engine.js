/**
 * Proxima — Kimi Engine
 * Runs inside kimi.com BrowserView context. Sends queries via the internal
 * Connect (CONNECT/gRPC-Web) protocol used by the Kimi web app:
 *
 *   POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat
 *
 * The request body is a Connect frame (1 flag byte + 4-byte big-endian length
 * + JSON payload). The response is a stream of the same 5-byte-framed JSON
 * events. Answer deltas live in event.block.text.content; reasoning lives in
 * event.block.think.content.
 *
 * ⚠️ Uses the same non-official protocol the kimi.com web app itself uses.
 *    If Kimi changes their protocol this engine may need updating.
 */
(function () {
    if (window.__proximaKimi) return;

    var TIMEOUT = 360000;
    var CHAT_PATH = '/apiv2/kimi.gateway.chat.v1.ChatService/Chat';
    var REFRESH_PATH = '/api/auth/token/refresh';
    var DEFAULT_SCENARIO = 'SCENARIO_K2D5';

    var _accessToken = null;
    var _refreshToken = null;
    var _currentSessionId = null;
    var _sessions = {};
    try {
        var saved = localStorage.getItem('proxima_kimi_sessions');
        if (saved) _sessions = JSON.parse(saved);
    } catch (e) { }

    var MAX_SESSIONS = 200;
    function _pruneSessions() {
        var keys = Object.keys(_sessions);
        for (var i = 0; i < keys.length && Object.keys(_sessions).length > MAX_SESSIONS; i++) {
            if (keys[i] !== _currentSessionId) delete _sessions[keys[i]];
        }
    }

    // Session change signal for the opencode plugin. The engine bumps this
    // counter every time it rolls a Kimi chat over to a NEW chat_id (context
    // limit recovery). The plugin polls Proxima's session-status endpoint and,
    // on change, re-sends the system prompt + a comprehensive handoff summary.
    function getSessionStatus(sessionId) {
        var s = _sessions[sessionId || 'default'];
        if (!s) return { resetCount: 0, chatId: null, parentId: null };
        return {
            resetCount: (s.resetCount || 0),
            chatId: s.chatId || null,
            parentId: s.parentId || null
        };
    }

    function _deviceId() {
        try {
            var d = localStorage.getItem('proxima_kimi_device_id');
            if (d && /^[0-9]{19}$/.test(d)) return d;
            var nd = String(Math.floor(7000000000000000000 + Math.random() * 999999999999999999));
            localStorage.setItem('proxima_kimi_device_id', nd);
            return nd;
        } catch (e) {
            return '7' + String(Math.floor(Math.random() * 9e17)).padStart(18, '0');
        }
    }

    function _sessionHeader() {
        try {
            var s = localStorage.getItem('proxima_kimi_session_id');
            if (s && /^[0-9]{19}$/.test(s)) return s;
            var ns = String(Math.floor(1700000000000000000 + Math.random() * 99999999999999999));
            localStorage.setItem('proxima_kimi_session_id', ns);
            return ns;
        } catch (e) {
            return '17' + String(Math.floor(Math.random() * 9e17)).padStart(17, '0');
        }
    }

    function _isJwt(v) {
        return typeof v === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v.trim());
    }

    // Parse the exp claim from a JWT (no signature verification needed for
    // expiry math). Returns seconds-epoch, or 0 if unparsable.
    function _jwtExp(jwt) {
        try {
            var parts = jwt.split('.');
            if (parts.length !== 3) return 0;
            var b64 = parts[1];
            b64 += '='.repeat((4 - (b64.length % 4)) % 4);
            var payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
            return typeof payload.exp === 'number' ? payload.exp : 0;
        } catch (e) {
            return 0;
        }
    }

    // True if the token is missing or expired within 120s (proactive refresh
    // window so Kimi never sees a stale token).
    function _tokenNeedsRefresh(jwt) {
        if (!_isJwt(jwt)) return true;
        var exp = _jwtExp(jwt);
        if (!exp) return false; // can't verify — assume it's fine
        return (Date.now() / 1000) + 120 >= exp;
    }

    function _scanStorageToken() {
        try {
            var storages = [localStorage, sessionStorage];
            for (var si = 0; si < storages.length; si++) {
                var store = storages[si];
                var access = null;
                var refresh = null;
                for (var i = 0; i < store.length; i++) {
                    var key = store.key(i);
                    var val = '';
                    try { val = store.getItem(key) || ''; } catch (e) { continue; }
                    var candidate = val.trim();
                    if (!_isJwt(candidate)) {
                        try {
                            var parsed = JSON.parse(val);
                            if (parsed && typeof parsed === 'object') {
                                var deep = _deepFindToken(parsed);
                                if (deep) candidate = deep;
                            }
                        } catch (e2) { }
                    }
                    if (!_isJwt(candidate)) continue;
                    var lower = key.toLowerCase();
                    if (lower.includes('refresh')) {
                        if (!refresh) refresh = candidate;
                    } else if (lower.includes('access') || lower.includes('token') || lower.includes('auth')) {
                        if (!access) access = candidate;
                    } else if (!access) {
                        access = candidate;
                    }
                }
                if (access) { _refreshToken = refresh || _refreshToken; return access; }
                if (refresh) { _refreshToken = refresh; }
            }
        } catch (e) { }

        // Fallback: check cookies for token-ish values.
        try {
            var cookies = document.cookie.split(';');
            for (var ci = 0; ci < cookies.length; ci++) {
                var cookie = cookies[ci].trim();
                var eq = cookie.indexOf('=');
                if (eq === -1) continue;
                var cName = cookie.substring(0, eq).trim();
                var cVal = decodeURIComponent(cookie.substring(eq + 1).trim());
                if (_isJwt(cVal)) {
                    var lName = cName.toLowerCase();
                    if (lName.includes('refresh')) { if (!_refreshToken) _refreshToken = cVal; }
                    else if (lName.includes('access') || lName.includes('token')) { return cVal; }
                    else if (!_accessToken) { return cVal; }
                }
            }
        } catch (e) { }

        return null;
    }

    function _deepFindToken(obj, depth) {
        if (!depth) depth = 0;
        if (depth > 6 || !obj || typeof obj !== 'object') return null;
        if (typeof obj === 'string' && _isJwt(obj)) return obj;
        for (var key of Object.keys(obj)) {
            var val = obj[key];
            if (typeof val === 'string' && _isJwt(val)) return val;
            if (val && typeof val === 'object') {
                var found = _deepFindToken(val, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    async function _refreshAccessToken() {
        // Always rediscover the refresh token from storage first — Kimi rotates
        // refresh tokens too, so a stale in-memory one will be rejected.
        _scanStorageToken();
        if (!_refreshToken) return null;
        try {
            var res = await fetch(REFRESH_PATH, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Authorization': 'Bearer ' + _refreshToken,
                    'Accept': 'application/json',
                    'X-Msh-Platform': 'web',
                    'X-Msh-Device-Id': _deviceId(),
                    'X-Msh-Session-Id': _sessionHeader(),
                    'R-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                    'Origin': 'https://www.kimi.com'
                }
            });
            if (res.ok) {
                var data = await res.json();
                var token = data.access_token || data.token;
                if (token && _isJwt(token)) {
                    _accessToken = token;
                    // Persist the fresh token so later engine loads reuse it
                    // instead of re-reading an expired one from storage.
                    try {
                        localStorage.setItem('access_token', token);
                    } catch (e) { }
                    return token;
                }
            }
        } catch (e) { }
        return null;
    }

    // Kimi revokes access tokens server-side (rotation) while the JWT exp claim
    // stays ~30 days out, so expiry math alone can't detect a stale token. Always
    // prefer the token the site currently has in storage over our cached copy.
    function _getAccessToken(force) {
        var storageToken = _scanStorageToken();
        if (storageToken) {
            _accessToken = storageToken;
            return Promise.resolve(storageToken);
        }
        if (_accessToken && !force) {
            return Promise.resolve(_accessToken);
        }
        return _refreshAccessToken();
    }

    function _encodeConnect(payload) {
        var body = new TextEncoder().encode(JSON.stringify(payload));
        var header = new Uint8Array(5);
        header[0] = 0x00;
        var len = body.length;
        header[1] = (len >>> 24) & 0xff;
        header[2] = (len >>> 16) & 0xff;
        header[3] = (len >>> 8) & 0xff;
        header[4] = len & 0xff;
        var out = new Uint8Array(5 + body.length);
        out.set(header, 0);
        out.set(body, 5);
        return out;
    }

    function _isAuthErrorMsg(msg) {
        if (!msg) return false;
        var lower = String(msg).toLowerCase();
        return lower.indexOf('invalid user token') !== -1 ||
            lower.indexOf('invalid token') !== -1 ||
            lower.indexOf('unauthorized') !== -1 ||
            lower.indexOf('unauthenticated') !== -1 ||
            lower.indexOf('session expired') !== -1 ||
            lower.indexOf('not logged in') !== -1 ||
            lower.indexOf('authentication') !== -1 ||
            lower.indexOf('expired') !== -1;
    }

    // Kimi's server-enforced conversation-context limit. No bypass exists
    // (web K2.6 ≈128K tokens; K3 1M only on top-tier membership). The only
    // recovery is a NEW chat_id. We detect it, then restart with the stored
    // system prompt + the current user message (research-backed).
    function _isTooLongMsg(msg) {
        if (!msg) return false;
        var lower = String(msg).toLowerCase();
        return lower.indexOf('too long') !== -1 ||
            lower.indexOf('start a new session') !== -1 ||
            lower.indexOf('start a new chat') !== -1 ||
            lower.indexOf('conversation') !== -1 && lower.indexOf('long') !== -1 ||
            lower.indexOf('context') !== -1 && lower.indexOf('limit') !== -1;
    }

    function _AuthError(msg) {
        var e = new Error(msg);
        e.__kimiAuth = true;
        return e;
    }

    function _TooLongError(msg) {
        var e = new Error(msg);
        e.__kimiTooLong = true;
        return e;
    }

    // The engine may receive either a plain string or a JSON-encoded messages
    // array (opencode / REST clients send [{role,content}, ...]). Normalize to
    // an array and flatten content parts to plain text.
    function _parseIncomingMessage(message) {
        if (Array.isArray(message)) return message;
        if (typeof message === 'string') {
            var trimmed = message.trim();
            if (trimmed.charAt(0) === '[') {
                try {
                    var parsed = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) return parsed;
                } catch (e) { }
            }
            return [{ role: 'user', content: message }];
        }
        return [{ role: 'user', content: String(message || '') }];
    }

    function _contentText(content) {
        if (content === null || content === undefined) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            var parts = [];
            for (var i = 0; i < content.length; i++) {
                var item = content[i];
                if (typeof item === 'string') parts.push(item);
                else if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
            }
            return parts.join('\n');
        }
        return String(content);
    }

    async function _parseStream(response, session) {
        var reader = response.body.getReader();
        var buffer = new Uint8Array(0);
        var decoder = new TextDecoder();
        var answer = '';
        var reasoning = '';
        var done = false;

        try {
            while (!done) {
                var chunk = await reader.read();
                if (chunk.done) break;

                var merged = new Uint8Array(buffer.length + chunk.value.length);
                merged.set(buffer, 0);
                merged.set(chunk.value, buffer.length);
                buffer = merged;

                var offset = 0;
                while (offset + 5 <= buffer.length) {
                    var flag = buffer[offset];
                    var length = ((buffer[offset + 1] << 24) | (buffer[offset + 2] << 16) |
                        (buffer[offset + 3] << 8) | buffer[offset + 4]) >>> 0;
                    var frameEnd = offset + 5 + length;
                    if (frameEnd > buffer.length) break;

                    var payload = buffer.slice(offset + 5, frameEnd);
                    offset = frameEnd;

                    // Trailers (flag & 0x80) carry headers only — skip.
                    if (flag & 0x80) continue;

                    var text = decoder.decode(payload).trim();
                    if (!text) continue;

                    var event;
                    try { event = JSON.parse(text); } catch (e) { continue; }

                    if (event.error) {
                        var err = event.error;
                        var msg = err.message || JSON.stringify(err);
                        // Conversation hit the server-side context limit — recover
                        // by starting a NEW chat (no bypass exists).
                        if (_isTooLongMsg(msg)) throw _TooLongError(msg);
                        // Kimi reports expired/invalid sessions as a stream error
                        // inside an HTTP 200 body — flag it so send() can refresh
                        // the token and retry instead of surfacing a raw failure.
                        if (_isAuthErrorMsg(msg)) throw _AuthError(msg);
                        throw new Error(msg);
                    }
                    if (event.chat && event.chat.id) {
                        session.chatId = event.chat.id;
                    }
                    if (event.message && event.message.role === 'assistant' && event.message.id) {
                        session.parentId = event.message.id;
                    }
                    if (event.block) {
                        if (event.block.think && event.block.think.content) {
                            reasoning += event.block.think.content;
                        }
                        if (event.block.text && event.block.text.content) {
                            answer += event.block.text.content;
                        }
                    }
                    if ('done' in event) {
                        done = true;
                        break;
                    }
                }

                if (offset > 0) {
                    buffer = buffer.slice(offset);
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (e) { }
        }

        return { answer: answer.trim(), reasoning: reasoning.trim() };
    }

    function activateSession(sessionId) {
        if (!sessionId) sessionId = 'default';
        if (sessionId !== _currentSessionId) {
            _currentSessionId = sessionId;
            if (!_sessions[sessionId]) {
                _sessions[sessionId] = { chatId: null, parentId: null, systemPrompt: null, lastUser: null, resetCount: 0 };
            }
        }
        return _sessions[_currentSessionId];
    }

    function saveSession() {
        if (!_currentSessionId) return;
        try {
            _pruneSessions();
            localStorage.setItem('proxima_kimi_sessions', JSON.stringify(_sessions));
        } catch (e) { }
    }

    async function send(message, engine, attachments, sessionId) {
        var session = activateSession(sessionId);

        // Normalize the incoming payload. opencode / REST clients pass either a
        // plain string or a JSON-encoded messages array. Extract the system
        // prompt (sent ONCE at chat start) and the latest user turn (the only
        // thing follow-ups need — the parent_id chain carries the rest).
        var msgs = _parseIncomingMessage(message);
        var systemParts = [];
        var userParts = [];
        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            if (!m || typeof m !== 'object') continue;
            if (m.role === 'system') systemParts.push(_contentText(m.content));
            else if (m.role === 'user') userParts.push(_contentText(m.content));
        }
        var systemPrompt = systemParts.filter(Boolean).join('\n');

        // Decide whether this request starts a NEW Kimi chat or continues the
        // existing one. The incoming system prompt is the discriminator:
        //   * FIRST turn        — no stored systemPrompt yet  → new chat
        //   * ROLLOVER handoff  — system prompt changed (summary appended by the
        //     plugin)          → new chat (the old chat hit Kimi's context limit)
        //   * Follow-up         — system prompt identical to stored (opencode can
        //     be restarted between turns; the plugin state that strips the prompt
        //     lives per-process, so the same prompt may legitimately reappear) →
        //     REUSE the existing chat_id so the conversation actually continues.
        // A stale chat_id that is already too long self-heals: Kimi answers with
        // the too-long error, the engine detects it below and rolls the session.
        var isSameSystemPrompt = systemPrompt && session.systemPrompt === systemPrompt;
        if (systemPrompt && !isSameSystemPrompt) {
            if (session.chatId || session.parentId) {
                console.log('[Proxima Kimi] System prompt changed on this request — starting a fresh chat (was chatId=' + (session.chatId || 'none') + ').');
            }
            session.chatId = null;
            session.parentId = null;
        }
        // Only the LATEST user turn is the new message — everything earlier is
        // already on Kimi's server via chat_id/parent_id (follow-up) or will be
        // included as first-turn context (new chat).
        var lastUser = userParts.filter(Boolean).pop() || (typeof message === 'string' ? message : '');

        // Remember the system prompt for this conversation so a context-limit
        // reset can re-establish it in the fresh chat.
        if (systemPrompt) session.systemPrompt = systemPrompt;
        session.lastUser = lastUser;

        // First turn of a Kimi chat → send system prompt (which the opencode
        // plugin augments with a comprehensive handoff summary after a rollover)
        // + the current user turn. Do NOT re-send raw history here: after a
        // context-limit rollover opencode re-sends the whole array and re-injecting
        // it would instantly slam the new chat's limit again. Real context is
        // carried by the summary inside the system prompt, not by replaying
        // past turns.
        var isNewChat = !session.chatId;
        var content;
        if (isNewChat) {
            content = (systemPrompt ? 'system:' + systemPrompt + '\n' : '') + 'user:' + lastUser;
        } else {
            content = 'user:' + lastUser;
        }

        var token = await _getAccessToken(false);

        var scenario = DEFAULT_SCENARIO;
        if (engine && engine !== 'auto') {
            var e = String(engine).toUpperCase();
            if (e.indexOf('SCENARIO_') === 0) scenario = e;
        }

        var headers = {
            'Accept': '*/*',
            'Content-Type': 'application/connect+json',
            'Connect-Protocol-Version': '1',
            'Origin': 'https://www.kimi.com',
            'X-Msh-Platform': 'web',
            'X-Msh-Device-Id': _deviceId(),
            'X-Msh-Session-Id': _sessionHeader(),
            'R-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin'
        };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

        // Build the Connect payload for the current session state.
        var buildPayload = function () {
            var payload = {
                scenario: scenario,
                tools: [],
                message: {
                    role: 'user',
                    blocks: [{
                        message_id: crypto.randomUUID ? crypto.randomUUID() : '',
                        text: { content: content }
                    }],
                    scenario: scenario
                },
                options: { thinking: false }
            };
            if (session.chatId) payload.chat_id = session.chatId;
            if (session.parentId) payload.message.parent_id = session.parentId;
            return payload;
        };

        try {
            var res = await fetch(CHAT_PATH, {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: _encodeConnect(buildPayload()),
                signal: controller.signal
            });

            var needAuthRetry = (res.status === 401 || res.status === 403);

            if (res.status === 429) throw new Error('Kimi rate limited');
            if (!res.ok && !needAuthRetry) {
                var errBody = await res.text().catch(function () { return ''; });
                throw new Error('Kimi API error (' + res.status + '): ' + errBody.substring(0, 300));
            }

            var result;
            var tooLong = false;
            try {
                result = needAuthRetry ? null : await _parseStream(res, session);
            } catch (parseErr) {
                if (parseErr && parseErr.__kimiAuth && !needAuthRetry) {
                    needAuthRetry = true;
                } else if (parseErr && parseErr.__kimiTooLong) {
                    tooLong = true;
                } else {
                    throw parseErr;
                }
            }

            if (needAuthRetry) {
                // Kimi revokes access tokens server-side even when the JWT exp is
                // far in the future, so the stored token can be stale/rejected.
                // Force a refresh-token EXCHANGE (not a storage re-read — that
                // would return the same revoked token).
                if (token) _accessToken = null;
                var fresh = await _refreshAccessToken();
                if (!fresh) {
                    fresh = await _getAccessToken(true);
                }
                if (fresh && fresh !== token) {
                    headers['Authorization'] = 'Bearer ' + fresh;
                    res = await fetch(CHAT_PATH, {
                        method: 'POST',
                        credentials: 'include',
                        headers: headers,
                        body: _encodeConnect(buildPayload()),
                        signal: controller.signal
                    });
                    if (res.status === 429) throw new Error('Kimi rate limited');
                    if (!res.ok) {
                        var errBody2 = await res.text().catch(function () { return ''; });
                        throw new Error('Kimi API error (' + res.status + '): ' + errBody2.substring(0, 300));
                    }
                    result = await _parseStream(res, session);
                } else {
                    throw _AuthError('Not logged in to Kimi (no valid token found)');
                }
            }

            if (tooLong) {
                // No bypass exists for Kimi's context limit — the research-backed
                // recovery is a NEW chat_id. The opencode plugin owns the context
                // restoration: it polls Proxima's session status (resetCount),
                // detects the rollover, and re-sends the system prompt + a
                // comprehensive handoff summary on the next message. So we do NOT
                // auto-recover here with the bare current question (the user
                // explicitly wants a summary of recent work, not the question only).
                console.log('[Proxima Kimi] Conversation too long — rolling session (resetCount++). Plugin will restore context.');
                session.chatId = null;
                session.parentId = null;
                session.resetCount = (session.resetCount || 0) + 1;
                saveSession();
                result = {
                    answer: '**Conversation too long** — Kimi\'s context limit was reached, so I started a new session for you. Your next message will continue with a summary of our recent work (system prompt + context restored automatically).',
                    reasoning: ''
                };
            }

            saveSession();

            if (!result.answer) {
                throw new Error('Kimi returned an empty response' +
                    (result.reasoning ? ' (thinking only)' : ''));
            }
            return result.answer;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    function newConversation(sessionId) {
        if (sessionId) {
            delete _sessions[sessionId];
            if (_currentSessionId === sessionId) {
                _currentSessionId = null;
            }
        } else if (_currentSessionId) {
            delete _sessions[_currentSessionId];
            _currentSessionId = null;
        } else {
            // Nothing active — reset the loose globals as a safety net.
            _accessToken = null;
        }
        try {
            localStorage.setItem('proxima_kimi_sessions', JSON.stringify(_sessions));
        } catch (e) { }
        console.log('[Proxima Kimi] Conversation reset:', sessionId || _currentSessionId || 'current');
    }
    // Kimi's web protocol does not expose a public upload endpoint from the
    // page context; text files are inlined into the message upstream.
    async function uploadFileToKimi() {
        throw new Error('Kimi web API does not support direct file upload yet. Text files are inlined into the message instead.');
    }

    window.__proximaKimi = { send: send, newConversation: newConversation, uploadFileToKimi: uploadFileToKimi, getSessionStatus: getSessionStatus };
    console.log('[Proxima] Kimi engine loaded');
})();

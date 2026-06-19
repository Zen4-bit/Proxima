/**
 * Proxima — Z.AI / GLM Engine v4.1.0
 * Runs inside chat.z.ai BrowserView context. Uses a browser session token
 * (guest JWT or logged-in token from localStorage) for auth, signs requests
 * with the site's X-Signature HMAC scheme, and streams responses via SSE.
 *
 * Target model: glm-5.2 (GLM-5.2). Other models exposed by the site
 * (GLM-5.1, GLM-5-Turbo, glm-4.7, ...) can be selected via the MODEL constant.
 *
 * Auth notes: chat.z.ai auto-creates a guest session at GET /api/v1/auths/.
 * Registered login uses an Aliyun slider CAPTCHA which is not automatable, so
 * we rely on whatever token the live browser session already holds — guest or
 * logged-in. The token lives in localStorage.token; we fall back to the guest
 * endpoint when it is missing.
 */
(function () {
    if (window.__proximaZAI) return;

    var ZAI_BASE = 'https://chat.z.ai';
    var MODEL = 'glm-5.2';
    var FE_VERSION = 'prod-fe-1.1.66';
    var TIMEOUT = 360000;

    var _token = null;

    function _uuid() {
        if (crypto && crypto.randomUUID) return crypto.randomUUID();
        // RFC4122-ish fallback
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    // ─── Token ──────────────────────────────────────────
    // Prefer the token the live session already holds (guest or logged in).
    // Fall back to the guest-auth endpoint, which mints a JWT without login.
    async function _getToken() {
        if (_token) return _token;

        try {
            var stored = window.localStorage.getItem('token');
            if (stored && stored.length > 10) {
                _token = stored;
                return _token;
            }
        } catch (e) {}

        // Mint a guest token — no login or CAPTCHA required.
        var res = await fetch('/api/v1/auths/', { credentials: 'include' });
        if (!res.ok) throw new Error('Z.AI auth failed (' + res.status + ')');
        var data = await res.json();
        if (!data || !data.token) throw new Error('Z.AI returned no token');
        _token = data.token;
        try { window.localStorage.setItem('token', _token); } catch (e) {}
        return _token;
    }

    // ─── X-Signature ────────────────────────────────────
    // The site signs requests with an HMAC-SHA256 scheme keyed on a 5-minute
    // time window. message = "<model>|<base64(body)>|<timestamp>" and the key
    // is HMAC(secret, floor(timestamp / 300000)). We use Web Crypto (HMAC).
    // The signing secret is derived from a fixed site constant combined with
    // the browser fingerprint already present in this context.
    async function _hmacSha256(keyBytes, msgBytes) {
        var key = await crypto.subtle.importKey(
            'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        var sig = await crypto.subtle.sign('HMAC', key, msgBytes);
        return new Uint8Array(sig);
    }

    function _toHex(bytes) {
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
            var h = bytes[i].toString(16);
            hex += h.length === 1 ? '0' + h : h;
        }
        return hex;
    }

    function _utf8(str) {
        return new TextEncoder().encode(str);
    }

    // base64 of a UTF-8 string (matches the site's btoa(unescape(encodeURIComponent(x))))
    function _b64(str) {
        return btoa(unescape(encodeURIComponent(str)));
    }

    // Fingerprint string the site folds into the signing secret.
    function _fingerprint(token) {
        var parts = [
            (screen.width || 1920) + 'x' + (screen.height || 1080),
            Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            navigator.userAgent || '',
            window.location.href,
            token || ''
        ];
        return parts.join('|');
    }

    async function _sign(bodyStr, timestamp, token) {
        var windowKey = String(Math.floor(timestamp / 300000));
        var secret = _fingerprint(token);
        // key = HMAC(secret, windowKey)
        var derivedKey = await _hmacSha256(_utf8(secret), _utf8(windowKey));
        // message = model|base64(body)|timestamp
        var message = MODEL + '|' + _b64(bodyStr) + '|' + timestamp;
        var sig = await _hmacSha256(derivedKey, _utf8(message));
        return _toHex(sig);
    }

    // ─── SSE Stream Parser ──────────────────────────────
    // Events look like:
    //   data: {"type":"chat:completion","data":{"data":{"content":"Hello","done":false},...}}
    //   data: [DONE]
    // The site sends cumulative or incremental content depending on phase; we
    // keep the longest observed content so partial/incremental both work.
    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var incremental = '';
        var snapshot = '';

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;

            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].trim();
                if (!line.startsWith('data:')) continue;
                var raw = line.slice(5).trim();
                if (!raw || raw === '[DONE]') continue;

                try {
                    var parsed = JSON.parse(raw);
                    if (parsed.type && parsed.type !== 'chat:completion') continue;

                    var inner = parsed.data && parsed.data.data ? parsed.data.data : (parsed.data || {});
                    var content = inner.content;
                    if (typeof content !== 'string') continue;

                    // Some phases send the full content so far (snapshot), others
                    // send only deltas. Track both and pick the longer at the end.
                    if (content.length >= snapshot.length) {
                        snapshot = content;
                    } else {
                        incremental += content;
                    }
                } catch (e) {}
            }
        }

        reader.releaseLock();
        return snapshot.length >= incremental.length ? snapshot : incremental;
    }

    // ─── Send Message ───────────────────────────────────
    async function send(message) {
        var token = await _getToken();
        var timestamp = Date.now();
        var sessionId = _uuid();
        var chatId = _uuid();
        var msgId = _uuid();

        var bodyObj = {
            stream: true,
            model: MODEL,
            messages: [{ role: 'user', content: message }],
            signature_prompt: '',
            params: { format: null, keep_alive: null, stop: null },
            features: {
                image_generation: false,
                web_search: false,
                auto_web_search: false,
                preview_mode: false,
                enable_thinking: false
            },
            variables: {},
            session_id: sessionId,
            chat_id: chatId,
            id: msgId,
            background_tasks: { title_generation: false, tags_generation: false },
            captcha_verify_param: ''
        };

        var bodyStr = JSON.stringify(bodyObj);
        var signature = await _sign(bodyStr, timestamp, token);

        var query = '?timestamp=' + timestamp +
            '&signature_timestamp=' + timestamp +
            '&requestId=' + msgId;

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

        var res;
        try {
            res = await fetch('/api/v2/chat/completions' + query, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    'Accept-Language': 'en-US',
                    'X-FE-Version': FE_VERSION,
                    'X-Signature': signature
                },
                body: bodyStr,
                signal: controller.signal
            });
        } catch (e) {
            clearTimeout(timeoutId);
            throw new Error('Z.AI request failed: ' + (e && e.message ? e.message : e));
        }

        if (!res.ok) {
            clearTimeout(timeoutId);
            var errBody = await res.text().catch(function () { return ''; });
            if (res.status === 401 || res.status === 403) {
                _token = null; // force re-auth next call
                throw new Error('Z.AI auth error (' + res.status + ')');
            }
            if (res.status === 429) throw new Error('Z.AI rate limited');
            throw new Error('Z.AI API error (' + res.status + '): ' + errBody.substring(0, 300));
        }

        var result = await _parseStream(res);
        clearTimeout(timeoutId);

        if (!result || result.length === 0) {
            throw new Error('Z.AI returned empty response');
        }
        return result;
    }

    function newConversation() {
        // Each send already uses fresh session/chat IDs; nothing persistent to reset.
        console.log('[Proxima Z.AI] Conversation reset');
    }

    window.__proximaZAI = { send: send, newConversation: newConversation };
    console.log('[Proxima] Z.AI (GLM) engine loaded');
})();

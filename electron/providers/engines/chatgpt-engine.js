// Proxima — ChatGPT Engine.
// Performs SSE message streaming, multi-session state isolation, and handles proof-of-work challenges.

(function () {
    // Engine definition (rebinds __proximaChatGPT upon reload)

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

    function _fnvMurmur(e) {
        var t = 0x811c9dc5;
        for (var n = 0; n < e.length; n++) {
            t ^= e.charCodeAt(n);
            t = Math.imul(t, 0x1000193) >>> 0;
        }
        t ^= t >>> 16;
        t = Math.imul(t, 0x85ebca6b) >>> 0;
        t ^= t >>> 13;
        t = Math.imul(t, 0xc2b2ae35) >>> 0;
        return ((t ^= t >>> 16) >>> 0).toString(16).padStart(8, '0');
    }

    function _xorStr(e, t) {
        var n = "";
        for (var a = 0; a < e.length; a++) n += String.fromCharCode(e.charCodeAt(a) ^ t.charCodeAt(a % t.length));
        return n;
    }

    function _encodeObj(e) {
        var t = JSON.stringify(e);
        var bytes = new TextEncoder().encode(t);
        var bin = "";
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function _getSysMetrics(scripts, dpl) {
        var nav = (typeof navigator !== 'undefined') ? navigator : { userAgent: 'Mozilla/5.0', language: 'en-US', languages: ['en-US'], hardwareConcurrency: 8 };
        var navProto = (typeof Object.getPrototypeOf === 'function') ? Object.getPrototypeOf(nav) : nav;
        var navKeys = Object.keys(navProto || nav || {});
        var pickRandom = function (arr) { return arr && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null; };

        var scrWidth = (typeof screen !== 'undefined' && screen.width) ? screen.width : 1920;
        var scrHeight = (typeof screen !== 'undefined' && screen.height) ? screen.height : 1080;
        var mem = (typeof performance !== 'undefined' && performance.memory && performance.memory.jsHeapSizeLimit) ? performance.memory.jsHeapSizeLimit : null;

        var scriptList = (scripts && scripts.length) ? scripts : [null];
        var dataBuild = dpl || (typeof document !== 'undefined' && document.documentElement && typeof document.documentElement.getAttribute === 'function' && document.documentElement.getAttribute('data-build')) || '';

        return [
            (scrWidth + scrHeight) || 3000,
            String(new Date()),
            mem,
            Math.random(),
            nav.userAgent || '',
            pickRandom(scriptList),
            dataBuild,
            nav.language || 'en-US',
            nav.languages ? nav.languages.join(',') : (nav.language || 'en-US'),
            Math.random(),
            (function () {
                var k = navKeys.length ? pickRandom(navKeys) : 'userAgent';
                try { return k + '−' + String(nav[k]); } catch (e) { return k; }
            })(),
            (typeof document !== 'undefined') ? pickRandom(Object.keys(document)) : 'title',
            (typeof window !== 'undefined') ? pickRandom(Object.keys(window)) : 'location',
            (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0,
            (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'req-uuid',
            (typeof window !== 'undefined' && window.location && window.location.search) ? [...new URLSearchParams(window.location.search).keys()].join(',') : '',
            nav.hardwareConcurrency || 8,
            (typeof performance !== 'undefined' && performance.timeOrigin) ? performance.timeOrigin : Date.now(),
            Number(typeof window !== 'undefined' && 'ai' in window),
            Number(typeof window !== 'undefined' && 'createPRNG' in window),
            Number(typeof window !== 'undefined' && 'cache' in window),
            Number(typeof window !== 'undefined' && 'data' in window),
            Number(typeof window !== 'undefined' && 'solana' in window),
            Number(typeof window !== 'undefined' && 'dump' in window),
            Number(typeof window !== 'undefined' && 'InstallTrigger' in window)
        ];
    }

    function _generateP(scripts, dpl) {
        var start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        try {
            var m = _getSysMetrics(scripts, dpl);
            m[3] = 1;
            m[9] = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - start;
            return "gAAAAAC" + _encodeObj(m);
        } catch (e) {
            return "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + _encodeObj(String(e));
        }
    }

    async function _solvePOW(seed, difficulty, scripts, dpl) {
        var startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        try {
            var a = _getSysMetrics(scripts, dpl);
            for (var i = 0; i < 500000; i++) {
                if (i % 2500 === 0 && typeof Promise !== 'undefined') {
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
                a[3] = i;
                a[9] = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startTime);
                var encoded = _encodeObj(a);
                var hash = _fnvMurmur(seed + encoded);
                if (hash.substring(0, difficulty.length) <= difficulty) {
                    return encoded + '~S';
                }
            }
        } catch (e) {
            return "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + _encodeObj(String(e));
        }
        return null;
    }

    function _solveTurnstileVM(dx, p_key) {
        if (!dx) return Promise.resolve(null);
        var r = new Map(), i = 0;
        async function s_vm() {
            for (; r.get(9).length > 0;) {
                var item = r.get(9).shift() ?? [];
                var e = item[0], t = item.slice(1);
                var n = r.get(e);
                var a = n?.(...t);
                if (a && typeof a.then === 'function') await Promise.resolve(a);
                i++;
            }
        }
        return (function runVM(dx_str, key_str) {
            return new Promise(function (resolve, reject) {
                r.clear();
                r.set(0, function (t) { return runVM(t, String(r.get(16))); });
                r.set(1, function (e, t) { r.set(e, _xorStr(String(r.get(e)), String(r.get(t)))); });
                r.set(2, function (e, t) { r.set(e, t); });
                r.set(5, function (e, t) { var n = r.get(e); Array.isArray(n) ? n.push(r.get(t)) : r.set(e, n + r.get(t)); });
                r.set(27, function (e, t) { var n = r.get(e); Array.isArray(n) ? n.splice(n.indexOf(r.get(t)), 1) : r.set(e, n - r.get(t)); });
                r.set(29, function (e, t, n) { r.set(e, Number(r.get(t)) < Number(r.get(n))); });
                r.set(33, function (e, t, n) { r.set(e, Number(r.get(t)) * Number(r.get(n))); });
                r.set(35, function (e, t, n) { var a = Number(r.get(n)); r.set(e, 0 === a ? 0 : Number(r.get(t)) / a); });
                r.set(6, function (e, t, n) { var a = r.get(t); r.set(e, a[String(r.get(n))]); });
                r.set(7, function (e) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    return r.get(e).apply(null, args.map(function (x) { return r.get(x); }));
                });
                r.set(17, function (e, t) {
                    var args = Array.prototype.slice.call(arguments, 2);
                    try {
                        var n = r.get(t).apply(null, args.map(function (x) { return r.get(x); }));
                        if (n && typeof n.then === 'function') return n.then(function (res) { r.set(e, res); }).catch(function (err) { r.set(e, String(err)); });
                        r.set(e, n);
                    } catch (err) { r.set(e, String(err)); }
                });
                r.set(13, function (e, t) {
                    var args = Array.prototype.slice.call(arguments, 2);
                    try { r.get(t).apply(null, args); } catch (err) { r.set(e, String(err)); }
                });
                r.set(8, function (e, t) { r.set(e, r.get(t)); });
                r.set(10, (typeof window !== 'undefined') ? window : globalThis);
                r.set(11, function (e, t) {
                    var docScripts = (typeof document !== 'undefined' && document.scripts) ? Array.from(document.scripts) : [];
                    var matched = docScripts.map(function (s) { return s?.src?.match(String(r.get(t))); }).filter(function (m) { return m?.length; })[0] ?? [];
                    r.set(e, matched[0] ?? null);
                });
                r.set(12, function (e) { r.set(e, r); });
                r.set(14, function (e, t) { r.set(e, JSON.parse(String(r.get(t)))); });
                r.set(15, function (e, t) { r.set(e, JSON.stringify(r.get(t))); });
                r.set(18, function (e) { r.set(e, atob(String(r.get(e)))); });
                r.set(19, function (e) { r.set(e, btoa(String(r.get(e)))); });
                r.set(20, function (e, t, n) {
                    var args = Array.prototype.slice.call(arguments, 3);
                    return r.get(e) === r.get(t) ? r.get(n).apply(null, args) : null;
                });
                r.set(21, function (e, t, n, a) {
                    var args = Array.prototype.slice.call(arguments, 4);
                    return Math.abs(Number(r.get(e)) - Number(r.get(t))) > Number(r.get(n)) ? r.get(a).apply(null, args) : null;
                });
                r.set(23, function (e, t) {
                    var args = Array.prototype.slice.call(arguments, 2);
                    return void 0 !== r.get(e) ? r.get(t).apply(null, args) : null;
                });
                r.set(24, function (e, t, n) {
                    var a = r.get(t), fn = a[String(r.get(n))];
                    r.set(e, fn.bind(a));
                });
                r.set(34, function (e, t) {
                    return Promise.resolve(r.get(t)).then(function (res) { r.set(e, res); });
                });
                r.set(22, function (e, t) {
                    var n = Array.from(r.get(9));
                    r.set(9, Array.from(t));
                    return s_vm().catch(function (err) { r.set(e, String(err)); }).finally(function () { r.set(9, n); });
                });
                r.set(28, function () { return void 0; });
                r.set(26, function () { return void 0; });
                r.set(25, function () { return void 0; });
                i = 0;
                r.set(16, key_str);
                var isDone = false;
                var vmTimer = setTimeout(function () { isDone = true; resolve(String(i)); }, 1000);
                r.set(3, function (res) { if (!isDone) { isDone = true; clearTimeout(vmTimer); resolve(btoa(String(res))); } });
                r.set(4, function (err) { if (!isDone) { isDone = true; clearTimeout(vmTimer); reject(btoa(String(err))); } });
                r.set(30, function (e, t, n, a) {
                    var isArr = Array.isArray(a);
                    var o_arr = isArr ? n : [];
                    var l_arr = (isArr ? a : n) ?? [];
                    r.set(e, function () {
                        var fnArgs = Array.prototype.slice.call(arguments);
                        if (isDone) return;
                        var d_arr = Array.from(r.get(9));
                        if (isArr) {
                            for (var idx = 0; idx < o_arr.length; idx++) r.set(o_arr[idx], fnArgs[idx]);
                        }
                        r.set(9, Array.from(l_arr));
                        return s_vm().then(function () { return r.get(t); }).catch(function (err) { return String(err); }).finally(function () { r.set(9, d_arr); });
                    });
                });
                try {
                    r.set(9, JSON.parse(_xorStr(atob(dx_str), String(r.get(16)))));
                    s_vm().catch(function (err) { resolve(btoa(i + ': ' + String(err))); });
                } catch (err) {
                    resolve(btoa(i + ': ' + String(err)));
                }
            });
        })(dx, p_key);
    }

    var _cachedAccountId = null;

    function _getAccountId(token) {
        if (_cachedAccountId) return _cachedAccountId;
        var accountId = '';
        try {
            if (token && typeof token === 'string') {
                var jwtParts = token.split('.');
                if (jwtParts.length > 1) {
                    var payload = JSON.parse(atob(jwtParts[1].replace(/-/g, '+').replace(/_/g, '/')));
                    if (payload && payload['https://api.openai.com/auth']) {
                        accountId = payload['https://api.openai.com/auth'].chatgpt_account_id || '';
                    }
                }
            }
        } catch (e) { }
        if (!accountId && typeof document !== 'undefined' && document.documentElement && typeof document.documentElement.getAttribute === 'function') {
            accountId = document.documentElement.getAttribute('data-theme-account-id') || '';
        }
        return accountId;
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
        _cachedAccountId = (data.account && data.account.id) || (data.user && data.user.id) || data.account_id || null;
        return _cachedToken;
    }

    var _cachedScripts = null;
    var _cachedDpl = null;

    async function _getScriptsAndDpl() {
        if (_cachedScripts) return { scripts: _cachedScripts, dpl: _cachedDpl };
        try {
            var buildAttr = (typeof document !== 'undefined' && document.documentElement && typeof document.documentElement.getAttribute === 'function') ? document.documentElement.getAttribute('data-build') : null;
            if (buildAttr) {
                _cachedDpl = buildAttr;
            }
            var scriptsList = (typeof document !== 'undefined' && document.querySelectorAll)
                ? Array.from(document.querySelectorAll('script[src], link[href*=".js"]'))
                    .map(function (el) { return (typeof el.getAttribute === 'function') ? (el.getAttribute('src') || el.getAttribute('href')) : null; })
                    .filter(Boolean)
                : [];

            if (!scriptsList.length && typeof fetch !== 'undefined') {
                var html = await fetch('/', { credentials: 'include' }).then(function (r) { return r.text(); }).catch(function () { return ''; });
                var m;
                var re = /(?:src|href)="([^"]*\.js[^"]*)"/g;
                while ((m = re.exec(html)) !== null) scriptsList.push(m[1]);
                if (!_cachedDpl) {
                    var dplMatch = html.match(/data-build="([^"]+)"/) || html.match(/dpl=([a-zA-Z0-9_-]+)/);
                    _cachedDpl = dplMatch ? dplMatch[1] : '';
                }
            }
            _cachedScripts = scriptsList.length ? scriptsList : [null];
            if (!_cachedDpl) _cachedDpl = '';
        } catch (e) {
            _cachedScripts = [null];
            _cachedDpl = '';
        }
        return { scripts: _cachedScripts, dpl: _cachedDpl };
    }

    function _getDeviceId() {
        var deviceId = '';
        try {
            var cookies = (typeof document !== 'undefined' && document.cookie) ? document.cookie.split(';') : [];
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                if (c.startsWith('oai-did=')) { deviceId = c.substring(8); break; }
            }
        } catch (e) { }
        return deviceId;
    }

    async function _getRequirementsAndPOW(token) {
        var accountId = _getAccountId(token);
        var deviceId = _getDeviceId();
        var reqHeaders = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'OAI-Language': 'en-US'
        };
        if (deviceId) {
            reqHeaders['oai-did'] = deviceId;
            reqHeaders['OAI-Device-Id'] = deviceId;
        }
        if (accountId) {
            reqHeaders['chatgpt-account-id'] = accountId;
            reqHeaders['ChatGPT-Account-Id'] = accountId;
            reqHeaders['ChatGPT-Account-ID'] = accountId;
        }

        var sd = await _getScriptsAndDpl();
        var p_val = _generateP(sd.scripts, sd.dpl);

        // Modern OpenAI Sentinel: 2-step prepare -> solve VM & POW -> finalize
        try {
            var sPrepRes = await fetch('/backend-api/sentinel/chat-requirements/prepare', {
                method: 'POST',
                credentials: 'include',
                headers: reqHeaders,
                body: JSON.stringify({ p: p_val })
            });

            if (sPrepRes && sPrepRes.ok) {
                var sPrepData = await sPrepRes.json();
                var powToken = null;
                if (sPrepData.proofofwork && sPrepData.proofofwork.required) {
                    var powSolved = await _solvePOW(sPrepData.proofofwork.seed, sPrepData.proofofwork.difficulty, sd.scripts, sd.dpl);
                    if (powSolved) powToken = 'gAAAAAB' + powSolved;
                }
                var turnstileToken = null;
                if (sPrepData.turnstile && sPrepData.turnstile.required && sPrepData.turnstile.dx) {
                    turnstileToken = await _solveTurnstileVM(sPrepData.turnstile.dx, p_val);
                }

                var finBody = { prepare_token: sPrepData.prepare_token };
                if (powToken) finBody.proofofwork = powToken;
                if (turnstileToken) finBody.turnstile = turnstileToken;

                var sFinRes = await fetch('/backend-api/sentinel/chat-requirements/finalize', {
                    method: 'POST',
                    credentials: 'include',
                    headers: reqHeaders,
                    body: JSON.stringify(finBody)
                });

                if (sFinRes && sFinRes.ok) {
                    var sFinData = await sFinRes.json();
                    return {
                        requirementsToken: sFinData.token || null,
                        proofToken: powToken,
                        turnstileToken: turnstileToken,
                        pVal: p_val
                    };
                }
            }
        } catch (prepErr) { }

        // Fallback: Legacy /backend-api/sentinel/chat-requirements (for test mock environments or legacy endpoints)
        try {
            var reqRes = await fetch('/backend-api/sentinel/chat-requirements', {
                method: 'POST',
                credentials: 'include',
                headers: reqHeaders,
                body: JSON.stringify({ conversation_mode_kind: 'primary_assistant' })
            });

            if (reqRes && reqRes.ok) {
                var req = await reqRes.json();
                var result = { requirementsToken: req.token || null, proofToken: null, turnstileToken: null };
                if (req.proofofwork && req.proofofwork.required) {
                    var powToken2 = await _solvePOW(req.proofofwork.seed, req.proofofwork.difficulty, sd.scripts, sd.dpl);
                    if (powToken2) result.proofToken = 'gAAAAAB' + powToken2;
                }

                if (req.prepare_token && !result.requirementsToken) {
                    try {
                        var finRes2 = await fetch('/backend-api/sentinel/chat-requirements/finalize', {
                            method: 'POST',
                            credentials: 'include',
                            headers: reqHeaders,
                            body: JSON.stringify({
                                prepare_token: req.prepare_token,
                                proofofwork: result.proofToken || void 0
                            })
                        });
                        if (finRes2.ok) {
                            var finData2 = await finRes2.json();
                            if (finData2 && finData2.token) result.requirementsToken = finData2.token;
                        }
                    } catch (e) { }
                }

                return result;
            }
        } catch (legacyErr) { }

        return {};
    }

    function _parseModelVersion(slug) {
        if (!slug || typeof slug !== 'string') return null;
        var s = slug.toLowerCase().trim();
        if (s.indexOf('research') !== -1 || s === 'auto' || s === 'default') return null;
        var m = s.match(/(?:chatgpt|gpt)-(\d+)(?:[-.](\d+))?/i);
        if (!m) return null;
        var major = parseInt(m[1], 10);
        var minor = m[2] ? parseInt(m[2], 10) : 0;
        return { major: major, minor: minor };
    }

    function _isAllowedModelSlug(slug) {
        if (!slug || typeof slug !== 'string') return false;
        var s = slug.toLowerCase().trim();
        if (s.indexOf('research') !== -1 || s === 'auto' || s === 'default') return false;
        var ver = _parseModelVersion(s);
        if (!ver) return false;
        // Strict major/minor integer comparison (>= 5.6):
        // major must be > 5, or if major === 5, minor must be >= 6.
        return ver.major > 5 || (ver.major === 5 && ver.minor >= 6);
    }

    function formatModelSlug(slug) {
        if (!slug) return '';
        if (slug === 'auto') return 'Auto (Fastest)';
        return slug
            .replace(/^gpt-(\d+)-(\d+)/i, 'GPT-$1.$2')
            .replace(/^gpt-(\d+)\b/i, 'GPT-$1')
            .replace(/^gpt-/i, 'GPT-')
            .replace(/-t-mini-mini/i, ' Thinking Nano')
            .replace(/-t-mini/i, ' Thinking Mini')
            .replace(/-t\b/i, ' Thinking')
            .replace(/-thinking/i, ' Thinking')
            .replace(/-mini/i, ' Mini')
            .replace(/-nano/i, ' Nano')
            .replace(/-instant/i, ' Instant')
            .replace(/-preview/i, ' Preview')
            .replace(/-latest/i, ' Latest')
            .replace(/-turbo/i, ' Turbo')
            .replace(/-pro/i, ' Pro');
    }

    function getModelTagInfo(slug, hasError) {
        if (hasError) return { tag: 'Limit / Error', cls: 'error' };
        if (!slug || slug === 'auto') return { tag: 'Auto Fast', cls: 'fast' };
        var lower = slug.toLowerCase();
        if (lower.indexOf('think') !== -1 || lower.indexOf('-t-') !== -1 || lower.endsWith('-t') || lower.indexOf('reason') !== -1) {
            return { tag: 'Reasoning', cls: 'thinking' };
        }
        if (lower.indexOf('mini') !== -1 || lower.indexOf('instant') !== -1 || lower.indexOf('fast') !== -1 || lower.indexOf('lite') !== -1 || lower.indexOf('nano') !== -1) {
            return { tag: 'Fast', cls: 'fast' };
        }
        if (lower.indexOf('preview') !== -1 || lower.indexOf('latest') !== -1 || lower.indexOf('o1') !== -1 || lower.indexOf('o3') !== -1 || lower.indexOf('pro') !== -1) {
            return { tag: 'Pro', cls: 'pro' };
        }
        return { tag: 'Base', cls: 'pro' };
    }

    var _cachedModelsByAccount = {};
    var _errorModels = {};
    var ERROR_MODEL_COOLDOWN_MS = 5 * 60 * 1000;

    function _markModelError(slug) {
        if (!slug || slug === 'auto' || slug === 'default') return;
        _errorModels[slug] = Date.now() + ERROR_MODEL_COOLDOWN_MS;
    }

    function _isModelInError(slug) {
        if (!slug || !_errorModels[slug]) return false;
        if (Date.now() > _errorModels[slug]) {
            delete _errorModels[slug];
            return false;
        }
        return true;
    }

    function _clearModelError(slug) {
        if (slug) delete _errorModels[slug];
    }

    async function _fetchModelsMetadata(signal) {
        var token = await _getToken();
        var accountId = _getAccountId(token) || 'default-account';

        var cached = _cachedModelsByAccount[accountId];
        if (cached && Date.now() < cached.expiresAt) {
            return cached.meta;
        }

        var headers = {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'OAI-Language': 'en-US'
        };
        if (accountId && accountId !== 'default-account') {
            headers['chatgpt-account-id'] = accountId;
            headers['ChatGPT-Account-Id'] = accountId;
            headers['ChatGPT-Account-ID'] = accountId;
        }

        var defaultModelSlug = null;
        var availableSlugs = [];
        var categories = [];
        var slugSet = new Set();
        var thinkingSlug = null;
        var instantSlug = null;
        var miniSlug = null;
        var discoveryError = null;

        try {
            var initRes = await fetch('/backend-api/conversation/init', {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify({}),
                signal: signal
            });
            if (initRes && initRes.ok) {
                var initData = await initRes.json();
                if (initData && initData.default_model_slug) {
                    if (_isAllowedModelSlug(initData.default_model_slug)) {
                        defaultModelSlug = initData.default_model_slug;
                        slugSet.add(defaultModelSlug);
                    }
                }
            }
        } catch (e) {
            discoveryError = e;
        }

        try {
            var modelsRes = await fetch('/backend-api/models', {
                credentials: 'include',
                headers: headers,
                signal: signal
            });
            if (modelsRes && modelsRes.ok) {
                var modelsData = await modelsRes.json();
                if (modelsData && Array.isArray(modelsData.models)) {
                    modelsData.models
                        .filter(function (m) { return m && m.is_work_mode_model !== true; })
                        .forEach(function (m) {
                            var s = m.slug || m.id;
                            if (_isAllowedModelSlug(s)) slugSet.add(s);
                        });
                }
                if (modelsData && Array.isArray(modelsData.categories)) {
                    categories = modelsData.categories;
                    for (var i = 0; i < categories.length; i++) {
                        var cat = categories[i];
                        if (_isAllowedModelSlug(cat.default_model)) slugSet.add(cat.default_model);
                        if (Array.isArray(cat.supported_models)) {
                            cat.supported_models.forEach(function (s) {
                                if (_isAllowedModelSlug(s)) slugSet.add(s);
                            });
                        }
                        var rType = (cat.reasoning_type || '').toLowerCase();
                        var catName = (cat.category || cat.human_category_name || cat.title || '').toLowerCase();
                        if (rType === 'reasoning' || catName.indexOf('think') !== -1 || catName.indexOf('reason') !== -1) {
                            if (!thinkingSlug && _isAllowedModelSlug(cat.default_model)) thinkingSlug = cat.default_model;
                        } else if (rType === 'none' || catName.indexOf('instant') !== -1 || catName.indexOf('auto') !== -1) {
                            if (!instantSlug && _isAllowedModelSlug(cat.default_model)) instantSlug = cat.default_model;
                        }
                    }
                }
                if (modelsData && Array.isArray(modelsData.versions)) {
                    modelsData.versions.forEach(function (v) {
                        if (v && v.enabled !== false && Array.isArray(v.slugs)) {
                            v.slugs.forEach(function (s) {
                                if (_isAllowedModelSlug(s)) slugSet.add(s);
                            });
                        }
                    });
                }
            } else if (modelsRes) {
                var errTxt = await modelsRes.text().catch(function () { return ''; });
                discoveryError = new Error('HTTP ' + modelsRes.status + ': ' + errTxt.substring(0, 150));
            }
        } catch (e) {
            discoveryError = e;
        }

        availableSlugs = Array.from(slugSet);

        if (availableSlugs.length === 0) {
            if (cached && cached.meta) {
                return cached.meta;
            }
            var errDetail = discoveryError ? (': ' + discoveryError.message) : '';
            throw new Error('ChatGPT model discovery failed for account ' + accountId + errDetail + '. No eligible models (>= 5.6) found.');
        }

        var fastCandidates = availableSlugs.filter(function (s) {
            var lower = s.toLowerCase();
            var isSlow = lower.indexOf('-t-') !== -1 || lower.endsWith('-t') || lower.indexOf('think') !== -1 || lower.indexOf('reason') !== -1 || lower.indexOf('extended') !== -1;
            return !isSlow && (lower.indexOf('mini') !== -1 || lower.indexOf('instant') !== -1 || lower.indexOf('fast') !== -1 || lower.indexOf('lite') !== -1 || lower.indexOf('nano') !== -1);
        });

        function compareVersions(slugA, slugB) {
            var va = _parseModelVersion(slugA);
            var vb = _parseModelVersion(slugB);
            if (!va && !vb) return slugA.localeCompare(slugB, undefined, { numeric: true });
            if (!va) return 1;
            if (!vb) return -1;
            if (va.major !== vb.major) return va.major - vb.major;
            if (va.minor !== vb.minor) return va.minor - vb.minor;
            return slugA.localeCompare(slugB, undefined, { numeric: true });
        }

        availableSlugs.sort(function (a, b) {
            var aLower = a.toLowerCase();
            var bLower = b.toLowerCase();
            var aIsThink = aLower.indexOf('-t-') !== -1 || aLower.endsWith('-t') || aLower.indexOf('think') !== -1 || aLower.indexOf('reason') !== -1;
            var bIsThink = bLower.indexOf('-t-') !== -1 || bLower.endsWith('-t') || bLower.indexOf('think') !== -1 || bLower.indexOf('reason') !== -1;
            if (aIsThink !== bIsThink) return aIsThink ? 1 : -1;

            var aIsMini = aLower.indexOf('mini') !== -1 || aLower.indexOf('instant') !== -1 || aLower.indexOf('fast') !== -1 || aLower.indexOf('lite') !== -1 || aLower.indexOf('nano') !== -1;
            var bIsMini = bLower.indexOf('mini') !== -1 || bLower.indexOf('instant') !== -1 || bLower.indexOf('fast') !== -1 || bLower.indexOf('lite') !== -1 || bLower.indexOf('nano') !== -1;
            if (aIsMini !== bIsMini) return aIsMini ? -1 : 1;

            return compareVersions(a, b);
        });

        fastCandidates.sort(compareVersions);

        var lowestFastModel = fastCandidates[0] || instantSlug || availableSlugs[0];

        if (!defaultModelSlug) {
            defaultModelSlug = lowestFastModel || availableSlugs[0];
        }

        if (!thinkingSlug) {
            var thinkCand = availableSlugs.find(function (s) {
                return s.indexOf('thinking') !== -1 || s.indexOf('-t-') !== -1 || s.indexOf('-t') !== -1;
            });
            thinkingSlug = thinkCand || defaultModelSlug;
        }

        if (!instantSlug) instantSlug = lowestFastModel || defaultModelSlug;
        if (!miniSlug) miniSlug = lowestFastModel || defaultModelSlug;

        var richModels = [];
        richModels.push({
            id: 'chatgpt:auto',
            slug: 'auto',
            name: 'Auto (' + formatModelSlug(lowestFastModel) + ')',
            resolvedModel: lowestFastModel,
            version: 'auto',
            tag: 'Auto Fast',
            tagCls: 'fast',
            status: 'enabled'
        });

        availableSlugs.forEach(function (slug) {
            var ver = _parseModelVersion(slug);
            var verStr = ver ? (ver.major + (ver.minor ? '.' + ver.minor : '')) : '';
            var isErr = _isModelInError(slug);
            var tagInfo = getModelTagInfo(slug, isErr);

            richModels.push({
                id: 'chatgpt:' + slug,
                slug: slug,
                name: formatModelSlug(slug),
                version: verStr,
                major: ver ? ver.major : 0,
                minor: ver ? ver.minor : 0,
                tag: tagInfo.tag,
                tagCls: tagInfo.cls,
                status: isErr ? 'disabled' : 'enabled'
            });
        });

        var resultMeta = {
            accountId: accountId,
            defaultModel: defaultModelSlug,
            lowestFastModel: lowestFastModel,
            fastCandidates: fastCandidates,
            availableSlugs: availableSlugs,
            richModels: richModels,
            categories: categories,
            aliases: {
                default: lowestFastModel,
                auto: lowestFastModel,
                lowest: lowestFastModel,
                fastest: lowestFastModel,
                thinking: thinkingSlug,
                reasoning: thinkingSlug,
                instant: instantSlug,
                mini: miniSlug
            }
        };

        _cachedModelsByAccount[accountId] = {
            meta: resultMeta,
            expiresAt: Date.now() + 600000
        };

        return resultMeta;
    }

    async function getAvailableModels(forceRefresh) {
        if (forceRefresh) {
            _cachedModelsByAccount = {};
            _cachedToken = null;
            _tokenExpiry = 0;
            _cachedAccountId = null;
        }
        var meta = await _fetchModelsMetadata();
        return meta && meta.richModels ? meta.richModels : [];
    }

    async function _parseSSEStream(response, signal) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var buffer = '';
        var idleTimer = null;
        var stalled = false;

        function watchIdle() {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(function () {
                stalled = true;
                reader.cancel().catch(function () { });
            }, 45000);
        }

        try {
            watchIdle();
            while (true) {
                var chunk = await reader.read();
                if (chunk.done || stalled) break;
                watchIdle();

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

                        if (typeof parsed.error === 'string' && parsed.error.trim()) {
                            throw new Error('ChatGPT error: ' + parsed.error.trim());
                        }

                        if (parsed.conversation_id) {
                            _conversationId = parsed.conversation_id;
                        }

                        // Delta encoding fallback support (if stream is v1 delta encoded)
                        if (parsed.p === '/message/content/parts/0' && parsed.o === 'append' && typeof parsed.v === 'string') {
                            fullText += parsed.v;
                        } else if (parsed.v && parsed.v.message && parsed.v.message.content && parsed.v.message.content.parts) {
                            fullText = parsed.v.message.content.parts.join('');
                            if (parsed.v.message.id) _parentMessageId = parsed.v.message.id;
                        }

                        var parts = parsed && parsed.message && parsed.message.content && parsed.message.content.parts;
                        if (parts && parts.length > 0 && parsed.message.author && parsed.message.author.role === 'assistant') {
                            var joined = parts.join('');
                            if (joined.length > 0) fullText = joined;

                            if (parsed.message.id) {
                                _parentMessageId = parsed.message.id;
                            }

                            if (parsed.message.status === 'finished_successfully' && parsed.message.end_turn === true && fullText.length > 0) {
                                reader.cancel().catch(function () { });
                                break;
                            }
                        }

                        if (parsed.type === 'message_stream_complete' && fullText.length > 0) {
                            reader.cancel().catch(function () { });
                            break;
                        }
                    } catch (parseErr) {
                        if (parseErr.message && parseErr.message.indexOf('ChatGPT error:') === 0) {
                            throw parseErr;
                        }
                    }
                }
            }
        } finally {
            clearTimeout(idleTimer);
            try { reader.releaseLock(); } catch (e) { }
        }

        if (stalled) {
            throw new Error('ChatGPT answer stalled (no data for 45s) — try again');
        }
        return fullText;
    }

    function _handleWebSocketStream(wssUrl, responseId, signal) {
        return new Promise(function (resolve, reject) {
            var ws;
            try {
                ws = new WebSocket(wssUrl, 'json.reliable.webpubsub.azure.v1');
            } catch (e) {
                return reject(new Error('ChatGPT WebSocket initialization failed: ' + e.message));
            }

            var fullText = '';
            var buffer = '';
            var decoder = new TextDecoder();
            var idleTimer = null;
            var settled = false;

            function cleanup() {
                if (idleTimer) clearTimeout(idleTimer);
                if (signal && onAbort) signal.removeEventListener('abort', onAbort);
                try {
                    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                        ws.close();
                    }
                } catch (e) { }
            }

            function watchIdle() {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(function () {
                    if (!settled) {
                        settled = true;
                        cleanup();
                        reject(new Error('ChatGPT WebSocket answer stalled (no data for 45s) — try again'));
                    }
                }, 45000);
            }

            function onAbort() {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(new Error('ChatGPT WebSocket request aborted'));
                }
            }

            if (signal) {
                if (signal.aborted) return onAbort();
                signal.addEventListener('abort', onAbort, { once: true });
            }

            ws.addEventListener('open', function () {
                watchIdle();
            });

            ws.addEventListener('error', function () {
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(new Error('ChatGPT WebSocket connection failed'));
                }
            });

            ws.addEventListener('close', function () {
                if (!settled) {
                    settled = true;
                    cleanup();
                    if (fullText.trim().length > 10) {
                        resolve(fullText);
                    } else {
                        reject(new Error('ChatGPT WebSocket closed before response completed'));
                    }
                }
            });

            ws.addEventListener('message', function (event) {
                watchIdle();
                try {
                    var raw = typeof event.data === 'string' ? event.data : '';
                    var msg = JSON.parse(raw);
                    if (msg.sequenceId && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'sequenceAck', sequenceId: msg.sequenceId }));
                    }
                    if (msg.type !== 'message' || !msg.data) return;
                    if (responseId && msg.data.response_id && msg.data.response_id !== responseId) return;

                    if (msg.data.body) {
                        var binStr = atob(msg.data.body);
                        var bytes = new Uint8Array(binStr.length);
                        for (var b = 0; b < binStr.length; b++) bytes[b] = binStr.charCodeAt(b);
                        var chunkText = decoder.decode(bytes, { stream: true });
                        buffer += chunkText;
                        var lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (var i = 0; i < lines.length; i++) {
                            var line = lines[i];
                            if (!line.startsWith('data: ')) continue;
                            var data = line.slice(6).trim();
                            if (data === '[DONE]') {
                                if (!settled) {
                                    settled = true;
                                    cleanup();
                                    resolve(fullText);
                                }
                                return;
                            }
                            var parsed = JSON.parse(data);
                            if (typeof parsed.error === 'string' && parsed.error.trim()) {
                                if (!settled) {
                                    settled = true;
                                    cleanup();
                                    reject(new Error('ChatGPT error: ' + parsed.error.trim()));
                                }
                                return;
                            }
                            if (parsed.conversation_id) _conversationId = parsed.conversation_id;
                            var parts = parsed && parsed.message && parsed.message.content && parsed.message.content.parts;
                            if (parts && parts.length > 0 && parsed.message.author && parsed.message.author.role === 'assistant') {
                                var joined = parts.join('');
                                if (joined.length > 0) fullText = joined;
                                if (parsed.message.id) _parentMessageId = parsed.message.id;
                                if (parsed.message.status === 'finished_successfully' && parsed.message.end_turn === true && fullText.length > 0) {
                                    if (!settled) {
                                        settled = true;
                                        cleanup();
                                        resolve(fullText);
                                    }
                                    return;
                                }
                            }
                        }
                    }
                } catch (e) { }
            });
            watchIdle();
        });
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

    async function send(message, engine, attachments, sessionId, _isRecovery) {
        activateSession(sessionId);

        var token = await _getToken();
        var accountId = _getAccountId(token);

        var deviceId = '';
        try {
            var cookies = document.cookie.split(';');
            for (var i = 0; i < cookies.length; i++) {
                var c = cookies[i].trim();
                if (c.startsWith('oai-did=')) { deviceId = c.substring(8); break; }
            }
        } catch (e) { }

        var powData = await _getRequirementsAndPOW(token);

        var turnTraceId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('trace-' + Date.now());

        var headers = {
            'originator': 'Codex Browser',
            'x-openai-web-frontend': 'codex_webview',
            'x-openai-codex-window-type': 'browser',
            'OAI-Language': 'en-US',
            'x-oai-mcp-form-version': '2',
            'x-oai-turn-trace-id': turnTraceId,
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'x-openai-web-sse-compression': 'gzip'
        };

        if (deviceId) headers['oai-did'] = deviceId;
        if (accountId) headers['ChatGPT-Account-Id'] = accountId;
        if (powData.requirementsToken) headers['OpenAI-Sentinel-Chat-Requirements-Token'] = powData.requirementsToken;
        if (powData.proofToken) headers['OpenAI-Sentinel-Proof-Token'] = powData.proofToken;
        if (powData.turnstileToken) headers['OpenAI-Sentinel-Turnstile-Token'] = powData.turnstileToken;

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

        var meta = await _fetchModelsMetadata();
        var chosenModel = null;

        if (!engine || engine === 'auto' || engine === 'default') {
            chosenModel = meta.lowestFastModel;
            if (_isModelInError(chosenModel)) {
                var candidate = meta.fastCandidates && meta.fastCandidates.find(function (s) {
                    return !_isModelInError(s);
                });
                if (candidate) {
                    console.log('[Proxima ChatGPT] Auto-fallback from limit-reached ' + chosenModel + ' to ' + candidate);
                    chosenModel = candidate;
                } else {
                    var anyValid = meta.availableSlugs.find(function (s) { return !_isModelInError(s); });
                    if (anyValid) chosenModel = anyValid;
                }
            }
        } else if (typeof engine === 'string') {
            var engLower = engine.toLowerCase().trim();
            if (engLower.startsWith('chatgpt:')) engLower = engLower.substring(8);

            if (engLower === 'auto' || engLower === 'default') {
                chosenModel = meta.lowestFastModel;
            } else if (meta.aliases && meta.aliases[engLower]) {
                chosenModel = meta.aliases[engLower];
            } else if (meta.availableSlugs && meta.availableSlugs.indexOf(engLower) !== -1) {
                chosenModel = engLower;
            } else {
                var matchedSlug = meta.availableSlugs && meta.availableSlugs.find(function (s) {
                    var sClean = s.toLowerCase().replace(/[-_.]/g, '');
                    var engClean = engLower.replace(/[-_.]/g, '');
                    return s.toLowerCase() === engLower || sClean === engClean;
                });
                if (matchedSlug) {
                    chosenModel = matchedSlug;
                } else {
                    throw new Error('Model \'' + engine + '\' is not available in the current account. Currently available models: ' + meta.availableSlugs.join(', ') + '. Call \'list_available_models\' for current models and exact usage instructions.');
                }
            }

            if (_isModelInError(chosenModel)) {
                throw new Error('Temporary quota limit reached for model \'' + formatModelSlug(chosenModel) + '\'. Call \'list_available_models\' to see currently ready models or use \'auto\'.');
            }
        }

        if (!chosenModel) {
            chosenModel = meta.lowestFastModel || meta.defaultModel;
        }
        console.log('[Proxima ChatGPT] Using model slug:', chosenModel, '(requested engine:', engine || 'default', ')');

        var userMsgId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('msg-' + Date.now());
        var tz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
        var tzOffset = new Date().getTimezoneOffset();

        // Step 4: Conversation prepare (retrieves conduit_token)
        try {
            var cPrepBody = {
                action: 'next',
                is_do_not_remember: false,
                model: chosenModel,
                parent_message_id: _parentMessageId || 'client-created-root',
                timezone: tz,
                timezone_offset_min: tzOffset,
                client_contextual_info: {
                    app_name: 'chatgpt.com',
                    app_surface: 'codex_browser',
                    has_web_push_capabilities: true,
                    web_push_notification_permission: 'granted'
                },
                local_function_names: ['local.continue_in_work'],
                client_prepare_state: 'sent',
                partial_query: {
                    id: userMsgId,
                    author: { role: 'user' },
                    content: messageContent
                },
                client_prepare_dispatch: 'debounced',
                client_prepare_source: 'context_change'
            };
            if (_conversationId) cPrepBody.conversation_id = _conversationId;

            var cPrepRes = await fetch('/backend-api/f/conversation/prepare', {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(cPrepBody)
            });
            if (cPrepRes && cPrepRes.ok) {
                var cPrepData = await cPrepRes.json();
                if (cPrepData && cPrepData.conduit_token) {
                    headers['x-conduit-token'] = cPrepData.conduit_token;
                }
            }
        } catch (cPrepErr) { }

        // Primary modern payload for /backend-api/f/conversation
        var modernPayload = {
            turn_attribution: { turn_trigger: 'composer' },
            action: 'next',
            is_do_not_remember: false,
            history_and_training_disabled: false,
            model: chosenModel,
            parent_message_id: _parentMessageId || 'client-created-root',
            timezone: tz,
            timezone_offset_min: tzOffset,
            client_contextual_info: {
                app_name: 'chatgpt.com',
                app_surface: 'codex_browser',
                has_web_push_capabilities: true,
                web_push_notification_permission: 'granted'
            },
            local_function_names: ['local.continue_in_work'],
            messages: [{
                author: { metadata: {}, name: null, role: 'user' },
                channel: null,
                content: messageContent,
                create_time: Date.now() / 1000,
                end_turn: null,
                id: userMsgId,
                metadata: messageMetadata,
                recipient: 'all',
                status: 'finished_successfully',
                update_time: null,
                weight: 1
            }],
            genui_state_snapshots: [],
            client_prepare_state: 'success'
        };
        if (_conversationId) {
            modernPayload.conversation_id = _conversationId;
            console.log('[Proxima ChatGPT] Continuing conversation:', _conversationId);
        } else {
            console.log('[Proxima ChatGPT] Starting new conversation');
        }

        // Legacy payload for /backend-api/conversation fallback
        var legacyPayload = {
            action: 'next',
            messages: [{
                id: userMsgId,
                author: { role: 'user' },
                content: messageContent,
                metadata: messageMetadata
            }],
            model: chosenModel,
            parent_message_id: _parentMessageId || 'client-created-root',
            timezone_offset_min: tzOffset,
            history_and_training_disabled: false,
            conversation_mode: { kind: 'primary_assistant' },
            force_paragen: false,
            force_nulligen: false,
            force_rate_limit: false,
            websocket_request_id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('ws-' + Date.now())
        };
        if (_conversationId) legacyPayload.conversation_id = _conversationId;

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

        // Try /backend-api/f/conversation first, then fallback to /backend-api/conversation
        var res = await fetch('/backend-api/f/conversation', {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(modernPayload),
            signal: controller.signal
        }).catch(function () { return null; });

        var usedEndpoint = '/backend-api/f/conversation';
        var usedPayload = modernPayload;

        // If f/conversation failed (e.g. 404 in unit test mocks or proxy environments), fallback
        if (!res || (res.status === 404 && (!_conversationId || !res.ok))) {
            var checkErr = '';
            try {
                if (res && typeof res.clone === 'function') {
                    checkErr = await res.clone().text().catch(function () { return ''; });
                }
            } catch (e) { }
            var isSpecificConvNotFound = checkErr.indexOf('conversation_not_found') !== -1;
            if (!isSpecificConvNotFound) {
                res = await fetch('/backend-api/conversation', {
                    method: 'POST',
                    credentials: 'include',
                    headers: headers,
                    body: JSON.stringify(legacyPayload),
                    signal: controller.signal
                });
                usedEndpoint = '/backend-api/conversation';
                usedPayload = legacyPayload;
            }
        }

        // Refresh expired token and retry request once
        if (res.status === 401) {
            clearTimeout(timeoutId);
            var newToken = await _getToken();
            headers['Authorization'] = 'Bearer ' + newToken;

            var refreshedPow = await _getRequirementsAndPOW(newToken);
            if (refreshedPow.requirementsToken) {
                headers['OpenAI-Sentinel-Chat-Requirements-Token'] = refreshedPow.requirementsToken;
            } else {
                delete headers['OpenAI-Sentinel-Chat-Requirements-Token'];
            }
            if (refreshedPow.proofToken) {
                headers['OpenAI-Sentinel-Proof-Token'] = refreshedPow.proofToken;
            } else {
                delete headers['OpenAI-Sentinel-Proof-Token'];
            }
            if (refreshedPow.turnstileToken) {
                headers['OpenAI-Sentinel-Turnstile-Token'] = refreshedPow.turnstileToken;
            } else {
                delete headers['OpenAI-Sentinel-Turnstile-Token'];
            }

            var retryController = new AbortController();
            var retryTimeoutId = setTimeout(function () { retryController.abort(); }, TIMEOUT);
            res = await fetch(usedEndpoint, {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(usedPayload),
                signal: retryController.signal
            });
            timeoutId = retryTimeoutId;
            controller = retryController;
        }

        if (!res.ok) {
            clearTimeout(timeoutId);
            var err = await res.text().catch(function () { return ''; });
            var isNotFound = res.status === 404 && (
                err.indexOf('conversation_not_found') !== -1 ||
                err.indexOf('Model not found') !== -1 ||
                (function () {
                    try {
                        var parsed = JSON.parse(err);
                        return parsed && (
                            (parsed.detail && parsed.detail.code === 'conversation_not_found') ||
                            parsed.detail === 'Model not found'
                        );
                    } catch (e) { return false; }
                })()
            );

            // Recover from expired or deleted conversation on OpenAI server
            if (isNotFound && _conversationId && !_isRecovery) {
                console.log('[Proxima ChatGPT] Stale conversation ID not found on OpenAI server (' + _conversationId + '). Recovering with a fresh conversation...');
                var staleSession = sessionId || 'default';
                newConversation(staleSession);
                activateSession(staleSession);

                var recPayload = Object.assign({}, usedPayload);
                delete recPayload.conversation_id;
                recPayload.parent_message_id = 'client-created-root';

                var recController = new AbortController();
                var recTimeoutId = setTimeout(function () { recController.abort(); }, TIMEOUT);
                var recRes = await fetch(usedEndpoint, {
                    method: 'POST',
                    credentials: 'include',
                    headers: headers,
                    body: JSON.stringify(recPayload),
                    signal: recController.signal
                });

                if (!recRes.ok) {
                    clearTimeout(recTimeoutId);
                    var recErr = await recRes.text().catch(function () { return ''; });
                    throw new Error('ChatGPT recovery failed (' + recRes.status + '): ' + recErr.substring(0, 300));
                }

                var recContentType = recRes.headers.get('content-type') || '';
                var recResult;
                if (recContentType.startsWith('application/json')) {
                    clearTimeout(recTimeoutId);
                    var jsonRec = await recRes.json().catch(function () { return null; });
                    if (jsonRec && jsonRec.wss_url) {
                        recResult = await _handleWebSocketStream(jsonRec.wss_url, jsonRec.response_id, recController.signal);
                    } else {
                        throw new Error('ChatGPT returned unexpected JSON response without WebSocket URL');
                    }
                } else {
                    try { recResult = await _parseSSEStream(recRes, recController.signal); }
                    finally { clearTimeout(recTimeoutId); }
                }

                saveSession(staleSession);
                var notice = "*[System Notice: Previous ChatGPT conversation was not found or expired on the server. Resumed in a new conversation.]*\n\n";
                return notice + recResult;
            }

            if (res.status === 429 || err.toLowerCase().indexOf('limit reached for model') !== -1 || err.toLowerCase().indexOf('usage limit') !== -1 || err.toLowerCase().indexOf('quota') !== -1) {
                if (chosenModel) _markModelError(chosenModel);
            }

            throw new Error('ChatGPT API error (' + res.status + '): ' + err.substring(0, 300));
        }

        var resContentType = (res && res.headers && typeof res.headers.get === 'function') ? (res.headers.get('content-type') || '') : '';
        if (resContentType.startsWith('application/json')) {
            clearTimeout(timeoutId);
            var jsonMain = await res.json().catch(function () { return null; });
            if (jsonMain && jsonMain.wss_url) {
                var wsMainResult = await _handleWebSocketStream(jsonMain.wss_url, jsonMain.response_id, controller.signal);
                saveSession(sessionId);
                return wsMainResult;
            }
            throw new Error('ChatGPT returned unexpected JSON response without WebSocket URL');
        }

        var result;
        try { result = await _parseSSEStream(res, controller.signal); }
        finally { clearTimeout(timeoutId); }
        saveSession(sessionId);
        return result;
    }

    function newConversation(sessionId) {
        var sessionsToDelete = sessionId ? [sessionId] : ['default', 'mcp-session', _currentSessionId].filter(Boolean);
        for (var s = 0; s < sessionsToDelete.length; s++) {
            delete _sessions[sessionsToDelete[s]];
        }
        _conversationId = null;
        _parentMessageId = null;
        _currentSessionId = null;
        try {
            localStorage.setItem('proxima_chatgpt_sessions', JSON.stringify(_sessions));
        } catch (e) { }

        console.log('[Proxima ChatGPT] Conversation reset:', sessionId || 'default & mcp');
    }

    window.__proximaChatGPT = {
        send: send,
        newConversation: newConversation,
        uploadFileToChatGPT: uploadFileToChatGPT,
        getModels: function () { return _fetchModelsMetadata(); },
        getAvailableModels: getAvailableModels,
        getModelsMetadata: function () { return _fetchModelsMetadata(); },
        formatModelSlug: formatModelSlug,
        getModelTagInfo: getModelTagInfo,
        _parseModelVersion: _parseModelVersion,
        _isAllowedModelSlug: _isAllowedModelSlug,
        _markModelError: _markModelError,
        _clearModelError: _clearModelError,
        _isModelInError: _isModelInError,
        _getToken: _getToken,
        _resetTokenCache: function () { _cachedToken = null; _tokenExpiry = 0; _cachedAccountId = null; },
        _getRequirementsAndPOW: _getRequirementsAndPOW
    };
    console.log('[Proxima] ChatGPT engine loaded');
    _getToken().catch(function () { });
    _getScriptsAndDpl().catch(function () { });
    _fetchModelsMetadata().catch(function () { });
})();

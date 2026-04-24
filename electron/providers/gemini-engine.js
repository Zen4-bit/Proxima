/**
 * Proxima — Gemini Engine v4.1.0
 * Runs inside gemini.google.com BrowserView context. Extracts SNlM0e/cfb2h
 * tokens from page HTML, sends requests to BardFrontendService, and parses
 * Gemini's complex nested JSON response format.
 */
(function() {
    if (window.__proximaGemini) return;

    var GEMINI_BASE = 'https://gemini.google.com';
    var TIMEOUT = 360000;
    var TOKEN_TTL = 300000;
    var _tokens = null;
    var _tokensFetchedAt = 0;

    // ─── State ───────────────────────────────────────
    var _conversationId = '';
    var _responseId = '';
    var _choiceId = '';

    // ─── Auth Tokens (SNlM0e + cfb2h, cached 5 min) ───

    async function _getTokens(forceRefresh) {
        var isExpired = (Date.now() - _tokensFetchedAt) > TOKEN_TTL;
        if (_tokens && !forceRefresh && !isExpired) return _tokens;

        var controller = new AbortController();
        var tid = setTimeout(function() { controller.abort(); }, 30000);

        var res = await fetch('/faq', { credentials: 'include', signal: controller.signal });
        clearTimeout(tid);

        if (!res.ok) throw new Error('Gemini page fetch failed (' + res.status + ')');
        var html = await res.text();

        if (html.indexOf('$authuser') === -1) {
            throw new Error('Not logged into Google');
        }

        var at, bl;
        try {
            at = html.split('SNlM0e')[1].split('":"')[1].split('"')[0];
        } catch(e) { throw new Error('Failed to extract SNlM0e token'); }

        try {
            bl = html.split('cfb2h')[1].split('":"')[1].split('"')[0];
        } catch(e) { throw new Error('Failed to extract cfb2h token'); }

        _tokens = { at: at, bl: bl };
        _tokensFetchedAt = Date.now();
        return _tokens;
    }

    // ─── Response Parser ────────────────────────────
    // Gemini returns deeply nested JSON arrays. This parser tries multiple
    // extraction paths and falls back to recursive string search.

    function _parseResponse(rawText) {
        var cleanText = rawText.replace(/^\)\]}'?\s*\n?/, '');
        var lines = cleanText.split('\n').filter(function(l) { return l.trim().length > 0; });

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
                                } catch(e) {}
                            }
                        }
                    }
                }
            } catch(e) {}
        }

        // Fallback: recursive deep search for JSON strings
        if (allItems.length === 0) {
            var jsonStrings = [];
            function deepSearch(obj) {
                if (typeof obj === 'string' && obj.length > 50) {
                    try { JSON.parse(obj); jsonStrings.push(obj); } catch(e) {}
                } else if (Array.isArray(obj)) {
                    for (var i = 0; i < obj.length; i++) deepSearch(obj[i]);
                }
            }
            for (var i = 0; i < lines.length; i++) {
                try { deepSearch(JSON.parse(lines[i])); } catch(e) {}
            }
            if (jsonStrings.length > 0) {
                for (var j = 0; j < jsonStrings.length; j++) {
                    allItems.push([null, null, jsonStrings[j]]);
                    dataIndices.push(2);
                }
            }
        }

        if (allItems.length === 0) throw new Error('Failed to parse Gemini response');


        try {
            var firstIdx = dataIndices[0] || 2;
            var inner0 = JSON.parse(allItems[0][firstIdx]);
            var errorCode = inner0 && inner0[5] && inner0[5][0];
            if (errorCode === 9) throw new Error('No Gemini access');
        } catch(e) { if (e.message.indexOf('No Gemini') >= 0) throw e; }

        // Extract conversation context for persistence
        try {
            var firstIdx = dataIndices[0] || 2;
            var inner = JSON.parse(allItems[0][firstIdx]);
            
        // Gemini nests conversation IDs at inner[1][0], inner[1][1], inner[4][0][0]
            if (inner[1] && Array.isArray(inner[1])) {
                if (typeof inner[1][0] === 'string' && inner[1][0].length > 5) {
                    _conversationId = inner[1][0];
                }
                if (typeof inner[1][1] === 'string' && inner[1][1].length > 5) {
                    _responseId = inner[1][1];
                }
            }

            if (inner[4] && inner[4][0] && typeof inner[4][0][0] === 'string') {
                _choiceId = inner[4][0][0];
            }
            
            if (_conversationId) {
                console.log('[Proxima Gemini] Captured conversation context: ' + _conversationId.substring(0, 20) + '...');
            }
        } catch(e) {}


        var replyText = '';

        for (var i = 0; i < allItems.length; i++) {
            var item = allItems[i];
            var idx = dataIndices[i] || 2;
            try {
                var inner = JSON.parse(item[idx]);
                var paths = [
                    function() { return (Array.isArray(inner[0]) && typeof inner[0][0] === 'string') ? inner[0][0] : ''; },
                    function() { return (inner[4] && inner[4][0] && inner[4][0][1] && inner[4][0][1][0]) || ''; },
                    function() { return (inner[4] && inner[4][0] && inner[4][0][1]) || ''; },
                    function() { return (Array.isArray(inner[1]) && typeof inner[1][0] === 'string') ? inner[1][0] : ''; },
                    function() { return (inner[0] && inner[0][1] && inner[0][1][0]) || ''; },
                    function() { return (inner[3] && inner[3][0] && inner[3][0][0]) || ''; },
                    function() { return (inner[3] && inner[3][1] && inner[3][1][0]) || ''; }
                ];

                for (var pi = 0; pi < paths.length; pi++) {
                    try {
                        var candidate = paths[pi]();
                        if (typeof candidate === 'string' && candidate.length > 10 && candidate.length > replyText.length) {
                            replyText = candidate;
                        }
                    } catch(e) {}
                }

                // Last resort: recursive deep search for longest string
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
                    if (longest.length > 50 && longest.length > replyText.length) replyText = longest;
                }
            } catch(e) {}
        }

        if (!replyText) throw new Error('Could not extract reply from Gemini');
        return replyText;
    }

    // ─── Send Message ───────────────────────────────

    async function send(message) {
        var tokens = await _getTokens();
        var reqId = Math.floor(900000 * Math.random()) + 100000;

        var queryParams = new URLSearchParams({
            bl: tokens.bl,
            rt: 'c',
            _reqid: reqId.toString()
        });


        var conversationContext = [_conversationId, _responseId, _choiceId];
        
        if (_conversationId) {
            console.log('[Proxima Gemini] Continuing conversation: ' + _conversationId.substring(0, 20) + '...');
        } else {
            console.log('[Proxima Gemini] Starting new conversation');
        }

        var body = new URLSearchParams({
            at: tokens.at,
            'f.req': JSON.stringify([null, JSON.stringify([[message], null, conversationContext])])
        });

        var url = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + queryParams;

        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT);

        var res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1'
            },
            body: body,
            signal: controller.signal
        });

        // 400 = token expired — refresh and retry once
        if (res.status === 400) {
            _tokens = null;
            _tokensFetchedAt = 0;
            var freshTokens = await _getTokens(true);

            var retryBody = new URLSearchParams({
                at: freshTokens.at,
                'f.req': JSON.stringify([null, JSON.stringify([[message], null, conversationContext])])
            });

            var retryParams = new URLSearchParams({
                bl: freshTokens.bl,
                rt: 'c',
                _reqid: (Math.floor(900000 * Math.random()) + 100000).toString()
            });

            var retryUrl = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + retryParams;
            var retryController = new AbortController();
            var retryTimeoutId = setTimeout(function() { retryController.abort(); }, TIMEOUT);

            res = await fetch(retryUrl, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'x-same-domain': '1'
                },
                body: retryBody,
                signal: retryController.signal
            });

            if (!res.ok) {
                clearTimeout(retryTimeoutId);
                var err = await res.text().catch(function() { return ''; });
                throw new Error('Gemini API error (' + res.status + '): ' + err.substring(0, 300));
            }

            var result = _parseResponse(await res.text());
            clearTimeout(retryTimeoutId);
            return result;
        }

        if (!res.ok) {
            clearTimeout(timeoutId);
            var err = await res.text().catch(function() { return ''; });
            throw new Error('Gemini API error (' + res.status + '): ' + err.substring(0, 300));
        }

        var result = _parseResponse(await res.text());
        clearTimeout(timeoutId);
        return result;
    }


    function newConversation() {
        _conversationId = '';
        _responseId = '';
        _choiceId = '';
        console.log('[Proxima Gemini] Conversation reset');
    }

    window.__proximaGemini = { send: send, newConversation: newConversation };
    console.log('[Proxima] Gemini engine loaded');
})();

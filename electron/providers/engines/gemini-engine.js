// Proxima — Unified Gemini Engine.
// Performs StreamGenerate request routing, Scotty file uploads, and session management.

(function () {
    // Engine definition (rebinds __proximaGeminiUnified upon reload)

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
    var _turnIndex = 0;
    var _sessionUuid = generateUuid().toUpperCase();
    var _workspaces = { fast: [], thinking: [] };

    var _activeController = null;
    var _activeReader = null;

    function abortActive() {
        if (_activeController) {
            try { _activeController.abort(); } catch (e) { }
            _activeController = null;
        }
        if (_activeReader) {
            try { _activeReader.cancel(); } catch (e) { }
            _activeReader = null;
        }
        if (window.__proximaGeminiStream) {
            window.__proximaGeminiStream.status = 'error';
            window.__proximaGeminiStream.error = 'Cancelled by user';
        }
    }

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

    function _sessionKey(sessionId, engineKey) {
        if (!sessionId) sessionId = 'default';
        var cleanEngine = (engineKey || 'auto');
        if (cleanEngine.indexOf(':') !== -1) {
            cleanEngine = cleanEngine.split(':')[1];
        }
        return sessionId + '::' + cleanEngine;
    }

    function activateSession(sessionId, engineKey, forceFresh) {
        if (!sessionId) sessionId = 'default';
        var key = _sessionKey(sessionId, engineKey);
        _currentSessionId = key;
        if (!_sessions[key]) {
            // Inherit ongoing conversation across sub-engines
            var existing = _sessions[sessionId];
            if (!existing || !existing.conversationId) {
                var prefix = sessionId + '::';
                for (var sk in _sessions) {
                    if (sk.indexOf(prefix) === 0 && _sessions[sk] && _sessions[sk].conversationId) {
                        existing = _sessions[sk];
                        break;
                    }
                }
            }
            if (existing && existing.conversationId) {
                _sessions[key] = {
                    conversationId: existing.conversationId,
                    responseId: existing.responseId || '',
                    choiceId: existing.choiceId || '',
                    contextToken: existing.contextToken || '',
                    turnIndex: existing.turnIndex || 0,
                    sessionUuid: existing.sessionUuid || generateUuid().toUpperCase()
                };
            } else {
                _sessions[key] = {
                    conversationId: '',
                    responseId: '',
                    choiceId: '',
                    contextToken: '',
                    turnIndex: 0,
                    sessionUuid: generateUuid().toUpperCase()
                };
            }
        }
        var sess = _sessions[key];
        if (!sess.sessionUuid) {
            sess.sessionUuid = generateUuid().toUpperCase();
        }
        _conversationId = forceFresh ? '' : sess.conversationId;
        _responseId = forceFresh ? '' : sess.responseId;
        _choiceId = forceFresh ? '' : sess.choiceId;
        _contextToken = forceFresh ? '' : (sess.contextToken || '');
        _turnIndex = forceFresh ? 0 : (typeof sess.turnIndex === 'number' ? sess.turnIndex : (_conversationId ? 1 : 0));
        _sessionUuid = forceFresh ? generateUuid().toUpperCase() : sess.sessionUuid;
        return sess;
    }

    function saveSession(sessionId, engineKey) {
        if (!sessionId) sessionId = 'default';
        var key = _sessionKey(sessionId, engineKey);
        var sessObj = {
            conversationId: _conversationId,
            responseId: _responseId,
            choiceId: _choiceId,
            contextToken: _contextToken,
            turnIndex: _turnIndex,
            sessionUuid: _sessionUuid
        };
        _sessions[key] = sessObj;
        _sessions[sessionId] = sessObj;
        var prefix = sessionId + '::';
        for (var k in _sessions) {
            if (k.indexOf(prefix) === 0) {
                _sessions[k] = Object.assign({}, sessObj);
            }
        }
        try {
            _pruneSessions();
            localStorage.setItem('proxima_sessions', JSON.stringify(_sessions));
        } catch (e) { }
    }

    var _cachedModelsByAccount = {};
    var _cachedAccountId = null;

    function _detectAccountIdentifier() {
        try {
            if (typeof document !== 'undefined') {
                var emailEl = document.querySelector('[aria-label*="@"]');
                if (emailEl) {
                    var aria = emailEl.getAttribute('aria-label') || '';
                    var match = aria.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                    if (match && match[1]) return match[1].toLowerCase();
                }
            }
            if (typeof window !== 'undefined' && window.location && window.location.pathname) {
                var uMatch = window.location.pathname.match(/^\/u\/(\d+)/);
                if (uMatch) return 'user_' + uMatch[1];
            }
            if (_tokens && _tokens.at) {
                return 'token_' + _tokens.at.substring(0, 16);
            }
        } catch (e) { }
        return 'default_account';
    }

    function _slugify(name) {
        if (!name) return '';
        return name.toLowerCase()
            .replace(/[^\w\s\.-]/g, '')
            .trim()
            .replace(/[\s\.]+/g, '-');
    }

    async function _extractLiveMenuModels() {
        var accountId = _detectAccountIdentifier();
        if (typeof _modelsLockedByAccount !== 'undefined' && _modelsLockedByAccount[accountId]) {
            return [];
        }
        var items = [];
        var btn = document.querySelector('[data-test-id="bard-mode-menu-button"]');
        var menuId = btn ? btn.getAttribute('aria-controls') : null;
        var menuEl = menuId ? document.getElementById(menuId) : document.querySelector('[role="menu"]');

        var needDismiss = false;
        if (!menuEl && btn) {
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (evtType) {
                btn.dispatchEvent(new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window }));
            });
            needDismiss = true;
            await new Promise(function (resolve) { setTimeout(resolve, 350); });
            menuId = btn.getAttribute('aria-controls');
            menuEl = menuId ? document.getElementById(menuId) : document.querySelector('[role="menu"]');
        }

        if (menuEl) {
            var rawItems = Array.from(menuEl.querySelectorAll('gem-menu-item, [role="menuitem"], [data-test-id^="bard-mode-option-"]'));
            var seenWk = new Set();
            rawItems.forEach(function (el) {
                var text = (el.innerText || '').trim();
                var jslog = el.getAttribute('jslog') || '';
                var dataTestId = el.getAttribute('data-test-id') || '';
                var wkId = null;
                var testIdMatch = dataTestId.match(/bard-mode-option-([0-9a-f]{16})/i);
                if (testIdMatch) {
                    wkId = testIdMatch[1];
                } else {
                    var veMatch = jslog.match(/BardVeMetadataKey:([^;]+)/);
                    if (veMatch) {
                        try {
                            var decoded = atob(veMatch[1]);
                            var m = decoded.match(/"([0-9a-f]{16})"/i);
                            if (m) wkId = m[1];
                        } catch (e) { }
                    }
                }

                if (wkId && !seenWk.has(wkId) && text) {
                    seenWk.add(wkId);
                    var lines = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
                    var displayName = lines[0] || 'Gemini Model';
                    var desc = lines.slice(1).join(' - ') || 'Google Gemini Engine';
                    items.push({
                        displayName: displayName,
                        description: desc,
                        workspaceId: wkId,
                        rawText: text
                    });
                }
            });
        }

        if (needDismiss) {
            try {
                var backdrop = document.querySelector('.cdk-overlay-backdrop');
                if (backdrop) {
                    backdrop.click();
                } else if (btn) {
                    btn.click();
                }
            } catch (e) { }
            try {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            } catch (e) { }
        }

        return items;
    }

    var _modelsLockedByAccount = {};

    async function getAvailableModels(forceRefresh) {
        var accountId = _detectAccountIdentifier();

        // Lock check: once models are discovered for an account, lock them in memory
        // Never repeatedly re-click DOM elements during normal chat or subsequent queries
        if (_cachedModelsByAccount[accountId] && _cachedModelsByAccount[accountId].length > 1) {
            return _cachedModelsByAccount[accountId];
        }

        if (accountId !== _cachedAccountId) {
            _cachedAccountId = accountId;
        }

        _detectWorkspaces();

        var liveItems = [];
        try {
            if (typeof document !== 'undefined') {
                liveItems = await _extractLiveMenuModels();
            }
        } catch (e) {
            console.warn('[Proxima Gemini] Live menu extraction non-fatal warning:', e.message);
        }

        var hasThinkingSupport = liveItems.some(function (it) {
            return it.displayName.toLowerCase().indexOf('pro') !== -1 ||
                   it.displayName.toLowerCase().indexOf('argon') !== -1 ||
                   it.rawText.toLowerCase().indexOf('reasoning') !== -1 ||
                   it.rawText.toLowerCase().indexOf('thinking') !== -1;
        }) || (_workspaces.thinking && _workspaces.thinking.length > 0);

        var supportedThinkingLevels = hasThinkingSupport ? ['low', 'medium', 'high'] : [];

        var richModels = [];
        var fastestModel = null;
        var reasoningModel = null;

        liveItems.forEach(function (item) {
            var slug = _slugify(item.displayName);
            var fullId = 'gemini:' + slug;
            var lower = item.displayName.toLowerCase() + ' ' + item.description.toLowerCase();

            var tag = 'General';
            var tagCls = 'fast';
            if (lower.indexOf('lite') !== -1 || lower.indexOf('fastest') !== -1) {
                tag = 'Fast';
                tagCls = 'fast';
                if (!fastestModel) fastestModel = item;
            } else if (lower.indexOf('flash') !== -1) {
                tag = 'All-Around';
                tagCls = 'fast';
                if (!fastestModel) fastestModel = item;
            } else if (lower.indexOf('argon') !== -1) {
                tag = 'Pro';
                tagCls = 'pro';
                if (!reasoningModel) reasoningModel = item;
            } else if (lower.indexOf('pro') !== -1 || lower.indexOf('reasoning') !== -1) {
                tag = 'Reasoning';
                tagCls = 'reasoning';
                if (!reasoningModel) reasoningModel = item;
            }

            richModels.push({
                id: fullId,
                slug: slug,
                name: item.displayName,
                displayName: item.displayName,
                description: item.description,
                workspaceId: item.workspaceId,
                status: 'enabled',
                tag: tag,
                tags: [tag],
                tagCls: tagCls,
                supported_thinking_levels: supportedThinkingLevels
            });
        });

        // Dynamic fallback from detected workspaces / document HTML
        if (richModels.length === 0) {
            var docHtml = (typeof document !== 'undefined' && document.documentElement) ? document.documentElement.innerHTML : '';
            var hexMatches = docHtml.match(/[0-9a-f]{16}/g) || [];
            var uniqueHex = Array.from(new Set(hexMatches)).filter(function (h) {
                return h === '56fdd199312815e2' || h === '8c46e95b1a07cecc' || h === 'e6fa609c3fa255c0' || h === '95a4c0abcba24364';
            });

            if (uniqueHex.length === 0) {
                uniqueHex = ['8c46e95b1a07cecc', '56fdd199312815e2', 'e6fa609c3fa255c0', '95a4c0abcba24364'];
            }

            var defMap = {
                '8c46e95b1a07cecc': { slug: '3-5-flash-lite', name: '3.5 Flash-Lite', desc: 'Fastest answers', tag: 'Fast' },
                '56fdd199312815e2': { slug: '3-8-flash', name: '3.8 Flash', desc: 'All-around help', tag: 'General' },
                'e6fa609c3fa255c0': { slug: '3-1-pro', name: '3.1 Pro', desc: 'Advanced reasoning', tag: 'Reasoning' },
                '95a4c0abcba24364': { slug: '4-argon', name: '4 Argon', desc: 'Complex tasks', tag: 'Pro' }
            };

            uniqueHex.forEach(function (h) {
                var d = defMap[h] || { slug: h, name: 'Gemini ' + h.substring(0, 4), desc: 'Google Gemini Engine', tag: 'General' };
                richModels.push({
                    id: 'gemini:' + d.slug,
                    slug: d.slug,
                    name: d.name,
                    displayName: d.name,
                    description: d.desc,
                    workspaceId: h,
                    status: 'enabled',
                    tag: d.tag,
                    tags: [d.tag],
                    tagCls: d.tag.toLowerCase(),
                    supported_thinking_levels: supportedThinkingLevels
                });
            });
        }

        if (!fastestModel && richModels.length > 0) {
            fastestModel = richModels[0];
        }

        var autoName = fastestModel ? 'Auto (' + (fastestModel.displayName || fastestModel.name || 'Gemini') + ')' : 'Gemini Auto';
        var autoModel = {
            id: 'gemini:auto',
            slug: 'auto',
            name: autoName,
            displayName: autoName,
            description: 'Auto-routes to fastest available Gemini model with adaptive reasoning',
            status: 'enabled',
            tag: 'Auto Fast',
            tags: ['Auto Fast'],
            tagCls: 'fast',
            supported_thinking_levels: supportedThinkingLevels
        };

        var finalModels = [autoModel].concat(richModels);
        _cachedModelsByAccount[accountId] = finalModels;
        _modelsLockedByAccount[accountId] = true;
        return finalModels;
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

    function _extractGeminiToken(html, tokenName) {
        try {
            var r1 = new RegExp(tokenName + '":"([^"]+)"');
            var m1 = html.match(r1);
            if (m1 && m1[1]) return m1[1];
        } catch (e) { }

        try {
            var r2 = new RegExp(tokenName + '\\\\?":\\\\?"([^"\\\\]+)');
            var m2 = html.match(r2);
            if (m2 && m2[1]) return m2[1];
        } catch (e) { }

        try {
            var r3 = new RegExp(tokenName + '[^"]*"\\s*:\\s*"([^"]+)"');
            var m3 = html.match(r3);
            if (m3 && m3[1]) return m3[1];
        } catch (e) { }

        try {
            return html.split(tokenName)[1].split('":"')[1].split('"')[0];
        } catch (e) { }

        return null;
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
                at = _extractGeminiToken(html, 'SNlM0e');
            }
            if (!bl) {
                bl = _extractGeminiToken(html, 'cfb2h');
                if (!bl) {
                    var blMatch = html.match(/boq_assistant-bard-web-server_[a-zA-Z0-9_\.\-]+/);
                    if (blMatch) bl = blMatch[0];
                }
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
        var faqHtml = await res.text();

        if (faqHtml.indexOf('$authuser') === -1) {
            throw new Error('Not logged into Google');
        }

        at = _extractGeminiToken(faqHtml, 'SNlM0e');
        if (!at) throw new Error('Failed to extract SNlM0e token');

        bl = _extractGeminiToken(faqHtml, 'cfb2h');
        if (!bl) throw new Error('Failed to extract cfb2h token');

        _tokens = { at: at, bl: bl };
        _tokensFetchedAt = Date.now();
        return _tokens;
    }

    var GEMINI_FAILURE_PHRASES = [
        "I'm having a hard time fulfilling your request right now",
        "I'm having a hard time fulfilling your request",
        'having a hard time fulfilling your request right now',
        'having a hard time fulfilling your request',
        'I seem to be encountering an error',
        'Can I try something else for you',
        'Can I try something else',
        'Sorry, something went wrong',
        'I encountered an error doing what you asked',
        'I encountered an error',
        'Please try your request again',
        'Please try again later',
        'Something went wrong',
        'An error occurred',
        'Could you try again',
        'Can I help you with something else instead',
        'try something else for you'
    ];

    function _isGeminiFailureText(text) {
        if (typeof text !== 'string') return false;
        var trimmed = text.trim();
        if (!trimmed) return false;
        var lower = trimmed.toLowerCase();
        var matchedAny = false;
        for (var i = 0; i < GEMINI_FAILURE_PHRASES.length; i++) {
            var phrase = GEMINI_FAILURE_PHRASES[i].toLowerCase();
            if (lower === phrase || lower === phrase + '.' || lower === phrase + '?') {
                return true;
            }
            if (lower.indexOf(phrase) !== -1) {
                matchedAny = true;
            }
        }
        if (!matchedAny) return false;
        var stripped = lower;
        var sortedPhrases = GEMINI_FAILURE_PHRASES.slice().sort(function (a, b) { return b.length - a.length; });
        for (var j = 0; j < sortedPhrases.length; j++) {
            stripped = stripped.split(sortedPhrases[j].toLowerCase()).join('');
        }
        stripped = stripped.replace(/[\s\.\?\!\,\:\;\-]+/g, '');
        stripped = stripped.replace(/^(im|rightnow|instead|foryou|for|you)+/g, '').replace(/(im|rightnow|instead|foryou|for|you)+$/g, '');
        return stripped.length === 0;
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
                            if (typeof item[idx] === 'string' && item[idx].length > 10) {
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
                if (typeof obj === 'string' && obj.length > 10) {
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
            if (rawText.indexOf('"37":[0]') !== -1 || rawText.indexOf('\\"37\\":[0]') !== -1) {
                console.error('[Proxima API] Gemini extension/workspace rejected by Google (error code 37). Raw response: ' + rawText.substring(0, 500));
                throw new Error('Gemini workspace rejected by Google (code 37: unsupported workspace for this account)');
            }
            console.error('[Proxima API] Parse error: Raw response length is ' + rawText.length + '. Content: ' + rawText.substring(0, 500));
            throw new Error('Failed to parse Gemini response');
        }

        try {
            var firstIdx = dataIndices[0] || 2;
            var inner0 = JSON.parse(allItems[0][firstIdx]);
            var errorCode = (inner0 && inner0[5] && inner0[5][0]) != null ? inner0[5][0] : null;
            if (errorCode === 9) throw new Error('No Gemini access — check your Google account');
        } catch (e) {
            if (e.message.indexOf('No Gemini') !== -1) throw e;
        }

        var sawAbortText = false;
        var notReplyText = function (s) {
            return /^c_[0-9a-f]+r_[0-9a-f]+$/i.test(s) || /^[rc]_[a-f0-9]{16,}$/i.test(s) || /^(?:https?:)?\/\/\S*$/i.test(s.trim());
        };
        var extractParts = function (val) {
            if (typeof val === 'string') return val;
            if (Array.isArray(val)) {
                return val.map(function (p) {
                    return typeof p === 'string' ? p : (Array.isArray(p) ? extractParts(p) : '');
                }).join('');
            }
            return '';
        };

        var extracted = { conversationId: null, responseId: null, choiceId: null, contextToken: null };
        var _answerFrameSeen = false;

        function find26(obj, depth) {
            if (!obj || depth > 4) return null;
            if (typeof obj === 'object') {
                if (typeof obj['26'] === 'string' && obj['26'].length > 5) return obj['26'];
                if (Array.isArray(obj)) {
                    for (var i = 0; i < obj.length; i++) {
                        var f = find26(obj[i], depth + 1);
                        if (f) return f;
                    }
                } else {
                    for (var k in obj) {
                        var f = find26(obj[k], depth + 1);
                        if (f) return f;
                    }
                }
            }
            return null;
        }

        for (var ci = 0; ci < allItems.length; ci++) {
            try {
                var innerC = JSON.parse(allItems[ci][dataIndices[ci] || 2]);
                var candChoice = null;
                if (innerC[4] && Array.isArray(innerC[4]) && innerC[4].length > 0) {
                    var c0 = innerC[4][0];
                    if (typeof c0 === 'string') candChoice = c0;
                    else if (Array.isArray(c0) && c0.length > 0) {
                        if (typeof c0[0] === 'string') candChoice = c0[0];
                        else if (Array.isArray(c0[0]) && c0[0].length > 0 && typeof c0[0][0] === 'string') candChoice = c0[0][0];
                    }
                }
                var hasChoice = !!(candChoice && candChoice.length >= 3);

                if (hasChoice) {
                    if (innerC[1] && Array.isArray(innerC[1])) {
                        if (typeof innerC[1][0] === 'string' && innerC[1][0].length > 5) {
                            extracted.conversationId = innerC[1][0];
                        }
                        if (typeof innerC[1][1] === 'string' && innerC[1][1].length > 5) {
                            extracted.responseId = innerC[1][1];
                        }
                    }
                    extracted.choiceId = candChoice;
                    _answerFrameSeen = true;
                } else if (!_answerFrameSeen && innerC[1] && Array.isArray(innerC[1])) {
                    if (typeof innerC[1][0] === 'string' && innerC[1][0].length > 5) {
                        extracted.conversationId = innerC[1][0];
                    }
                    if (typeof innerC[1][1] === 'string' && innerC[1][1].length > 5) {
                        extracted.responseId = innerC[1][1];
                    }
                }

                var tok26 = find26(innerC, 0);
                if (tok26) {
                    extracted.contextToken = tok26;
                }
            } catch (e) { }
        }

        var replyText = '';
        var lastResort = '';

        for (var i = 0; i < allItems.length; i++) {
            var item = allItems[i];
            var idx = dataIndices[i] || 2;
            try {
                var inner = JSON.parse(item[idx]);
                var paths = [
                    function () { return extractParts(inner[4] && inner[4][0] && inner[4][0][1]); },
                    function () { return (Array.isArray(inner[0]) && typeof inner[0][0] === 'string') ? inner[0][0] : ''; },
                    function () { return extractParts(inner[0] && inner[0][1]); },
                    function () { return extractParts(inner[3] && inner[3][0]); },
                    function () { return extractParts(inner[3] && inner[3][1]); }
                ];

                for (var pi = 0; pi < paths.length; pi++) {
                    try {
                        var candidate = paths[pi]();
                        if (typeof candidate !== 'string' || !candidate.trim()) continue;
                        if (_isGeminiFailureText(candidate)) {
                            sawAbortText = true;
                            continue;
                        }
                        if (candidate.length > replyText.length) {
                            if (notReplyText(candidate)) continue;
                            replyText = candidate;
                        }
                    } catch (e) { }
                }

                if (!replyText) {
                    function findLongestString(obj, depth) {
                        if (depth > 8) return '';
                        if (typeof obj === 'string') {
                            if (notReplyText(obj)) return '';
                            return obj;
                        }
                        var longest = '';
                        if (Array.isArray(obj)) {
                            if (obj.length > 0 && obj.every(function (x) { return typeof x === 'string'; })) {
                                var joined = obj.join('');
                                if (joined.length > longest.length) longest = joined;
                            }
                            for (var k = 0; k < obj.length; k++) {
                                var s = findLongestString(obj[k], depth + 1);
                                if (typeof s === 'string' && s.length > longest.length) longest = s;
                            }
                        }
                        return longest;
                    }
                    var longest = findLongestString(inner, 0);
                    if (longest.trim().length > 0 && longest.length > lastResort.length && !notReplyText(longest)) {
                        lastResort = longest;
                    }
                }
            } catch (e) { }
        }

        if (!replyText && lastResort) {
            if (_isGeminiFailureText(lastResort)) {
                sawAbortText = true;
            } else {
                replyText = lastResort;
            }
        }

        // Abort if stream failed mid-generation
        if (sawAbortText) {
            throw new Error('Gemini stream aborted by Google server mid-generation');
        }

        if (!replyText) {
            if (commitIds) {
                console.error('[Proxima API] Parse error: ReplyText empty. Raw response: ' + rawText.substring(0, 500));
            }
            throw new Error('Could not extract reply from Gemini');
        }

        // Commit turn state on successful reply
        if (commitIds) {
            if (extracted.conversationId) _conversationId = extracted.conversationId;
            if (extracted.responseId) _responseId = extracted.responseId;
            if (extracted.choiceId) _choiceId = extracted.choiceId;
            if (extracted.contextToken) _contextToken = extracted.contextToken;
            _turnIndex = (_turnIndex || 0) + 1;
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

    async function _processStreamResponse(res, isReasoningEngine, _isRetry) {
        var reader = res.body.getReader();
        _activeReader = reader;
        var decoder = new TextDecoder();
        var rawText = '';
        window.__proximaGeminiStream = { response: '', status: 'streaming', updates: [] };

        var idleTimeout = null;
        var stalled = false;
        var sawAnswer = false;

        var resetIdle = function (customMs) {
            if (idleTimeout) clearTimeout(idleTimeout);
            // Streaming idle timeout: 3.5s after reply starts, or engine initial limit
            var initialMs = _isRetry ? 25000 : (isReasoningEngine ? 30000 : 20000);
            var ms = customMs || (sawAnswer ? 3500 : initialMs);
            idleTimeout = setTimeout(function () {
                stalled = true;
                try { reader.cancel(); } catch (e) { }
            }, ms);
        };

        try {
            resetIdle();
            while (true) {
                var chunk = await reader.read();
                if (chunk.done || stalled) break;

                var chunkStr = decoder.decode(chunk.value, { stream: true });
                rawText += chunkStr;

                // Fast-fail on RPC code 37 rejection
                if (rawText.indexOf('"37":[0]') !== -1 || rawText.indexOf('\\"37\\":[0]') !== -1) {
                    try { reader.cancel(); } catch (e) { }
                    break;
                }

                var updateText = window.__proximaGeminiStream.response || '';
                if (chunkStr.indexOf('\n') !== -1) {
                    try {
                        var parsed = _parseResponse(rawText, false);
                        if (parsed) {
                            window.__proximaGeminiStream.response = parsed;
                            updateText = parsed;
                            sawAnswer = true;
                        }
                    } catch (e) {
                        // Break on abort text so fallback triggers
                        if (e.message && e.message.indexOf('stream aborted') !== -1) {
                            try { reader.cancel(); } catch (cancelErr) { }
                            break;
                        }
                        updateText = 'error: ' + e.message;
                    }
                }

                // End-of-stream terminal envelope: [["e", ...]]
                if (chunkStr.indexOf('["e",') !== -1 || rawText.indexOf('["e",') !== -1) {
                    try { reader.cancel(); } catch (e) { }
                    break;
                }

                resetIdle();

                var _updates = window.__proximaGeminiStream.updates;
                _updates.push({
                    time: Date.now(),
                    chunkLength: chunk.value.length,
                    parsedLength: updateText.length,
                    text: updateText.substring(0, 30)
                });
                if (_updates.length > 50) _updates.shift();
            }

            if (stalled && !sawAnswer && !window.__proximaGeminiStream.response) {
                var waitSec = _isRetry ? 25 : (isReasoningEngine ? 30 : 20);
                window.__proximaGeminiStream.status = 'error';
                window.__proximaGeminiStream.error = 'Gemini stream stalled: no data received for ' + waitSec + 's';
                throw new Error('Gemini stream stalled: no data received for ' + waitSec + 's');
            }

            window.__proximaGeminiStream.status = 'done';
        } catch (err) {
            window.__proximaGeminiStream.status = 'error';
            window.__proximaGeminiStream.error = err.message;
            throw err;
        } finally {
            _activeReader = null;
            if (idleTimeout) clearTimeout(idleTimeout);
        }

        return _parseResponse(rawText, true);
    }

    async function send(message, engine, attachments, sessionId, _isRetry, options) {
        abortActive();
        if (typeof engine === 'object' && engine !== null) {
            options = engine;
            engine = options.model || options.engine || 'auto';
        }
        options = options || {};
        engine = engine || 'auto';

        var requestedThinkingLevel = options.thinking_level || options.thinkingLevel || options.reasoning_effort || null;
        if (typeof engine === 'string' && engine.indexOf(':') !== -1) {
            var segs = engine.split(':');
            if (segs[0] === 'gemini') {
                engine = segs.slice(1).join(':');
                segs = engine.split(':');
            }
            var lastSeg = segs[segs.length - 1].toLowerCase();
            if (['low', 'medium', 'high', 'default', 'off'].includes(lastSeg)) {
                if (!requestedThinkingLevel) requestedThinkingLevel = lastSeg;
                engine = segs.slice(0, segs.length - 1).join(':');
            }
        }

        var thinkingCode = null;
        var normLevel = null;
        if (requestedThinkingLevel) {
            normLevel = String(requestedThinkingLevel).toLowerCase().trim();
            if (normLevel === 'low') thinkingCode = 1;
            else if (normLevel === 'medium') thinkingCode = 4;
            else if (normLevel === 'high') thinkingCode = 2;
            else if (normLevel === 'default' || normLevel === 'off') thinkingCode = null;
            else {
                throw new Error("Unsupported thinking_level '" + requestedThinkingLevel + "'. Supported levels for Gemini are: default, low, medium, high.");
            }
        }

        activateSession(sessionId, engine, false);
        _detectWorkspaces();

        var isAuto = (engine === 'auto' || engine === 'gemini' || engine === 'gemini:auto' || !engine);

        try {
            var availableModels = await getAvailableModels(false);
            var rawSub = (engine || 'auto').toLowerCase().trim();
            if (rawSub.startsWith('gemini:')) rawSub = rawSub.slice(7);

            var targetModel = null;
            if (isAuto) {
                if (normLevel === 'high') {
                    targetModel = availableModels.find(function (m) { return m.slug !== 'auto' && (m.tag === 'Reasoning' || m.tag === 'Pro'); }) ||
                                  availableModels.find(function (m) { return m.slug !== 'auto'; }) || availableModels[0];
                } else if (normLevel === 'low') {
                    targetModel = availableModels.find(function (m) { return m.slug !== 'auto' && (m.tag === 'Fast' || m.slug.includes('lite') || m.slug.includes('flash')); }) ||
                                  availableModels.find(function (m) { return m.slug !== 'auto'; }) || availableModels[0];
                } else {
                    targetModel = availableModels.find(function (m) { return m.slug !== 'auto'; }) || availableModels[0];
                }
            } else {
                targetModel = availableModels.find(function (m) {
                    if (m.slug === 'auto') return false;
                    if (m.slug === rawSub || m.id === 'gemini:' + rawSub) return true;
                    if (m.name && m.name.toLowerCase() === rawSub) return true;
                    if (m.displayName && m.displayName.toLowerCase() === rawSub) return true;
                    if (m.workspaceId && m.workspaceId.toLowerCase() === rawSub) return true;
                    if (rawSub === 'flash' && m.name.toLowerCase().includes('flash') && !m.name.toLowerCase().includes('lite')) return true;
                    if (rawSub === 'pro' && m.name.toLowerCase().includes('pro')) return true;
                    if (rawSub === 'argon' && m.name.toLowerCase().includes('argon')) return true;
                    if (rawSub === 'latest' && (m.name.toLowerCase().includes('lite') || m.tag === 'Fast')) return true;
                    return false;
                });
            }

            if (!targetModel) {
                var availableNames = availableModels.filter(function (m) { return m.slug !== 'auto'; }).map(function (m) { return m.displayName || m.name || m.slug; });
                throw new Error("Model '" + engine + "' is not available in the current Google account. Currently available models: [" + availableNames.join(', ') + "]. Call 'list_available_models' to view available models and usage instructions.");
            }

            var isReasoningEngine = (targetModel.tag === 'Reasoning' || targetModel.tag === 'Pro' || thinkingCode !== null);
            var workspaceId = (options && options._omitWorkspace) ? null : (targetModel.workspaceId || null);

            if (rawSub === 'latest' && _workspaces.fast && _workspaces.fast.length > 0 && !(options && options._omitWorkspace)) {
                workspaceId = _workspaces.fast[0];
            }

            if (isAuto && _isRetry && !(options && options._omitWorkspace)) {
                var backup = availableModels.find(function (m) { return (m.tag === 'Reasoning' || m.tag === 'Pro') && m.workspaceId !== targetModel.workspaceId; }) ||
                             availableModels.find(function (m) { return m.slug !== 'auto' && m.workspaceId !== targetModel.workspaceId; });
                if (backup && backup.workspaceId) workspaceId = backup.workspaceId;
            }

            var modelId = 1;
            var customIndex11 = 2;
            var modelIdentifier = 1;

            if (workspaceId) {
                var profiles = {
                    '9d8ca3786ebdfbea': { modelId: 3, customIndex11: 2, inner79: 3 },
                    'e6fa609c3fa255c0': { modelId: 3, customIndex11: 2, inner79: 3 },
                    '56fdd199312815e2': { modelId: 1, customIndex11: 2, inner79: 1 },
                    'fbb127bbb056c959': { modelId: 1, customIndex11: 2, inner79: 1 },
                    '797f3d0293f288ad': { modelId: 1, customIndex11: 2, inner79: 1 },
                    '8c46e95b1a07cecc': { modelId: 6, customIndex11: 2, inner79: 6 },
                    '95a4c0abcba24364': { modelId: 8, customIndex11: 2, inner79: 8 }
                };

                var profile = profiles[workspaceId];
                if (!profile) {
                    if (targetModel.tag === 'Fast' || (targetModel.name && targetModel.name.toLowerCase().includes('lite'))) {
                        profile = { modelId: 6, customIndex11: 2, inner79: 6 };
                    } else if (targetModel.tag === 'Reasoning' || (targetModel.name && targetModel.name.toLowerCase().includes('pro'))) {
                        profile = { modelId: 3, customIndex11: 2, inner79: 3 };
                    } else if (targetModel.tag === 'Pro' || (targetModel.name && targetModel.name.toLowerCase().includes('argon'))) {
                        profile = { modelId: 8, customIndex11: 2, inner79: 8 };
                    } else {
                        profile = { modelId: 1, customIndex11: 2, inner79: 1 };
                    }
                }

                modelId = profile.modelId;
                customIndex11 = profile.customIndex11;
                modelIdentifier = profile.inner79;
            }

            console.log('[Proxima API] Query routing - Model:', targetModel.name, 'Workspace:', workspaceId || 'default (no extension)', 'Thinking:', requestedThinkingLevel || 'default', 'ModelId:', modelId);

            var tokens = await _getTokens();
            var reqId = Math.floor(900000 * Math.random()) + 100000;

            var queryParams = new URLSearchParams({
                bl: tokens.bl,
                rt: 'c',
                _reqid: reqId.toString()
            });
            if (typeof window !== 'undefined' && window.WIZ_global_data && window.WIZ_global_data.FdrFJe) {
                queryParams.set('f.sid', window.WIZ_global_data.FdrFJe);
            }

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

            // Clear continuation state if conversation ID is absent
            if (!_conversationId) {
                _responseId = '';
                _choiceId = '';
                _contextToken = '';
                _turnIndex = 0;
            }

            var innerReq = new Array(99).fill(null);
            innerReq[0] = [message, 0, null, attachmentsArray, null, null, 0];
            innerReq[1] = ["en-GB"];
            if (_conversationId) {
                innerReq[2] = [_conversationId, _responseId || "", _choiceId || "", null, null, null, null, null, null, _contextToken || ""];
                if (_contextToken) {
                    innerReq[71] = [_conversationId, null, null, null, null, null, null, _contextToken];
                }
            } else {
                innerReq[2] = null;
            }

            innerReq[6] = [1];
            innerReq[7] = 1;
            innerReq[10] = 1;
            innerReq[11] = 0;
            innerReq[17] = [[_turnIndex || 0]];
            innerReq[18] = 0;
            innerReq[27] = 1;
            innerReq[30] = [4, 16, 19];
            innerReq[41] = [1];
            innerReq[49] = 0;
            innerReq[53] = 0;
            var requestUuid = generateUuid().toUpperCase();
            innerReq[59] = requestUuid;
            innerReq[61] = [];
            innerReq[67] = 0;
            innerReq[68] = 2;
            innerReq[79] = modelIdentifier;
            innerReq[80] = 1;
            innerReq[91] = 1;
            innerReq[96] = (_turnIndex === 0) ? 1 : 0;
            innerReq[98] = 1;

            var body = new URLSearchParams({
                at: tokens.at,
                'f.req': JSON.stringify([null, JSON.stringify(innerReq)])
            });

            var headers = {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1',
                'x-goog-ext-73010989-jspb': '[0]',
                'x-goog-ext-73010990-jspb': '[0,0,0]',
                'x-goog-ext-525005358-jspb': JSON.stringify([requestUuid, 1])
            };

            if (workspaceId) {
                var wkArg = workspaceId;
                headers['x-goog-ext-525001261-jspb'] = JSON.stringify([1, null, null, null, wkArg, null, null, 0, [4, 5, 6, 8, 16, 19, 20, 4, 5, 6, 8, 16, 19, 20], null, null, customIndex11, null, null, modelId, 1, _sessionUuid, [tokens.bl]]);
            }

            var userPrefixMatch = (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname.match(/^(\/u\/\d+)/) : null;
            var userPrefix = userPrefixMatch ? userPrefixMatch[1] : '';
            var url = userPrefix + '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + queryParams;

            var controller = new AbortController();
            _activeController = controller;
            var fetchTimeoutMs = _isRetry ? 30000 : (isReasoningEngine ? 35000 : 25000);
            var timeoutId = setTimeout(function () { controller.abort(); }, fetchTimeoutMs);

            var res;
            try {
                res = await fetch(url, {
                    method: 'POST',
                    credentials: 'include',
                    headers: headers,
                    body: body,
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeoutId);
                _activeController = null;
            }

            if (res.status === 400) {
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
                _activeController = retryController;
                var retryTimeoutId = setTimeout(function () { retryController.abort(); }, TIMEOUT);

                try {
                    res = await fetch(retryUrl, {
                        method: 'POST',
                        credentials: 'include',
                        headers: retryHeaders,
                        body: retryBody,
                        signal: retryController.signal
                    });
                } finally {
                    clearTimeout(retryTimeoutId);
                    _activeController = null;
                }

                if (!res.ok) {
                    if (res.status === 400 && _conversationId) {
                        console.log('[Proxima API] Old conversation ID invalid on current account. Resetting session...');
                        newConversation(sessionId, engine);
                        return await send(message, engine, attachments, sessionId)
                            .then(function (newResult) {
                                var notice = "*[System Notice: Gemini account changed or session expired. Resuming this conversation in a new provider session.]*\n\n";
                                return notice + newResult;
                            });
                    }
                    var err = await res.text().catch(function () { return ''; });
                    throw new Error('Gemini API error (' + res.status + '): ' + err.substring(0, 300));
                }

                var result = await _processStreamResponse(res, isReasoningEngine, _isRetry);
                saveSession(sessionId, engine);
                return result;
            }

            if (!res.ok) {
                var err = await res.text().catch(function () { return ''; });
                throw new Error('Gemini API error (' + res.status + '): ' + err.substring(0, 300));
            }

            var result = await _processStreamResponse(res, isReasoningEngine, _isRetry);
            saveSession(sessionId, engine);
            return result;
        } catch (err) {
            console.error('[Proxima API] Chat processing failed.', err.message);
            // Fallback Policy: Auto mode fallback on failure, or resilient recovery on code 37 / stream abort
            var isCode37 = err.message.indexOf('code 37') !== -1;
            var isStreamAbort = err.message.indexOf('aborted by Google server') !== -1;
            var canFallback = !_isRetry && (isAuto || isCode37 || isStreamAbort);
            if (canFallback) {
                console.warn('[Proxima API] Gemini route failed (' + err.message + '). Bounded fallback...');
                window.__proximaGeminiStream = { response: '', status: 'streaming', updates: [] };
                var retryEngine = isAuto ? 'auto' : engine;
                var baseSess = _sessions[sessionId] || _sessions[_sessionKey(sessionId, engine)];
                if (baseSess && baseSess.conversationId) {
                    _conversationId = baseSess.conversationId;
                    _responseId = baseSess.responseId || '';
                    _choiceId = baseSess.choiceId || '';
                    _contextToken = baseSess.contextToken || '';
                    _turnIndex = baseSess.turnIndex || 0;
                    _sessionUuid = baseSess.sessionUuid || generateUuid().toUpperCase();
                    var fallbackKey = _sessionKey(sessionId, retryEngine);
                    _sessions[fallbackKey] = {
                        conversationId: _conversationId,
                        responseId: _responseId,
                        choiceId: _choiceId,
                        contextToken: _contextToken,
                        turnIndex: _turnIndex,
                        sessionUuid: _sessionUuid
                    };
                }
                try {
                    var retryOptions = Object.assign({}, options);
                    if (isCode37 || isStreamAbort) {
                        retryOptions._omitWorkspace = true;
                    }
                    return await send(message, retryEngine, attachments, sessionId, true, retryOptions);
                } catch (fallbackErr) {
                    if (window.__proximaGeminiStream) {
                        window.__proximaGeminiStream.status = 'error';
                        window.__proximaGeminiStream.error = fallbackErr.message;
                    }
                    console.error('[Proxima API] Resilient fallback also failed:', fallbackErr.message);
                    throw fallbackErr;
                }
            }
            if (window.__proximaGeminiStream) {
                window.__proximaGeminiStream.status = 'error';
                window.__proximaGeminiStream.error = err.message;
            }
            throw err;
        }
    }

    function newConversation(sessionId, engineKey) {
        abortActive();
        var sessionsToDelete = sessionId ? [sessionId] : ['default', 'mcp-session', _currentSessionId].filter(Boolean);
        for (var s = 0; s < sessionsToDelete.length; s++) {
            var sId = sessionsToDelete[s];
            var prefix = sId + '::';
            for (var k in _sessions) {
                if (k === sId || k.indexOf(prefix) === 0) {
                    delete _sessions[k];
                }
            }
            if (engineKey) {
                delete _sessions[_sessionKey(sId, engineKey)];
            }
            delete _sessions[sId];
        }
        _currentSessionId = null;
        _conversationId = '';
        _responseId = '';
        _choiceId = '';
        _contextToken = '';
        _turnIndex = 0;
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
        console.log('[Proxima API] Conversation reset:', sessionId || 'default & mcp');
    }

    window.__proximaGeminiUnified = { send: send, newConversation: newConversation, abort: abortActive, getAvailableModels: getAvailableModels };
    window.__proximaGemini = {
        send: function (msg, engine, attachments, sessionId, maybeForceOrOptions, maybeOptions) {
            var forceFresh = false;
            var options = null;
            if (typeof maybeForceOrOptions === 'boolean') {
                forceFresh = maybeForceOrOptions;
                options = maybeOptions;
            } else if (typeof maybeForceOrOptions === 'object' && maybeForceOrOptions !== null) {
                options = maybeForceOrOptions;
            }
            return send(msg, engine || 'auto', attachments, sessionId, forceFresh, options);
        },
        newConversation: newConversation,
        abort: abortActive,
        uploadFileToGoogle: uploadFileToGoogle,
        getAvailableModels: getAvailableModels
    };

    console.log('[Proxima] Upgraded Unified Multimodal Gemini Engine Loaded');
})();

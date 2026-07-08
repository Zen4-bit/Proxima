// Proxima — Claude Engine.
// Performs SSE message streaming, organization-based session auth, and conversation management.

(function () {
    if (window.__proximaClaude) return;

    var TIMEOUT = 360000;
    let _orgId = null;
    let _convId = null;

    var _currentSessionId = null;
    var _sessions = {};
    try {
        var saved = localStorage.getItem('proxima_claude_sessions');
        if (saved) {
            _sessions = JSON.parse(saved);
            console.log('[Proxima Claude] Restored', Object.keys(_sessions).length, 'sessions from localStorage');
        }
    } catch (e) {
        console.error('[Proxima Claude] Failed to restore sessions:', e);
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
            _sessions[sessionId] = { convId: null };
        }
        var sess = _sessions[sessionId];
        _convId = sess.convId;
        return sess;
    }

    function saveSession(sessionId) {
        if (!sessionId) sessionId = 'default';
        var sess = _sessions[sessionId];
        if (sess) {
            sess.convId = _convId;
        }
        try {
            _pruneSessions();
            localStorage.setItem('proxima_claude_sessions', JSON.stringify(_sessions));
        } catch (e) { }
    }

    async function _getOrgId() {
        if (_orgId) return _orgId;
        const res = await fetch('/api/organizations', { credentials: 'include' });
        if (res.status === 401 || res.status === 403) {
            throw new Error('Not logged in to Claude');
        }
        if (!res.ok) throw new Error('Claude session check failed (' + res.status + ')');
        const orgs = await res.json();
        if (!Array.isArray(orgs) || orgs.length === 0) {
            throw new Error('No Claude organization found');
        }
        _orgId = orgs[0].uuid;
        return _orgId;
    }

    async function _createConversation(orgId, promptPreview) {
        const res = await fetch('/api/organizations/' + orgId + '/chat_conversations', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: (promptPreview || 'proxima').substring(0, 50).replace(/\n/g, ' ').trim(),
                project_uuid: null,
                is_starred: false
            })
        });
        if (!res.ok) {
            if (res.status === 401 || res.status === 403) {
                _orgId = null;
                throw new Error('Claude auth error (' + res.status + ')');
            }
            const errBody = await res.text().catch(function () { return ''; });
            throw new Error('Conv create failed (' + res.status + '): ' + errBody.substring(0, 200));
        }
        const data = await res.json();
        return data.uuid;
    }

    async function _parseStream(response) {
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
                    if (!data) continue;

                    try {
                        var parsed = JSON.parse(data);
                        if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.type === 'text_delta') {
                            fullText += parsed.delta.text;
                        }
                        if (parsed.completion) {
                            fullText += parsed.completion;
                        }
                    } catch (e) { }
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (e) { }
        }
        return fullText;
    }

    async function uploadFileToClaude(fileBase64, filename, mimeType) {
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

        var orgId = await _getOrgId();
        if (!_convId) {
            _convId = await _createConversation(orgId, 'Upload: ' + filename);
        }

        var formData = new FormData();
        formData.append('file', new Blob([bytes], { type: mimeType }), filename);

        var res = await fetch('/api/organizations/' + orgId + '/conversations/' + _convId + '/wiggle/upload-file', {
            method: 'POST',
            credentials: 'include',
            body: formData
        });

        if (!res.ok) {
            var errText = await res.text().catch(function () { return ''; });
            throw new Error('Claude file upload failed (' + res.status + '): ' + errText);
        }

        var data = await res.json();
        if (!data.success || !data.file_uuid) {
            throw new Error('Claude file upload failed: No file uuid returned');
        }

        return data.file_uuid;
    }

    async function send(message, engine, attachments, sessionId) {
        activateSession(sessionId);

        var orgId = await _getOrgId();

        if (!_convId) {
            _convId = await _createConversation(orgId, message);
            console.log('[Proxima Claude] Created new conversation:', _convId);
        } else {
            console.log('[Proxima Claude] Continuing conversation:', _convId);
        }

        try {
            var controller = new AbortController();
            var timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT);

            var res = await fetch('/api/organizations/' + orgId + '/chat_conversations/' + _convId + '/completion', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify({
                    prompt: message,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                    attachments: [],
                    files: (attachments && attachments.imageToken) ? [attachments.imageToken] : []
                }),
                signal: controller.signal
            });

            if (!res.ok) {
                clearTimeout(timeoutId);
                var errBody = await res.text().catch(function () { return ''; });

                // Reset session mapping if conversation is deleted/expired on the server.
                if (res.status === 404 || res.status === 410) {
                    console.log('[Proxima Claude] Conversation expired, creating new one...');
                    _convId = await _createConversation(orgId, message);

                    var retryController = new AbortController();
                    var retryTimeoutId = setTimeout(function () { retryController.abort(); }, TIMEOUT);

                    res = await fetch('/api/organizations/' + orgId + '/chat_conversations/' + _convId + '/completion', {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream'
                        },
                        body: JSON.stringify({
                            prompt: message,
                            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                            attachments: [],
                            files: (attachments && attachments.imageToken) ? [attachments.imageToken] : []
                        }),
                        signal: retryController.signal
                    });

                    if (!res.ok) {
                        clearTimeout(retryTimeoutId);
                        throw new Error('Claude completion failed on retry (' + res.status + ')');
                    }

                    var result;
                    try { result = await _parseStream(res); }
                    finally { clearTimeout(retryTimeoutId); }
                    saveSession(sessionId);
                    return result;
                }

                if (res.status === 429) throw new Error('Claude rate limited');
                throw new Error('Claude completion failed (' + res.status + '): ' + errBody.substring(0, 200));
            }

            var result;
            try { result = await _parseStream(res); }
            finally { clearTimeout(timeoutId); }
            saveSession(sessionId);
            return result;
        } catch (e) {
            if (e.message && (e.message.includes('404') || e.message.includes('410'))) {
                _convId = null;
            }
            throw e;
        }
    }

    function newConversation(sessionId) {
        if (sessionId) {
            delete _sessions[sessionId];
        } else if (_currentSessionId) {
            delete _sessions[_currentSessionId];
        }
        _convId = null;
        _currentSessionId = null;
        try {
            localStorage.setItem('proxima_claude_sessions', JSON.stringify(_sessions));
        } catch (e) { }
        console.log('[Proxima Claude] Conversation reset:', sessionId || 'current');
    }

    window.__proximaClaude = { send: send, newConversation: newConversation, uploadFileToClaude: uploadFileToClaude };
    console.log('[Proxima] Claude engine loaded');
})();

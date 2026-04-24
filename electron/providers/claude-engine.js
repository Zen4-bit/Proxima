/**
 * Proxima — Claude Engine v4.1.0
 * Runs inside claude.ai BrowserView context. Uses org-based session auth,
 * creates persistent conversations, and streams responses via SSE.
 */
(function() {
    if (window.__proximaClaude) return;

    const CLAUDE_BASE = 'https://claude.ai';
    var TIMEOUT = 360000;
    let _orgId = null;
    let _convId = null;

    // --- Organization Management ---
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

    // ─── Conversation ────────────────────────────────
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
            const errBody = await res.text().catch(function() { return ''; });
            throw new Error('Conv create failed (' + res.status + '): ' + errBody.substring(0, 200));
        }
        const data = await res.json();
        return data.uuid;
    }

    // ─── SSE Stream Parser ──────────────────────────
    async function _parseStream(response) {
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var fullText = '';
        var buffer = '';

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
                } catch(e) {}
            }
        }

        reader.releaseLock();
        return fullText;
    }

    // ─── Send Message ───────────────────────────────
    async function send(message) {
        var orgId = await _getOrgId();

        // Reuse existing conversation or create new one
        if (!_convId) {
            _convId = await _createConversation(orgId, message);
            console.log('[Proxima Claude] Created new conversation:', _convId);
        } else {
            console.log('[Proxima Claude] Continuing conversation:', _convId);
        }

        try {
            var controller = new AbortController();
            var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT);

            var res = await fetch('/api/organizations/' + orgId + '/chat_conversations/' + _convId + '/completion', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream'
                },
                body: JSON.stringify({
                    prompt: message,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
                    attachments: [],
                    files: []
                }),
                signal: controller.signal
            });

            if (!res.ok) {
                clearTimeout(timeoutId);
                var errBody = await res.text().catch(function() { return ''; });

                // Conversation expired or deleted — create new and retry
                if (res.status === 404 || res.status === 410) {
                    console.log('[Proxima Claude] Conversation expired, creating new one...');
                    _convId = await _createConversation(orgId, message);

                    var retryController = new AbortController();
                    var retryTimeoutId = setTimeout(function() { retryController.abort(); }, TIMEOUT);

                    res = await fetch('/api/organizations/' + orgId + '/chat_conversations/' + _convId + '/completion', {
                        method: 'POST',
                        credentials: 'include',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'text/event-stream'
                        },
                        body: JSON.stringify({
                            prompt: message,
                            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
                            attachments: [],
                            files: []
                        }),
                        signal: retryController.signal
                    });

                    if (!res.ok) {
                        clearTimeout(retryTimeoutId);
                        throw new Error('Claude completion failed on retry (' + res.status + ')');
                    }

                    var result = await _parseStream(res);
                    clearTimeout(retryTimeoutId);
                    return result;
                }

                if (res.status === 429) throw new Error('Claude rate limited');
                throw new Error('Claude completion failed (' + res.status + '): ' + errBody.substring(0, 200));
            }

            var result = await _parseStream(res);
            clearTimeout(timeoutId);
            return result;
        } catch(e) {
            // Reset on conversation-related errors so next call creates fresh
            if (e.message && (e.message.includes('404') || e.message.includes('410'))) {
                _convId = null;
            }
            throw e;
        }
    }


    function newConversation() {
        _convId = null;
        console.log('[Proxima Claude] Conversation reset');
    }

    window.__proximaClaude = { send: send, newConversation: newConversation };
    console.log('[Proxima] Claude engine loaded');
})();

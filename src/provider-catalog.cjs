const DEFAULT_CHROME_VERSION = '130.0.6723.191';
const DEFAULT_BROWSER_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${DEFAULT_CHROME_VERSION} Safari/537.36`;

const providerRuntimeConfig = {
    perplexity: {
        loginCheckScript: `
            (function() {
                const buttons = Array.from(document.querySelectorAll('button, a'));
                const hasLoginBtn = buttons.some(b => b.innerText === 'Log in' || b.innerText === 'Sign Up');
                if (hasLoginBtn) return false;
                const hasInput = !!document.querySelector('textarea') || !!document.querySelector('[contenteditable="true"]');
                return !hasLoginBtn && hasInput;
            })()
        `,
        interceptor: {
            name: 'Perplexity',
            urlPatterns: `url.includes('/api/query') || url.includes('/api/search') || url.includes('/socket.io') || (url.includes('perplexity') && method === 'POST')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('text/plain')`,
            parser: `
                // Perplexity SSE format: data: {text: "...", answer: "..."} or chunks
                if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                    try {
                        var data = JSON.parse(line.slice(6));
                        if (data.text) {
                            fullText = data.text;
                        }
                        if (data.answer) {
                            fullText = data.answer;
                        }
                        if (data.output) {
                            fullText = data.output;
                        }
                        if (data.chunks && Array.isArray(data.chunks)) {
                            fullText = data.chunks.join('');
                        }
                    } catch(e) {
                        var rawData = line.slice(6).trim();
                        if (rawData && rawData !== '[DONE]' && rawData.length > 10) {
                            fullText += rawData;
                        }
                    }
                }
            `
        }
    },
    chatgpt: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('#prompt-textarea');
                const hasLoginModal = !!document.querySelector('[data-testid="login-button"]');
                return hasInput && !hasLoginModal;
            })()
        `,
        interceptor: {
            name: 'ChatGPT',
            urlPatterns: `url.includes('/backend-api/conversation') || url.includes('/backend-api/f/conversation')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream')`,
            parser: `
                // ChatGPT SSE format: data: {message: {content: {parts: ["text"]}}}
                if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.message && data.message.content && data.message.content.parts) {
                            var newText = data.message.content.parts.join('');
                            if (newText.length > fullText.length) {
                                fullText = newText;
                            }
                        }
                        if (data.v && data.v === 'text' && data.d) {
                            fullText += data.d;
                        }
                    } catch(e) {}
                }
            `
        }
    },
    claude: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('[contenteditable="true"]');
                const hasLoginPage = window.location.href.includes('/login');
                return hasInput && !hasLoginPage;
            })()
        `,
        interceptor: {
            name: 'Claude',
            urlPatterns: `url.includes('/chat_conversations') || url.includes('/completion') || url.includes('/messages') || url.includes('/chat') || url.includes('/api/') || url.includes('/retry_completion') || url.includes('/organizations') || url.includes('/v1/') || (url.includes('claude') && method === 'POST')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('text/plain')`,
            parser: `
                // Claude SSE format: data: {type: "content_block_delta", delta: {text: "..."}}
                // Claude sends MULTIPLE content blocks (thinking + response) - track separately
                if (!window.__proxima_blocks) window.__proxima_blocks = {};
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (data.type === 'content_block_start' && data.index !== undefined) {
                            window.__proxima_blocks[data.index] = '';
                        }

                        if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
                            var blockIdx = data.index !== undefined ? data.index : 0;
                            if (!window.__proxima_blocks[blockIdx]) window.__proxima_blocks[blockIdx] = '';
                            window.__proxima_blocks[blockIdx] += data.delta.text;
                            var bestBlock = '';
                            for (var bk in window.__proxima_blocks) {
                                if (window.__proxima_blocks[bk].length > bestBlock.length) {
                                    bestBlock = window.__proxima_blocks[bk];
                                }
                            }
                            fullText = bestBlock;
                        }
                        if (data.completion) {
                            fullText += data.completion;
                        }
                        if (data.type === 'message_stop') {
                            window.__proxima_blocks = {};
                            window.__proxima_is_streaming = false;
                            window.__proxima_last_capture_time = Date.now();
                        }
                    } catch(e) {}
                }
            `
        }
    },
    gemini: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('.ql-editor') ||
                               !!document.querySelector('[contenteditable="true"]') ||
                               !!document.querySelector('rich-textarea');
                const hasSignIn = !!document.querySelector('a[href*="ServiceLogin"]') ||
                                !!document.querySelector('a[data-action-id="sign-in"]');
                return hasInput && !hasSignIn;
            })()
        `,
        interceptor: {
            name: 'Gemini',
            urlPatterns: `url.includes('BimAJc') || url.includes('generate') || url.includes('stream') || url.includes('_/WizAO') || (url.includes('gemini') && method === 'POST')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('application/json') || contentType.includes('text/plain')`,
            parser: `
                // Gemini format: JSON array responses or streaming text
                if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                    try {
                        var data = JSON.parse(line.slice(6));
                        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
                            var parts = data.candidates[0].content.parts || [];
                            for (var p = 0; p < parts.length; p++) {
                                if (parts[p].text) fullText += parts[p].text;
                            }
                        }
                        if (data.text) fullText = data.text;
                        if (data.modelOutput) fullText = data.modelOutput;
                    } catch(e) {
                        var raw = line.trim();
                        if (raw.startsWith('[')) {
                            try {
                                var arr = JSON.parse(raw);
                                var findText = function(obj) {
                                    if (typeof obj === 'string' && obj.length > 20) return obj;
                                    if (Array.isArray(obj)) {
                                        for (var i = 0; i < obj.length; i++) {
                                            var found = findText(obj[i]);
                                            if (found) return found;
                                        }
                                    }
                                    return null;
                                };
                                var found = findText(arr);
                                if (found && found.length > fullText.length) fullText = found;
                            } catch(e2) {}
                        }
                    }
                } else if (!line.startsWith('data:') && line.trim().length > 50) {
                    try {
                        var raw2 = JSON.parse(line.trim());
                        if (raw2 && typeof raw2 === 'object') {
                            var jsonStr = JSON.stringify(raw2);
                            if (jsonStr.length > fullText.length) {
                                var textMatch = jsonStr.match(/"text":"([^"]+)"/g);
                                if (textMatch) {
                                    var combined = textMatch.map(function(m) { return m.replace(/"text":"|"/g, ''); }).join('');
                                    if (combined.length > fullText.length) fullText = combined;
                                }
                            }
                        }
                    } catch(e3) {}
                }
            `
        }
    },
    googleai: {
        loginCheckScript: `
            (function() {
                const hasComposer = !!document.querySelector('textarea.ITIRGe') ||
                    !!document.querySelector('[data-active="input-plate-active"] textarea') ||
                    !!document.querySelector('button[data-xid="input-plate-send-button"]');
                const hasAuthGate = !!document.querySelector('a[href*="ServiceLogin"]') ||
                    !!document.querySelector('form[action*="ServiceLogin"]') ||
                    !!document.querySelector('iframe[src*="accounts.google.com"]');
                return hasComposer && !hasAuthGate;
            })()
        `,
        interceptor: {
            name: 'GoogleAI',
            urlPatterns: `url.includes('/wizrpcui/_/WizRpcUi/data/batchexecute') || url.includes('/async/folif') || url.includes('/httpservice/web/AimThreadsService')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('application/json') || contentType.includes('text/plain') || contentType.includes('text/html')`,
            parser: `
                var appendGoogleAiText = function(value) {
                    if (!value) return;

                    if (typeof value === 'string') {
                        var cleaned = value
                            .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
                            .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/\\\\u003c/g, '<')
                            .replace(/\\\\u003e/g, '>')
                            .replace(/\\\\u0026/g, '&')
                            .replace(/\\s+/g, ' ')
                            .trim();

                        if (!cleaned || /^https?:\\/\\//i.test(cleaned)) {
                            return;
                        }

                        if (cleaned.length > 120 && cleaned.length > fullText.length) {
                            fullText = cleaned;
                            return;
                        }

                        if (cleaned.length > 40 && !fullText.includes(cleaned)) {
                            fullText += (fullText ? ' ' : '') + cleaned;
                        }
                        return;
                    }

                    if (Array.isArray(value)) {
                        for (var ai = 0; ai < value.length; ai++) {
                            appendGoogleAiText(value[ai]);
                        }
                        return;
                    }

                    if (typeof value !== 'object') {
                        return;
                    }

                    var preferredKeys = ['text', 'answer', 'output', 'content', 'message', 'modelOutput', 'html'];
                    for (var pk = 0; pk < preferredKeys.length; pk++) {
                        if (value[preferredKeys[pk]] !== undefined) {
                            appendGoogleAiText(value[preferredKeys[pk]]);
                        }
                    }

                    for (var key in value) {
                        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
                        if (preferredKeys.indexOf(key) !== -1) continue;
                        appendGoogleAiText(value[key]);
                    }
                };

                var rawLine = line.startsWith('data: ') ? line.slice(6).trim() : line.trim();
                if (!rawLine || rawLine === '[DONE]') {
                    return;
                }

                try {
                    appendGoogleAiText(JSON.parse(rawLine));
                } catch (e) {
                    appendGoogleAiText(rawLine);
                }
            `
        }
    },
    deepseek: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('textarea') ||
                    !!document.querySelector('[contenteditable="true"]') ||
                    !!document.querySelector('[role="textbox"]');
                const authCtas = Array.from(document.querySelectorAll('button, a'))
                    .map((el) => (el.innerText || el.textContent || '').trim())
                    .filter(Boolean);
                const hasAuthPrompt = authCtas.some((text) => /log\\s*in|sign\\s*in|sign\\s*up/i.test(text));
                const onAuthRoute = /login|signin|signup/i.test(window.location.pathname + window.location.href);
                return hasInput && !hasAuthPrompt && !onAuthRoute;
            })()
        `,
        interceptor: {
            name: 'DeepSeek',
            urlPatterns: `url.includes('/api/v0/chat/completion') || url.includes('/api/v0/chat/continue') || (url.includes('/api/v0/chat/') && method === 'POST')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('application/json') || contentType.includes('text/plain')`,
            parser: `
                var extractDeepSeekText = function(payload) {
                    if (!payload) return '';
                    if (typeof payload === 'string') return payload;
                    if (Array.isArray(payload)) {
                        var joined = '';
                        for (var ai = 0; ai < payload.length; ai++) {
                            joined += extractDeepSeekText(payload[ai]);
                        }
                        return joined;
                    }
                    if (typeof payload !== 'object') return '';

                    if (payload.choices && Array.isArray(payload.choices) && payload.choices.length > 0) {
                        return extractDeepSeekText(payload.choices[0]);
                    }
                    if (payload.delta) return extractDeepSeekText(payload.delta);
                    if (payload.message) return extractDeepSeekText(payload.message);
                    if (payload.data) return extractDeepSeekText(payload.data);

                    var parts = [];
                    var directKeys = ['reasoning_content', 'thinking_content', 'content', 'text', 'answer', 'output'];
                    for (var dk = 0; dk < directKeys.length; dk++) {
                        var directValue = payload[directKeys[dk]];
                        if (typeof directValue === 'string') {
                            parts.push(directValue);
                        } else if (Array.isArray(directValue)) {
                            parts.push(extractDeepSeekText(directValue));
                        }
                    }

                    if (parts.length > 0) {
                        return parts.join('');
                    }

                    return '';
                };

                var applyDeepSeekPayload = function(payload) {
                    var textValue = extractDeepSeekText(payload);
                    if (!textValue) return;

                    var isDeltaPayload =
                        !!payload.delta ||
                        (payload.choices && payload.choices[0] && payload.choices[0].delta) ||
                        typeof payload.text === 'string' ||
                        typeof payload.content === 'string' ||
                        typeof payload.reasoning_content === 'string' ||
                        typeof payload.thinking_content === 'string';

                    if (isDeltaPayload) {
                        fullText += textValue;
                    } else if (textValue.length > fullText.length) {
                        fullText = textValue;
                    }
                };

                if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                    try {
                        var data = JSON.parse(line.slice(6));
                        applyDeepSeekPayload(data);
                    } catch (e) {}
                } else if (!line.startsWith('data:') && line.trim().length > 0) {
                    try {
                        var rawData = JSON.parse(line.trim());
                        applyDeepSeekPayload(rawData);
                    } catch (e2) {}
                }
            `
        }
    },
    grok: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('textarea') ||
                    !!document.querySelector('[contenteditable="true"]') ||
                    !!document.querySelector('[role="textbox"]');
                const authCtas = Array.from(document.querySelectorAll('button, a'))
                    .map((el) => (el.innerText || el.textContent || '').trim())
                    .filter(Boolean);
                const hasAuthPrompt = authCtas.some((text) => /log\\s*in|sign\\s*in|sign\\s*up/i.test(text));
                const onAuthRoute = /login|signin|signup/i.test(window.location.pathname + window.location.href);
                return hasInput && !hasAuthPrompt && !onAuthRoute;
            })()
        `
    },
    zai: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('textarea[placeholder*="Send a Message"]') ||
                    !!document.querySelector('textarea[placeholder*="help"]') ||
                    !!document.querySelector('textarea');
                const onAuthRoute = /login|signin|signup|auth/i.test(window.location.pathname + window.location.href);
                return hasInput && !onAuthRoute;
            })()
        `,
        interceptor: {
            name: 'ZAI',
            urlPatterns: `url.includes('/api/v2/chat/completions') || url.includes('/api/v1/chats/new') || (url.includes('chat.z.ai/api/') && method === 'POST')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('application/json') || contentType.includes('text/plain')`,
            parser: `
                var extractZAIText = function(payload) {
                    if (!payload) return '';
                    if (typeof payload === 'string') return payload;
                    if (Array.isArray(payload)) {
                        var combined = '';
                        for (var i = 0; i < payload.length; i++) {
                            combined += extractZAIText(payload[i]);
                        }
                        return combined;
                    }
                    if (typeof payload !== 'object') return '';

                    if (payload.choices && Array.isArray(payload.choices)) {
                        return extractZAIText(payload.choices[0]);
                    }
                    if (payload.delta) return extractZAIText(payload.delta);
                    if (payload.message) return extractZAIText(payload.message);
                    if (payload.data) return extractZAIText(payload.data);

                    var parts = [];
                    var directKeys = ['content', 'text', 'answer', 'output'];
                    for (var dk = 0; dk < directKeys.length; dk++) {
                        var value = payload[directKeys[dk]];
                        if (typeof value === 'string') {
                            parts.push(value);
                        } else if (Array.isArray(value)) {
                            parts.push(extractZAIText(value));
                        }
                    }

                    return parts.join('');
                };

                var applyZAIPayload = function(payload) {
                    var textValue = extractZAIText(payload);
                    if (!textValue) return;

                    var isDeltaPayload =
                        !!payload.delta ||
                        (payload.choices && payload.choices[0] && payload.choices[0].delta) ||
                        typeof payload.text === 'string' ||
                        typeof payload.content === 'string';

                    if (isDeltaPayload) {
                        fullText += textValue;
                    } else if (textValue.length > fullText.length) {
                        fullText = textValue;
                    }
                };

                if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                    try {
                        var data = JSON.parse(line.slice(6));
                        applyZAIPayload(data);
                    } catch (e) {}
                } else if (!line.startsWith('data:') && line.trim().length > 0) {
                    try {
                        var rawData = JSON.parse(line.trim());
                        applyZAIPayload(rawData);
                    } catch (e2) {}
                }
            `
        }
    },
    copilot: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('textarea[data-testid="composer-input"]') ||
                    !!document.querySelector('textarea[placeholder*="Copilot"]') ||
                    !!document.querySelector('textarea');
                const onAuthRoute = /login\\.live\\.com|oauth|signin|login/i.test(window.location.href);
                return hasInput && !onAuthRoute;
            })()
        `
    },
    metaai: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('[role="textbox"][contenteditable="true"]') ||
                    !!document.querySelector('[contenteditable="true"]') ||
                    !!document.querySelector('input[placeholder*="Meta AI"]') ||
                    !!document.querySelector('input[type="text"]');
                const authCtas = Array.from(document.querySelectorAll('button, a'))
                    .map((el) => (el.innerText || el.textContent || '').trim())
                    .filter(Boolean);
                const hasAuthPrompt = authCtas.some((text) => /log\\s*in|sign\\s*up|create an account/i.test(text));
                const onAuthRoute = /auth\\.meta\\.com|facebook\\.com\\/login|signin|signup|login/i.test(window.location.href);
                return hasInput && !hasAuthPrompt && !onAuthRoute;
            })()
        `
    },
    qwen: {
        loginCheckScript: `
            (function() {
                const hasInput = !!document.querySelector('textarea.message-input-textarea') ||
                    !!document.querySelector('textarea[placeholder*="help you today"]') ||
                    !!document.querySelector('textarea') ||
                    !!document.querySelector('[contenteditable="true"]');
                const hasLoggedInMenu = !!document.querySelector('.user-menu-btn') ||
                    !!document.querySelector('button[aria-label*="User profile"]');
                const authCtas = Array.from(document.querySelectorAll('button, a, [role="button"], div'))
                    .map((el) => (el.innerText || el.textContent || '').trim())
                    .filter((text) => text.length > 0 && text.length < 40);
                const hasAuthPrompt = authCtas.some((text) => /log\\s*in|sign\\s*up/i.test(text));
                const onAuthRoute = /\\/auth|login|signin|signup|oauth/i.test(window.location.pathname + window.location.href);
                return hasInput && (hasLoggedInMenu || (!hasAuthPrompt && !onAuthRoute));
            })()
        `,
        interceptor: {
            name: 'Qwen',
            urlPatterns: `url.includes('/api/v2/chat/completions') || url.includes('/api/v2/chats/new') || (url.includes('chat.qwen.ai/api/') && method === 'POST')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('application/json') || contentType.includes('text/plain')`,
            parser: `
                var extractQwenText = function(payload) {
                    if (!payload) return '';
                    if (typeof payload === 'string') return payload;
                    if (Array.isArray(payload)) {
                        var combined = '';
                        for (var i = 0; i < payload.length; i++) {
                            combined += extractQwenText(payload[i]);
                        }
                        return combined;
                    }
                    if (typeof payload !== 'object') return '';

                    if (payload.choices && Array.isArray(payload.choices) && payload.choices.length > 0) {
                        return extractQwenText(payload.choices[0]);
                    }
                    if (payload.delta) return extractQwenText(payload.delta);
                    if (payload.message) return extractQwenText(payload.message);
                    if (payload.data) return extractQwenText(payload.data);

                    var parts = [];
                    var directKeys = ['reasoning_content', 'thinking_content', 'content', 'text', 'answer', 'output'];
                    for (var dk = 0; dk < directKeys.length; dk++) {
                        var value = payload[directKeys[dk]];
                        if (typeof value === 'string') {
                            parts.push(value);
                        } else if (Array.isArray(value)) {
                            parts.push(extractQwenText(value));
                        }
                    }

                    return parts.join('');
                };

                var applyQwenPayload = function(payload) {
                    var textValue = extractQwenText(payload);
                    if (!textValue) return;

                    var isDeltaPayload =
                        !!payload.delta ||
                        (payload.choices && payload.choices[0] && payload.choices[0].delta) ||
                        typeof payload.text === 'string' ||
                        typeof payload.content === 'string' ||
                        typeof payload.reasoning_content === 'string' ||
                        typeof payload.thinking_content === 'string';

                    if (isDeltaPayload) {
                        fullText += textValue;
                    } else if (textValue.length > fullText.length) {
                        fullText = textValue;
                    }
                };

                if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                    try {
                        var data = JSON.parse(line.slice(6));
                        applyQwenPayload(data);
                    } catch (e) {}
                } else if (!line.startsWith('data:') && line.trim().length > 0) {
                    try {
                        var rawData = JSON.parse(line.trim());
                        applyQwenPayload(rawData);
                    } catch (e2) {}
                }
            `
        }
    }
};

const providers = [
    {
        id: 'perplexity',
        label: 'Perplexity',
        defaultEnabled: true,
        url: 'https://www.perplexity.ai/',
        systemBrowserUrl: 'https://www.perplexity.ai/',
        partition: 'persist:perplexity',
        color: '#20b2aa',
        icon: '../assets/perplexity.png',
        cookieDomain: 'perplexity.ai',
        authCompletionDomains: ['perplexity.ai'],
        aliases: ['perplexity', 'pplx', 'sonar'],
        defaultQueryAction: 'search',
        ...providerRuntimeConfig.perplexity
    },
    {
        id: 'chatgpt',
        label: 'ChatGPT',
        defaultEnabled: true,
        url: 'https://chatgpt.com/',
        systemBrowserUrl: 'https://chatgpt.com/',
        partition: 'persist:chatgpt',
        color: '#10a37f',
        icon: '../assets/chatgpt.png',
        cookieDomain: 'openai.com',
        authCompletionDomains: ['chatgpt.com', 'openai.com'],
        aliases: ['chatgpt', 'gpt', 'gpt-4', 'gpt-4o', 'gpt-4.5', 'openai'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.chatgpt
    },
    {
        id: 'claude',
        label: 'Claude',
        defaultEnabled: false,
        url: 'https://claude.ai/',
        systemBrowserUrl: 'https://claude.ai/',
        partition: 'persist:claude',
        color: '#cc785c',
        icon: '../assets/claude.svg',
        cookieDomain: 'claude.ai',
        authCompletionDomains: ['claude.ai'],
        aliases: ['claude', 'claude-3', 'claude-3.5', 'claude-4', 'anthropic', 'sonnet', 'opus', 'haiku'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.claude
    },
    {
        id: 'gemini',
        label: 'Gemini',
        defaultEnabled: true,
        url: 'https://gemini.google.com/app',
        systemBrowserUrl: 'https://gemini.google.com/',
        partition: 'persist:gemini',
        color: '#4285f4',
        icon: '../assets/gemini.png',
        cookieDomain: 'google.com',
        authCompletionDomains: ['gemini.google.com'],
        aliases: ['gemini', 'gemini-pro', 'gemini-2', 'gemini-2.5', 'google', 'bard'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.gemini
    },
    {
        id: 'googleai',
        label: 'Google AI',
        defaultEnabled: false,
        url: 'https://www.google.com/search?sclient=gws-wiz&udm=50&arv=1&aep=1&ntc=1',
        systemBrowserUrl: 'https://www.google.com/',
        partition: 'persist:googleai',
        color: '#4285f4',
        icon: '../assets/gemini.png',
        cookieDomain: 'google.com',
        authCompletionDomains: ['www.google.com', 'google.com', 'accounts.google.com'],
        aliases: ['googleai', 'google ai', 'google ai mode', 'google-ai', 'aimode'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.googleai
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        defaultEnabled: false,
        url: 'https://chat.deepseek.com/',
        systemBrowserUrl: 'https://chat.deepseek.com/',
        partition: 'persist:deepseek',
        color: '#4f6bff',
        icon: '../assets/deepseek.png',
        cookieDomain: 'deepseek.com',
        authCompletionDomains: ['chat.deepseek.com', 'deepseek.com'],
        aliases: ['deepseek', 'deepseek-chat', 'deepseek-r1', 'r1'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.deepseek
    },
    {
        id: 'grok',
        label: 'Grok',
        defaultEnabled: false,
        url: 'https://grok.com/',
        systemBrowserUrl: 'https://grok.com/',
        partition: 'persist:grok',
        color: '#111827',
        icon: '../assets/grok.png',
        cookieDomain: 'grok.com',
        authCompletionDomains: ['grok.com', 'x.ai', 'x.com'],
        aliases: ['grok', 'grok-3', 'xai', 'x.ai'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.grok
    },
    {
        id: 'zai',
        label: 'Z.ai',
        defaultEnabled: false,
        url: 'https://chat.z.ai/',
        systemBrowserUrl: 'https://chat.z.ai/',
        partition: 'persist:zai',
        color: '#2563eb',
        icon: '../assets/zai.svg',
        cookieDomain: 'z.ai',
        authCompletionDomains: ['chat.z.ai', 'z.ai'],
        aliases: ['zai', 'z.ai', 'z ai', 'z-ai', 'glm', 'glm-5', 'glm-5.1'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.zai
    },
    {
        id: 'copilot',
        label: 'Copilot',
        defaultEnabled: false,
        url: 'https://copilot.microsoft.com/',
        systemBrowserUrl: 'https://copilot.microsoft.com/',
        partition: 'persist:copilot',
        color: '#2563eb',
        icon: '../assets/copilot.svg',
        cookieDomain: 'copilot.microsoft.com',
        authCompletionDomains: ['copilot.microsoft.com', 'microsoft.com'],
        aliases: ['copilot', 'microsoft copilot', 'ms copilot'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.copilot
    },
    {
        id: 'metaai',
        label: 'Meta AI',
        defaultEnabled: false,
        url: 'https://meta.ai/',
        systemBrowserUrl: 'https://meta.ai/',
        partition: 'persist:metaai',
        color: '#2563eb',
        icon: '../assets/metaai.png',
        cookieDomain: 'meta.ai',
        authCompletionDomains: ['meta.ai', 'auth.meta.com', 'facebook.com'],
        aliases: ['metaai', 'meta ai', 'meta.ai'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.metaai
    },
    {
        id: 'qwen',
        label: 'Qwen',
        defaultEnabled: false,
        url: 'https://chat.qwen.ai/',
        systemBrowserUrl: 'https://chat.qwen.ai/',
        partition: 'persist:qwen',
        color: '#5b6cff',
        icon: '../assets/qwen.svg',
        cookieDomain: 'qwen.ai',
        authCompletionDomains: ['chat.qwen.ai', 'qwen.ai'],
        aliases: ['qwen', 'qwen-chat', 'qwen3', 'qwen-max', 'qwen studio'],
        defaultQueryAction: 'chat',
        ...providerRuntimeConfig.qwen
    }
];

const publicProviderCatalog = providers.map(({ interceptor, loginCheckScript, ...provider }) => ({
    ...provider
}));

const providerIds = providers.map((provider) => provider.id);

const providerMap = Object.fromEntries(
    providers.map((provider) => [provider.id, provider])
);

const defaultProviderSettings = Object.fromEntries(
    providers.map((provider) => [
        provider.id,
        { enabled: provider.defaultEnabled, loggedIn: false }
    ])
);

const defaultEnabledProviderIds = providers
    .filter((provider) => provider.defaultEnabled)
    .map((provider) => provider.id);

const modelAliases = Object.fromEntries(
    providers.flatMap((provider) =>
        (provider.aliases || []).map((alias) => [String(alias).toLowerCase(), provider.id])
    )
);

const smartRouterOrder = ['chatgpt', 'claude', 'perplexity', 'gemini', 'googleai', 'deepseek', 'grok', 'zai', 'copilot', 'metaai', 'qwen'];
const restAutoOrder = ['claude', 'chatgpt', 'gemini', 'googleai', 'perplexity', 'deepseek', 'grok', 'zai', 'copilot', 'metaai', 'qwen'];

function getChromeVersionFromUserAgent(userAgent = DEFAULT_BROWSER_USER_AGENT) {
    const match = String(userAgent || '').match(/Chrome\/([\d.]+)/i);
    return match?.[1] || DEFAULT_CHROME_VERSION;
}

function getChromeMajorVersionFromUserAgent(userAgent = DEFAULT_BROWSER_USER_AGENT) {
    return getChromeVersionFromUserAgent(userAgent).split('.')[0] || DEFAULT_CHROME_VERSION.split('.')[0];
}

function getProviderLabel(providerId) {
    return providerMap[providerId]?.label || providerId;
}

function getDefaultQueryAction(providerId) {
    return providerMap[providerId]?.defaultQueryAction || 'chat';
}

function getProviderLoginCheckScript(providerId) {
    return providerMap[providerId]?.loginCheckScript || null;
}

function buildProviderInterceptorScript(providerId) {
    const config = providerMap[providerId]?.interceptor;
    if (!config) return null;

    return `
        (function() {
            if (window.__proxima_fetch_intercepted) return;
            window.__proxima_fetch_intercepted = true;
            window.__proxima_captured_response = '';
            window.__proxima_is_streaming = false;
            window.__proxima_last_capture_time = 0;

            var originalFetch = window.fetch;
            window.fetch = async function() {
                var args = arguments;
                var response = await originalFetch.apply(this, args);
                var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
                var method = (args[1] && args[1].method) ? args[1].method : 'GET';

                try {
                    if (method === 'POST') {
                        console.error('[brAInstorm] ${config.name} POST:', url.substring(0, 120));
                    }
                    if (${config.urlPatterns}) {
                        var contentType = response.headers.get('content-type') || '';

                        if (${config.streamTypes}) {
                            var cloned = response.clone();
                            var reader = cloned.body.getReader();
                            var decoder = new TextDecoder();

                            var streamId = Date.now() + '_' + Math.random().toString(36).slice(2);
                            window.__proxima_active_stream_id = streamId;
                            if ('${config.name}' !== 'Claude') { window.__proxima_captured_response = ''; }
                            window.__proxima_is_streaming = true;
                            window.__proxima_last_capture_time = Date.now();
                            var fullText = ('${config.name}' === 'Claude') ? (window.__proxima_captured_response || '') : '';

                            (async function() {
                                try {
                                    while (true) {
                                        var result = await reader.read();
                                        if (result.done) break;

                                        var chunk = decoder.decode(result.value, { stream: true });
                                        var lines = chunk.split('\\n');

                                        for (var li = 0; li < lines.length; li++) {
                                            var line = lines[li];
                                            ${config.parser}
                                        }

                                        if (window.__proxima_active_stream_id === streamId || fullText.length > (window.__proxima_captured_response || '').length) {
                                            window.__proxima_captured_response = fullText;
                                            window.__proxima_last_capture_time = Date.now();
                                        }
                                    }
                                } catch (e) {
                                    console.log('[brAInstorm] Stream read error:', e.message);
                                } finally {
                                    if ('${config.name}' !== 'Claude' && window.__proxima_active_stream_id === streamId) {
                                        window.__proxima_is_streaming = false;
                                        window.__proxima_last_capture_time = Date.now();
                                    }
                                    console.log('[brAInstorm] ${config.name} stream ' + streamId.slice(0,8) + ' complete. Captured ' + fullText.length + ' chars');
                                }
                            })();
                        }
                    }
                } catch(e) {
                    // Don't break the original fetch
                }

                return response;
            };

            console.log('[brAInstorm] ${config.name} fetch interceptor installed');
        })();
    `;
}

module.exports = {
    providers,
    publicProviderCatalog,
    providerIds,
    providerMap,
    defaultProviderSettings,
    defaultEnabledProviderIds,
    modelAliases,
    smartRouterOrder,
    restAutoOrder,
    DEFAULT_CHROME_VERSION,
    DEFAULT_BROWSER_USER_AGENT,
    getChromeVersionFromUserAgent,
    getChromeMajorVersionFromUserAgent,
    getProviderLabel,
    getDefaultQueryAction,
    getProviderLoginCheckScript,
    buildProviderInterceptorScript
};

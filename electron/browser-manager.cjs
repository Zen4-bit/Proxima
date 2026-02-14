// Browser manager — handles provider BrowserViews, stealth, and auth popups

const { BrowserView, BrowserWindow, session, shell } = require('electron');
const path = require('path');

/**
 * Returns provider-specific fetch interceptor script
 * Captures raw API responses at the network level before DOM rendering
 * This makes response capture reliable regardless of CSS/DOM changes
 */
function getProviderInterceptorScript(provider) {
    // Common interceptor shell - same structure for all providers
    // Only the URL matching and response parsing differs

    const configs = {
        claude: {
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
                        
                        // Track which block we're in
                        if (data.type === 'content_block_start' && data.index !== undefined) {
                            window.__proxima_blocks[data.index] = '';
                        }
                        
                        if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
                            var blockIdx = data.index !== undefined ? data.index : 0;
                            if (!window.__proxima_blocks[blockIdx]) window.__proxima_blocks[blockIdx] = '';
                            window.__proxima_blocks[blockIdx] += data.delta.text;
                            // Use the longest block as the response (skip thinking/short blocks)
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
                        // message_stop = Claude is fully done (all streams complete)
                        if (data.type === 'message_stop') {
                            window.__proxima_blocks = {};
                            window.__proxima_is_streaming = false;
                            window.__proxima_last_capture_time = Date.now();
                        }
                    } catch(e) {}
                }
            `
        },
        chatgpt: {
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
                        // Also handle v2 format
                        if (data.v && data.v === 'text' && data.d) {
                            fullText += data.d;
                        }
                    } catch(e) {}
                }
            `
        },
        perplexity: {
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
                        // Handle chunks array
                        if (data.chunks && Array.isArray(data.chunks)) {
                            fullText = data.chunks.join('');
                        }
                    } catch(e) {
                        // Might be raw text chunk
                        var rawData = line.slice(6).trim();
                        if (rawData && rawData !== '[DONE]' && rawData.length > 10) {
                            fullText += rawData;
                        }
                    }
                }
            `
        },
        gemini: {
            name: 'Gemini',
            urlPatterns: `url.includes('BimAJc') || url.includes('generate') || url.includes('stream') || url.includes('_/WizAO') || (url.includes('gemini') && method === 'POST')`,
            streamTypes: `contentType.includes('text/event-stream') || contentType.includes('stream') || contentType.includes('application/json') || contentType.includes('text/plain')`,
            parser: `
                // Gemini format: JSON array responses or streaming text
                if (line.startsWith('data: ') && line.slice(6).trim() !== '[DONE]') {
                    try {
                        var data = JSON.parse(line.slice(6));
                        // Gemini response format
                        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
                            var parts = data.candidates[0].content.parts || [];
                            for (var p = 0; p < parts.length; p++) {
                                if (parts[p].text) fullText += parts[p].text;
                            }
                        }
                        // Alternative format
                        if (data.text) fullText = data.text;
                        if (data.modelOutput) fullText = data.modelOutput;
                    } catch(e) {
                        // Gemini sometimes sends raw JSON arrays
                        var raw = line.trim();
                        if (raw.startsWith('[')) {
                            try {
                                var arr = JSON.parse(raw);
                                // Deep search for text content in nested arrays
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
                    // Gemini might send raw text/JSON without SSE prefix
                    try {
                        var raw2 = JSON.parse(line.trim());
                        if (raw2 && typeof raw2 === 'object') {
                            var jsonStr = JSON.stringify(raw2);
                            if (jsonStr.length > fullText.length) {
                                // Try to find text in the object
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
    };

    const config = configs[provider];
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
                    // Debug: Log all POST requests to find correct API endpoints
                    if (method === 'POST') {
                        console.error('[Proxima] ${config.name} POST:', url.substring(0, 120));
                    }
                    if (${config.urlPatterns}) {
                        var contentType = response.headers.get('content-type') || '';
                        
                        if (${config.streamTypes}) {
                            var cloned = response.clone();
                            var reader = cloned.body.getReader();
                            var decoder = new TextDecoder();
                            
                            // Each stream gets a unique ID to prevent conflicts
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
                                        
                                        // Only update if this is still the active stream (latest request)
                                        // or if this stream has more content than what's captured
                                        if (window.__proxima_active_stream_id === streamId || fullText.length > (window.__proxima_captured_response || '').length) {
                                            window.__proxima_captured_response = fullText;
                                            window.__proxima_last_capture_time = Date.now();
                                        }
                                    }
                                } catch (e) {
                                    console.log('[Proxima] Stream read error:', e.message);
                                } finally {
                                    // Only mark streaming complete if this is the active stream
                                    // Claude: skip — message_stop in parser handles this
                                    if ('${config.name}' !== 'Claude' && window.__proxima_active_stream_id === streamId) {
                                        window.__proxima_is_streaming = false;
                                        window.__proxima_last_capture_time = Date.now();
                                    }
                                    console.log('[Proxima] ${config.name} stream ' + streamId.slice(0,8) + ' complete. Captured ' + fullText.length + ' chars');
                                }
                            })();
                        }
                    }
                } catch(e) {
                    // Don't break the original fetch
                }

                return response;
            };

            console.log('[Proxima] ${config.name} fetch interceptor installed');
        })();
    `;
}


class BrowserManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.views = new Map();
        this.activeProvider = null;
        this.isDestroyed = false;
        this.authPopups = new Map();

        // Provider configurations
        this.providers = {
            perplexity: {
                url: 'https://www.perplexity.ai/',
                partition: 'persist:perplexity',
                color: '#20b2aa'
            },
            chatgpt: {
                url: 'https://chatgpt.com/',
                partition: 'persist:chatgpt',
                color: '#10a37f'
            },
            claude: {
                url: 'https://claude.ai/',
                partition: 'persist:claude',
                color: '#cc785c'
            },
            gemini: {
                url: 'https://gemini.google.com/app',
                partition: 'persist:gemini',
                color: '#4285f4'
            }
        };

        // Match the exact Chrome version that ships with Electron 33 (Chromium 130)
        this.chromeVersion = '130.0.0.0';
        this.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`;
    }

    /**
     * Stealth script - removes Electron fingerprints from the JS environment
     */
    getStealthScript() {
        return `
            (function() {
                'use strict';
                try {
                    // 1. Remove webdriver flag
                    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

                    // 2. Remove Electron globals
                    const electronGlobals = ['process', 'require', 'module', '__filename', '__dirname', 'global', 'Buffer'];
                    electronGlobals.forEach(g => {
                        try { delete window[g]; } catch(e) {}
                        try { Object.defineProperty(window, g, { get: () => undefined, configurable: true }); } catch(e) {}
                    });

                    // 3. Chrome runtime object
                    if (!window.chrome) window.chrome = {};
                    if (!window.chrome.runtime) {
                        window.chrome.runtime = {
                            OnInstalledReason: {},
                            OnRestartRequiredReason: {},
                            PlatformArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
                            connect: function() { throw new Error('Could not establish connection. Receiving end does not exist.'); },
                            sendMessage: function() { throw new Error('Could not establish connection. Receiving end does not exist.'); },
                            id: undefined
                        };
                    }
                    if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
                    if (!window.chrome.csi) window.chrome.csi = function() { return { pageT: performance.now(), startE: Date.now(), onloadT: Date.now() }; };
                    if (!window.chrome.loadTimes) window.chrome.loadTimes = function() { return { commitLoadTime: Date.now()/1000, connectionInfo: 'h2', finishDocumentLoadTime: Date.now()/1000, finishLoadTime: Date.now()/1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now()/1000, navigationType: 'Other', npnNegotiatedProtocol: 'h2', requestTime: Date.now()/1000, startLoadTime: Date.now()/1000, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; };

                    // 4. Navigator spoofing
                    const navProps = {
                        platform: 'Win32',
                        vendor: 'Google Inc.',
                        languages: ['en-US', 'en'],
                        hardwareConcurrency: navigator.hardwareConcurrency || 8,
                        deviceMemory: 8,
                        maxTouchPoints: 0,
                    };
                    Object.entries(navProps).forEach(([key, val]) => {
                        try { Object.defineProperty(navigator, key, { get: () => val, configurable: true }); } catch(e) {}
                    });

                    // 5. Plugins - simulate real Chrome plugins
                    try {
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => {
                                const arr = [
                                    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                                    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                                    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                                ];
                                arr.item = (i) => arr[i];
                                arr.namedItem = (name) => arr.find(p => p.name === name);
                                arr.refresh = () => {};
                                return arr;
                            },
                            configurable: true
                        });
                    } catch(e) {}

                    // 6. userAgentData
                    try {
                        const brands = [
                            { brand: "Chromium", version: "130" },
                            { brand: "Google Chrome", version: "130" },
                            { brand: "Not?A_Brand", version: "99" }
                        ];
                        const uad = {
                            brands,
                            mobile: false,
                            platform: "Windows",
                            getHighEntropyValues: (hints) => Promise.resolve({
                                brands,
                                mobile: false,
                                platform: "Windows",
                                platformVersion: "15.0.0",
                                architecture: "x86",
                                bitness: "64",
                                model: "",
                                uaFullVersion: "130.0.6723.191",
                                fullVersionList: [
                                    { brand: "Chromium", version: "130.0.6723.191" },
                                    { brand: "Google Chrome", version: "130.0.6723.191" },
                                    { brand: "Not?A_Brand", version: "99.0.0.0" }
                                ],
                                wow64: false
                            }),
                            toJSON: function() { return { brands, mobile: false, platform: "Windows" }; }
                        };
                        Object.defineProperty(navigator, 'userAgentData', { get: () => uad, configurable: true });
                    } catch(e) {}

                    // 7. Permissions API
                    try {
                        const origQuery = window.Permissions.prototype.query;
                        window.Permissions.prototype.query = function(params) {
                            if (params && params.name === 'notifications') {
                                return Promise.resolve({ state: Notification.permission });
                            }
                            return origQuery.call(this, params);
                        };
                    } catch(e) {}

                    // 8. WebGL renderer info
                    try {
                        const getParam = WebGLRenderingContext.prototype.getParameter;
                        WebGLRenderingContext.prototype.getParameter = function(param) {
                            if (param === 37445) return 'Google Inc. (NVIDIA)';
                            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                            return getParam.call(this, param);
                        };
                        const getParam2 = WebGL2RenderingContext.prototype.getParameter;
                        WebGL2RenderingContext.prototype.getParameter = function(param) {
                            if (param === 37445) return 'Google Inc. (NVIDIA)';
                            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                            return getParam2.call(this, param);
                        };
                    } catch(e) {}

                    // 9. iframe contentWindow protection
                    try {
                        const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
                        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                            get: function() {
                                const win = origContentWindow.get.call(this);
                                if (win) {
                                    try {
                                        Object.defineProperty(win, 'chrome', { get: () => window.chrome, configurable: true });
                                    } catch(e) {}
                                }
                                return win;
                            }
                        });
                    } catch(e) {}

                    console.log('[Stealth] v4.0 active');
                } catch(e) {
                    console.log('[Stealth] Error:', e.message);
                }
            })();
        `;
    }

    /**
     * Setup session with clean headers
     */
    setupSession(provider) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });
        ses.setUserAgent(this.userAgent);

        // Spoof Chrome client hints headers on ALL outgoing requests
        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = { ...details.requestHeaders };

            // Set proper Chrome client hints for EVERY request
            headers['sec-ch-ua'] = `"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"`;
            headers['sec-ch-ua-mobile'] = '?0';
            headers['sec-ch-ua-platform'] = '"Windows"';
            headers['sec-ch-ua-platform-version'] = '"15.0.0"';
            headers['sec-ch-ua-full-version-list'] = `"Chromium";v="130.0.6723.191", "Google Chrome";v="130.0.6723.191", "Not?A_Brand";v="99.0.0.0"`;
            headers['sec-ch-ua-arch'] = '"x86"';
            headers['sec-ch-ua-bitness'] = '"64"';
            headers['sec-ch-ua-wow64'] = '?0';
            headers['sec-ch-ua-model'] = '""';

            // Remove any Electron-specific headers
            delete headers['X-Electron-Version'];

            callback({ requestHeaders: headers });
        });

        // Strip Accept-CH from Google responses to prevent further client hint negotiation
        // Google uses Accept-CH to request high-entropy client hints that may reveal Electron
        ses.webRequest.onHeadersReceived((details, callback) => {
            if (details.url.includes('google.com') || details.url.includes('gstatic.com') || details.url.includes('googleapis.com')) {
                const headers = { ...details.responseHeaders };
                // Remove Accept-CH header - prevents Google from requesting more client hints
                delete headers['accept-ch'];
                delete headers['Accept-CH'];
                delete headers['Accept-Ch'];
                // Remove Permissions-Policy that might affect feature detection
                delete headers['permissions-policy'];
                delete headers['Permissions-Policy'];
                callback({ responseHeaders: headers });
            } else {
                callback({});
            }
        });

        return ses;
    }

    /**
     * Initialize a browser view for a provider
     */
    createView(provider) {
        if (this.isDestroyed) return null;

        if (this.views.has(provider)) {
            return this.views.get(provider);
        }

        const config = this.providers[provider];
        if (!config) {
            throw new Error(`Unknown provider: ${provider}`);
        }

        const ses = this.setupSession(provider);

        const view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: ses,
                webSecurity: true,
                sandbox: true,
                allowRunningInsecureContent: false,
                javascript: true,
                images: true,
                webgl: true,
                backgroundThrottling: false,
            }
        });

        this.views.set(provider, view);

        // Inject stealth on every page load
        view.webContents.on('dom-ready', () => {
            if (view.webContents.isDestroyed()) return;
            view.webContents.executeJavaScript(this.getStealthScript()).catch(() => { });

            // FETCH INTERCEPTOR: Inject for ALL providers to capture raw API responses
            // This bypasses all DOM/CSS issues by capturing text at the network level
            const interceptorScript = getProviderInterceptorScript(provider);
            if (interceptorScript) {
                view.webContents.executeJavaScript(interceptorScript).catch(() => { });
            }
        });

        // Track navigation for URL bar
        view.webContents.on('did-navigate', (event, url) => {
            console.log(`[${provider}] Navigated to:`, url.substring(0, 80));
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-navigated', { provider, url });
            }
        });

        view.webContents.on('did-navigate-in-page', (event, url) => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-navigated', { provider, url });
            }
        });

        // Handle popups / window.open - This is KEY for Google OAuth
        // Google OAuth uses popup windows. We must allow them with proper stealth.
        view.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
            console.log(`[${provider}] Popup requested:`, url.substring(0, 80));

            // For Google OAuth popup, open in a separate clean BrowserWindow
            if (url.includes('accounts.google.com') ||
                url.includes('accounts.youtube.com') ||
                url.includes('appleid.apple.com') ||
                url.includes('login.microsoftonline.com') ||
                url.includes('login.live.com') ||
                url.includes('github.com/login') ||
                url.includes('auth0.com')) {

                this.openAuthPopup(provider, url);
                return { action: 'deny' };
            }

            // For Claude Google sign-in, load in same view
            if (provider === 'claude' && url.includes('accounts.google.com')) {
                view.webContents.loadURL(url);
                return { action: 'deny' };
            }

            // Allow other popups normally
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 600,
                    height: 700,
                    webPreferences: {
                        session: ses,
                        sandbox: true,
                        contextIsolation: true,
                        nodeIntegration: false,
                    }
                }
            };
        });

        // Console messages (only errors)
        view.webContents.on('console-message', (event, level, message) => {
            if (level >= 2) {
                console.log(`[${provider}] Console:`, message.substring(0, 100));
            }
        });

        // Page loaded
        view.webContents.on('did-finish-load', () => {
            console.log(`[${provider}] Page loaded`);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-loaded', { provider });
            }
        });

        // Load provider URL
        view.webContents.loadURL(config.url);

        return view;
    }

    /**
     * Open an auth popup for Google/Microsoft/Apple sign-in
     * This creates a STANDALONE BrowserWindow that looks like a real browser
     */
    openAuthPopup(provider, url) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });
        ses.setUserAgent(this.userAgent);

        // Create a clean standalone window - NOT a child, NOT modal
        // Google is less suspicious of standalone windows
        const authWindow = new BrowserWindow({
            width: 500,
            height: 700,
            show: true,
            title: 'Sign in',
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: ses,
                sandbox: true,
                webSecurity: true,
            }
        });

        this.authPopups.set(provider, authWindow);

        // Inject stealth into the auth window too
        authWindow.webContents.on('dom-ready', () => {
            if (!authWindow.isDestroyed()) {
                authWindow.webContents.executeJavaScript(this.getStealthScript()).catch(() => { });
            }
        });

        // Note: Headers are already spoofed via the session-level onBeforeSendHeaders
        // set up in setupSession(). Don't override it here.

        authWindow.loadURL(url);

        // When auth completes and redirects back to provider, close the popup
        authWindow.webContents.on('did-navigate', (event, navUrl) => {
            console.log(`[Auth ${provider}] Navigated to:`, navUrl.substring(0, 80));

            const providerDomains = {
                perplexity: 'perplexity.ai',
                chatgpt: 'chatgpt.com',
                claude: 'claude.ai',
                gemini: 'gemini.google.com'
            };

            const domain = providerDomains[provider];
            if (domain && navUrl.includes(domain)) {
                console.log(`[Auth ${provider}] Auth complete! Closing popup and reloading.`);
                setTimeout(() => {
                    if (!authWindow.isDestroyed()) {
                        authWindow.close();
                    }
                }, 1500);
            }
        });

        authWindow.on('closed', () => {
            console.log(`[${provider}] Auth popup closed`);
            this.authPopups.delete(provider);

            // Reload the main view to apply the auth
            const view = this.views.get(provider);
            if (view && !view.webContents.isDestroyed()) {
                console.log(`[${provider}] Reloading after auth...`);
                view.webContents.reload();
            }
        });
    }

    /**
     * Show a provider's browser view
     */
    showProvider(provider, bounds) {
        if (this.isDestroyed || !this.mainWindow || this.mainWindow.isDestroyed()) return null;

        if (!this.views.has(provider)) {
            this.createView(provider);
        }

        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;

        try {
            // Move all views, bring active one to front
            for (const [p, v] of this.views) {
                if (!v.webContents.isDestroyed()) {
                    const existingViews = this.mainWindow.getBrowserViews();
                    if (!existingViews.includes(v)) {
                        this.mainWindow.addBrowserView(v);
                    }

                    if (p === provider) {
                        v.setBounds(bounds);
                    } else {
                        v.setBounds({ x: -10000, y: 0, width: bounds.width, height: bounds.height });
                    }
                }
            }

            // Bring to front
            this.mainWindow.removeBrowserView(view);
            this.mainWindow.addBrowserView(view);
            view.setBounds(bounds);
            view.setAutoResize({ width: true, height: true });

            this.activeProvider = provider;
        } catch (e) {
            console.log('Could not show view:', e.message);
        }

        return view;
    }

    hideCurrentView() {
        if (this.isDestroyed) return;

        if (this.activeProvider) {
            const view = this.views.get(this.activeProvider);
            if (view && !view.webContents.isDestroyed() && this.mainWindow && !this.mainWindow.isDestroyed()) {
                try {
                    this.mainWindow.removeBrowserView(view);
                } catch (e) {
                    console.log('Could not hide view:', e.message);
                }
            }
            this.activeProvider = null;
        }
    }

    getWebContents(provider) {
        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;
        return view.webContents;
    }

    async executeScript(provider, script) {
        const webContents = this.getWebContents(provider);
        if (!webContents) throw new Error(`Provider ${provider} not initialized`);
        return await webContents.executeJavaScript(script);
    }

    async navigate(provider, url) {
        const webContents = this.getWebContents(provider);
        if (!webContents) {
            this.createView(provider);
            const newWebContents = this.getWebContents(provider);
            if (newWebContents) await newWebContents.loadURL(url);
            return;
        }
        await webContents.loadURL(url);
    }

    async reload(provider) {
        const webContents = this.getWebContents(provider);
        if (webContents) await webContents.reload();
    }

    async isLoggedIn(provider) {
        const webContents = this.getWebContents(provider);
        if (!webContents) return false;

        try {
            switch (provider) {
                case 'perplexity':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const buttons = Array.from(document.querySelectorAll('button, a'));
                            const hasLoginBtn = buttons.some(b => b.innerText === 'Log in' || b.innerText === 'Sign Up');
                            if (hasLoginBtn) return false;
                            const hasInput = !!document.querySelector('textarea') || !!document.querySelector('[contenteditable="true"]');
                            return !hasLoginBtn && hasInput;
                        })()
                    `);
                case 'chatgpt':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('#prompt-textarea');
                            const hasLoginModal = !!document.querySelector('[data-testid="login-button"]');
                            return hasInput && !hasLoginModal;
                        })()
                    `);
                case 'claude':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('[contenteditable="true"]');
                            const hasLoginPage = window.location.href.includes('/login');
                            return hasInput && !hasLoginPage;
                        })()
                    `);
                case 'gemini':
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('.ql-editor') ||
                                           !!document.querySelector('[contenteditable="true"]') ||
                                           !!document.querySelector('rich-textarea');
                            const hasSignIn = !!document.querySelector('a[href*="ServiceLogin"]') ||
                                            !!document.querySelector('a[data-action-id="sign-in"]');
                            return hasInput && !hasSignIn;
                        })()
                    `);
                default:
                    return false;
            }
        } catch (e) {
            return false;
        }
    }

    openGoogleSignIn(provider) {
        // Open Google sign-in in auth popup window
        this.openAuthPopup(provider, 'https://accounts.google.com/ServiceLogin?continue=' + encodeURIComponent(this.providers[provider]?.url || 'https://google.com'));
    }

    getInitializedProviders() {
        return Array.from(this.views.keys());
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        // Close auth popups
        for (const [provider, popup] of this.authPopups) {
            try { if (!popup.isDestroyed()) popup.close(); } catch (e) { }
        }
        this.authPopups.clear();

        // Remove views
        for (const [provider, view] of this.views) {
            try {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.removeBrowserView(view);
                }
            } catch (e) { }
        }

        // Destroy views
        for (const [provider, view] of this.views) {
            try {
                if (!view.webContents.isDestroyed()) view.webContents.destroy();
            } catch (e) { }
        }

        this.views.clear();
        this.activeProvider = null;
    }
}

module.exports = BrowserManager;

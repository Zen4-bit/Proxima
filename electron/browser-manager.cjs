// Proxima — Provider BrowserView Manager.
// Manages persistent BrowserViews per AI provider, injecting stealth scripts and handling auth popups.

const { app, BrowserView, BrowserWindow, session, shell, webContents } = require('electron');
const path = require('path');

class BrowserManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.views = new Map();
        this.activeProvider = null;
        this.isDestroyed = false;
        this.authPopups = new Map();

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

        // Must match Electron 33's bundled Chromium version for compatibility.
        this.chromeVersion = '130.0.6723.191';
        this.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`;

        this.popupWebContentsIds = new Set();

        // Bind ref so destroy() can detach it to prevent listener leaks on the global app object.
        this._onWebContentsCreated = (event, contents) => {
            if (contents.getType() === 'window') {
                const partition = contents.session.partition || '';
                if (partition.startsWith('persist:')) {
                    console.log(`[Popup] Forcing Firefox UA and stealth on popup in partition: ${partition}`);
                    contents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0');

                    this.popupWebContentsIds.add(contents.id);

                    // Inject stealth script on popup dom-ready.
                    contents.on('dom-ready', () => {
                        if (!contents.isDestroyed()) {
                            contents.executeJavaScript(this.getStealthScript()).catch(() => { });
                        }
                    });

                    contents.on('destroyed', () => {
                        this.popupWebContentsIds.delete(contents.id);
                    });
                }
            }
        };
        app.on('web-contents-created', this._onWebContentsCreated);
    }

    getStealthScript() {
        return `
            (function() {
                'use strict';
                try {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

                    // Exclude 'global' and 'Buffer' to prevent breaking polyfills like Claude's Buffer.isBuffer.
                    const electronGlobals = ['process', 'require', 'module', '__filename', '__dirname'];
                    electronGlobals.forEach(g => {
                        try { delete window[g]; } catch(e) {}
                        try { Object.defineProperty(window, g, { get: () => undefined, configurable: true }); } catch(e) {}
                    });

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

                    try {
                        const origQuery = window.Permissions.prototype.query;
                        window.Permissions.prototype.query = function(params) {
                            if (params && params.name === 'notifications') {
                                return Promise.resolve({ state: Notification.permission });
                            }
                            return origQuery.call(this, params);
                        };
                    } catch(e) {}

                    try {
                        // Spoof WebGL renderer only when a headless/software renderer is detected to avoid obvious fingerprints.
                        const _isSoftwareRenderer = (s) => typeof s === 'string' && /swiftshader|llvmpipe|basic render|software|microsoft basic/i.test(s);
                        const _spoofVendor = 'Google Inc. (NVIDIA)';
                        const _spoofRenderer = 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                        const _patchGetParameter = (proto) => {
                            const orig = proto.getParameter;
                            proto.getParameter = function(param) {
                                const real = orig.call(this, param);
                                if (param === 37445) { // UNMASKED_VENDOR_WEBGL
                                    return _isSoftwareRenderer(real) ? _spoofVendor : real;
                                }
                                if (param === 37446) { // UNMASKED_RENDERER_WEBGL
                                    return (!real || _isSoftwareRenderer(real)) ? _spoofRenderer : real;
                                }
                                return real;
                            };
                        };
                        _patchGetParameter(WebGLRenderingContext.prototype);
                        _patchGetParameter(WebGL2RenderingContext.prototype);
                    } catch(e) {}

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

                    // Spoof screen dimensions to prevent Cloudflare Turnstile CAPTCHA loops.
                    try {
                        const screenProps = {
                            colorDepth: 24,
                            pixelDepth: 24,
                            availWidth: screen.availWidth || 1920,
                            availHeight: screen.availHeight || 1040,
                            width: screen.width || 1920,
                            height: screen.height || 1080,
                        };
                        Object.entries(screenProps).forEach(([key, val]) => {
                            try { Object.defineProperty(screen, key, { get: () => val, configurable: true }); } catch(e) {}
                        });
                    } catch(e) {}

                    try {
                        if (!window.outerWidth || window.outerWidth === 0) {
                            Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth || 1920, configurable: true });
                        }
                        if (!window.outerHeight || window.outerHeight === 0) {
                            Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 1040) + 85, configurable: true });
                        }
                    } catch(e) {}

                    try {
                        if (typeof Notification !== 'undefined') {
                            const OrigNotification = Notification;
                            if (!OrigNotification.requestPermission) {
                                OrigNotification.requestPermission = function(cb) {
                                    const p = Promise.resolve('default');
                                    if (cb) p.then(cb);
                                    return p;
                                };
                            }
                        }
                    } catch(e) {}

                    console.log('[Compat] v4.1 active');
                } catch(e) {
                    console.log('[Compat] Error:', e.message);
                }
            })();
        `;
    }

    setupSession(provider) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });

        if (provider === 'claude') {
            ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0');
        } else {
            ses.setUserAgent(this.userAgent);
        }

        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = { ...details.requestHeaders };

            let isFirefox = this.popupWebContentsIds.has(details.webContentsId);
            if (!isFirefox && details.webContentsId) {
                try {
                    const wc = webContents.fromId(details.webContentsId);
                    if (wc && !wc.isDestroyed()) {
                        const ua = wc.getUserAgent() || '';
                        isFirefox = ua.includes('Firefox');
                    }
                } catch (e) {
                }
            }

            if (!isFirefox) {
                const getHeaderCaseInsensitive = (obj, key) => {
                    const keys = Object.keys(obj);
                    const match = keys.find(k => k.toLowerCase() === key.toLowerCase());
                    return match ? obj[match] : undefined;
                };
                const ua = getHeaderCaseInsensitive(headers, 'user-agent') || '';
                isFirefox = ua.includes('Firefox');
            }

            const isAuthRequest =
                isFirefox ||
                details.url.includes('accounts.google.com') ||
                details.url.includes('accounts.youtube.com') ||
                details.url.includes('appleid.apple.com') ||
                details.url.includes('login.microsoftonline.com') ||
                details.url.includes('login.live.com') ||
                details.url.includes('github.com/login') ||
                details.url.includes('auth0.com');

            if (isAuthRequest) {
                // Overwrite User-Agent to Firefox for Google Auth
                if (details.url.includes('accounts.google.com') || details.url.includes('accounts.youtube.com')) {
                    const keys = Object.keys(headers);
                    const match = keys.find(k => k.toLowerCase() === 'user-agent');
                    if (match) {
                        headers[match] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0';
                    } else {
                        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0';
                    }
                }

                // Strip client hints for auth requests
                delete headers['sec-ch-ua'];
                delete headers['sec-ch-ua-mobile'];
                delete headers['sec-ch-ua-platform'];
                delete headers['sec-ch-ua-platform-version'];
                delete headers['sec-ch-ua-full-version-list'];
                delete headers['sec-ch-ua-arch'];
                delete headers['sec-ch-ua-bitness'];
                delete headers['sec-ch-ua-wow64'];
                delete headers['sec-ch-ua-model'];
            } else {
                headers['sec-ch-ua'] = '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"';
                headers['sec-ch-ua-mobile'] = '?0';
                headers['sec-ch-ua-platform'] = '"Windows"';
                headers['sec-ch-ua-platform-version'] = '"15.0.0"';
                headers['sec-ch-ua-full-version-list'] = '"Chromium";v="130.0.6723.191", "Google Chrome";v="130.0.6723.191", "Not?A_Brand";v="99.0.0.0"';
                headers['sec-ch-ua-arch'] = '"x86"';
                headers['sec-ch-ua-bitness'] = '"64"';
                headers['sec-ch-ua-wow64'] = '?0';
                headers['sec-ch-ua-model'] = '""';
            }

            delete headers['X-Electron-Version'];

            callback({ requestHeaders: headers });
        });

        ses.webRequest.onHeadersReceived((details, callback) => {
            if (details.url.includes('google.com') || details.url.includes('gstatic.com') || details.url.includes('googleapis.com')) {
                const headers = { ...details.responseHeaders };

                delete headers['accept-ch'];
                delete headers['Accept-CH'];
                delete headers['Accept-Ch'];

                delete headers['permissions-policy'];
                delete headers['Permissions-Policy'];
                callback({ responseHeaders: headers });
            } else {
                callback({});
            }
        });

        return ses;
    }

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

        const isAuthUrl = (url) => {
            if (!url) return false;
            const lowerUrl = url.toLowerCase();
            return lowerUrl.includes('accounts.google.com') ||
                lowerUrl.includes('accounts.youtube.com') ||
                lowerUrl.includes('appleid.apple.com') ||
                lowerUrl.includes('login.microsoftonline.com') ||
                lowerUrl.includes('login.live.com') ||
                lowerUrl.includes('github.com/login') ||
                lowerUrl.includes('auth0.com');
        };

        view.webContents.on('will-navigate', (event, url) => {
            if (isAuthUrl(url)) {
                console.log(`[${provider}] Intercepting navigation to auth URL:`, url.substring(0, 80));
                event.preventDefault();
                this.openAuthPopup(provider, url);
            }
        });

        view.webContents.on('will-redirect', (event, url) => {
            if (isAuthUrl(url)) {
                console.log(`[${provider}] Intercepting redirect to auth URL:`, url.substring(0, 80));
                event.preventDefault();
                this.openAuthPopup(provider, url);
            }
        });

        view.webContents.on('dom-ready', () => {
            if (view.webContents.isDestroyed()) return;
            view.webContents.executeJavaScript(this.getStealthScript()).catch(() => { });
        });

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

        view.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
            console.log(`[${provider}] Popup requested:`, url.substring(0, 80));

            const lowerUrl = url.toLowerCase();
            const isAuthPopup =
                lowerUrl.includes('accounts.google.com') ||
                lowerUrl.includes('accounts.youtube.com') ||
                lowerUrl.includes('appleid.apple.com') ||
                lowerUrl.includes('login.microsoftonline.com') ||
                lowerUrl.includes('login.live.com') ||
                lowerUrl.includes('github.com') ||
                lowerUrl.includes('auth0.com') ||
                lowerUrl.includes('/auth/') ||
                lowerUrl.includes('/login') ||
                lowerUrl.includes('/signin') ||
                lowerUrl.includes('/oauth');

            if (isAuthPopup) {
                this.openAuthPopup(provider, url);
                return { action: 'deny' };
            }

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

        // Filter out third-party console warning noise to keep logs clean.
        const _consoleDedup = new Set();
        const CONSOLE_NOISE_PATTERNS = [
            'The resource https://',
            'Datadog Browser SDK',
            'popover',
            'Refused to connect',
            'Refused to load',
            'Deprecated API for given entry type',
            'DOMNodeInserted',
            'Permissions-Policy',
            'Insecure Content-Security-Policy',
            'SERVICE_WORKER',
            'ga-audiences',
            'doubleclick.net',
            'cloudflareaccess.com',
        ];

        view.webContents.on('console-message', (event, level, message) => {
            if (message.startsWith('[Proxima ChatGPT Payload] ')) {
                const fs = require('fs');
                const path = require('path');
                try {
                    fs.writeFileSync(path.join(__dirname, '..', 'scratch_payload.json'), message.substring('[Proxima ChatGPT Payload] '.length), 'utf8');
                    console.log('[DEBUG] ChatGPT payload dumped to scratch_payload.json');
                } catch (err) {
                    console.error('[DEBUG] Failed to dump payload:', err.message);
                }
            }

            if (level < 2) return;

            const msgLower = message.toLowerCase();
            for (const pattern of CONSOLE_NOISE_PATTERNS) {
                if (msgLower.includes(pattern.toLowerCase())) return;
            }

            const dedupKey = `${provider}:${message.substring(0, 80)}`;
            if (_consoleDedup.has(dedupKey)) return;
            _consoleDedup.add(dedupKey);

            if (_consoleDedup.size > 200) _consoleDedup.clear();

            const label = level >= 3 ? 'Error' : 'Warn';
            console.log(`[${provider}] ${label}:`, message.substring(0, 120));
        });

        let _pageLoadLogged = false;
        view.webContents.on('did-finish-load', () => {
            if (!_pageLoadLogged) {
                console.log(`[${provider}] Page loaded`);
                _pageLoadLogged = true;
            }
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-loaded', { provider });
            }
        });

        view.webContents.loadURL(config.url);

        return view;
    }

    openAuthPopup(provider, url) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });

        // Focus existing popup to avoid duplicate auth windows.
        const existing = this.authPopups.get(provider);
        if (existing && !existing.isDestroyed()) {
            try {
                existing.focus();
                existing.webContents.loadURL(url);
                return;
            } catch (e) {
                try { existing.destroy(); } catch (_e) { }
                this.authPopups.delete(provider);
            }
        }

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

        // Force Firefox User-Agent to bypass Google login restrictions.
        authWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0');

        this.authPopups.set(provider, authWindow);

        authWindow.webContents.on('dom-ready', () => {
            if (!authWindow.isDestroyed()) {
                authWindow.webContents.executeJavaScript(this.getStealthScript()).catch(() => { });
            }
        });

        // Request account selection prompts for Google OAuth flows.
        let targetUrl = url;
        try {
            const parsedUrl = new URL(url);
            if (parsedUrl.hostname.includes('accounts.google.com') &&
                provider !== 'gemini' &&
                (parsedUrl.pathname.includes('/oauth') || parsedUrl.pathname.includes('/auth')) &&
                !parsedUrl.pathname.includes('ServiceLogin') &&
                !parsedUrl.pathname.includes('InteractiveLogin')) {

                parsedUrl.searchParams.set('prompt', 'select_account');
                targetUrl = parsedUrl.toString();
                console.log(`[Auth] Forcing Google Account Selection UI:`, targetUrl.substring(0, 80));
            }
        } catch (e) {
            if (url.includes('accounts.google.com') &&
                provider !== 'gemini' &&
                (url.includes('/oauth') || url.includes('/auth')) &&
                !url.includes('ServiceLogin') &&
                !url.includes('InteractiveLogin')) {

                targetUrl = url + (url.includes('?') ? '&' : '?') + 'prompt=select_account';
            }
        }

        authWindow.loadURL(targetUrl);

        authWindow.webContents.on('did-navigate', (event, navUrl) => {
            console.log(`[Auth ${provider}] Navigated to:`, navUrl.substring(0, 80));

            const providerDomains = {
                perplexity: 'perplexity.ai',
                chatgpt: 'chatgpt.com',
                claude: 'claude.ai',
                gemini: 'gemini.google.com'
            };

            const domain = providerDomains[provider];
            let isComplete = false;
            try {
                const parsedUrl = new URL(navUrl);
                const h = parsedUrl.hostname;
                // Check hostname matches exactly to prevent spoofing bypasses.
                if (domain && (h === domain || h.endsWith('.' + domain))) {
                    const path = parsedUrl.pathname.toLowerCase();
                    const isAuthPath =
                        path.includes('/auth/') ||
                        path.includes('/login') ||
                        path.includes('/signin') ||
                        path.includes('/signup') ||
                        path.includes('/oauth') ||
                        path.includes('/callback') ||
                        path.includes('/register') ||
                        path.includes('/api/');

                    if (!isAuthPath) {
                        isComplete = true;
                    }
                }
            } catch (e) {
                const lowerNavUrl = navUrl.toLowerCase();
                const hasAuthKeyword =
                    lowerNavUrl.includes('/auth/') ||
                    lowerNavUrl.includes('/login') ||
                    lowerNavUrl.includes('/signin') ||
                    lowerNavUrl.includes('/signup') ||
                    lowerNavUrl.includes('/oauth') ||
                    lowerNavUrl.includes('/callback') ||
                    lowerNavUrl.includes('/register') ||
                    lowerNavUrl.includes('/api/');

                if (domain && navUrl.includes(domain) && !navUrl.includes('accounts.google.com') && !navUrl.includes('accounts.youtube.com') && !hasAuthKeyword) {
                    isComplete = true;
                }
            }

            if (isComplete) {
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
            // Only clear if the map entry still points to this instance.
            if (this.authPopups.get(provider) === authWindow) {
                this.authPopups.delete(provider);
            }

            const view = this.views.get(provider);
            if (view && !view.webContents.isDestroyed()) {
                console.log(`[${provider}] Loading home URL after auth:`, config.url);
                view.webContents.loadURL(config.url);
            }
        });
    }

    showProvider(provider, bounds) {
        if (this.isDestroyed || !this.mainWindow || this.mainWindow.isDestroyed()) return null;

        if (!this.views.has(provider)) {
            this.createView(provider);
        }

        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;

        try {
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

        // Detach global listener to prevent handler memory leaks on reload.
        if (this._onWebContentsCreated) {
            try { app.removeListener('web-contents-created', this._onWebContentsCreated); } catch (e) { }
            this._onWebContentsCreated = null;
        }

        for (const [provider, popup] of this.authPopups) {
            try { if (!popup.isDestroyed()) popup.close(); } catch (e) { }
        }
        this.authPopups.clear();

        for (const [provider, view] of this.views) {
            try {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.removeBrowserView(view);
                }
            } catch (e) { }
        }

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

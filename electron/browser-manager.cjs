// Proxima — BrowserView manager (sessions, compatibility, auth popups)

const { BrowserView, BrowserWindow, session, shell } = require('electron');
const path = require('path');

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

        // Must match Electron 33's bundled Chromium version for compatibility
        this.chromeVersion = '130.0.6723.191';
        this.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`;
    }

    /** Browser compatibility script — ensures proper Chrome environment */
    getStealthScript() {
        return `
            (function() {
                'use strict';
                try {

                    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });

                    // 'global' and 'Buffer' excluded — sandbox:true handles them, and
                    // defineProperty traps break polyfills (e.g. Claude's Buffer.isBuffer)
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

                    // ─── Cloudflare Turnstile compatibility ──────────────
                    // Cloudflare checks these to detect headless/embedded browsers.
                    // BrowserView can report wrong values, causing CAPTCHA loops.

                    // 1. Screen properties must be consistent and realistic
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

                    // 2. outerWidth/outerHeight — BrowserView often reports 0 (major Cloudflare red flag)
                    try {
                        if (!window.outerWidth || window.outerWidth === 0) {
                            Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth || 1920, configurable: true });
                        }
                        if (!window.outerHeight || window.outerHeight === 0) {
                            Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 1040) + 85, configurable: true });
                        }
                    } catch(e) {}

                    // 3. Notification constructor must be proper (Cloudflare probes this)
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

    /** Setup session with proper Chrome headers */
    setupSession(provider) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });
        ses.setUserAgent(this.userAgent);

        // Set Chrome client hints headers
        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = { ...details.requestHeaders };


            headers['sec-ch-ua'] = `"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"`;
            headers['sec-ch-ua-mobile'] = '?0';
            headers['sec-ch-ua-platform'] = '"Windows"';
            headers['sec-ch-ua-platform-version'] = '"15.0.0"';
            headers['sec-ch-ua-full-version-list'] = `"Chromium";v="130.0.6723.191", "Google Chrome";v="130.0.6723.191", "Not?A_Brand";v="99.0.0.0"`;
            headers['sec-ch-ua-arch'] = '"x86"';
            headers['sec-ch-ua-bitness'] = '"64"';
            headers['sec-ch-ua-wow64'] = '?0';
            headers['sec-ch-ua-model'] = '""';


            delete headers['X-Electron-Version'];

            callback({ requestHeaders: headers });
        });

        // Google uses Accept-CH to negotiate high-entropy hints
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

    /** Create and configure a BrowserView for a provider */
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

        // Google OAuth uses popup windows
        view.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
            console.log(`[${provider}] Popup requested:`, url.substring(0, 80));


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


        view.webContents.on('console-message', (event, level, message) => {
            if (level >= 2) {
                console.log(`[${provider}] Console:`, message.substring(0, 100));
            }
        });


        view.webContents.on('did-finish-load', () => {
            console.log(`[${provider}] Page loaded`);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-loaded', { provider });
            }
        });


        view.webContents.loadURL(config.url);

        return view;
    }

    /** Auth popup — standalone window for OAuth providers */
    openAuthPopup(provider, url) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });
        ses.setUserAgent(this.userAgent);

        // Standalone window (not child/modal) for clean auth flow
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


        authWindow.webContents.on('dom-ready', () => {
            if (!authWindow.isDestroyed()) {
                authWindow.webContents.executeJavaScript(this.getStealthScript()).catch(() => { });
            }
        });



        authWindow.loadURL(url);

        // Close popup when user lands back on the provider domain
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


            const view = this.views.get(provider);
            if (view && !view.webContents.isDestroyed()) {
                console.log(`[${provider}] Reloading after auth...`);
                view.webContents.reload();
            }
        });
    }

    /** Show provider BrowserView */
    showProvider(provider, bounds) {
        if (this.isDestroyed || !this.mainWindow || this.mainWindow.isDestroyed()) return null;

        if (!this.views.has(provider)) {
            this.createView(provider);
        }

        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;

        try {
            // Move non-active views off-screen, bring active one to front
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

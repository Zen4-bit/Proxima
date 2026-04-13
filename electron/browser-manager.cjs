// Browser manager — handles provider BrowserViews, stealth, and auth popups

const { BrowserView, BrowserWindow, session } = require('electron');
const {
    providerMap,
    buildProviderInterceptorScript,
    getProviderLoginCheckScript,
    DEFAULT_BROWSER_USER_AGENT,
    getChromeVersionFromUserAgent,
    getChromeMajorVersionFromUserAgent
} = require('../src/provider-catalog.cjs');

function getProviderInterceptorScript(provider) {
    return buildProviderInterceptorScript(provider);
}


class BrowserManager {
    constructor(mainWindow, options = {}) {
        this.mainWindow = mainWindow;
        this.views = new Map();
        this.activeProvider = null;
        this.isDestroyed = false;
        this.authPopups = new Map();

        // Provider configurations
        this.providers = Object.fromEntries(
            Object.entries(providerMap).map(([providerId, config]) => [
                providerId,
                {
                    url: config.url,
                    partition: config.partition,
                    color: config.color
                }
            ])
        );

        this.setUserAgent(options.userAgent || DEFAULT_BROWSER_USER_AGENT);
    }

    setUserAgent(userAgent) {
        this.userAgent = userAgent || DEFAULT_BROWSER_USER_AGENT;
        this.chromeVersion = getChromeVersionFromUserAgent(this.userAgent);
        this.chromeMajorVersion = getChromeMajorVersionFromUserAgent(this.userAgent);

        try {
            session.defaultSession.setUserAgent(this.userAgent);
        } catch (e) {
            // Ignore when default session is not ready yet
        }

        for (const config of Object.values(this.providers)) {
            try {
                session.fromPartition(config.partition, { cache: true }).setUserAgent(this.userAgent);
            } catch (e) {
                // Ignore session update failures and continue
            }
        }
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
                    // Note: 'global' and 'Buffer' removed — sandbox:true already blocks them,
                    // and the defineProperty trap breaks polyfills (e.g. Claude's Buffer.isBuffer)
                    const electronGlobals = ['process', 'require', 'module', '__filename', '__dirname'];
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
                            { brand: "Chromium", version: "${this.chromeMajorVersion}" },
                            { brand: "Google Chrome", version: "${this.chromeMajorVersion}" },
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
                                uaFullVersion: "${this.chromeVersion}",
                                fullVersionList: [
                                    { brand: "Chromium", version: "${this.chromeVersion}" },
                                    { brand: "Google Chrome", version: "${this.chromeVersion}" },
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
            headers['sec-ch-ua'] = `"Chromium";v="${this.chromeMajorVersion}", "Google Chrome";v="${this.chromeMajorVersion}", "Not?A_Brand";v="99"`;
            headers['sec-ch-ua-mobile'] = '?0';
            headers['sec-ch-ua-platform'] = '"Windows"';
            headers['sec-ch-ua-platform-version'] = '"15.0.0"';
            headers['sec-ch-ua-full-version-list'] = `"Chromium";v="${this.chromeVersion}", "Google Chrome";v="${this.chromeVersion}", "Not?A_Brand";v="99.0.0.0"`;
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
            this.emitNavigationState(provider, view.webContents);
        });

        view.webContents.on('did-navigate-in-page', () => {
            this.emitNavigationState(provider, view.webContents);
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
            this.emitNavigationState(provider, view.webContents);
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

            const authDomains = providerMap[provider]?.authCompletionDomains || [];
            if (authDomains.some((domain) => navUrl.includes(domain))) {
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
            view.webContents.focus();

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

    getNavigationState(provider, webContents = this.getWebContents(provider)) {
        const fallbackUrl = this.providers[provider]?.url || '';
        if (!webContents || webContents.isDestroyed()) {
            return {
                provider,
                url: fallbackUrl,
                canGoBack: false,
                canGoForward: false
            };
        }

        return {
            provider,
            url: webContents.getURL() || fallbackUrl,
            canGoBack: webContents.navigationHistory.canGoBack(),
            canGoForward: webContents.navigationHistory.canGoForward()
        };
    }

    emitNavigationState(provider, webContents = this.getWebContents(provider)) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('provider-navigated', this.getNavigationState(provider, webContents));
        }
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

    goBack(provider) {
        const webContents = this.getWebContents(provider);
        if (webContents && webContents.navigationHistory.canGoBack()) {
            webContents.navigationHistory.goBack();
        }
    }

    goForward(provider) {
        const webContents = this.getWebContents(provider);
        if (webContents && webContents.navigationHistory.canGoForward()) {
            webContents.navigationHistory.goForward();
        }
    }

    async reload(provider) {
        const webContents = this.getWebContents(provider);
        if (webContents) await webContents.reload();
    }

    async isLoggedIn(provider) {
        const webContents = this.getWebContents(provider);
        if (!webContents) return false;

        try {
            const loginCheckScript = getProviderLoginCheckScript(provider);
            if (!loginCheckScript) {
                return false;
            }

            return await webContents.executeJavaScript(loginCheckScript);
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

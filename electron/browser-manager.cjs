/**
 * Browser Manager v3 - Handles Google OAuth in popup windows
 * 
 * Key fix: Google blocks BrowserView but allows BrowserWindow popup for OAuth.
 * We intercept Google login URLs and open them in a popup BrowserWindow.
 */

const { BrowserView, BrowserWindow, session, shell } = require('electron');
const path = require('path');

class BrowserManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.views = new Map(); // provider -> BrowserView
        this.activeProvider = null;
        this.isDestroyed = false;
        this.authPopups = new Map(); // Track auth popup windows

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
                url: 'https://gemini.google.com/',
                partition: 'persist:gemini',
                color: '#4285f4'
            }
        };

        // Chrome version to spoof
        this.chromeVersion = '121.0.0.0';
        this.userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.chromeVersion} Safari/537.36`;
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

        // Create session with persistent partition
        const ses = session.fromPartition(config.partition, { cache: true });

        // Set Chrome user agent
        ses.setUserAgent(this.userAgent);

        // Spoof headers to look like Chrome
        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = { ...details.requestHeaders };

            // Add Chrome-specific headers
            headers['sec-ch-ua'] = `"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"`;
            headers['sec-ch-ua-mobile'] = '?0';
            headers['sec-ch-ua-platform'] = '"Windows"';

            callback({ requestHeaders: headers });
        });

        const view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: ses,
                webSecurity: true,
                allowRunningInsecureContent: false,
                javascript: true,
                images: true,
                webgl: true,
                nativeWindowOpen: true, // Important for popup handling
                backgroundThrottling: false, // Keep running even when not visible
            }
        });

        // Store the view
        this.views.set(provider, view);

        // Inject stealth scripts when page loads
        view.webContents.on('dom-ready', () => {
            if (view.webContents.isDestroyed()) return;

            view.webContents.executeJavaScript(`
                // Mask Electron detection
                try {
                    // Only try to define if not already defined
                    if (Object.getOwnPropertyDescriptor(navigator, 'webdriver') === undefined) {
                        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    }
                    
                    // Detailed plugins
                    const pluginData = [
                        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
                    ];
                    
                    const pluginArray = {
                        length: pluginData.length,
                        item: (i) => pluginData[i],
                        namedItem: (name) => pluginData.find(p => p.name === name),
                        refresh: () => {},
                        [Symbol.iterator]: function* () { yield* pluginData; }
                    };
                    
                    for (let i = 0; i < pluginData.length; i++) {
                        pluginArray[i] = pluginData[i];
                    }
                    
                    try { Object.defineProperty(navigator, 'plugins', { get: () => pluginArray }); } catch(e) {}
                    try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch(e) {}
                    try { Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }); } catch(e) {}
                    try { Object.defineProperty(navigator, 'productSub', { get: () => '20030107' }); } catch(e) {}
                    try { Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' }); } catch(e) {}
                    
                    // Chrome runtime object - more complete
                    if (!window.chrome) {
                        window.chrome = {
                            app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } },
                            runtime: { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }, connect: function() {}, id: undefined, sendMessage: function() {} },
                            csi: function() { return { pageT: Date.now(), startE: Date.now(), onloadT: Date.now() }; },
                            loadTimes: function() { return { commitLoadTime: Date.now() / 1000, connectionInfo: 'h2', finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000, navigationType: 'navigate', npnNegotiatedProtocol: 'h2', requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true }; }
                        };
                    }
                    
                    // WebGL Vendor/Renderer spoofing
                    try {
                        const getParameter = WebGLRenderingContext.prototype.getParameter;
                        WebGLRenderingContext.prototype.getParameter = function(parameter) {
                            if (parameter === 37445) return 'Google Inc. (NVIDIA)';
                            if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                            return getParameter.call(this, parameter);
                        };
                    } catch(e) {}
                    
                    console.log('[Agent Hub] Stealth mode active');
                } catch(e) { console.log('[Agent Hub] Stealth partial:', e.message); }
            `).catch(() => { });
        });

        // Handle popups - allow OAuth to open in new window if needed
        view.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
            console.log('[BrowserManager] Popup requested:', url);

            // For Claude: Let Google OAuth happen in the same view (redirect, not popup)
            // This avoids the separate popup window issue
            if (provider === 'claude' && (url.includes('accounts.google.com') || url.includes('accounts.youtube.com'))) {
                // Navigate the current view to Google OAuth instead of popup
                view.webContents.loadURL(url);
                return { action: 'deny' };
            }

            // For other providers that need popup auth (like Gemini)
            if (url.includes('accounts.google.com') ||
                url.includes('accounts.youtube.com') ||
                url.includes('appleid.apple.com') ||
                url.includes('login.microsoftonline.com') ||
                url.includes('login.live.com')) {

                // Open in a proper BrowserWindow popup (Google allows this!)
                this.openAuthPopup(provider, url);
                return { action: 'deny' }; // We'll handle it ourselves
            }

            // For other URLs, allow normal popup
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 500,
                    height: 600,
                    webPreferences: {
                        session: ses
                    }
                }
            };
        });

        // Load the provider URL
        view.webContents.loadURL(config.url);

        // Handle console messages for debugging
        view.webContents.on('console-message', (event, level, message) => {
            if (level >= 2) {
                console.log(`[${provider}] Console:`, message.substring(0, 100));
            }
        });

        // Handle page navigation
        view.webContents.on('did-navigate', (event, url) => {
            console.log(`[${provider}] Navigated to:`, url);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-navigated', { provider, url });
            }
        });

        // Handle page load complete
        view.webContents.on('did-finish-load', () => {
            console.log(`[${provider}] Page loaded`);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('provider-loaded', { provider });
            }
        });

        return view;
    }

    /**
     * Open authentication popup - Google allows BrowserWindow for OAuth!
     */
    openAuthPopup(provider, url) {
        const config = this.providers[provider];
        const ses = session.fromPartition(config.partition, { cache: true });

        // Set user agent for the session
        ses.setUserAgent(this.userAgent);

        // Create a proper browser window for auth
        const authWindow = new BrowserWindow({
            width: 500,
            height: 700,
            parent: this.mainWindow,
            modal: false,
            show: true,
            title: `Sign in - ${provider}`,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                session: ses, // Share session with the provider view!
                webSecurity: true,
            }
        });

        // Track this popup
        this.authPopups.set(provider, authWindow);

        // Load the auth URL
        authWindow.loadURL(url);

        // When auth is complete (user closes window or navigates back)
        authWindow.on('closed', () => {
            console.log(`[${provider}] Auth popup closed`);
            this.authPopups.delete(provider);

            // Reload the provider view to pick up the new session
            const view = this.views.get(provider);
            if (view && !view.webContents.isDestroyed()) {
                console.log(`[${provider}] Reloading after auth...`);
                view.webContents.reload();
            }
        });

        // Handle navigation - close on successful auth
        authWindow.webContents.on('did-navigate', (event, navUrl) => {
            console.log(`[Auth Popup] Navigated to:`, navUrl);

            // If we're back to the provider's main domain, auth is likely complete
            const providerDomains = {
                perplexity: 'perplexity.ai',
                chatgpt: 'openai.com',
                claude: 'claude.ai',
                gemini: 'gemini.google.com'
            };

            const domain = providerDomains[provider];
            if (domain && navUrl.includes(domain)) {
                console.log(`[${provider}] Auth complete, closing popup`);
                setTimeout(() => {
                    if (!authWindow.isDestroyed()) {
                        authWindow.close();
                    }
                }, 1000);
            }
        });
    }

    /**
     * Show a provider's browser view
     * IMPORTANT: We don't remove views anymore - just move them off-screen
     * This keeps them running so MCP can still capture responses!
     */
    showProvider(provider, bounds) {
        if (this.isDestroyed || !this.mainWindow || this.mainWindow.isDestroyed()) return null;

        // Create view if doesn't exist
        if (!this.views.has(provider)) {
            this.createView(provider);
        }

        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;

        try {
            // Make sure all views are added to the window (not removed!)
            for (const [p, v] of this.views) {
                if (!v.webContents.isDestroyed()) {
                    // Check if already added
                    const existingViews = this.mainWindow.getBrowserViews();
                    if (!existingViews.includes(v)) {
                        this.mainWindow.addBrowserView(v);
                    }

                    if (p === provider) {
                        // Show this view in the visible area
                        v.setBounds(bounds);
                    } else {
                        // Move other views off-screen (but keep them running!)
                        v.setBounds({ x: -10000, y: 0, width: bounds.width, height: bounds.height });
                    }
                }
            }

            // Bring the active view to front by re-adding it last
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

    /**
     * Hide the current browser view
     */
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

    /**
     * Get a provider's webContents for interaction
     */
    getWebContents(provider) {
        const view = this.views.get(provider);
        if (!view || view.webContents.isDestroyed()) return null;
        return view.webContents;
    }

    /**
     * Execute JavaScript in a provider's page
     */
    async executeScript(provider, script) {
        const webContents = this.getWebContents(provider);
        if (!webContents) {
            throw new Error(`Provider ${provider} not initialized`);
        }
        return await webContents.executeJavaScript(script);
    }

    /**
     * Navigate to a URL
     */
    async navigate(provider, url) {
        const webContents = this.getWebContents(provider);
        if (!webContents) {
            this.createView(provider);
            const newWebContents = this.getWebContents(provider);
            if (newWebContents) {
                await newWebContents.loadURL(url);
            }
            return;
        }
        await webContents.loadURL(url);
    }

    /**
     * Reload the page
     */
    async reload(provider) {
        const webContents = this.getWebContents(provider);
        if (webContents) {
            await webContents.reload();
        }
    }

    /**
     * Check if a provider is logged in - SIMPLE & RELIABLE
     */
    async isLoggedIn(provider) {
        const webContents = this.getWebContents(provider);
        if (!webContents) return false;

        try {
            switch (provider) {
                case 'perplexity':
                    return await webContents.executeJavaScript(`
                        (function() {
                            // Negative check: If "Log in" or "Sign Up" button exists, we are NOT logged in
                            const buttons = Array.from(document.querySelectorAll('button, a'));
                            const hasLoginBtn = buttons.some(b => b.innerText === 'Log in' || b.innerText === 'Sign Up');
                            if (hasLoginBtn) return false;

                            // Positive check: Look for logged-in indicators
                            // 1. User avatar/profile in bottom left
                            const hasAvatar = !!document.querySelector('img[alt*="Avatar"]') || 
                                            !!document.querySelector('div[class*="avatar"]');
                            
                            // 2. "Pro" badge or text
                            const hasPro = document.body.innerText.includes('Pro Account') || 
                                         document.body.innerText.includes('perplexity pro') ||
                                         !!document.querySelector('[class*="ProTag"]');
                            
                            // 3. Input box presence (means we can chat)
                            const hasInput = !!document.querySelector('textarea') || 
                                           !!document.querySelector('[contenteditable="true"]');

                            return (!hasLoginBtn) && (hasAvatar || hasPro || hasInput);
                        })()
                    `);
                case 'chatgpt':
                    // Simple: If textarea exists and no login modal, we're logged in
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('#prompt-textarea');
                            const hasLoginModal = !!document.querySelector('[data-testid="login-button"]');
                            return hasInput && !hasLoginModal;
                        })()
                    `);
                case 'claude':
                    // Simple: Content editable input means logged in
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('[contenteditable="true"]');
                            const hasLoginPage = window.location.href.includes('/login');
                            return hasInput && !hasLoginPage;
                        })()
                    `);
                case 'gemini':
                    // Simple: Input editor exists
                    return await webContents.executeJavaScript(`
                        (function() {
                            const hasInput = !!document.querySelector('.ql-editor') ||
                                           !!document.querySelector('[contenteditable="true"]') ||
                                           !!document.querySelector('rich-textarea');
                            return hasInput;
                        })()
                    `);
                default:
                    return false;
            }
        } catch (e) {
            console.error('Login check error:', e);
            return false;
        }
    }

    /**
     * Manually trigger Google sign-in popup
     */
    openGoogleSignIn(provider) {
        const config = this.providers[provider];
        if (!config) return;

        // Open Google sign-in in popup
        this.openAuthPopup(provider, 'https://accounts.google.com/');
    }

    /**
     * Get all initialized providers
     */
    getInitializedProviders() {
        return Array.from(this.views.keys());
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Cleanup all views
     */
    destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        // Close any auth popups
        for (const [provider, popup] of this.authPopups) {
            try {
                if (!popup.isDestroyed()) {
                    popup.close();
                }
            } catch (e) { }
        }
        this.authPopups.clear();

        // Remove all views from the window
        for (const [provider, view] of this.views) {
            try {
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.removeBrowserView(view);
                }
            } catch (e) { }
        }

        // Destroy the webContents
        for (const [provider, view] of this.views) {
            try {
                if (!view.webContents.isDestroyed()) {
                    view.webContents.destroy();
                }
            } catch (e) { }
        }

        this.views.clear();
        this.activeProvider = null;
    }
}

module.exports = BrowserManager;

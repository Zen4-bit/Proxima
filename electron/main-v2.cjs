// Proxima main process — embedded browser + anti-detection + IPC server

const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const BrowserManager = require('./browser-manager.cjs');
const { initRestAPI, startRestAPI } = require('./rest-api.cjs');

// Anti-detection: must run before any Electron APIs
// These MUST be set before app is ready or any windows are created

// Clean Chrome UA matching Electron 33's Chromium 130
const CHROME_VERSION = '130.0.6723.191';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

// 1. Set user agent at Chromium COMMAND LINE level 
//    This affects the INTERNAL sec-ch-ua brand generation in Chromium
app.commandLine.appendSwitch('user-agent', CHROME_UA);

// 2. Disable automation detection flags
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// 3. Disable features that leak Electron identity
app.commandLine.appendSwitch('disable-features', 'ElectronSerialChooser,OutOfBlinkCors');

// 4. Set the app-wide fallback user agent
//    This affects navigator.userAgent AND sec-ch-ua hint headers for ALL sessions
app.userAgentFallback = CHROME_UA;

// 5. On ready, also clean all session user agents
app.on('ready', () => {
    // Clean default session
    session.defaultSession.setUserAgent(CHROME_UA);
});


// Store user settings
const userDataPath = app.getPath('userData');
const settingsPath = path.join(userDataPath, 'settings.json');
const enabledProvidersPath = path.join(userDataPath, 'enabled-providers.json');

let mainWindow;
let browserManager;
let ipcServer; // For MCP server communication

// Default settings
const defaultSettings = {
    providers: {
        perplexity: { enabled: true, loggedIn: false },
        chatgpt: { enabled: true, loggedIn: false },
        claude: { enabled: false, loggedIn: false },
        gemini: { enabled: true, loggedIn: false }
    },
    ipcPort: 19222, // Port for MCP server IPC communication
    theme: 'dark',
    headlessMode: false, // When true, runs in background without visible window
    startMinimized: false // Start minimized to system tray
};

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            return { ...defaultSettings, ...saved };
        }
    } catch (e) {
        console.error('Error loading settings:', e);
    }
    return defaultSettings;
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('Error saving settings:', e);
    }
}

function saveEnabledProviders(settings) {
    try {
        const enabled = Object.entries(settings.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        // Primary: Save to user data folder (AppData) — this ALWAYS works
        // The MCP server reads from here first
        fs.writeFileSync(enabledProvidersPath, JSON.stringify({ enabled }, null, 2));

        // Secondary: Also try to save to the app's src folder for MCP server fallback
        // This may fail in packaged app if installed in Program Files (needs admin)
        // That's OK — MCP server reads from AppData first anyway
        try {
            const isDev = !app.isPackaged;
            const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
            const mcpConfigPath = isDev
                ? path.join(__dirname, '..', 'src', 'enabled-providers.json')
                : path.join(resourcesPath, 'app.asar.unpacked', 'src', 'enabled-providers.json');

            fs.writeFileSync(mcpConfigPath, JSON.stringify({ enabled }, null, 2));
        } catch (e2) {
            // Not critical — AppData version is the primary source of truth
            console.log('[Settings] Could not write to app directory (normal in installed mode)');
        }
    } catch (e) {
        console.error('Error saving enabled providers:', e);
    }
}

// Cookie backup/restore — survive app restarts
const cookieBackupDir = path.join(userDataPath, 'cookie-backups');

async function backupCookies(provider, ses) {
    try {
        // Ensure backup directory exists
        if (!fs.existsSync(cookieBackupDir)) {
            fs.mkdirSync(cookieBackupDir, { recursive: true });
        }

        // Get all cookies from the session
        const allCookies = await ses.cookies.get({});

        // Save them with metadata
        const backup = {
            provider,
            timestamp: Date.now(),
            cookies: allCookies.map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite: c.sameSite || 'no_restriction',
                expirationDate: c.expirationDate || (Math.floor(Date.now() / 1000) + 2 * 24 * 60 * 60)
            }))
        };

        const backupPath = path.join(cookieBackupDir, `${provider}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

    } catch (e) {
        console.error(`[Cookie Backup] Error backing up ${provider}:`, e.message);
    }
}

async function restoreCookies(provider, ses) {
    try {
        const backupPath = path.join(cookieBackupDir, `${provider}.json`);
        if (!fs.existsSync(backupPath)) {
            return false;
        }

        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

        // Check if backup is too old (> 3 days)
        const maxAge = 3 * 24 * 60 * 60 * 1000; // 3 days in ms
        if (Date.now() - backup.timestamp > maxAge) {

            fs.unlinkSync(backupPath);
            return false;
        }

        // Check if there are already valid cookies in the session
        const existing = await ses.cookies.get({});
        if (existing.length > 5) {
            // Session already has cookies, probably still valid

            return true;
        }

        // Restore cookies with refreshed expiration
        const twoDaysFromNow = Math.floor(Date.now() / 1000) + (2 * 24 * 60 * 60);
        let restored = 0;

        for (const cookie of backup.cookies) {
            try {
                const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                const url = `http${cookie.secure !== false ? 's' : ''}://${domain}${cookie.path || '/'}`;

                await ses.cookies.set({
                    url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly === true,
                    sameSite: cookie.sameSite || 'no_restriction',
                    // Refresh expiration on restore
                    expirationDate: Math.max(cookie.expirationDate || 0, twoDaysFromNow)
                });
                restored++;
            } catch (e) {
                // Skip individual failures silently
            }
        }

        // Flush to disk
        await ses.cookies.flushStore();

        console.log(`[Cookie Restore] Restored ${restored}/${backup.cookies.length} cookies for ${provider}`);
        return restored > 0;
    } catch (e) {
        console.error(`[Cookie Restore] Error restoring ${provider}:`, e.message);
        return false;
    }
}


function createWindow() {
    const settings = loadSettings();
    const isHeadless = settings.headlessMode || process.argv.includes('--headless');
    const startMinimized = settings.startMinimized || process.argv.includes('--minimized');

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 850,
        minWidth: 900,
        minHeight: 700,
        show: !isHeadless && !startMinimized, // Don't show if headless or minimized
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs')
        },
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: '#0f0f1a',
            symbolColor: '#ffffff',
            height: 38
        },
        backgroundColor: '#0f0f23',
        icon: path.join(__dirname, '../assets/proxima-icon.png')
    });
    mainWindow.setMaxListeners(20); // Prevent MaxListenersExceeded warning

    // Initialize browser manager
    browserManager = new BrowserManager(mainWindow);

    mainWindow.loadFile(path.join(__dirname, 'index-v2.html'));

    // Show window when ready (if not headless)
    mainWindow.once('ready-to-show', async () => {
        if (!isHeadless && !startMinimized) {
            mainWindow.show();
        }
        console.log(`[Agent Hub] Running in ${isHeadless ? 'HEADLESS' : 'VISIBLE'} mode`);
        console.log('[Agent Hub] MCP server can connect on port', settings.ipcPort || 19222);

        // Auto-initialize ALL enabled providers on startup
        const enabledProviders = Object.entries(settings.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        console.log('[Agent Hub] Auto-loading enabled providers:', enabledProviders);

        // Wait a bit for the UI to be ready
        await sleep(1000);

        // Get the browser area bounds
        const bounds = { x: 0, y: 170, width: 1200, height: 680 };
        const offScreenBounds = { x: -10000, y: 0, width: 1200, height: 680 };

        // Initialize all enabled providers (create views, add to window, navigate)
        for (let i = 0; i < enabledProviders.length; i++) {
            const provider = enabledProviders[i];
            try {
                console.log(`[Agent Hub] Initializing ${provider}...`);

                // Restore backed up cookies before loading
                const providerConfig = browserManager.providers[provider];
                if (providerConfig) {
                    const ses = session.fromPartition(providerConfig.partition, { cache: true });
                    const restored = await restoreCookies(provider, ses);
                    if (restored) {
                        console.log(`[${provider}] Cookies restored from backup`);
                    }
                }

                const view = browserManager.createView(provider);

                if (view) {
                    // Add view to window (REQUIRED for it to render!)
                    mainWindow.addBrowserView(view);

                    // Set bounds (first one visible, others off-screen)
                    if (i === 0) {
                        view.setBounds(bounds);
                    } else {
                        view.setBounds(offScreenBounds);
                    }

                    // Navigate to the provider's URL
                    const providerConfig = browserManager.providers[provider];
                    if (providerConfig && providerConfig.url) {
                        view.webContents.loadURL(providerConfig.url);
                        console.log(`[Agent Hub] Loading ${providerConfig.url} for ${provider}`);
                    }
                }

                await sleep(1500); // Give time for page to start loading
            } catch (err) {
                console.error(`[Agent Hub] Error initializing ${provider}:`, err.message);
            }
        }

        // Set the first provider as active
        if (enabledProviders.length > 0) {
            browserManager.activeProvider = enabledProviders[0];
            console.log(`[Agent Hub] ${enabledProviders[0]} set as default (already visible)`);

            // Notify renderer which provider to highlight
            mainWindow.webContents.send('set-active-provider', enabledProviders[0]);
        }

        console.log('[Agent Hub] All providers initialized and ready!');

        // Periodically backup cookies every 10 minutes
        setInterval(async () => {
            if (!browserManager || browserManager.isDestroyed) return;
            for (const provider of browserManager.getInitializedProviders()) {
                try {
                    const config = browserManager.providers[provider];
                    if (config) {
                        const ses = session.fromPartition(config.partition, { cache: true });
                        const cookies = await ses.cookies.get({});
                        if (cookies.length > 5) {
                            await backupCookies(provider, ses);
                        }
                    }
                } catch (e) { }
            }
        }, 10 * 60 * 1000); // Every 10 minutes
    });

    mainWindow.on('closed', () => {
        if (browserManager) {
            browserManager.destroy();
        }
        mainWindow = null;
    });

    // Save enabled providers on startup
    saveEnabledProviders(loadSettings());

    // Start IPC server for MCP communication
    startIPCServer();

    // Start REST API server
    try {
        const enabledList = Object.entries(loadSettings().providers)
            .filter(([_, c]) => c.enabled).map(([n]) => n);
        initRestAPI({
            handleMCPRequest,
            getEnabledProviders: () => {
                const s = loadSettings();
                return Object.entries(s.providers)
                    .filter(([_, c]) => c.enabled).map(([n]) => n);
            }
        });
        startRestAPI();
    } catch (e) {
        console.error('[REST API] Failed to start:', e.message);
    }
}

// IPC Server for MCP Communication

function startIPCServer() {
    const settings = loadSettings();
    const port = settings.ipcPort || 19222;

    ipcServer = net.createServer((socket) => {


        let buffer = '';

        socket.on('data', async (data) => {
            buffer += data.toString();

            // Process complete messages (newline-delimited JSON)
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.trim()) {
                    try {

                        const request = JSON.parse(line);
                        const response = await handleMCPRequest(request);
                        // IMPORTANT: Include requestId in response for MCP server to match!
                        response.requestId = request.requestId;
                        const responseStr = JSON.stringify(response) + '\n';

                        socket.write(responseStr);
                    } catch (e) {
                        console.error('[IPC] Error:', e.message);
                        const request = (() => { try { return JSON.parse(line); } catch { return {}; } })();
                        socket.write(JSON.stringify({ error: e.message, requestId: request.requestId }) + '\n');
                    }
                }
            }
        });

        socket.on('error', (err) => {
            console.error('[IPC] Socket error:', err);
        });
    });

    ipcServer.listen(port, '127.0.0.1', () => {
        console.log(`[IPC] Server listening on port ${port}`);
    });

    ipcServer.on('error', (err) => {
        console.error('[IPC] Server error:', err);
        // Try next port if in use
        if (err.code === 'EADDRINUSE') {
            setTimeout(() => {
                ipcServer.close();
                ipcServer.listen(port + 1, '127.0.0.1');
            }, 1000);
        }
    });
}

async function handleMCPRequest(request) {
    const { action, provider, data } = request;

    try {
        switch (action) {
            case 'ping':
                return { success: true, message: 'pong' };

            case 'getStatus':
                return {
                    success: true,
                    providers: browserManager.getInitializedProviders(),
                    activeProvider: browserManager.activeProvider
                };

            case 'initProvider':
                browserManager.createView(provider);
                return { success: true, provider };

            case 'isLoggedIn':
                const loggedIn = await browserManager.isLoggedIn(provider);
                return { success: true, provider, loggedIn };

            case 'sendMessage':
                // Check if file should be uploaded
                if (data.filePath && fileReferenceEnabled) {
                    try {

                        const uploadResult = await uploadFileToProvider(provider, data.filePath);
                        await sleep(1000); // Wait for file to attach
                        const result = await sendMessageToProvider(provider, data.message);
                        return { success: true, provider, result, fileUploaded: uploadResult };
                    } catch (fileErr) {
                        console.error('[MCP] File upload failed:', fileErr.message);
                        // Still send message even if file upload fails
                        const result = await sendMessageToProvider(provider, data.message);
                        return { success: true, provider, result, fileError: fileErr.message };
                    }
                } else {
                    const result = await sendMessageToProvider(provider, data.message);
                    return { success: true, provider, result };
                }

            case 'uploadFile':
                // Upload file only (without sending message)
                if (!fileReferenceEnabled) {
                    return { success: false, error: 'File reference is disabled. Enable it in Agent Hub settings.' };
                }
                try {
                    const uploadResult = await uploadFileToProvider(provider, data.filePath);
                    // Set flag for Perplexity file upload tracking
                    if (provider === 'perplexity') {
                        perplexityFileJustUploaded = true;

                    }
                    return { success: true, provider, ...uploadResult };
                } catch (uploadErr) {
                    return { success: false, error: uploadErr.message };
                }

            case 'sendMessageWithFile':
                // Explicitly send message with file
                if (!fileReferenceEnabled) {

                }
                try {
                    let fileResult = null;
                    if (data.filePath && fileReferenceEnabled) {

                        fileResult = await uploadFileToProvider(provider, data.filePath);

                        // Set flag for Perplexity file upload tracking
                        if (provider === 'perplexity') {
                            perplexityFileJustUploaded = true;

                        }

                        // Wait longer and verify file is attached

                        await sleep(3000);

                        // Retry check for file attachment (up to 3 times)
                        let retries = 0;
                        while (!fileResult.fileAttached && retries < 3) {

                            await sleep(2000);

                            // Re-check for attachment indicators
                            const attached = await checkFileAttachment(provider);
                            if (attached) {
                                fileResult.fileAttached = true;

                                break;
                            }
                            retries++;
                        }

                        if (!fileResult.fileAttached) {

                        }

                        // Wait for send button to be ready (file upload complete)

                        await waitForSendButton(provider);
                    }


                    const msgResult = await sendMessageToProvider(provider, data.message);
                    const responseData = await getResponseWithTypingStatus(provider);
                    return {
                        success: true,
                        provider,
                        fileUploaded: fileResult,
                        messageSent: msgResult,
                        response: responseData.response
                    };
                } catch (err) {
                    return { success: false, error: err.message };
                }

            case 'getResponse':
                const response = await getProviderResponse(provider, data.selector);
                return { success: true, provider, response };

            case 'getTypingStatus':
                // Check if AI is currently typing/generating
                const typingStatus = await isAITyping(provider);
                return { success: true, provider, ...typingStatus };

            case 'getResponseWithTyping':
                // Smart response capture - waits for typing to start and stop
                const smartResponse = await getResponseWithTypingStatus(provider);
                return {
                    success: true,
                    provider,
                    typingStarted: smartResponse.typingStarted,
                    typingStopped: smartResponse.typingStopped,
                    response: smartResponse.response
                };

            case 'waitForSendButton':
                // Wait for send button to be visible and enabled
                const buttonReady = await waitForSendButtonReady(provider);
                return { success: true, provider, ready: buttonReady };

            case 'executeScript':
                const scriptResult = await browserManager.executeScript(provider, data.script);
                return { success: true, provider, result: scriptResult };

            case 'navigate':
                await browserManager.navigate(provider, data.url);
                return { success: true, provider };

            case 'newConversation':
                await startNewConversation(provider);
                return { success: true, provider };

            case 'debugDOM':
                // Debug: Inspect DOM structure to find correct selectors
                const debugInfo = await browserManager.executeScript(provider, `
                    (function() {
                        const info = {
                            url: window.location.href,
                            host: window.location.host,
                            articles: document.querySelectorAll('article').length,
                            proseElements: document.querySelectorAll('.prose').length,
                            markdownElements: document.querySelectorAll('.markdown').length,
                            divs: document.querySelectorAll('div').length
                        };
                        
                        // Get sample of article contents
                        const articles = document.querySelectorAll('article');
                        info.articleSamples = [];
                        for (let i = 0; i < Math.min(3, articles.length); i++) {
                            const art = articles[i];
                            info.articleSamples.push({
                                classes: art.className,
                                dataAttrs: art.dataset,
                                hasProseChild: !!art.querySelector('.prose'),
                                hasMarkdownChild: !!art.querySelector('.markdown'),
                                textPreview: art.innerText.substring(0, 100)
                            });
                        }
                        
                        // Get sample of prose elements
                        const proseEls = document.querySelectorAll('.prose');
                        info.proseSamples = [];
                        for (let i = 0; i < Math.min(3, proseEls.length); i++) {
                            info.proseSamples.push({
                                tag: proseEls[i].tagName,
                                classes: proseEls[i].className,
                                textPreview: proseEls[i].innerText.substring(0, 150)
                            });
                        }
                        
                        return info;
                    })()
                `);

                return { success: true, provider, debugInfo };

            // Window visibility controls (for headless mode)
            case 'showWindow':
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
                return { success: true, visible: true };

            case 'hideWindow':
                if (mainWindow) {
                    mainWindow.hide();
                }
                return { success: true, visible: false };

            case 'toggleWindow':
                if (mainWindow) {
                    if (mainWindow.isVisible()) {
                        mainWindow.hide();
                    } else {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
                return { success: true, visible: mainWindow?.isVisible() };

            case 'isWindowVisible':
                return { success: true, visible: mainWindow?.isVisible() || false };

            case 'getSettings':
                return { success: true, settings: loadSettings() };

            case 'setHeadlessMode':
                const settings = loadSettings();
                settings.headlessMode = data.enabled;
                saveSettings(settings);
                if (data.enabled && mainWindow) {
                    mainWindow.hide();
                } else if (!data.enabled && mainWindow) {
                    mainWindow.show();
                }
                return { success: true, headlessMode: data.enabled };

            default:
                return { success: false, error: `Unknown action: ${action}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Provider-Specific Interaction Functions

async function sendMessageToProvider(provider, message) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    // CRITICAL: Clear the network interceptor's captured response BEFORE sending new message
    // This prevents old conversation data from being mixed into the new response
    try {
        await webContents.executeJavaScript(`
            window.__proxima_captured_response = '';
            window.__proxima_is_streaming = false;
            window.__proxima_last_capture_time = 0;
            window.__proxima_active_stream_id = null;
            if (window.__proxima_blocks) window.__proxima_blocks = {};
        `);
    } catch (e) {
        // Silent — non-critical
    }

    switch (provider) {
        case 'perplexity':
            return await sendToPerplexity(webContents, message);
        case 'chatgpt':
            return await sendToChatGPT(webContents, message);
        case 'claude':
            return await sendToClaude(webContents, message);
        case 'gemini':
            return await sendToGemini(webContents, message);
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

async function sendToPerplexity(webContents, message) {
    console.log('[Perplexity] Sending message...');

    // Only navigate to home if NOT on Perplexity at all - STAY in same conversation
    const currentUrl = await webContents.executeJavaScript('window.location.href');
    if (!currentUrl.includes('perplexity.ai')) {
        await webContents.loadURL('https://www.perplexity.ai/');
        await sleep(2000);
    }

    // IMPORTANT: Capture the OLD response fingerprint BEFORE sending new message
    const oldResponseData = await webContents.executeJavaScript(`
        (function() {
            const proseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                .filter(block => {
                    const text = block.textContent.trim();
                    return text.length > 3 && 
                           !text.toLowerCase().includes('perplexity pro') &&
                           !text.includes('Ask anything') &&
                           !text.includes('Ask a follow-up') &&
                           !text.includes('Attach');
                });
            
            if (proseBlocks.length > 0) {
                const lastBlock = proseBlocks[proseBlocks.length - 1];
                return {
                    count: proseBlocks.length,
                    fingerprint: lastBlock.textContent.substring(0, 200).trim()
                };
            }
            return { count: 0, fingerprint: '' };
        })()
    `).catch(() => ({ count: 0, fingerprint: '' }));

    global.perplexityOldFingerprint = oldResponseData.fingerprint;
    global.perplexityOldBlockCount = oldResponseData.count;
    console.log('[Perplexity] Old response data:', { count: oldResponseData.count, fingerprint: oldResponseData.fingerprint.substring(0, 50) + '...' });

    // Step 1: Focus the input area
    for (let focusAttempt = 0; focusAttempt < 3; focusAttempt++) {
        await webContents.executeJavaScript(`
            (function() {
                const followUp = document.querySelector('textarea[placeholder*="follow"]') ||
                                document.querySelector('textarea[placeholder*="Ask"]');
                if (followUp) {
                    followUp.click();
                    followUp.focus();
                    return 'followUp';
                }
                const inputArea = document.querySelector('[contenteditable="true"]') ||
                                 document.querySelector('textarea');
                if (inputArea) {
                    inputArea.click();
                    inputArea.focus();
                    return 'input';
                }
                return 'none';
            })()
        `);
        await sleep(300);
    }

    await sleep(500);

    // Step 2: Insert message using clipboard paste (ALWAYS - works with or without file)
    const { clipboard } = require('electron');
    const oldClipboard = clipboard.readText();
    clipboard.writeText(message);

    // Paste with Ctrl+V
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });

    await sleep(500); // Wait for paste to complete

    // Restore clipboard
    clipboard.writeText(oldClipboard);
    console.log('[Perplexity] Message pasted via clipboard');

    // Step 3: Verify message was typed before sending
    const messageInInput = await webContents.executeJavaScript(`
        (function() {
            const input = document.activeElement;
            if (!input) return '';
            return (input.value || input.textContent || '').trim();
        })()
    `).catch(() => '');

    if (!messageInInput.includes(message.substring(0, 20))) {
        console.log('[Perplexity] WARNING: Message not found in input, retrying paste...');
        clipboard.writeText(message);
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
        await sleep(500);
        clipboard.writeText(oldClipboard);
    }

    await sleep(300);

    // Step 4: Submit with Enter key
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });

    console.log('[Perplexity] Enter key sent');
    await sleep(500);

    return { sent: true, oldFingerprint: oldResponseData.fingerprint };
}

async function sendToChatGPT(webContents, message) {
    // IMPORTANT: Capture current response fingerprint BEFORE sending new message
    // This helps us detect when the NEW response appears
    const oldResponseFingerprint = await webContents.executeJavaScript(`
        (function() {
            // Get all assistant messages
            const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (assistantMsgs.length > 0) {
                const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                const text = (lastMsg.innerText || lastMsg.textContent || '').trim();
                // Return first 200 chars as fingerprint
                return text.substring(0, 200);
            }
            // Fallback to article > .prose
            const articles = document.querySelectorAll('article');
            if (articles.length > 0) {
                const lastArticle = articles[articles.length - 1];
                const text = (lastArticle.innerText || lastArticle.textContent || '').trim();
                return text.substring(0, 200);
            }
            return '';
        })()
    `).catch(() => '');

    // Store fingerprint globally for response capture
    global.chatgptOldFingerprint = oldResponseFingerprint;
    console.log('[ChatGPT] Captured old response fingerprint:', oldResponseFingerprint.substring(0, 50) + '...');

    // Focus input field
    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('#prompt-textarea') || 
                          document.querySelector('textarea[data-id="root"]') ||
                          document.querySelector('textarea') ||
                          document.querySelector('[contenteditable="true"]');
            if (input) {
                input.focus();
                if (input.value !== undefined) input.value = '';
                return true;
            }
            return false;
        })()
    `);

    await typeIntoPage(webContents, message);
    await sleep(300);

    // Ensure focus is on input before pressing Enter
    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('#prompt-textarea') || 
                          document.querySelector('textarea') ||
                          document.querySelector('[contenteditable="true"]');
            if (input) input.focus();
        })()
    `);

    await sleep(100);

    // Try button click first (more reliable for ChatGPT's new UI)
    const clicked = await webContents.executeJavaScript(`
        (function() {
            const btn = document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label*="Send"]');
            if (btn && !btn.disabled) {
                btn.click();
                return true;
            }
            return false;
        })()
    `);

    // If button click failed, try Enter key
    if (!clicked) {
        await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }

    return { sent: true };
}

async function sendToClaude(webContents, message) {
    // IMPORTANT: Capture current response fingerprint BEFORE sending new message
    // This helps us detect when the NEW response appears
    const oldResponseFingerprint = await webContents.executeJavaScript(`
        (function() {
            // Get all prose/response blocks
            const responses = document.querySelectorAll('.prose, [class*="prose"], [class*="message-content"]');
            if (responses.length > 0) {
                const lastResponse = responses[responses.length - 1];
                const text = (lastResponse.innerText || lastResponse.textContent || '').trim();
                // Return first 200 chars as fingerprint
                return text.substring(0, 200);
            }
            return '';
        })()
    `).catch(() => '');

    // Store fingerprint globally for response capture
    global.claudeOldFingerprint = oldResponseFingerprint;
    console.log('[Claude] Captured old response fingerprint:', oldResponseFingerprint.substring(0, 50) + '...');

    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('[contenteditable="true"]') ||
                          document.querySelector('div[data-placeholder*="Reply"]');
            if (input) {
                input.focus();
                input.innerHTML = '';
                return true;
            }
            return false;
        })()
    `);

    await typeIntoPage(webContents, message);
    await sleep(200);

    // Simple & reliable: Press Enter key
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    return { sent: true };
}

async function sendToGemini(webContents, message) {
    console.log('[Gemini] Sending message...');

    // IMPORTANT: Capture current response fingerprint BEFORE sending new message
    // This helps us detect when the NEW response appears
    const oldResponseFingerprint = await webContents.executeJavaScript(`
        (function() {
            // Try multiple selectors for Gemini responses
            const selectors = [
                'message-content',
                '.message-content',
                '[class*="response-content"]',
                '.model-response',
                '[class*="model-response"]',
                '[class*="markdown"]'
            ];
            
            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    const lastEl = elements[elements.length - 1];
                    const text = (lastEl.innerText || lastEl.textContent || '').trim();
                    if (text.length > 10) {
                        return text.substring(0, 200);
                    }
                }
            }
            return '';
        })()
    `).catch(() => '');

    // Store fingerprint globally for response capture
    global.geminiOldFingerprint = oldResponseFingerprint;
    console.log('[Gemini] Captured old response fingerprint:', oldResponseFingerprint.substring(0, 50) + '...');

    // Wait a bit for page to be fully ready
    await sleep(500);


    // Step 1: Find and focus the input
    const inputFound = await webContents.executeJavaScript(`
        (function() {
            // Try multiple input selectors for Gemini
            const selectors = [
                'rich-textarea .ql-editor',
                '.ql-editor',
                'rich-textarea [contenteditable="true"]', 
                '[contenteditable="true"][aria-label*="message"]',
                '[contenteditable="true"]',
                'textarea[aria-label*="message"]',
                'textarea',
                'input[type="text"]'
            ];
            
            for (const selector of selectors) {
                const input = document.querySelector(selector);
                if (input) {
                    input.focus();
                    input.click();
                    console.log('[Gemini] Found input:', selector);
                    return { found: true, selector: selector };
                }
            }
            return { found: false };
        })()
    `);

    console.log('[Gemini] Input search result:', inputFound);

    if (!inputFound.found) {
        console.log('[Gemini] No input found!');
        return { sent: false, error: 'No input field found' };
    }

    await sleep(300);

    // Step 2: Type the message using keyboard simulation (Trusted Types compatible)
    const typeResult = await webContents.executeJavaScript(`
        (function() {
            const text = ${JSON.stringify(message)};
            const active = document.activeElement;
            
            if (active) {
                if (active.contentEditable === 'true' || active.isContentEditable) {
                    // DON'T clear - just append to preserve file attachments
                    // Create paragraph with textContent (Trusted Types safe)
                    const p = document.createElement('p');
                    p.textContent = text;
                    active.appendChild(p);
                    
                    // Trigger input events
                    active.dispatchEvent(new Event('input', { bubbles: true }));
                    active.dispatchEvent(new Event('change', { bubbles: true }));
                    return { success: true, method: 'contenteditable' };
                } else if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
                    active.value = text;
                    active.dispatchEvent(new Event('input', { bubbles: true }));
                    return { success: true, method: 'input' };
                }
            }
            
            // Fallback: Try ql-editor directly
            const qlEditor = document.querySelector('.ql-editor, rich-textarea .ql-editor');
            if (qlEditor) {
                // DON'T clear - just append
                const p = document.createElement('p');
                p.textContent = text;
                qlEditor.appendChild(p);
                qlEditor.dispatchEvent(new Event('input', { bubbles: true }));
                return { success: true, method: 'ql-editor-fallback' };
            }
            
            return { success: false };
        })()
    `);

    console.log('[Gemini] Type result:', typeResult);
    await sleep(300);

    // Re-focus input area to ensure Enter works
    await webContents.executeJavaScript(`
        (function() {
            const input = document.querySelector('rich-textarea .ql-editor, .ql-editor, [contenteditable="true"]');
            if (input) {
                input.focus();
            }
        })()
    `);
    await sleep(100);

    // Send with Enter key only
    await webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    await webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

    return { sent: true };
}

// Wait for send button to be visible and enabled (after file upload)
async function waitForSendButtonReady(provider) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) return false;

    // Gemini already handles file upload wait in uploadFileToProvider, skip here
    if (provider === 'gemini') {
        console.log(`[waitForSendButton] Gemini: Skipping (handled in file upload)`);
        return true;
    }

    console.log(`[waitForSendButton] Waiting for ${provider} send button...`);

    const maxWait = 10000; // 10 seconds max (reduced from 30)
    const checkInterval = 200; // faster checks
    let waited = 0;

    while (waited < maxWait) {
        const isReady = await webContents.executeJavaScript(`
            (function() {
                const host = window.location.host;
                let sendBtn = null;
                
                if (host.includes('chatgpt') || host.includes('openai')) {
                    sendBtn = document.querySelector('[data-testid="send-button"]') ||
                              document.querySelector('button[aria-label*="Send"]');
                } else if (host.includes('claude')) {
                    sendBtn = document.querySelector('button[aria-label*="Send"]') ||
                              document.querySelector('button:has(svg)');
                } else if (host.includes('gemini')) {
                    sendBtn = document.querySelector('button[aria-label*="Send"]') ||
                              document.querySelector('button.send-button');
                } else if (host.includes('perplexity')) {
                    sendBtn = document.querySelector('button[aria-label*="Submit"]') ||
                              document.querySelector('button[type="submit"]');
                }
                
                if (sendBtn) {
                    const isDisabled = sendBtn.disabled || sendBtn.hasAttribute('disabled');
                    const isVisible = sendBtn.offsetParent !== null || sendBtn.offsetWidth > 0;
                    return !isDisabled && isVisible;
                }
                
                // No button found - might be ready for Enter key
                return true;
            })()
        `).catch(() => true);

        if (isReady) {
            console.log(`[waitForSendButton] ${provider}: Send button ready!`);
            return true;
        }

        await sleep(checkInterval);
        waited += checkInterval;
    }

    console.log(`[waitForSendButton] ${provider}: Timeout waiting for send button`);
    return false;
}

async function typeIntoPage(webContents, text) {
    // SIMPLE & RELIABLE: Directly set value via JavaScript
    // No clipboard permissions needed, works instantly

    await webContents.executeJavaScript(`
        (function() {
            const text = ${JSON.stringify(text)};
            const active = document.activeElement;
            
            if (active) {
                if (active.contentEditable === 'true') {
                    // ContentEditable (Claude, Gemini)
                    active.innerText = text;
                    active.dispatchEvent(new Event('input', { bubbles: true }));
                } else if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
                    // Textarea/Input (ChatGPT, Perplexity)
                    active.value = text;
                    active.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            
            // Also try by selector as backup
            const textarea = document.querySelector('#prompt-textarea') || 
                           document.querySelector('textarea[placeholder*="Ask"]') ||
                           document.querySelector('textarea');
            if (textarea && !textarea.value) {
                textarea.value = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            const contentEditable = document.querySelector('[contenteditable="true"]');
            if (contentEditable && !contentEditable.innerText.trim()) {
                contentEditable.innerText = text;
                contentEditable.dispatchEvent(new Event('input', { bubbles: true }));
            }
        })()
    `);

    // Small delay for UI to update
    await sleep(100);
}

async function getResponseWithTypingStatus(provider) {
    console.log(`[getResponseWithTyping] Starting for ${provider}...`);

    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    // Capture OLD fingerprint BEFORE getting response (for detecting new vs old responses)
    try {
        if (provider === 'perplexity') {
            const oldData = await webContents.executeJavaScript(`
                (function() {
                    const proseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                        .filter(block => {
                            const text = block.textContent.trim();
                            return text.length > 3 && 
                                   !text.toLowerCase().includes('perplexity pro') &&
                                   !text.includes('Ask anything') &&
                                   !text.includes('Ask a follow-up') &&
                                   !text.includes('Attach');
                        });
                    if (proseBlocks.length > 0) {
                        const lastBlock = proseBlocks[proseBlocks.length - 1];
                        return {
                            count: proseBlocks.length,
                            fingerprint: lastBlock.textContent.substring(0, 200).trim()
                        };
                    }
                    return { count: 0, fingerprint: '' };
                })()
            `).catch(() => ({ count: 0, fingerprint: '' }));
            global.perplexityOldFingerprint = oldData.fingerprint;
            global.perplexityOldBlockCount = oldData.count;
            console.log(`[Perplexity] Captured old response fingerprint: ${oldData.fingerprint.substring(0, 50)}...`);
        } else if (provider === 'claude') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    const selectors = [
                        '[data-is-streaming]', '.font-claude-message',
                        '[class*="claude"][class*="message"]',
                        '[class*="response"][class*="content"]',
                        '[class*="assistant"][class*="message"]'
                    ];
                    for (const sel of selectors) {
                        const els = document.querySelectorAll(sel);
                        if (els.length > 0) {
                            return els[els.length - 1].textContent.substring(0, 200).trim();
                        }
                    }
                    const proseBlocks = document.querySelectorAll('.prose, [class*="prose"]');
                    if (proseBlocks.length > 0) {
                        return proseBlocks[proseBlocks.length - 1].textContent.substring(0, 200).trim();
                    }
                    return '';
                })()
            `).catch(() => '');
            global.claudeOldFingerprint = oldFp;
            console.log(`[Claude] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        } else if (provider === 'chatgpt') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
                    if (msgs.length > 0) {
                        return msgs[msgs.length - 1].textContent.substring(0, 200).trim();
                    }
                    return '';
                })()
            `).catch(() => '');
            console.log(`[ChatGPT] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        } else if (provider === 'gemini') {
            const oldFp = await webContents.executeJavaScript(`
                (function() {
                    const msgs = document.querySelectorAll('message-content, .message-content, [class*="response-content"]');
                    if (msgs.length > 0) {
                        return msgs[msgs.length - 1].textContent.substring(0, 200).trim();
                    }
                    return '';
                })()
            `).catch(() => '');
            console.log(`[Gemini] Captured old response fingerprint: ${oldFp.substring(0, 50)}...`);
        }
    } catch (e) {
        console.error(`[getResponseWithTyping] Error capturing old fingerprint for ${provider}:`, e.message);
    }

    // Now get the actual response
    const response = await getProviderResponse(provider);

    return {
        typingStarted: true,
        typingStopped: true,
        response
    };
}

async function getProviderResponse(provider, customSelector = null) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    // Fast path: grab from network interceptor instead of waiting for DOM

    const maxWaitSeconds = (provider === 'claude') ? 600 : 120; // 5 min Claude, 2 min others
    const maxPolls = maxWaitSeconds * 2; // polling every 500ms
    let networkGotResponse = false;

    console.log(`[getProviderResponse] ⚡ ${provider}: Network interceptor polling (fast path)...`);

    for (let i = 0; i < maxPolls; i++) {
        try {
            const status = await webContents.executeJavaScript(`
                (function() {
                    return {
                        response: window.__proxima_captured_response || '',
                        isStreaming: window.__proxima_is_streaming || false,
                        lastCaptureTime: window.__proxima_last_capture_time || 0,
                        installed: !!window.__proxima_fetch_intercepted
                    };
                })()
            `);

            // Interceptor not installed — skip to DOM fallback
            if (!status.installed) {
                console.log(`[getProviderResponse] ${provider}: Interceptor not installed, using DOM fallback`);
                break;
            }

            // Stream started and has content
            if (status.response.length > 0) {
                // Stream is DONE — return immediately!
                if (!status.isStreaming) {
                    console.log(`[getProviderResponse] ⚡ ${provider}: Network capture COMPLETE! ${status.response.length} chars (poll #${i})`);
                    // Clear for next use
                    await webContents.executeJavaScript(`window.__proxima_captured_response = ''`);
                    networkGotResponse = true;
                    return status.response;
                }

                // Still streaming — log progress every 5 seconds
                if (i % 10 === 0 && i > 0) {
                    console.log(`[getProviderResponse] ${provider}: Still streaming... ${status.response.length} chars captured`);
                }
            }

            // No content yet — waiting for stream to start
            // If no stream activity after 2 seconds, fall back to DOM quickly
            // (Gemini/Perplexity don't use fetch, so interceptor won't capture them)
            // Also handles case where interceptor matched URL but parser failed (ChatGPT)
            if (i > 3 && !status.isStreaming && status.response.length === 0) {
                console.log(`[getProviderResponse] ${provider}: No usable stream data after ${i * 0.5}s, trying DOM fallback`);
                break;
            }

        } catch (e) {
            // webContents might be navigating, retry
            if (i > 40) {
                console.log(`[getProviderResponse] ${provider}: Interceptor error, falling back to DOM`);
                break;
            }
        }

        await sleep(500);
    }

    // Slow path: DOM scraping fallback (interceptor missed or not installed)

    if (!networkGotResponse) {
        console.log(`[getProviderResponse] ${provider}: Using DOM fallback path...`);

        // Get old fingerprint for detecting new responses
        let oldFingerprint = '';
        let oldBlockCount = 0;
        if (provider === 'perplexity') {
            oldFingerprint = global.perplexityOldFingerprint || '';
            oldBlockCount = global.perplexityOldBlockCount || 0;
        } else if (provider === 'claude') {
            oldFingerprint = global.claudeOldFingerprint || '';
        }

        // Smart typing wait — check if AI is currently typing, wait only if needed
        try {
            const typingNow = await isAITyping(provider);
            if (typingNow.isTyping) {
                console.log(`[getProviderResponse] ${provider}: AI still typing, waiting...`);
                const maxTypingWait = (provider === 'claude') ? 600 : 120;
                for (let i = 0; i < maxTypingWait; i++) {
                    const ts = await isAITyping(provider);
                    if (!ts.isTyping) break;
                    if (i % 20 === 0 && i > 0) {
                        console.log(`[getProviderResponse] ${provider}: Still typing (${i * 0.5}s)...`);
                    }
                    await sleep(500);
                }
            }
        } catch (e) { }

        // Small delay for DOM to settle (Perplexity needs more time for math/LaTeX rendering)
        await sleep((provider === 'claude' || provider === 'perplexity') ? 1500 : 500);

        // One more try — maybe interceptor caught it while DOM was settling
        try {
            const lateCheck = await webContents.executeJavaScript(`
                (function() {
                    var resp = window.__proxima_captured_response || '';
                    if (resp.length > 50) {
                        window.__proxima_captured_response = '';
                        return resp;
                    }
                    return '';
                })()
            `);
            if (lateCheck && lateCheck.length > 50) {
                console.log(`[getProviderResponse] ✅ ${provider}: Late network capture (${lateCheck.length} chars)`);
                return lateCheck;
            }
        } catch (e) { }

        // STEP 4: DOM polling for response text
        let lastText = '';
        let stableCount = 0;
        // Perplexity math/LaTeX renders in stages — need more stability checks
        const STABLE_THRESHOLD = provider === 'perplexity' ? 5 : 3;
        const MAX_POLLS = (provider === 'claude' || provider === 'perplexity') ? 60 : 40;
        let foundNewResponse = false;


        // Poll for stable response
        for (let i = 0; i < MAX_POLLS; i++) {
            const text = await webContents.executeJavaScript(`
            (function() {
                const host = window.location.host;
                
                // DOM to Markdown Converter
                const NL = String.fromCharCode(10);  // Actual newline character
                
                function domToMarkdown(element) {
                    if (!element) return '';
                    
                    let markdown = '';
                    const children = element.childNodes;
                    
                    for (let i = 0; i < children.length; i++) {
                        const node = children[i];
                        
                        // Text node
                        if (node.nodeType === 3) {
                            markdown += node.textContent;
                            continue;
                        }
                        
                        // Element node
                        if (node.nodeType === 1) {
                            const tag = node.tagName.toLowerCase();
                            
                            // Skip hidden elements
                            if (node.style && node.style.display === 'none') continue;
                            if (node.classList && node.classList.contains('sr-only')) continue;
                            
                            // Code blocks (pre > code)
                            if (tag === 'pre') {
                                const codeEl = node.querySelector('code');
                                // Use innerText to preserve visual line breaks (especially for ChatGPT)
                                // textContent doesn't preserve newlines when lines are in separate elements
                                const codeText = codeEl ? codeEl.innerText : node.innerText;
                                // Try to detect language from class
                                let lang = '';
                                const langClass = node.className.match(/language-(\\w+)/) || 
                                                 (codeEl && codeEl.className.match(/language-(\\w+)/));
                                if (langClass) lang = langClass[1];
                                // Also check for common language indicators
                                const langSpan = node.querySelector('[class*="lang"], [class*="language"]');
                                if (!lang && langSpan) {
                                    lang = langSpan.textContent.trim().toLowerCase();
                                }
                                // Check parent for language hint
                                const parentLang = node.closest('[class*="language-"]');
                                if (!lang && parentLang) {
                                    const match = parentLang.className.match(/language-(\\w+)/);
                                    if (match) lang = match[1];
                                }
                                // Use actual newlines
                                markdown += NL + NL + '\`\`\`' + lang + NL + codeText.trim() + NL + '\`\`\`' + NL + NL;
                                continue;
                            }
                            
                            // Inline code
                            if (tag === 'code' && !node.closest('pre')) {
                                markdown += '\`' + node.textContent + '\`';
                                continue;
                            }
                            
                            // Headers
                            if (tag === 'h1') {
                                markdown += NL + NL + '# ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            if (tag === 'h2') {
                                markdown += NL + NL + '## ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            if (tag === 'h3') {
                                markdown += NL + NL + '### ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            if (tag === 'h4') {
                                markdown += NL + NL + '#### ' + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            
                            // Paragraphs
                            if (tag === 'p') {
                                markdown += NL + NL + domToMarkdown(node) + NL + NL;
                                continue;
                            }
                            
                            // Bold
                            if (tag === 'strong' || tag === 'b') {
                                markdown += '**' + domToMarkdown(node) + '**';
                                continue;
                            }
                            
                            // Italic
                            if (tag === 'em' || tag === 'i') {
                                markdown += '*' + domToMarkdown(node) + '*';
                                continue;
                            }
                            
                            // Links
                            if (tag === 'a') {
                                const href = node.getAttribute('href');
                                const text = domToMarkdown(node);
                                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                                    markdown += '[' + text + '](' + href + ')';
                                } else {
                                    markdown += text;
                                }
                                continue;
                            }
                            
                            // Lists
                            if (tag === 'ul' || tag === 'ol') {
                                markdown += NL;
                                const items = node.querySelectorAll(':scope > li');
                                items.forEach((li, idx) => {
                                    const prefix = tag === 'ol' ? (idx + 1) + '. ' : '- ';
                                    markdown += prefix + domToMarkdown(li).trim() + NL;
                                });
                                markdown += NL;
                                continue;
                            }
                            
                            // Skip list items if already processed by parent
                            if (tag === 'li') {
                                markdown += domToMarkdown(node);
                                continue;
                            }
                            
                            // Line breaks
                            if (tag === 'br') {
                                markdown += NL;
                                continue;
                            }
                            
                            // Horizontal rule
                            if (tag === 'hr') {
                                markdown += NL + NL + '---' + NL + NL;
                                continue;
                            }
                            
                            // Blockquote
                            if (tag === 'blockquote') {
                                const lines = domToMarkdown(node).split(NL);
                                markdown += NL + lines.map(l => '> ' + l).join(NL) + NL;
                                continue;
                            }
                            
                            // Tables (basic support)
                            if (tag === 'table') {
                                const rows = node.querySelectorAll('tr');
                                rows.forEach((row, rowIdx) => {
                                    const cells = row.querySelectorAll('th, td');
                                    const cellTexts = Array.from(cells).map(c => c.textContent.trim());
                                    markdown += '| ' + cellTexts.join(' | ') + ' |' + NL;
                                    if (rowIdx === 0 && row.querySelector('th')) {
                                        markdown += '| ' + cellTexts.map(() => '---').join(' | ') + ' |' + NL;
                                    }
                                });
                                markdown += NL;
                                continue;
                            }
                            
                            // Div and other containers - recurse
                            if (tag === 'div' || tag === 'span' || tag === 'section' || tag === 'article') {
                                markdown += domToMarkdown(node);
                                continue;
                            }
                            
                            // Default: just get text content for unknown elements
                            markdown += domToMarkdown(node);
                        }
                    }
                    
                    return markdown;
                }
                
                // Clean up markdown (remove excessive newlines)
                function cleanMarkdown(md) {
                    // Use RegExp with the actual NL character
                    const excessiveNL = new RegExp(NL + '{4,}', 'g');
                    return md
                        .replace(excessiveNL, NL + NL + NL)  // Max 3 newlines
                        .replace(/^\\s+/, '')                // Trim start
                        .replace(/\\s+$/, '')                // Trim end
                        .trim();
                }
                
                // ChatGPT specific - use [data-message-author-role="assistant"]
                if (host.includes('chatgpt') || host.includes('openai')) {
                    const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
                    if (assistantMsgs.length > 0) {
                        const lastMsg = assistantMsgs[assistantMsgs.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastMsg));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    // Fallback to article > .prose
                    const articles = document.querySelectorAll('article');
                    for (let j = articles.length - 1; j >= 0; j--) {
                        const article = articles[j];
                        const content = article.querySelector('.prose, .markdown, [class*="markdown"]');
                        if (content) {
                            const markdown = cleanMarkdown(domToMarkdown(content));
                            if (markdown && markdown.length > 0 && !markdown.includes('__oai_')) return markdown;
                        }
                    }
                }
                
                // Perplexity specific - Capture the FULL last/newest answer
                if (host.includes('perplexity')) {
                    // Get all prose blocks
                    const allProseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                        .filter(block => {
                            const text = block.textContent.trim();
                            return text.length > 3 && 
                                   !text.toLowerCase().includes('perplexity pro') &&
                                   !text.includes('Ask anything') &&
                                   !text.includes('Ask a follow-up') &&
                                   !text.includes('Attach');
                        });
                    
                    if (allProseBlocks.length > 0) {
                        // Get the LAST prose block
                        const lastBlock = allProseBlocks[allProseBlocks.length - 1];
                        
                        // Go UP to find the largest container that is still just ONE answer
                        let answerContainer = lastBlock;
                        let bestContainer = lastBlock;
                        let bestLength = lastBlock.textContent.length;
                        let parent = lastBlock.parentElement;
                        
                        for (let i = 0; i < 10 && parent; i++) {
                            // Stop conditions
                            if (parent.tagName === 'MAIN' || parent.tagName === 'BODY' || parent.tagName === 'HTML') break;
                            if (parent.querySelector('textarea, input[type="text"]')) break;
                            
                            const parentLength = parent.textContent.length;
                            
                            // Use this parent if it has more content but isn't too big
                            if (parentLength > bestLength && parentLength < 50000) {
                                bestContainer = parent;
                                bestLength = parentLength;
                            }
                            
                            parent = parent.parentElement;
                        }
                        
                        // Convert to markdown
                        const markdown = cleanMarkdown(domToMarkdown(bestContainer));
                        if (markdown && markdown.length > 5) {
                            return markdown;
                        }
                    }
                    
                    return '';
                }
                
                // Claude specific - handles normal text AND artifact/code responses
                // Claude has TWO panels: left=chat text, right=artifact code panel
                if (host.includes('claude')) {
                    let chatResponse = '';
                    let artifactCode = '';
                    
                    // === PART A: Capture chat text (left panel) ===
                    
                    // A0: Try to find individual turn/message containers first
                    // Claude 2026 uses individual turn containers for each message
                    const turnSelectors = [
                        '[data-testid="chat-message-turn"]',
                        '[data-testid="assistant-turn"]',
                        '[data-testid="ai-message"]',
                        'div[data-turn-role="assistant"]',
                        'div[data-role="assistant"]',
                        'div[data-message-role="assistant"]'
                    ];
                    
                    for (const sel of turnSelectors) {
                        const turns = document.querySelectorAll(sel);
                        if (turns.length > 0) {
                            const lastTurn = turns[turns.length - 1];
                            const md = cleanMarkdown(domToMarkdown(lastTurn));
                            if (md && md.length > chatResponse.length) {
                                chatResponse = md;
                            }
                        }
                    }
                    
                    // A1: Try modern Claude UI selectors for chat messages
                    if (chatResponse.length < 50) {
                        const chatSelectors = [
                            '[data-is-streaming]',
                            '.font-claude-message',
                            '[class*="claude"][class*="message"]',
                            '[class*="response"][class*="content"]',
                            '[class*="assistant"][class*="message"]'
                        ];
                        
                        for (const sel of chatSelectors) {
                            const elements = document.querySelectorAll(sel);
                            if (elements.length > 0) {
                                const lastEl = elements[elements.length - 1];
                                const md = cleanMarkdown(domToMarkdown(lastEl));
                                if (md && md.length > chatResponse.length) {
                                    chatResponse = md;
                                }
                            }
                        }
                    }
                    
                    // A2: Try prose blocks for chat
                    if (chatResponse.length < 50) {
                        const proseBlocks = document.querySelectorAll('.prose, [class*="prose"]');
                        if (proseBlocks.length > 0) {
                            const lastBlock = proseBlocks[proseBlocks.length - 1];
                            const md = cleanMarkdown(domToMarkdown(lastBlock));
                            if (md && md.length > chatResponse.length) {
                                chatResponse = md;
                            }
                        }
                    }

                    // A3: Fallback for chat - find message-like containers
                    // IMPORTANT: Never grab the full conversation container
                    if (chatResponse.length < 50) {
                        const allDivs = document.querySelectorAll('div[class]');
                        let candidates = [];
                        for (const div of allDivs) {
                            const text = div.innerText || '';
                            if (text.length < 100) continue;
                            
                            // Skip sidebar/navigation content
                            const sidebarKeywords = ['New chat', 'Chats', 'Projects', 'Recents', 'All chats', 'Free plan', 'Artifacts', 'Hide', 'Code'];
                            let sidebarScore = 0;
                            for (const kw of sidebarKeywords) {
                                if (text.includes(kw)) sidebarScore++;
                            }
                            if (sidebarScore >= 3) continue;
                            
                            if (div.closest('nav, header, footer, aside, [class*="sidebar"], [class*="nav"], [class*="menu"], [class*="drawer"], [class*="panel"][class*="left"]')) continue;
                            const className = div.className || '';
                            if (className.includes('sidebar') || className.includes('nav') || className.includes('menu') || className.includes('drawer') || className.includes('conversation-list')) continue;
                            if (div.querySelector('textarea, input[type="text"]')) continue;
                            if (text.includes('Claude can make mistakes') && text.length < 200) continue;
                            
                            candidates.push({ el: div, text: text, len: text.length });
                        }
                        
                        // Sort by length, pick a reasonable-sized candidate (not the mega-container)
                        candidates.sort((a, b) => a.len - b.len);
                        // Pick the SMALLEST candidate that is > 100 chars - more likely to be a single message
                        for (const c of candidates) {
                            if (c.len > 100 && c.len < 5000) {
                                chatResponse = cleanMarkdown(c.text);
                                break;
                            }
                        }
                        // If nothing small found, use last candidate but clean it
                        if (chatResponse.length < 50 && candidates.length > 0) {
                            chatResponse = candidates[candidates.length - 1].text;
                            chatResponse = cleanMarkdown(chatResponse);
                        }
                    }
                    
                    // A4: POST-PROCESSING - Detect and clean full conversation captures
                    // If response includes timestamps like "4:43 AM" or "10:30 PM", 
                    // it means we grabbed the full conversation. Extract only the last response.
                    if (chatResponse.length > 0) {
                        const tsPattern = new RegExp('\\d{1,2}:\\d{2}\\s*(AM|PM)', 'gi');
                        const hasTimestamps = tsPattern.test(chatResponse);
                        
                        if (hasTimestamps) {
                            // Split by timestamp pattern to get individual messages
                            const splitPattern = new RegExp('\\d{1,2}:\\d{2}\\s*(AM|PM)', 'gi');
                            const parts = chatResponse.split(splitPattern);
                            
                            // Filter out short parts (user messages are typically short)
                            // and take the LAST substantial part (the latest AI response)
                            let lastResponse = '';
                            for (let i = parts.length - 1; i >= 0; i--) {
                                const part = (parts[i] || '').trim();
                                // Skip empty, very short (user msgs), and AM/PM artifacts
                                if (!part || part.length < 20) continue;
                                if (part === 'AM' || part === 'PM') continue;
                                lastResponse = part;
                                break;
                            }
                            
                            if (lastResponse.length > 20) {
                                chatResponse = cleanMarkdown(lastResponse);
                            }
                        }
                    }
                    
                    // === PART B: Capture artifact code (right side panel) ===
                    // Claude opens artifacts in a side panel with code/preview
                    
                    // B1: Look for the artifact viewer panel
                    // Artifact panel selectors - it's a separate panel from the chat
                    const artifactSelectors = [
                        '[data-testid="artifact-view"]',
                        '[class*="artifact-renderer"]', 
                        '[class*="artifact-content"]',
                        '[class*="artifact"][class*="panel"]',
                        '[class*="artifact"][class*="viewer"]',
                        '[class*="code-editor"]',
                        '[class*="artifact"]'
                    ];
                    
                    let artifactPanel = null;
                    let artifactTitle = '';
                    
                    for (const sel of artifactSelectors) {
                        const panels = document.querySelectorAll(sel);
                        if (panels.length > 0) {
                            // Use the last/most recent artifact panel
                            artifactPanel = panels[panels.length - 1];
                            // Try to get artifact title
                            const titleEl = artifactPanel.querySelector('[class*="title"], [class*="name"], [class*="header"] span, h1, h2, h3');
                            if (titleEl) artifactTitle = titleEl.textContent.trim();
                            break;
                        }
                    }
                    
                    // B2: Extract code from artifact panel
                    if (artifactPanel) {
                        // Look for code elements in the artifact panel
                        const codeElements = artifactPanel.querySelectorAll('pre code, pre, code, [class*="code-block"], [class*="CodeMirror"], [class*="monaco"]');
                        for (const codeEl of codeElements) {
                            const codeText = codeEl.innerText || codeEl.textContent || '';
                            if (codeText.trim().length > artifactCode.length) {
                                artifactCode = codeText.trim();
                            }
                        }
                        
                        // If no code elements found, try innerText of the whole panel
                        if (artifactCode.length < 10) {
                            const panelText = artifactPanel.innerText || '';
                            if (panelText.length > 50) {
                                artifactCode = panelText;
                            }
                        }
                    }
                    
                    // B3: If no artifact panel found, search ENTIRE page for big code blocks
                    // that aren't in the chat area
                    if (artifactCode.length < 10) {
                        const allPres = document.querySelectorAll('pre, code');
                        let biggestCode = '';
                        for (const pre of allPres) {
                            const text = pre.innerText || '';
                            // Only grab substantial code blocks (likely artifacts)
                            if (text.length > 100 && text.length > biggestCode.length) {
                                biggestCode = text;
                            }
                        }
                        if (biggestCode.length > 100) {
                            artifactCode = biggestCode;
                        }
                    }
                    
                    // B4: Also try to find ALL artifact cards/buttons in the chat
                    // and extract their titles (even if code is in side panel)
                    const artifactButtons = document.querySelectorAll('button[class*="artifact"], [class*="artifact-block"], [data-component-name*="Artifact"]');
                    let artifactTitles = [];
                    artifactButtons.forEach(btn => {
                        const title = btn.textContent.trim();
                        if (title && title.length > 2 && title.length < 200) {
                            artifactTitles.push(title);
                        }
                    });
                    
                    // === PART C: Combine chat text + artifact code ===
                    let fullResponse = chatResponse;
                    
                    if (artifactCode && artifactCode.length > 10) {
                        // Detect language from title
                        let lang = '';
                        const titleLower = (artifactTitle || '').toLowerCase();
                        if (titleLower.includes('.jsx') || titleLower.includes('.tsx') || titleLower.includes('react')) lang = 'jsx';
                        else if (titleLower.includes('.js')) lang = 'javascript';
                        else if (titleLower.includes('.ts')) lang = 'typescript';
                        else if (titleLower.includes('.py')) lang = 'python';
                        else if (titleLower.includes('.html')) lang = 'html';
                        else if (titleLower.includes('.css')) lang = 'css';
                        else if (titleLower.includes('.json')) lang = 'json';
                        else if (titleLower.includes('.md')) lang = 'markdown';
                        
                        // Add artifact code to response
                        if (artifactTitle) {
                            fullResponse += NL + NL + '**Artifact: ' + artifactTitle + '**' + NL;
                        }
                        fullResponse += NL + '\`\`\`' + lang + NL + artifactCode + NL + '\`\`\`' + NL;
                    }
                    
                    // Add artifact title list if we found buttons but no code
                    if (artifactTitles.length > 0 && artifactCode.length < 10) {
                        fullResponse += NL + NL + '**Artifacts created:**' + NL;
                        artifactTitles.forEach(t => {
                            fullResponse += '- ' + t + NL;
                        });
                    }
                    
                    if (fullResponse && fullResponse.length > 0) return cleanMarkdown(fullResponse);
                }
                
                // Gemini specific - updated selectors
                if (host.includes('gemini') || host.includes('google')) {
                    // 1. Try message-content elements (Gemini's main container)
                    const msgContent = document.querySelectorAll('message-content, .message-content, [class*="response-content"]');
                    if (msgContent.length > 0) {
                        const lastMsg = msgContent[msgContent.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastMsg));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    
                    // 2. Try model response containers
                    const modelResponses = document.querySelectorAll('.model-response, [class*="model-response"], [class*="response-container"]');
                    if (modelResponses.length > 0) {
                        const lastResponse = modelResponses[modelResponses.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastResponse));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    
                    // 3. Try markdown containers
                    const markdownContainers = document.querySelectorAll('[class*="markdown"], .markdown-content');
                    if (markdownContainers.length > 0) {
                        const lastMd = markdownContainers[markdownContainers.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastMd));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                    
                    // 4. Try response-container-content (newer Gemini)
                    const responseContent = document.querySelectorAll('[class*="response"][class*="content"]');
                    if (responseContent.length > 0) {
                        const lastResp = responseContent[responseContent.length - 1];
                        const markdown = cleanMarkdown(domToMarkdown(lastResp));
                        if (markdown && markdown.length > 0) return markdown;
                    }
                }
                
                return '';
            })()
        `);


            if (text && text.length > 0) {
                // For Perplexity: Check if this is actually a NEW response (not the old one)
                if (provider === 'perplexity' && !foundNewResponse) {
                    // Get current block count and fingerprint
                    const currentData = await webContents.executeJavaScript(`
                    (function() {
                        const proseBlocks = Array.from(document.querySelectorAll('[class*="prose"]:not(.prose-sm)'))
                            .filter(block => {
                                const text = block.textContent.trim();
                                return text.length > 3 && 
                                       !text.toLowerCase().includes('perplexity pro') &&
                                       !text.includes('Ask anything') &&
                                       !text.includes('Ask a follow-up') &&
                                       !text.includes('Attach');
                            });
                        if (proseBlocks.length > 0) {
                            const lastBlock = proseBlocks[proseBlocks.length - 1];
                            return {
                                count: proseBlocks.length,
                                fingerprint: lastBlock.textContent.substring(0, 200).trim()
                            };
                        }
                        return { count: 0, fingerprint: '' };
                    })()
                `).catch(() => ({ count: 0, fingerprint: '' }));

                    const currentBlockCount = currentData.count;
                    const currentFingerprint = currentData.fingerprint;

                    // NEW response detected if block count increased OR fingerprint changed
                    const blockCountIncreased = oldBlockCount > 0 && currentBlockCount > oldBlockCount;
                    const fingerprintChanged = oldFingerprint &&
                        currentFingerprint !== oldFingerprint &&
                        !oldFingerprint.startsWith(currentFingerprint.substring(0, 100)) &&
                        !currentFingerprint.startsWith(oldFingerprint.substring(0, 100));

                    if (blockCountIncreased || fingerprintChanged) {

                        foundNewResponse = true;
                    } else if (oldFingerprint || oldBlockCount > 0) {

                        await sleep(500);
                        continue;
                    } else {
                        // No old fingerprint/count means this is first response
                        foundNewResponse = true;
                    }
                }

                // For Claude: Check if this is actually a NEW response (not the old one)
                if (provider === 'claude' && oldFingerprint && !foundNewResponse) {
                    const currentFingerprint = text.substring(0, 200).trim();
                    if (currentFingerprint === oldFingerprint ||
                        oldFingerprint.startsWith(currentFingerprint.substring(0, 100)) ||
                        currentFingerprint.startsWith(oldFingerprint.substring(0, 100))) {

                        await sleep(500);
                        continue;
                    } else {

                        foundNewResponse = true;
                    }
                }

                if (text === lastText) {
                    stableCount++;
                    if (stableCount >= STABLE_THRESHOLD) {
                        console.log('[getProviderResponse] ✓ Captured (' + text.length + ' chars)');
                        // Clear the old fingerprint after successful capture
                        if (provider === 'perplexity') {
                            global.perplexityOldFingerprint = '';
                            global.perplexityOldBlockCount = 0;
                        }
                        if (provider === 'claude') {
                            global.claudeOldFingerprint = '';
                        }
                        return text;
                    }
                } else {
                    stableCount = 0;
                    lastText = text;
                }
            }

            await sleep(500);
        }

        return lastText || 'No response captured';
    } // end DOM fallback

    return 'No response captured';
}
async function startNewConversation(provider) {
    const config = browserManager.providers[provider];
    if (config) {
        await browserManager.navigate(provider, config.url);
    }
}

// Typing Detection for All Providers

async function isAITyping(provider) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        return { isTyping: false, error: 'Provider not initialized' };
    }

    try {
        const result = await webContents.executeJavaScript(`
            (function() {
                const host = window.location.host;
                
                // ChatGPT typing detection
                if (host.includes('chatgpt') || host.includes('openai')) {
                    // Check for streaming indicator, stop button, or thinking indicator
                    const stopButton = document.querySelector('button[aria-label*="Stop"]');
                    const streamingDots = document.querySelector('[class*="streaming"]');
                    const thinkingIndicator = document.querySelector('[class*="typing"], [class*="thinking"]');
                    const resultStreaming = document.querySelector('[data-message-author-role="assistant"] [class*="result-streaming"]');
                    
                    if (stopButton || streamingDots || thinkingIndicator || resultStreaming) {
                        return { isTyping: true, provider: 'chatgpt' };
                    }
                }
                
                // Claude typing detection - must detect ALL generation states
                // including artifact creation which can take 2-5 minutes
                if (host.includes('claude')) {
                    // Check for stop button (appears during ALL generation)
                    const stopButton = document.querySelector('button[aria-label="Stop generating"], button[aria-label="Stop Response"], button[aria-label="Stop"]');
                    
                    // Check for streaming indicator attribute
                    const streamingIndicator = document.querySelector('[data-is-streaming="true"]');
                    
                    // Check for the orange loading spinner (claude's thinking indicator)
                    const loadingSpinner = document.querySelector('.animate-spin, [class*="loading-spinner"], [class*="animate-pulse"]');
                    
                    // Check for artifact creation in progress - the dotted orange circle
                    const artifactProgress = document.querySelector('[class*="artifact"][class*="loading"], [class*="artifact"][class*="progress"], [class*="generating"]');
                    
                    // Check for "thinking" or "writing" status text
                    const statusText = document.querySelector('[class*="status"], [class*="thinking"]');
                    const isThinking = statusText && (statusText.textContent.includes('thinking') || statusText.textContent.includes('writing') || statusText.textContent.includes('Generating'));
                    
                    if (stopButton && stopButton.offsetParent !== null) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (streamingIndicator) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (loadingSpinner && loadingSpinner.offsetParent !== null) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (artifactProgress) {
                        return { isTyping: true, provider: 'claude' };
                    }
                    if (isThinking) {
                        return { isTyping: true, provider: 'claude' };
                    }
                }
                
                // Perplexity typing detection
                if (host.includes('perplexity')) {
                    // 1. Stop button (appears during ALL generation)
                    const stopButton = document.querySelector('button[aria-label="Stop"]');
                    if (stopButton && stopButton.offsetParent !== null) {
                        return { isTyping: true, provider: 'perplexity' };
                    }
                    
                    // 2. "Searching" text/indicator
                    const searchingIndicator = document.querySelector('[data-testid*="searching"], [class*="searching"]');
                    if (searchingIndicator) {
                        return { isTyping: true, provider: 'perplexity' };
                    }
                    
                    // 3. Loading spinners & animated progress indicators
                    const spinners = document.querySelectorAll('.animate-spin, [class*="animate-pulse"], [class*="loading"], [class*="spinner"], [class*="progress"]');
                    for (const sp of spinners) {
                        // Only count spinners inside the main content area (not nav/sidebar)
                        if (sp.offsetParent !== null && !sp.closest('nav, header, [class*="sidebar"], [class*="nav"]')) {
                            return { isTyping: true, provider: 'perplexity' };
                        }
                    }
                    
                    // 4. Streaming/thinking dots (pulsing circles or dots animation)
                    const thinkingDots = document.querySelector('[class*="thinking"], [class*="typing"], [class*="generating"], [class*="streaming"]');
                    if (thinkingDots && thinkingDots.offsetParent !== null) {
                        return { isTyping: true, provider: 'perplexity' };
                    }
                    
                    // 5. Step counter still in-progress (e.g., "Searching 3 sources" text visible)
                    const stepIndicators = document.querySelectorAll('[class*="step"], [class*="source"]');
                    for (const si of stepIndicators) {
                        const text = si.textContent || '';
                        if ((text.includes('Searching') || text.includes('Reading') || text.includes('Analyzing') || text.includes('Thinking')) && si.offsetParent !== null) {
                            return { isTyping: true, provider: 'perplexity' };
                        }
                    }
                    
                    // 6. SVG animation (Perplexity uses animated SVG rings during generation)
                    const animatedSvg = document.querySelector('svg[class*="animate"], circle[class*="animate"], svg.animate-spin');
                    if (animatedSvg && animatedSvg.closest('[class*="prose"], [class*="answer"], [class*="response"], main') && animatedSvg.offsetParent !== null) {
                        return { isTyping: true, provider: 'perplexity' };
                    }
                }
                
                // Gemini typing detection
                if (host.includes('gemini') || host.includes('google')) {
                    // Only check for SPECIFIC stop button
                    const stopButton = document.querySelector('button[aria-label="Stop"], button[aria-label="Stop generating"]');
                    const matSpinner = document.querySelector('mat-spinner');
                    
                    // Check if stop button is actually visible
                    if (stopButton && stopButton.offsetParent !== null) {
                        return { isTyping: true, provider: 'gemini' };
                    }
                    if (matSpinner && matSpinner.offsetParent !== null) {
                        return { isTyping: true, provider: 'gemini' };
                    }
                }
                
                return { isTyping: false };
            })()
        `);

        return result;
    } catch (e) {
        return { isTyping: false, error: e.message };
    }
}

// NOTE: getResponseWithTypingStatus is defined above (near line 1193)
// with full fingerprint capture logic. Do NOT redefine it here.


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// IPC Handlers for UI

ipcMain.handle('get-settings', () => {
    return loadSettings();
});

ipcMain.handle('save-settings', (event, settings) => {
    saveSettings(settings);
    return { success: true };
});

ipcMain.handle('save-enabled-providers', () => {
    const settings = loadSettings();
    saveEnabledProviders(settings);
    return { success: true };
});

ipcMain.handle('init-provider', async (event, provider) => {
    try {
        // Restore backed up cookies before creating the view
        const config = browserManager.providers[provider];
        if (config) {
            const ses = session.fromPartition(config.partition, { cache: true });
            const restored = await restoreCookies(provider, ses);
            if (restored) {
                console.log(`[${provider}] Cookies restored from backup`);
            }
        }

        browserManager.createView(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('show-provider', async (event, provider) => {
    try {
        const bounds = await mainWindow.webContents.executeJavaScript(`
            (function() {
                const container = document.getElementById('browser-container');
                if (container) {
                    const rect = container.getBoundingClientRect();
                    return {
                        x: Math.round(rect.left),
                        y: Math.round(rect.top),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    };
                }
                return { x: 0, y: 100, width: 1200, height: 700 };
            })()
        `);

        browserManager.showProvider(provider, bounds);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('hide-browser', () => {
    browserManager.hideCurrentView();
    return { success: true };
});

ipcMain.handle('check-login-status', async (event, provider) => {
    try {
        const loggedIn = await browserManager.isLoggedIn(provider);
        return { success: true, provider, loggedIn };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('reload-provider', async (event, provider) => {
    try {
        await browserManager.reload(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-mcp-config', () => {
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
    const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', 'src', 'mcp-server-v3.js');

    const isDev = !app.isPackaged;
    const serverPath = isDev
        ? path.join(__dirname, '..', 'src', 'mcp-server-v3.js')
        : unpackedPath;

    return {
        mcpServers: {
            'proxima': {
                command: 'node',
                args: [serverPath.replace(/\\/g, '/')]
            }
        }
    };
});

ipcMain.handle('copy-to-clipboard', (event, text) => {
    require('electron').clipboard.writeText(text);
    return { success: true };
});

ipcMain.handle('open-external', (event, url) => {
    shell.openExternal(url);
    return { success: true };
});

ipcMain.handle('get-ipc-port', () => {
    const settings = loadSettings();
    return settings.ipcPort || 19222;
});

// Open provider in system browser (for login when embedded browser is blocked)
ipcMain.handle('open-in-system-browser', (event, provider) => {
    const urls = {
        perplexity: 'https://www.perplexity.ai/',
        chatgpt: 'https://chat.openai.com/',
        claude: 'https://claude.ai/',
        gemini: 'https://gemini.google.com/'
    };
    if (urls[provider]) {
        shell.openExternal(urls[provider]);
        return { success: true, provider };
    }
    return { success: false, error: 'Unknown provider' };
});

// Cookie-based Authentication for Gemini etc.

ipcMain.handle('set-cookies', async (event, provider, cookiesJson) => {
    try {
        const config = browserManager.providers[provider];
        if (!config) {
            return { success: false, error: 'Unknown provider' };
        }

        // Parse cookies from JSON (exported from cookie extensions)
        let cookies;
        try {
            cookies = JSON.parse(cookiesJson);
        } catch (e) {
            return { success: false, error: 'Invalid JSON format. Please paste valid cookie JSON.' };
        }

        if (!Array.isArray(cookies)) {
            return { success: false, error: 'Cookies should be an array. Try exporting from EditThisCookie or Cookie-Editor extension.' };
        }

        // Get the session for this provider
        const ses = session.fromPartition(config.partition, { cache: true });

        // Clear existing cookies for this domain first
        const existingCookies = await ses.cookies.get({});
        for (const cookie of existingCookies) {
            try {
                const url = `http${cookie.secure ? 's' : ''}://${cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain}${cookie.path || '/'}`;
                await ses.cookies.remove(url, cookie.name);
            } catch (e) {
                // Ignore individual cookie removal errors
            }
        }

        // Calculate default expiration: 2 days from now (in seconds since epoch)
        const twoDaysFromNow = Math.floor(Date.now() / 1000) + (2 * 24 * 60 * 60);

        // Set the new cookies
        let setCount = 0;
        let errorCount = 0;
        for (const cookie of cookies) {
            try {
                // Build the URL for setting the cookie
                const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                const url = `http${cookie.secure !== false ? 's' : ''}://${domain}${cookie.path || '/'}`;

                // Prepare cookie object for Electron
                const cookieDetails = {
                    url: url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly === true,
                    sameSite: cookie.sameSite || 'no_restriction'
                };

                // IMPORTANT: Always set an expirationDate!
                // Without it, cookies become "session cookies" and get deleted on app close
                if (cookie.expirationDate && cookie.expirationDate > Date.now() / 1000) {
                    cookieDetails.expirationDate = cookie.expirationDate;
                } else {
                    // Default: expire in 2 days
                    cookieDetails.expirationDate = twoDaysFromNow;
                }

                await ses.cookies.set(cookieDetails);
                setCount++;
            } catch (e) {
                console.error(`[Cookie] Failed to set cookie ${cookie.name}:`, e.message);
                errorCount++;
            }
        }

        console.log(`[Cookie] Set ${setCount} cookies for ${provider}, ${errorCount} failed`);

        // Backup cookies to file for restoration on next app start
        await backupCookies(provider, ses);

        // Flush cookies to disk immediately
        await ses.cookies.flushStore();

        // Reload the provider view to apply cookies
        const view = browserManager.views.get(provider);
        if (view && !view.webContents.isDestroyed()) {
            await view.webContents.loadURL(config.url);
        }

        return {
            success: true,
            message: `Successfully set ${setCount} cookies. ${errorCount > 0 ? `(${errorCount} failed)` : ''} Reloading...`,
            setCount,
            errorCount
        };
    } catch (e) {
        console.error('[Cookie] Error:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-cookies', async (event, provider) => {
    try {
        const config = browserManager.providers[provider];
        if (!config) {
            return { success: false, error: 'Unknown provider' };
        }

        const ses = session.fromPartition(config.partition, { cache: true });
        const cookies = await ses.cookies.get({});

        // Filter cookies for the provider's domain
        const providerDomains = {
            perplexity: 'perplexity.ai',
            chatgpt: 'openai.com',
            claude: 'claude.ai',
            gemini: 'google.com'
        };

        const domain = providerDomains[provider];
        const filteredCookies = cookies.filter(c => c.domain.includes(domain));

        return {
            success: true,
            cookies: filteredCookies,
            count: filteredCookies.length
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// File Reference Feature

let fileReferenceEnabled = true;

ipcMain.handle('set-file-reference-enabled', (event, enabled) => {
    fileReferenceEnabled = enabled;
    console.log('[FileReference] File reference:', enabled ? 'ENABLED' : 'DISABLED');
    return { success: true, enabled };
});

ipcMain.handle('get-file-reference-enabled', () => {
    return { success: true, enabled: fileReferenceEnabled };
});


// Check if file is attached in chat
async function checkFileAttachment(provider) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) return false;

    return await webContents.executeJavaScript(`
        (function() {
            const indicators = [
                '[data-testid*="attachment"]',
                '[data-testid*="file"]',
                '[aria-label*="attachment"]',
                '[aria-label*="file"]',
                '[aria-label*="Remove"]',
                '.attachment',
                '.file-chip',
                'button[aria-label*="Remove"]',
                '[data-filename]',
                '.uploaded-file',
                '[data-testid="file-thumbnail"]',
                '[data-testid="composer-attachment"]',
                '.file-preview-container'
            ];
            
            for (const sel of indicators) {
                if (document.querySelector(sel)) {
                    console.log('[FileCheck] Found:', sel);
                    return true;
                }
            }
            return false;
        })()
    `);
}

// Wait for send button to be ready (enabled and visible)
async function waitForSendButton(provider) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) return false;

    const maxWait = 15000; // 15 seconds max
    const checkInterval = 500;
    let waited = 0;

    while (waited < maxWait) {
        const isReady = await webContents.executeJavaScript(`
            (function() {
                const host = window.location.host;
                let sendBtn = null;
                
                if (host.includes('chatgpt')) {
                    sendBtn = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
                } else if (host.includes('claude')) {
                    sendBtn = document.querySelector('button[aria-label*="Send"], button[type="submit"]');
                } else if (host.includes('gemini')) {
                    sendBtn = document.querySelector('button[aria-label*="Send"], button.send-button');
                } else if (host.includes('perplexity')) {
                    sendBtn = document.querySelector('button[aria-label*="Submit"], button[type="submit"]');
                }
                
                if (sendBtn) {
                    const isDisabled = sendBtn.disabled || sendBtn.hasAttribute('disabled');
                    const isVisible = sendBtn.offsetParent !== null;
                    console.log('[SendButton] Found:', !isDisabled && isVisible ? 'READY' : 'NOT READY');
                    return !isDisabled && isVisible;
                }
                return false;
            })()
        `);

        if (isReady) {
            console.log('[MCP] Send button is ready!');
            return true;
        }

        await sleep(checkInterval);
        waited += checkInterval;
        console.log(`[MCP] Waiting for send button... ${waited}ms`);
    }

    console.log('[MCP] Timeout waiting for send button, proceeding anyway...');
    return false;
}

// Upload file to AI provider chat using file input manipulation
async function uploadFileToProvider(provider, filePath) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    const fs = require('fs');
    const path = require('path');

    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // Check file size limit (25MB max to avoid memory issues with base64)
    const fileStats = fs.statSync(filePath);
    const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
    if (fileStats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${(fileStats.size / 1024 / 1024).toFixed(1)}MB. Maximum is 25MB.`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const fileBase64 = fileBuffer.toString('base64');
    const fileMimeType = getMimeType(filePath);

    console.log(`[FileReference] Uploading ${fileName} via file input method...`);

    // Method 1: Find and click attach button, then set file input
    const uploadResult = await webContents.executeJavaScript(`
        (async function() {
            const fileName = ${JSON.stringify(fileName)};
            const fileBase64 = ${JSON.stringify(fileBase64)};
            const fileMimeType = ${JSON.stringify(fileMimeType)};
            

            
            // Convert base64 to File
            function base64ToFile(base64, filename, mimeType) {
                const byteCharacters = atob(base64);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: mimeType });
                return new File([blob], filename, { type: mimeType });
            }
            
            const file = base64ToFile(fileBase64, fileName, fileMimeType);

            
            // Create DataTransfer with file
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            
            const host = window.location.host;
            let fileInput = null;
            let attachButton = null;
            
            // Find file input or attach button based on provider
            if (host.includes('claude')) {
                // Claude: Look for attach button first
                attachButton = document.querySelector('button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Add"]');
                if (attachButton) {

                    attachButton.click();
                    await new Promise(r => setTimeout(r, 500));
                }
                fileInput = document.querySelector('input[type="file"]');
            } else if (host.includes('chatgpt')) {
                attachButton = document.querySelector('button[aria-label*="Attach"], button[data-testid*="attach"]');
                if (attachButton) {

                    attachButton.click();
                    await new Promise(r => setTimeout(r, 500));
                }
                fileInput = document.querySelector('input[type="file"]');
            } else if (host.includes('gemini')) {
                // Gemini: Use clipboard paste (Ctrl+V) since no hidden file input exists

                
                // Focus the input area first
                const inputArea = document.querySelector('rich-textarea, .ql-editor, [contenteditable="true"], textarea');
                if (inputArea) {
                    inputArea.focus();
                    inputArea.click();

                    
                    // Create clipboard data with file
                    const clipboardData = new DataTransfer();
                    clipboardData.items.add(file);
                    
                    // Create and dispatch paste event
                    const pasteEvent = new ClipboardEvent('paste', {
                        bubbles: true,
                        cancelable: true,
                        clipboardData: clipboardData
                    });
                    
                    inputArea.dispatchEvent(pasteEvent);

                    
                    // Wait 2 seconds for file to be ready (simple and reliable)
                    await new Promise(r => setTimeout(r, 2000));
                    
                    // Re-focus input
                    inputArea.focus();
                    inputArea.click();
                    
                    return {
                        success: true,
                        fileName,
                        mimeType: fileMimeType,
                        fileAttached: true,
                        method: 'clipboard-paste'
                    };
                } else {

                    return { success: false, error: 'Input area not found', fileAttached: false };
                }
            } else if (host.includes('perplexity')) {
                // Perplexity: Click attach button first, then find file input
                attachButton = document.querySelector('button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Upload"], button[aria-label*="Add file"], [data-testid*="attach"]');
                if (attachButton) {

                    attachButton.click();
                    await new Promise(r => setTimeout(r, 500));
                }
                fileInput = document.querySelector('input[type="file"]');
            }
            
            // If no file input found, search all inputs
            if (!fileInput) {

                const allInputs = document.querySelectorAll('input[type="file"]');

                fileInput = allInputs[0];
            }
            
            if (!fileInput) {

                return { success: false, error: 'No file input found', fileAttached: false };
            }
            

            
            // Set files on input
            fileInput.files = dataTransfer.files;
            
            // Dispatch events
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            

            
            // Wait for upload
            await new Promise(r => setTimeout(r, 2000));
            
            // Check if attached
            const indicators = [
                '[data-testid*="attachment"]',
                '[data-testid*="file"]',
                '[aria-label*="Remove"]',
                '.attachment',
                '.file-chip',
                '[data-filename]',
                '.uploaded-file',
                '[data-testid="file-thumbnail"]',
                '[data-testid="composer-attachment"]'
            ];
            
            let fileAttached = false;
            for (const sel of indicators) {
                if (document.querySelector(sel)) {

                    fileAttached = true;
                    break;
                }
            }
            
            return {
                success: true,
                fileName,
                mimeType: fileMimeType,
                fileAttached,
                method: 'file-input'
            };
        })()
    `);


    return uploadResult;
}

function getMimeType(filePath) {
    const ext = require('path').extname(filePath).toLowerCase();
    const mimeTypes = {
        '.txt': 'text/plain',
        '.js': 'text/javascript',
        '.ts': 'text/typescript',
        '.jsx': 'text/javascript',
        '.tsx': 'text/typescript',
        '.py': 'text/x-python',
        '.html': 'text/html',
        '.css': 'text/css',
        '.json': 'application/json',
        '.md': 'text/markdown',
        '.xml': 'text/xml',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.csv': 'text/csv',
        '.zip': 'application/zip'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

// App Lifecycle

app.whenReady().then(createWindow);

// Backup all cookies before quitting
app.on('before-quit', async (event) => {
    if (browserManager && !browserManager.isDestroyed) {
        for (const provider of browserManager.getInitializedProviders()) {
            try {
                const config = browserManager.providers[provider];
                if (config) {
                    const ses = session.fromPartition(config.partition, { cache: true });
                    await ses.cookies.flushStore();
                    await backupCookies(provider, ses);
                }
            } catch (e) {
                console.error(`[Quit] Cookie backup failed for ${provider}:`, e.message);
            }
        }
        console.log('[Quit] All cookies backed up');
    }
});

app.on('window-all-closed', () => {
    if (ipcServer) {
        ipcServer.close();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

// Handle certificate errors for some AI sites
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    // Only bypass for known AI provider domains
    const trustedDomains = ['perplexity.ai', 'openai.com', 'claude.ai', 'gemini.google.com', 'google.com'];
    const urlObj = new URL(url);
    if (trustedDomains.some(domain => urlObj.hostname.includes(domain))) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

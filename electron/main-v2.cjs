// brAInstorm main process — embedded browser + anti-detection + IPC server

const { app, BrowserWindow, ipcMain, shell, session, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const BrowserManager = require('./browser-manager.cjs');
const ProviderRuntime = require('./provider-runtime.cjs');
const { initRestAPI, startRestAPI } = require('./rest-api.cjs');
const {
    providers: providerCatalog,
    publicProviderCatalog,
    providerMap,
    defaultProviderSettings,
    DEFAULT_BROWSER_USER_AGENT
} = require('../src/provider-catalog.cjs');
const {
    getSkill,
    getSkillRegistrySummary,
    normalizeSkillName,
    refreshSkillRegistry,
    resolveSkillsDirectory
} = require('../src/skill-prompts.cjs');


const APP_NAME = 'brAInstorm';
const LEGACY_USER_DATA_DIRS = ['proxima'];
const PACKAGED_RUNTIME_DIR = 'runtime';
const PRIMARY_APP_ICON_PNG = path.join(__dirname, '../assets/brainstorm-app-icon.png');
const PRIMARY_APP_ICON_ICO = path.join(__dirname, '../assets/brainstorm-app-icon.ico');
const FALLBACK_APP_ICON_PNG = path.join(__dirname, '../assets/brainstorm-icon.png');

if (typeof app.setName === 'function') {
    app.setName(APP_NAME);
}

function resolveLegacyUserDataPaths(currentUserDataPath) {
    let basePath = '';

    if (process.platform === 'win32') {
        basePath = process.env.APPDATA || path.dirname(currentUserDataPath);
    } else if (process.platform === 'darwin') {
        basePath = path.join(process.env.HOME || '', 'Library', 'Application Support');
    } else {
        basePath = path.join(process.env.HOME || '', '.config');
    }

    return LEGACY_USER_DATA_DIRS
        .map((dirName) => path.join(basePath, dirName))
        .filter((candidate) => candidate && candidate !== currentUserDataPath);
}

function findFirstExistingPath(paths = []) {
    for (const candidate of paths) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function resolvePackagedRuntimeRoot(resourcesPath = process.resourcesPath || path.join(__dirname, '..')) {
    return findFirstExistingPath([
        path.join(resourcesPath, PACKAGED_RUNTIME_DIR),
        path.join(resourcesPath, 'app.asar.unpacked')
    ]) || path.join(resourcesPath, PACKAGED_RUNTIME_DIR);
}

function pathIsWritable(targetPath) {
    try {
        fs.accessSync(targetPath, fs.constants.W_OK);
        return true;
    } catch (error) {
        return false;
    }
}

function resolveWindowIconPath() {
    if (process.platform === 'win32' && fs.existsSync(PRIMARY_APP_ICON_ICO)) {
        return PRIMARY_APP_ICON_ICO;
    }

    if (fs.existsSync(PRIMARY_APP_ICON_PNG)) {
        return PRIMARY_APP_ICON_PNG;
    }

    return FALLBACK_APP_ICON_PNG;
}

function applyDockIcon() {
    if (process.platform !== 'darwin' || !app.dock || typeof app.dock.setIcon !== 'function') {
        return;
    }

    const dockIconPath = fs.existsSync(PRIMARY_APP_ICON_PNG)
        ? PRIMARY_APP_ICON_PNG
        : FALLBACK_APP_ICON_PNG;
    const dockIcon = nativeImage.createFromPath(dockIconPath);

    if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon);
    }
}

function getSkillsDirectoryStatus() {
    const directory = resolveSkillsDirectory();
    const exists = fs.existsSync(directory) && fs.statSync(directory).isDirectory();
    const writable = exists
        ? pathIsWritable(directory)
        : pathIsWritable(path.dirname(directory));

    return {
        directory,
        exists,
        writable
    };
}

function buildSkillManagerSummary(options = {}) {
    refreshSkillRegistry();
    const summary = getSkillRegistrySummary(options);
    const status = getSkillsDirectoryStatus();

    return {
        directory: status.directory,
        exists: status.exists,
        writable: status.writable,
        loadedAt: summary.loadedAt,
        skills: summary.skills.map((skill) => ({
            name: skill.name,
            fileName: skill.fileName,
            filePath: skill.filePath,
            variables: skill.variables,
            ...(options.includeTemplate ? { template: skill.template } : {})
        }))
    };
}

function saveSkillTemplateFile(payload = {}) {
    const normalizedName = normalizeSkillName(payload.name);
    if (!normalizedName) {
        throw new Error('Skill name is required');
    }

    const template = typeof payload.template === 'string' ? payload.template.replace(/\r\n/g, '\n') : '';
    const status = getSkillsDirectoryStatus();

    if (!status.exists) {
        fs.mkdirSync(status.directory, { recursive: true });
    }

    if (!pathIsWritable(status.directory)) {
        throw new Error(`Skills directory is not writable: ${status.directory}`);
    }

    const filePath = path.join(status.directory, `${normalizedName}.md`);
    const existed = fs.existsSync(filePath);
    fs.writeFileSync(filePath, template, 'utf8');

    refreshSkillRegistry();
    const savedSkill = getSkill(normalizedName, { refresh: false, refreshOnMiss: false });
    if (!savedSkill) {
        throw new Error(`Saved skill could not be reloaded: ${normalizedName}`);
    }

    return {
        created: !existed,
        name: savedSkill.name,
        fileName: savedSkill.fileName,
        filePath: savedSkill.filePath,
        variables: savedSkill.variables,
        template: savedSkill.template
    };
}

// Store user settings
const userDataPath = app.getPath('userData');
const legacyUserDataPaths = resolveLegacyUserDataPaths(userDataPath);
const settingsPath = path.join(userDataPath, 'settings.json');
const enabledProvidersPath = path.join(userDataPath, 'enabled-providers.json');
const legacySettingsPaths = legacyUserDataPaths.map((legacyPath) => path.join(legacyPath, 'settings.json'));
const cookieBackupDir = path.join(userDataPath, 'cookie-backups');
const legacyCookieBackupDirs = legacyUserDataPaths.map((legacyPath) => path.join(legacyPath, 'cookie-backups'));

let mainWindow;
let browserManager;
let providerRuntime;
let ipcServer; // For MCP server communication

const trustedCertificateDomains = [
    ...new Set(
        providerCatalog.flatMap((provider) => {
            const domains = [
                provider.cookieDomain,
                ...(provider.authCompletionDomains || [])
            ].filter(Boolean);

            try {
                domains.push(new URL(provider.url).hostname);
            } catch (e) {
                // Ignore malformed URLs in provider config
            }

            return domains;
        })
    )
];

function buildDefaultProvidersConfig() {
    return Object.fromEntries(
        Object.entries(defaultProviderSettings).map(([providerId, config]) => [
            providerId,
            { ...config }
        ])
    );
}

function normalizeUserAgent(userAgent) {
    return typeof userAgent === 'string' && userAgent.trim()
        ? userAgent.trim()
        : DEFAULT_BROWSER_USER_AGENT;
}

function normalizeCapturedImageDownloadDir(downloadDir) {
    return typeof downloadDir === 'string'
        ? downloadDir.trim()
        : '';
}

function mergeProviderSettings(savedProviders = {}) {
    const merged = buildDefaultProvidersConfig();

    for (const [providerId, config] of Object.entries(savedProviders || {})) {
        merged[providerId] = {
            enabled: false,
            loggedIn: false,
            ...merged[providerId],
            ...config
        };
    }

    return merged;
}

// Default settings
const defaultSettings = {
    providers: buildDefaultProvidersConfig(),
    userAgent: DEFAULT_BROWSER_USER_AGENT,
    capturedImageDownloadDir: '',
    ipcPort: 19222, // Port for MCP server IPC communication
    theme: 'dark',
    headlessMode: false, // When true, runs in background without visible window
    startMinimized: false // Start minimized to system tray
};

function mergeSettings(saved = {}) {
    return {
        ...defaultSettings,
        ...saved,
        userAgent: normalizeUserAgent(saved.userAgent),
        capturedImageDownloadDir: normalizeCapturedImageDownloadDir(saved.capturedImageDownloadDir),
        providers: mergeProviderSettings(saved.providers)
    };
}

function loadInitialUserAgent() {
    try {
        const resolvedSettingsPath = findFirstExistingPath([settingsPath, ...legacySettingsPaths]);
        if (resolvedSettingsPath) {
            const saved = JSON.parse(fs.readFileSync(resolvedSettingsPath, 'utf8'));
            return mergeSettings(saved).userAgent;
        }
    } catch (e) {
        console.error('Error loading initial user agent:', e);
    }
    return DEFAULT_BROWSER_USER_AGENT;
}

let currentUserAgent = loadInitialUserAgent();

// Anti-detection: must run before any Electron APIs
// These MUST be set before app is ready or any windows are created

// 1. Set user agent at Chromium COMMAND LINE level
//    This affects the INTERNAL sec-ch-ua brand generation in Chromium
app.commandLine.appendSwitch('user-agent', currentUserAgent);

// 2. Disable automation detection flags
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// 3. Disable features that leak Electron identity
app.commandLine.appendSwitch('disable-features', 'ElectronSerialChooser,OutOfBlinkCors');

// 4. Set the app-wide fallback user agent
app.userAgentFallback = currentUserAgent;

// 5. On ready, also clean all session user agents
app.on('ready', () => {
    session.defaultSession.setUserAgent(currentUserAgent);
});

function loadSettings() {
    try {
        const resolvedSettingsPath = findFirstExistingPath([settingsPath, ...legacySettingsPaths]);
        if (resolvedSettingsPath) {
            const saved = JSON.parse(fs.readFileSync(resolvedSettingsPath, 'utf8'));
            return mergeSettings(saved);
        }
    } catch (e) {
        console.error('Error loading settings:', e);
    }
    return mergeSettings();
}

function saveSettings(settings) {
    try {
        const normalizedSettings = mergeSettings(settings);
        fs.writeFileSync(settingsPath, JSON.stringify(normalizedSettings, null, 2));
        return normalizedSettings;
    } catch (e) {
        console.error('Error saving settings:', e);
    }
    return mergeSettings(settings);
}

function applyUserAgent(userAgent) {
    currentUserAgent = normalizeUserAgent(userAgent);
    app.userAgentFallback = currentUserAgent;

    try {
        session.defaultSession.setUserAgent(currentUserAgent);
    } catch (e) {
        console.error('Error applying default session user agent:', e);
    }

    if (browserManager) {
        browserManager.setUserAgent(currentUserAgent);
    }

    return currentUserAgent;
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
            const packagedRuntimeRoot = resolvePackagedRuntimeRoot(resourcesPath);
            const mcpConfigPath = isDev
                ? path.join(__dirname, '..', 'src', 'enabled-providers.json')
                : path.join(packagedRuntimeRoot, 'src', 'enabled-providers.json');

            fs.writeFileSync(mcpConfigPath, JSON.stringify({ enabled }, null, 2));
        } catch (e2) {
            // Not critical — AppData version is the primary source of truth
            console.log('[Settings] Could not write to app directory (normal in installed mode)');
        }
    } catch (e) {
        console.error('Error saving enabled providers:', e);
    }
}

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
        const backupPath = findFirstExistingPath([
            path.join(cookieBackupDir, `${provider}.json`),
            ...legacyCookieBackupDirs.map((legacyDir) => path.join(legacyDir, `${provider}.json`))
        ]);
        if (!backupPath) {
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
    const isMac = process.platform === 'darwin';

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
        titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
        ...(isMac ? {} : {
            titleBarOverlay: {
                color: '#0f0f1a',
                symbolColor: '#ffffff',
                height: 38
            }
        }),
        backgroundColor: '#0f0f23',
        icon: resolveWindowIconPath(),
        title: APP_NAME
    });
    mainWindow.setMaxListeners(20); // Prevent MaxListenersExceeded warning

    if (isMac) {
        mainWindow.setWindowButtonVisibility(true);
    }

    // Initialize browser manager
    browserManager = new BrowserManager(mainWindow, {
        userAgent: settings.userAgent
    });
    providerRuntime = new ProviderRuntime({
        browserManager,
        getSettings: loadSettings
    });

    mainWindow.loadFile(path.join(__dirname, 'index-v2.html'));

    // Show window when ready (if not headless)
    mainWindow.once('ready-to-show', async () => {
        if (!isHeadless && !startMinimized) {
            mainWindow.show();
        }
        console.log(`[${APP_NAME}] Running in ${isHeadless ? 'HEADLESS' : 'VISIBLE'} mode`);
        console.log(`[${APP_NAME}] MCP server can connect on port`, settings.ipcPort || 19222);

        // Auto-initialize ALL enabled providers on startup
        const enabledProviders = Object.entries(settings.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        console.log(`[${APP_NAME}] Auto-loading enabled providers:`, enabledProviders);

        // Wait a bit for the UI to be ready
        await sleep(1000);

        // Get the browser area bounds
        const bounds = { x: 0, y: 170, width: 1200, height: 680 };
        const offScreenBounds = { x: -10000, y: 0, width: 1200, height: 680 };

        // Initialize all enabled providers (create views, add to window, navigate)
        for (let i = 0; i < enabledProviders.length; i++) {
            const provider = enabledProviders[i];
            try {
                console.log(`[${APP_NAME}] Initializing ${provider}...`);

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
                        console.log(`[${APP_NAME}] Loading ${providerConfig.url} for ${provider}`);
                    }
                }

                await sleep(1500); // Give time for page to start loading
            } catch (err) {
                console.error(`[${APP_NAME}] Error initializing ${provider}:`, err.message);
            }
        }

        // Set the first provider as active
        if (enabledProviders.length > 0) {
            browserManager.activeProvider = enabledProviders[0];
            console.log(`[${APP_NAME}] ${enabledProviders[0]} set as default (already visible)`);

            // Notify renderer which provider to highlight
            mainWindow.webContents.send('set-active-provider', enabledProviders[0]);
        }

        console.log(`[${APP_NAME}] All providers initialized and ready!`);

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
                    return { success: false, error: 'File reference is disabled. Enable it in brAInstorm settings.' };
                }
                try {
                    const uploadResult = await uploadFileToProvider(provider, data.filePath);
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
                        const preview = (value, limit = 180) => String(value || '')
                            .replace(/\\s+/g, ' ')
                            .trim()
                            .slice(0, limit);
                        const isVisible = (el) => {
                            if (!el) return false;
                            const style = window.getComputedStyle(el);
                            return style.display !== 'none' &&
                                style.visibility !== 'hidden' &&
                                (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
                        };
                        const collect = (elements, mapper, limit = 10) =>
                            Array.from(elements)
                                .filter(Boolean)
                                .slice(0, limit)
                                .map((el, index) => mapper(el, index));

                        const visibleButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
                            .filter(isVisible);
                        const visibleLinks = Array.from(document.querySelectorAll('a[href]'))
                            .filter(isVisible);
                        const responseCandidates = Array.from(document.querySelectorAll(
                            'article, .prose, .markdown, [data-message-author-role="assistant"], [class*="message"], [class*="response"], main'
                        ))
                            .filter((el, index, arr) => arr.indexOf(el) === index)
                            .filter((el) => preview(el.innerText, 60).length > 0);

                        const info = {
                            url: window.location.href,
                            title: document.title,
                            host: window.location.host,
                            readyState: document.readyState,
                            articles: document.querySelectorAll('article').length,
                            proseElements: document.querySelectorAll('.prose').length,
                            markdownElements: document.querySelectorAll('.markdown').length,
                            divs: document.querySelectorAll('div').length,
                            textareas: document.querySelectorAll('textarea').length,
                            contenteditables: document.querySelectorAll('[contenteditable="true"]').length,
                            fileInputs: document.querySelectorAll('input[type="file"]').length,
                            buttons: visibleButtons.length,
                            links: visibleLinks.length
                        };

                        info.textareaSamples = collect(document.querySelectorAll('textarea'), (el) => ({
                            placeholder: el.getAttribute('placeholder') || '',
                            ariaLabel: el.getAttribute('aria-label') || '',
                            disabled: !!el.disabled,
                            visible: isVisible(el),
                            textPreview: preview(el.value || el.textContent)
                        }));

                        info.contenteditableSamples = collect(document.querySelectorAll('[contenteditable="true"]'), (el) => ({
                            tag: el.tagName,
                            role: el.getAttribute('role') || '',
                            ariaLabel: el.getAttribute('aria-label') || '',
                            dataTestId: el.getAttribute('data-testid') || '',
                            classes: preview(el.className, 120),
                            visible: isVisible(el),
                            textPreview: preview(el.innerText || el.textContent)
                        }));

                        info.fileInputSamples = collect(document.querySelectorAll('input[type="file"]'), (el) => ({
                            accept: el.getAttribute('accept') || '',
                            multiple: !!el.multiple,
                            visible: isVisible(el)
                        }));

                        info.buttonSamples = collect(visibleButtons, (el) => ({
                            text: preview(el.innerText || el.textContent),
                            ariaLabel: el.getAttribute('aria-label') || '',
                            dataTestId: el.getAttribute('data-testid') || '',
                            classes: preview(el.className, 120),
                            disabled: !!el.disabled
                        }));

                        info.linkSamples = collect(visibleLinks, (el) => ({
                            text: preview(el.innerText || el.textContent),
                            href: el.href,
                            classes: preview(el.className, 120)
                        }));

                        info.articleSamples = collect(document.querySelectorAll('article'), (art) => ({
                            classes: preview(art.className, 120),
                            dataAttrs: art.dataset,
                            hasProseChild: !!art.querySelector('.prose'),
                            hasMarkdownChild: !!art.querySelector('.markdown'),
                            textPreview: preview(art.innerText || art.textContent)
                        }), 4);

                        info.proseSamples = collect(document.querySelectorAll('.prose, .markdown, [class*="prose"], [class*="markdown"]'), (el) => ({
                            tag: el.tagName,
                            classes: preview(el.className, 120),
                            textPreview: preview(el.innerText || el.textContent, 220)
                        }), 6);

                        info.responseCandidates = collect(responseCandidates.slice(-8), (el) => ({
                            tag: el.tagName,
                            classes: preview(el.className, 120),
                            dataTestId: el.getAttribute('data-testid') || '',
                            textPreview: preview(el.innerText || el.textContent, 220)
                        }), 8);

                        info.bodyPreview = preview(document.body && document.body.innerText, 800);

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

// Provider interaction helpers delegate provider-specific browser automation
// to ProviderRuntime so main-v2 stays focused on orchestration and IPC.

function getProviderRuntime() {
    if (!providerRuntime) {
        if (!browserManager) {
            throw new Error('Browser manager not initialized');
        }
        providerRuntime = new ProviderRuntime({
            browserManager,
            getSettings: loadSettings
        });
    }

    return providerRuntime;
}

async function sendMessageToProvider(provider, message) {
    return getProviderRuntime().sendMessage(provider, message);
}

async function waitForSendButtonReady(provider) {
    return getProviderRuntime().waitForSendButton(provider, {
        maxWait: 10000,
        checkInterval: 200,
        logPrefix: 'waitForSendButton'
    });
}

async function getResponseWithTypingStatus(provider) {
    console.log(`[getResponseWithTyping] Starting for ${provider}...`);
    return getProviderRuntime().getResponseWithTypingStatus(provider);
}

async function getProviderResponse(provider, customSelector = null) {
    return getProviderRuntime().getProviderResponse(provider, customSelector);
}

async function startNewConversation(provider) {
    const config = browserManager.providers[provider];
    if (config) {
        await browserManager.navigate(provider, config.url);
    }
}

async function isAITyping(provider) {
    return getProviderRuntime().isTyping(provider);
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// IPC Handlers for UI

ipcMain.handle('get-settings', () => {
    return loadSettings();
});

ipcMain.handle('get-provider-catalog', () => {
    return publicProviderCatalog;
});

ipcMain.handle('list-skills', () => {
    try {
        return {
            success: true,
            ...buildSkillManagerSummary()
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-skill', (event, skillName) => {
    try {
        const skill = getSkill(skillName, { refresh: true });
        if (!skill) {
            return { success: false, error: `Skill not found: ${skillName}` };
        }

        const status = getSkillsDirectoryStatus();

        return {
            success: true,
            directory: status.directory,
            exists: status.exists,
            writable: status.writable,
            skill: {
                name: skill.name,
                fileName: skill.fileName,
                filePath: skill.filePath,
                variables: skill.variables,
                template: skill.template
            }
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('save-skill', (event, payload) => {
    try {
        const skill = saveSkillTemplateFile(payload || {});
        return {
            success: true,
            skill,
            ...buildSkillManagerSummary()
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('save-settings', (event, settings) => {
    const savedSettings = saveSettings(settings);
    applyUserAgent(savedSettings.userAgent);
    return { success: true, settings: savedSettings };
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
        return {
            success: true,
            provider,
            navigationState: browserManager.getNavigationState(provider)
        };
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

ipcMain.handle('navigate-provider', async (event, provider, url) => {
    try {
        await browserManager.navigate(provider, url);
        return {
            success: true,
            provider,
            navigationState: browserManager.getNavigationState(provider)
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('go-back', async (event, provider) => {
    try {
        browserManager.goBack(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('go-forward', async (event, provider) => {
    try {
        browserManager.goForward(provider);
        return { success: true, provider };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-provider-navigation-state', async (event, provider) => {
    try {
        return {
            success: true,
            provider,
            navigationState: browserManager.getNavigationState(provider)
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-mcp-config', () => {
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
    const packagedRuntimeRoot = resolvePackagedRuntimeRoot(resourcesPath);

    const isDev = !app.isPackaged;
    const serverPath = isDev
        ? path.join(__dirname, '..', 'src', 'mcp-server-v3.js')
        : path.join(packagedRuntimeRoot, 'src', 'mcp-server-v3.js');
    const cwdPath = isDev
        ? path.join(__dirname, '..')
        : packagedRuntimeRoot;

    return {
        mcpServers: {
            'brainstorm': {
                command: 'node',
                args: [serverPath.replace(/\\/g, '/')],
                cwd: cwdPath.replace(/\\/g, '/')
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
    const targetUrl = providerMap[provider]?.systemBrowserUrl;
    if (targetUrl) {
        shell.openExternal(targetUrl);
        return { success: true, provider };
    }
    return { success: false, error: 'Unknown provider' };
});

// Cookie-based Authentication for Gemini etc.

function normalizeStorageEntries(entries) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(entries)
            .filter(([key]) => typeof key === 'string' && key.length > 0)
            .map(([key, value]) => [
                key,
                typeof value === 'string' ? value : JSON.stringify(value)
            ])
    );
}

async function ensureProviderView(provider, config) {
    let view = browserManager.views.get(provider);
    if (!view || view.webContents.isDestroyed()) {
        browserManager.createView(provider);
        view = browserManager.views.get(provider);
    }

    if (!view || view.webContents.isDestroyed()) {
        throw new Error(`Unable to create provider view for ${provider}`);
    }

    await view.webContents.loadURL(config.url);
    return view;
}

async function applyBrowserStorage(provider, config, storageState = {}) {
    const localStorageEntries = normalizeStorageEntries(storageState.localStorage);
    const sessionStorageEntries = normalizeStorageEntries(storageState.sessionStorage);
    const hasStorageEntries = Object.keys(localStorageEntries).length > 0 ||
        Object.keys(sessionStorageEntries).length > 0;

    if (!hasStorageEntries) {
        return {
            applied: false,
            localStorageKeys: [],
            sessionStorageKeys: []
        };
    }

    const view = await ensureProviderView(provider, config);
    await sleep(500);

    const result = await view.webContents.executeJavaScript(`
        (function() {
            const localEntries = ${JSON.stringify(localStorageEntries)};
            const sessionEntries = ${JSON.stringify(sessionStorageEntries)};

            try {
                for (const [key, value] of Object.entries(localEntries)) {
                    window.localStorage.setItem(key, value);
                }

                for (const [key, value] of Object.entries(sessionEntries)) {
                    window.sessionStorage.setItem(key, value);
                }

                return {
                    success: true,
                    href: window.location.href,
                    localStorageKeys: Object.keys(localEntries),
                    sessionStorageKeys: Object.keys(sessionEntries)
                };
            } catch (error) {
                return {
                    success: false,
                    error: error && error.message ? error.message : String(error)
                };
            }
        })()
    `);

    if (!result?.success) {
        throw new Error(`Failed to apply browser storage: ${result?.error || 'Unknown error'}`);
    }

    await view.webContents.loadURL(config.url);

    return {
        applied: true,
        localStorageKeys: result.localStorageKeys || [],
        sessionStorageKeys: result.sessionStorageKeys || []
    };
}

async function applyProviderAuthState(provider, payload = {}) {
    const config = browserManager.providers[provider];
    if (!config) {
        throw new Error('Unknown provider');
    }

    const cookiesJson = typeof payload.cookiesJson === 'string' ? payload.cookiesJson.trim() : '';
    const hasStorageEntries = Object.keys(normalizeStorageEntries(payload.localStorage)).length > 0 ||
        Object.keys(normalizeStorageEntries(payload.sessionStorage)).length > 0;

    if (!cookiesJson && !hasStorageEntries) {
        throw new Error('No cookies or browser storage were provided');
    }

    let setCount = 0;
    let errorCount = 0;

    if (cookiesJson) {
        let cookies;
        try {
            cookies = JSON.parse(cookiesJson);
        } catch (e) {
            throw new Error('Invalid JSON format. Please paste valid cookie JSON.');
        }

        if (!Array.isArray(cookies)) {
            throw new Error('Cookies should be an array. Try exporting from EditThisCookie or Cookie-Editor extension.');
        }

        const ses = session.fromPartition(config.partition, { cache: true });

        // Replace existing cookies with the imported set.
        const existingCookies = await ses.cookies.get({});
        for (const cookie of existingCookies) {
            try {
                const url = `http${cookie.secure ? 's' : ''}://${cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain}${cookie.path || '/'}`;
                await ses.cookies.remove(url, cookie.name);
            } catch (e) {
                // Ignore individual cookie removal errors.
            }
        }

        const twoDaysFromNow = Math.floor(Date.now() / 1000) + (2 * 24 * 60 * 60);

        for (const cookie of cookies) {
            try {
                const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
                const url = `http${cookie.secure !== false ? 's' : ''}://${domain}${cookie.path || '/'}`;
                const cookieDetails = {
                    url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly === true,
                    sameSite: cookie.sameSite || 'no_restriction'
                };

                if (cookie.expirationDate && cookie.expirationDate > Date.now() / 1000) {
                    cookieDetails.expirationDate = cookie.expirationDate;
                } else {
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
        await backupCookies(provider, ses);
        await ses.cookies.flushStore();
    }

    const storageResult = await applyBrowserStorage(provider, config, payload);
    const view = browserManager.views.get(provider);
    if (view && !view.webContents.isDestroyed()) {
        await view.webContents.loadURL(config.url);
    }

    const messageParts = [];
    if (cookiesJson) {
        messageParts.push(`set ${setCount} cookies${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);
    }
    if (storageResult.applied) {
        if (storageResult.localStorageKeys.length > 0) {
            messageParts.push(`applied ${storageResult.localStorageKeys.length} localStorage key${storageResult.localStorageKeys.length === 1 ? '' : 's'}`);
        }
        if (storageResult.sessionStorageKeys.length > 0) {
            messageParts.push(`applied ${storageResult.sessionStorageKeys.length} sessionStorage key${storageResult.sessionStorageKeys.length === 1 ? '' : 's'}`);
        }
    }

    return {
        success: true,
        message: `Successfully ${messageParts.join(' and ')}. Reloading...`,
        setCount,
        errorCount,
        localStorageKeys: storageResult.localStorageKeys,
        sessionStorageKeys: storageResult.sessionStorageKeys
    };
}

ipcMain.handle('set-cookies', async (event, provider, cookiesJson) => {
    try {
        return await applyProviderAuthState(provider, { cookiesJson });
    } catch (e) {
        console.error('[Cookie] Error:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('set-provider-auth-state', async (event, provider, payload) => {
    try {
        return await applyProviderAuthState(provider, payload || {});
    } catch (e) {
        console.error('[Auth State] Error:', e);
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
        const domain = providerMap[provider]?.cookieDomain;
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


async function checkFileAttachment(provider) {
    return getProviderRuntime().checkFileAttachment(provider);
}

async function waitForSendButton(provider) {
    return getProviderRuntime().waitForSendButton(provider, {
        maxWait: 15000,
        checkInterval: 500,
        logPrefix: 'MCP'
    });
}

async function uploadFileToProvider(provider, filePath) {
    return getProviderRuntime().uploadFile(provider, filePath);
}

// App Lifecycle

app.whenReady().then(() => {
    applyDockIcon();
    createWindow();
});

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
    const urlObj = new URL(url);
    if (trustedCertificateDomains.some(domain => urlObj.hostname.includes(domain))) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

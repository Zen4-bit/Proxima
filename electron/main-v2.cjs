// Proxima — Electron Main Process.

const { app, BrowserWindow, ipcMain, shell, session, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const BrowserManager = require('./browser-manager.cjs');
const { initRestAPI, startRestAPI, stopRestAPI, isRestAPIRunning, generateApiKey, revokeApiKey, loadApiKey } = require('./api/rest-api.cjs');
const providerAPI = require('./providers/api.cjs');
const byok = require('./api/byok/index.cjs');

// ── Auto-Updater (electron-updater) ──────────────────────────────────
let autoUpdater = null;
try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;
} catch (e) {
    console.log('[AutoUpdater] electron-updater not available (dev mode or not installed):', e.message);
}

const providerSender = require('./providers/sender.cjs');
const { registerCoreHandlers } = require('./ipc/core.cjs');
const { registerSettingsHandlers } = require('./ipc/settings.cjs');
const { registerCLIHandlers } = require('./ipc/cli.cjs');
const pythonEnv = require('./python-env.cjs');
const envCheck = require('./env-check.cjs');

const CHROME_VERSION = (process.versions && process.versions.chrome) || '130.0.6723.191';
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

app.commandLine.appendSwitch('user-agent', CHROME_UA);
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'ElectronSerialChooser,OutOfBlinkCors');

app.userAgentFallback = CHROME_UA;

app.on('ready', () => {
    session.defaultSession.setUserAgent(CHROME_UA);

    clearProviderCachesOnStartup().catch((e) =>
        console.warn('[CacheClean] failed:', e && e.message)
    );
});

const PROVIDER_PARTITIONS = [
    'persist:perplexity',
    'persist:chatgpt',
    'persist:claude',
    'persist:gemini',
];

async function clearProviderCachesOnStartup() {
    try {
        const s = loadSettings();
        if (s && s.clearCacheOnStartup === false) return;
    } catch {
    }

    for (const partition of PROVIDER_PARTITIONS) {
        try {
            const ses = session.fromPartition(partition);
            await ses.clearCache();
            await ses.clearStorageData({ storages: ['cachestorage', 'shadercache'] });
        } catch (e) {
            console.warn(`[CacheClean] Skipped ${partition}: ${e && e.message}`);
        }
    }
    console.log('[CacheClean] Provider caches cleared on startup (logins preserved).');
}

const userDataPath = app.getPath('userData');
const settingsPath = path.join(userDataPath, 'settings.json');
const enabledProvidersPath = path.join(userDataPath, 'enabled-providers.json');
const ipcPortFilePath = path.join(userDataPath, 'ipc-port.json');
const ipcTokenFilePath = path.join(userDataPath, 'ipc-token.json');
let ipcAuthToken = null;

function provisionIpcToken() {
    try {
        const crypto = require('crypto');
        const token = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(ipcTokenFilePath, JSON.stringify({ token, pid: process.pid, updatedAt: Date.now() }));
        ipcAuthToken = token;
        console.log('[IPC] Auth token provisioned (TCP channel is gated).');
    } catch (e) {
        ipcAuthToken = null;
        console.error('[IPC] Could not persist auth token — TCP channel falls back to loopback-only trust:', e.message);
    }
}

let mainWindow;
let browserManager;
let ipcServer;

const defaultSettings = {
    providers: {
        perplexity: { enabled: true, loggedIn: false },
        chatgpt: { enabled: true, loggedIn: false },
        claude: { enabled: true, loggedIn: false },
        gemini: { enabled: true, loggedIn: false }
    },
    ipcPort: 19222,
    theme: 'dark',
    headlessMode: false,
    startMinimized: false
};

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            const merged = { ...defaultSettings, ...saved };
            merged.providers = { ...defaultSettings.providers };
            const savedProviders = (saved && typeof saved.providers === 'object' && saved.providers) || {};
            for (const name of new Set([...Object.keys(defaultSettings.providers), ...Object.keys(savedProviders)])) {
                merged.providers[name] = { ...(defaultSettings.providers[name] || {}), ...(savedProviders[name] || {}) };
            }
            return merged;
        }
    } catch (e) {
        console.error('Error loading settings:', e);
    }
    return defaultSettings;
}

function saveSettings(settings) {
    try {
        const tmp = settingsPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
        fs.renameSync(tmp, settingsPath);
    } catch (e) {
        console.error('Error saving settings:', e);
    }
}

function saveEnabledProviders(settings) {
    try {
        const enabled = Object.entries(settings.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        fs.writeFileSync(enabledProvidersPath, JSON.stringify({ enabled }, null, 2));

        try {
            const isDev = !app.isPackaged;
            const resourcesPath = process.resourcesPath || path.join(__dirname, '..');
            const mcpConfigPath = isDev
                ? path.join(__dirname, '..', 'src', 'enabled-providers.json')
                : path.join(resourcesPath, 'app.asar.unpacked', 'src', 'enabled-providers.json');

            fs.writeFileSync(mcpConfigPath, JSON.stringify({ enabled }, null, 2));
        } catch (e2) {
            console.log('[Settings] Could not write to app directory (normal in installed mode)');
        }
    } catch (e) {
        console.error('Error saving enabled providers:', e);
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
        show: !isHeadless && !startMinimized,
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
    mainWindow.setMaxListeners(50);

    browserManager = new BrowserManager(mainWindow);

    initModules();
    setupAutoUpdater();

    mainWindow.loadFile(path.join(__dirname, 'index-v2.html'));

    mainWindow.once('ready-to-show', async () => {
        if (!isHeadless && !startMinimized) {
            mainWindow.show();
        }
        console.log(`[Agent Hub] Running in ${isHeadless ? 'HEADLESS' : 'VISIBLE'} mode`);
        console.log('[Agent Hub] MCP server can connect on port', settings.ipcPort || 19222);

        const enabledProviders = Object.entries(settings.providers)
            .filter(([_, config]) => config.enabled)
            .map(([name]) => name);

        console.log('[Agent Hub] Auto-loading enabled providers:', enabledProviders);

        await sleep(1000);

        const bounds = { x: 0, y: 170, width: 1200, height: 680 };
        const offScreenBounds = { x: -10000, y: 0, width: 1200, height: 680 };

        for (let i = 0; i < enabledProviders.length; i++) {
            const provider = enabledProviders[i];
            try {
                console.log(`[Agent Hub] Initializing ${provider}...`);

                const view = browserManager.createView(provider);

                if (view) {
                    mainWindow.addBrowserView(view);

                    if (i === 0) {
                        view.setBounds(bounds);
                    } else {
                        view.setBounds(offScreenBounds);
                    }
                }

                await sleep(1500);

                const wc = browserManager.getWebContents(provider);
                if (wc) {
                    providerAPI.setupAutoInject(provider, wc);
                }
            } catch (err) {
                console.error(`[Agent Hub] Error initializing ${provider}:`, err.message);
            }
        }

        if (enabledProviders.length > 0) {
            browserManager.activeProvider = enabledProviders[0];
            console.log(`[Agent Hub] ${enabledProviders[0]} set as default (already visible)`);

            mainWindow.webContents.send('set-active-provider', enabledProviders[0]);
        }

        console.log('[Agent Hub] All providers initialized and ready!');
    });

    mainWindow.on('closed', () => {
        if (browserManager) {
            browserManager.destroy();
        }
        mainWindow = null;
    });

    saveEnabledProviders(loadSettings());

    startIPCServer();

    bootstrapPythonEnvironment();

    try {
        const currentSettings = loadSettings();
        initRestAPI({
            handleMCPRequest,
            getEnabledProviders: () => {
                const s = loadSettings();
                return Object.entries(s.providers)
                    .filter(([_, c]) => c.enabled).map(([n]) => n);
            }
        });
        if (currentSettings.restApiEnabled) {
            startRestAPI();
        } else {
            console.log('[REST API] Disabled in settings. Enable via UI toggle.');
        }
    } catch (e) {
        console.error('[REST API] Failed to start:', e.message);
    }
}

let _envReport = { python: { status: 'unknown' }, checks: null };

function bootstrapPythonEnvironment() {
    (async () => {
        try {
            const result = await pythonEnv.ensureEnvironmentAsync((line) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('python-env-progress', line);
                }
            });
            _envReport.python = pythonEnv.getStatus();
            _envReport.checks = await envCheck.runChecks(_envReport.python);

            console.log('[Env] Python:', _envReport.python.status, '-', _envReport.python.message);
            for (const c of _envReport.checks.checks) {
                const mark = c.present ? 'OK' : (c.required ? 'MISSING (required)' : 'missing (optional)');
                console.log(`[Env] ${c.name}: ${mark}`);
            }

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('env-status', _envReport);
            }

            if (result.ok) {
                const s = loadSettings();
                if (s.restApiEnabled && isRestAPIRunning()) {
                    console.log('[Env] Python ready — agent Web UI will use managed interpreter on next start');
                }
            }
        } catch (e) {
            console.error('[Env] Bootstrap error:', e.message);
            _envReport.python = { status: 'error', message: e.message };
        }
    })();
}

function startIPCServer() {
    const DEFAULT_IPC_PORT = 19222;

    provisionIpcToken();

    const providerQueues = {};

    function enqueueForProvider(provider, task) {
        if (!provider) return task();
        if (!providerQueues[provider]) providerQueues[provider] = Promise.resolve();

        const prev = providerQueues[provider];
        const next = prev.then(task, task);
        providerQueues[provider] = next.catch(() => { });
        return next;
    }

    const MAX_IPC_CONNECTIONS = 32;
    const MAX_IPC_BUFFER_BYTES = 8 * 1024 * 1024;
    const IPC_SOCKET_IDLE_MS = 10 * 60 * 1000;
    let _ipcConnCount = 0;

    ipcServer = net.createServer((socket) => {
        if (_ipcConnCount >= MAX_IPC_CONNECTIONS) {
            try { socket.destroy(); } catch (e) { }
            return;
        }
        _ipcConnCount++;
        socket.once('close', () => { _ipcConnCount = Math.max(0, _ipcConnCount - 1); });

        try { socket.setKeepAlive(true, 60 * 1000); } catch (e) { }

        socket.setTimeout(IPC_SOCKET_IDLE_MS, () => {
            try { socket.destroy(); } catch (e) { }
        });

        let buffer = '';

        socket.on('data', (data) => {
            buffer += data.toString();

            if (buffer.length > MAX_IPC_BUFFER_BYTES) {
                console.error('[IPC] Receive buffer exceeded cap — dropping connection');
                try { socket.destroy(); } catch (e) { }
                buffer = '';
                return;
            }

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;

                let request;
                try {
                    request = JSON.parse(line);
                } catch (e) {
                    continue;
                }

                if (ipcAuthToken && request.action !== 'ping' && request.token !== ipcAuthToken) {
                    if (socket.writable && !socket.destroyed) {
                        socket.write(JSON.stringify({
                            success: false,
                            error: 'Unauthorized: invalid or missing IPC token',
                            requestId: request.requestId,
                        }) + '\n');
                    }
                    continue;
                }

                const provider = request.provider || null;

                const task = async () => {
                    const HEARTBEAT_MS = 60 * 1000;
                    let hb = setInterval(() => {
                        if (socket.writable && !socket.destroyed) {
                            try {
                                socket.write(JSON.stringify({
                                    type: 'heartbeat',
                                    requestId: request.requestId,
                                }) + '\n');
                            } catch (e) { }
                        }
                    }, HEARTBEAT_MS);
                    if (hb.unref) hb.unref();

                    try {
                        const response = await handleMCPRequest(request);
                        response.requestId = request.requestId;
                        const responseStr = JSON.stringify(response) + '\n';

                        if (socket.writable && !socket.destroyed) {
                            socket.write(responseStr);
                        }
                    } catch (e) {
                        console.error('[IPC] Error:', e.message);
                        if (socket.writable && !socket.destroyed) {
                            socket.write(JSON.stringify({ error: e.message, requestId: request.requestId }) + '\n');
                        }
                    } finally {
                        clearInterval(hb);
                    }
                };

                enqueueForProvider(provider, task);
            }
        });

        socket.on('error', (err) => {
            if (err.code !== 'ECONNRESET') {
                console.error('[IPC] Socket error:', err);
            }
        });
    });

    function persistBoundPort(port) {
        try {
            const s = loadSettings();
            if (s.ipcPort !== port) {
                s.ipcPort = port;
                saveSettings(s);
            }
        } catch (e) {
            console.error('[IPC] Could not persist bound port to settings:', e.message);
        }
        try {
            fs.writeFileSync(
                ipcPortFilePath,
                JSON.stringify({ port, pid: process.pid, updatedAt: Date.now() })
            );
        } catch (e) {
            console.error('[IPC] Could not write ipc-port.json:', e.message);
        }
    }

    const MAX_PORT_ATTEMPTS = 20;

    function bindIPCPort(attempt) {
        const port = DEFAULT_IPC_PORT + attempt;

        const onListening = () => {
            console.log(`[IPC] Server listening on port ${port}`);
            console.log('[Agent Hub] MCP server can connect on port', port);
            persistBoundPort(port);
        };

        const onError = (err) => {
            if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS - 1) {
                console.log(`[IPC] Port ${port} in use, trying ${port + 1}...`);
                ipcServer.removeListener('error', onError);
                // Clean up listening handler to prevent firing on later successful binds.
                ipcServer.removeListener('listening', onListening);
                try { ipcServer.close(); } catch (e) { }
                setTimeout(() => bindIPCPort(attempt + 1), 200);
            } else {
                console.error('[IPC] Server error:', err.message);
            }
        };

        ipcServer.once('listening', onListening);
        ipcServer.once('error', onError);
        ipcServer.listen(port, '127.0.0.1');
    }

    bindIPCPort(0);
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
                    activeProvider: browserManager.activeProvider,
                    apiMode: byok.keys.isEnabled(),
                    byokProviders: byok.keys.isEnabled() ? byok.keys.listConfigured() : [],
                };

            case 'initProvider':
                if (byok.keys.isEnabled() && byok.keys.hasKey(provider)) {
                    return { success: true, provider, mode: 'api' };
                }
                browserManager.createView(provider);
                return { success: true, provider };

            case 'isLoggedIn': {
                if (byok.keys.isEnabled() && byok.keys.hasKey(provider)) {
                    const model = byok.keys.getSelectedModel(provider) || byok.models.DEFAULT_MODELS[provider] || 'auto';
                    return { success: true, provider, loggedIn: true, mode: 'api', model };
                }
                const loggedIn = await browserManager.isLoggedIn(provider);
                return { success: true, provider, loggedIn };
            }

            case 'sendMessage': {
                const baseProviderName = provider.split(':')[0];
                const engineOverride = data.gemini || data.engine || null;
                const targetProvider = engineOverride ? `${provider}:${engineOverride}` : provider;
                const conversationId = data.conversationId || data.conversation_id || data.sessionId || data.session_id || null;

                const byokKey = byok.keys.isEnabled() ? byok.keys.getKey(baseProviderName) : null;
                if (byokKey) {
                    try {
                        const startMs = Date.now();
                        const apiResult = await byok.callProvider(baseProviderName, byokKey, data.message, {
                            filePath: data.filePath || null,
                            engine: engineOverride,
                        });
                        if (!apiResult.text || apiResult.text.length === 0) {
                            return { success: false, provider: baseProviderName, error: `${baseProviderName} API returned empty response`, mode: 'api' };
                        }
                        return {
                            success: true,
                            provider: baseProviderName,
                            response: apiResult.text,
                            mode: 'api',
                            model: apiResult.model || null,
                            responseTimeMs: Date.now() - startMs,
                        };
                    } catch (apiErr) {
                        return { success: false, provider: baseProviderName, error: `API: ${apiErr.message}`, mode: 'api' };
                    }
                }

                if (data.filePath && fileReferenceEnabled) {
                    try {
                        const uploadResult = await uploadFileToProvider(provider, data.filePath);
                        await sleep(1000);
                        const result = await sendMessageToProvider(
                            targetProvider,
                            data.message,
                            uploadResult.imageToken ? {
                                imageToken: uploadResult.imageToken,
                                mimeType: uploadResult.mimeType,
                                filename: uploadResult.fileName,
                                fileSize: uploadResult.fileSize
                            } : null,
                            data.onChunk,
                            conversationId
                        );
                        if (!result.response && result.error) {
                            return { success: false, provider, error: result.error, fileUploaded: uploadResult };
                        }
                        if (!result.response || result.response.length === 0) {
                            return { success: false, provider, error: `${provider} returned empty response after all retries`, fileUploaded: uploadResult };
                        }
                        return { success: true, provider, response: result.response, fileUploaded: uploadResult };
                    } catch (fileErr) {
                        console.error('[MCP] File upload failed:', fileErr.message);
                        const result = await sendMessageToProvider(targetProvider, data.message, null, data.onChunk, conversationId);
                        if (!result.response || result.response.length === 0) {
                            return { success: false, provider, error: result.error || `${provider} returned empty response`, fileError: fileErr.message };
                        }
                        return { success: true, provider, response: result.response, fileError: fileErr.message };
                    }
                } else {
                    const result = await sendMessageToProvider(targetProvider, data.message, null, data.onChunk, conversationId);
                    if (!result.response && result.error) {
                        return { success: false, provider, error: result.error };
                    }
                    if (!result.response || result.response.length === 0) {
                        return { success: false, provider, error: `${provider} returned empty response after all retries` };
                    }
                    return { success: true, provider, response: result.response };
                }
            }

            case 'uploadFile':
                if (!fileReferenceEnabled) {
                    return { success: false, error: 'File reference is disabled. Enable it in Agent Hub settings.' };
                }
                try {
                    const uploadResult = await uploadFileToProvider(provider, data.filePath);
                    return { success: true, provider, ...uploadResult };
                } catch (uploadErr) {
                    return { success: false, error: uploadErr.message };
                }

            case 'sendMessageWithFile':
                if (!fileReferenceEnabled) {
                    return { success: false, error: 'File reference is disabled. Enable it in Agent Hub settings.' };
                }
                try {
                    let fileResult = null;
                    if (data.filePath && fileReferenceEnabled) {
                        fileResult = await uploadFileToProvider(provider, data.filePath);
                    }

                    const targetProviderWithFile = data.engine ? `${provider}:${data.engine}` : provider;
                    const conversationIdWithFile = data.conversationId || data.conversation_id || data.sessionId || data.session_id || null;
                    const msgResult = await sendMessageToProvider(
                        targetProviderWithFile,
                        data.message,
                        fileResult && fileResult.imageToken ? {
                            imageToken: fileResult.imageToken,
                            mimeType: fileResult.mimeType,
                            filename: fileResult.fileName,
                            fileSize: fileResult.fileSize
                        } : null,
                        null,
                        conversationIdWithFile
                    );
                    const finalResponse = (msgResult && msgResult.response) || '';
                    return {
                        success: true,
                        provider,
                        fileUploaded: fileResult,
                        messageSent: msgResult,
                        response: finalResponse
                    };
                } catch (err) {
                    return { success: false, error: err.message };
                }

            case 'executeScript':
                {
                    if (!loadSettings().allowScriptExecution) {
                        return { success: false, error: 'executeScript is disabled. Enable "allowScriptExecution" in settings to permit raw script injection.' };
                    }
                    const scriptResult = await browserManager.executeScript(provider, data.script);
                    return { success: true, provider, result: scriptResult };
                }

            case 'navigate':
                await browserManager.navigate(provider, data.url);
                return { success: true, provider };

            case 'newConversation':
                {
                    const wc = browserManager.getWebContents(provider);
                    try {
                        await providerAPI.resetConversation(provider, () => wc);
                    } catch (e) {
                        console.error(`[newConversation] reset failed for ${provider}:`, e.message);
                    }
                    return { success: true, provider };
                }

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
                {
                    const settings = loadSettings();
                    settings.headlessMode = data.enabled;
                    saveSettings(settings);
                    if (data.enabled && mainWindow) {
                        mainWindow.hide();
                    } else if (!data.enabled && mainWindow) {
                        mainWindow.show();
                    }
                    return { success: true, headlessMode: data.enabled };
                }

            case 'getByokStatus':
                return {
                    success: true,
                    enabled: byok.keys.isEnabled(),
                    providers: byok.keys.listConfigured().map(p => ({
                        name: p,
                        model: byok.keys.getSelectedModel(p) || byok.models.DEFAULT_MODELS[p] || 'auto',
                        hasKey: true,
                    })),
                };

            default:
                return { success: false, error: `Unknown action: ${action}` };
        }
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function initModules() {
    const deps = { browserManager, providerAPI };
    providerSender.init(deps);

    const handlerDeps = {
        mainWindow: () => mainWindow,
        browserManager,
        loadSettings, saveSettings, saveEnabledProviders,
        startRestAPI, stopRestAPI, isRestAPIRunning,
        generateApiKey, revokeApiKey, loadApiKey,
        getFileReferenceEnabled: () => fileReferenceEnabled,
        setFileReferenceEnabled: (v) => { fileReferenceEnabled = !!v; },
    };
    registerCoreHandlers(handlerDeps);
    registerSettingsHandlers(handlerDeps);
    registerCLIHandlers(handlerDeps);
}

const { sendMessageToProvider } = providerSender;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Auto-Updater Setup ──────────────────────────────────────────────
function setupAutoUpdater() {
    if (!autoUpdater) return;

    // Only check for updates in packaged (installed) builds
    if (!app.isPackaged) {
        console.log('[AutoUpdater] Skipping update check in dev mode.');
        return;
    }

    autoUpdater.on('checking-for-update', () => {
        console.log('[AutoUpdater] Checking for updates...');
        if (mainWindow) mainWindow.webContents.send('updater-status', { status: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
        console.log('[AutoUpdater] Update available:', info.version);
        if (mainWindow) mainWindow.webContents.send('updater-status', { status: 'available', version: info.version });
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('[AutoUpdater] Already on latest version:', info.version);
        if (mainWindow) mainWindow.webContents.send('updater-status', { status: 'up-to-date', version: info.version });
    });

    autoUpdater.on('download-progress', (progress) => {
        console.log(`[AutoUpdater] Downloading: ${Math.round(progress.percent)}%`);
        if (mainWindow) mainWindow.webContents.send('updater-status', { status: 'downloading', percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('[AutoUpdater] Update downloaded:', info.version, '— will install on quit.');
        if (mainWindow) mainWindow.webContents.send('updater-status', { status: 'ready', version: info.version });
    });

    autoUpdater.on('error', (err) => {
        console.error('[AutoUpdater] Error:', err.message);
        if (mainWindow) mainWindow.webContents.send('updater-status', { status: 'error', message: err.message });
    });

    // IPC: Manual check for updates from renderer
    ipcMain.handle('updater-check', async () => {
        try {
            const result = await autoUpdater.checkForUpdates();
            return { success: true, version: result?.updateInfo?.version };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // IPC: Quit and install downloaded update immediately
    ipcMain.handle('updater-install', () => {
        autoUpdater.quitAndInstall(false, true);
    });

    // Auto-check on startup (delay 5s to let the app fully load)
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(e => {
            console.warn('[AutoUpdater] Startup check failed:', e.message);
        });
    }, 5000);

    console.log('[AutoUpdater] Initialized. Will check for updates from GitHub Releases.');
}

let fileReferenceEnabled = true;

async function uploadFileToProvider(provider, filePath) {
    const webContents = browserManager.getWebContents(provider);
    if (!webContents) {
        throw new Error(`Provider ${provider} not initialized`);
    }

    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const fileStats = fs.statSync(filePath);
    const MAX_FILE_SIZE = 25 * 1024 * 1024;
    if (fileStats.size > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${(fileStats.size / 1024 / 1024).toFixed(1)}MB. Maximum is 25MB.`);
    }

    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const fileBase64 = fileBuffer.toString('base64');
    const fileMimeType = getMimeType(filePath);

    if (provider === 'gemini') {
        console.log(`[Gemini API] Direct upload of ${fileName} via Scotty API...`);
        try {
            await providerAPI.ensureAPI(provider, webContents);
            const token = await webContents.executeJavaScript(
                `window.__proximaGemini.uploadFileToGoogle(${JSON.stringify(fileBase64)}, ${JSON.stringify(fileName)}, ${JSON.stringify(fileMimeType)})`
            );
            return {
                success: true,
                fileName,
                mimeType: fileMimeType,
                imageToken: token,
                fileAttached: true,
                method: 'scotty-api'
            };
        } catch (apiUploadErr) {
            console.error(`[Gemini API] Direct Scotty upload failed:`, apiUploadErr.message);
            throw apiUploadErr;
        }
    }

    if (provider.startsWith('chatgpt')) {
        console.log(`[ChatGPT API] Direct upload of ${fileName} via Web API...`);
        try {
            await providerAPI.ensureAPI(provider, webContents);
            const token = await webContents.executeJavaScript(
                `window.__proximaChatGPT.uploadFileToChatGPT(${JSON.stringify(fileBase64)}, ${JSON.stringify(fileName)}, ${JSON.stringify(fileMimeType)})`
            );
            return {
                success: true,
                fileName,
                mimeType: fileMimeType,
                imageToken: token,
                fileAttached: true,
                fileSize: fileStats.size,
                method: 'chatgpt-api'
            };
        } catch (apiUploadErr) {
            console.error(`[ChatGPT API] Direct upload failed:`, apiUploadErr.message);
            throw apiUploadErr;
        }
    }

    if (provider === 'perplexity') {
        console.log(`[Perplexity API] Direct upload of ${fileName} via Web API...`);
        try {
            await providerAPI.ensureAPI(provider, webContents);
            const token = await webContents.executeJavaScript(
                `window.__proximaPerplexity.uploadFileToPerplexity(${JSON.stringify(fileBase64)}, ${JSON.stringify(fileName)}, ${JSON.stringify(fileMimeType)})`
            );
            return {
                success: true,
                fileName,
                mimeType: fileMimeType,
                imageToken: token,
                fileAttached: true,
                fileSize: fileStats.size,
                method: 'perplexity-api'
            };
        } catch (apiUploadErr) {
            console.error(`[Perplexity API] Direct upload failed:`, apiUploadErr.message);
            throw apiUploadErr;
        }
    }

    if (provider.startsWith('claude')) {
        console.log(`[Claude API] Direct upload of ${fileName} via Web API...`);
        try {
            await providerAPI.ensureAPI(provider, webContents);
            const token = await webContents.executeJavaScript(
                `window.__proximaClaude.uploadFileToClaude(${JSON.stringify(fileBase64)}, ${JSON.stringify(fileName)}, ${JSON.stringify(fileMimeType)})`
            );
            return {
                success: true,
                fileName,
                mimeType: fileMimeType,
                imageToken: token,
                fileAttached: true,
                fileSize: fileStats.size,
                method: 'claude-api'
            };
        } catch (apiUploadErr) {
            console.error(`[Claude API] Direct upload failed:`, apiUploadErr.message);
            throw apiUploadErr;
        }
    }

    throw new Error(`File upload is not supported for ${provider} (API mode). Only Gemini, ChatGPT, Perplexity, and Claude support file attachments.`);
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (ipcServer) {
        ipcServer.close();
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

let _childrenCleanedUp = false;
function cleanupSpawnedChildren() {
    if (_childrenCleanedUp) return;
    _childrenCleanedUp = true;
    try { stopRestAPI(); } catch (e) { }
    if (ipcServer) { try { ipcServer.close(); } catch { } }
}

app.on('before-quit', cleanupSpawnedChildren);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
        cleanupSpawnedChildren();
        try { app.quit(); } catch { }
    });
}

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    const trustedDomains = ['perplexity.ai', 'openai.com', 'chatgpt.com', 'claude.ai', 'anthropic.com', 'gemini.google.com', 'accounts.google.com'];
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return callback(false);
    }
    const trusted = trustedDomains.some(domain => host === domain || host.endsWith('.' + domain));
    if (trusted) {
        event.preventDefault();
        callback(true);
    } else {
        callback(false);
    }
});

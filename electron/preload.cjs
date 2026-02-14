// Preload — bridge between renderer and main process

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHub', {
    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    saveEnabledProviders: () => ipcRenderer.invoke('save-enabled-providers'),

    // Provider Management
    initProvider: (provider) => ipcRenderer.invoke('init-provider', provider),
    showProvider: (provider) => ipcRenderer.invoke('show-provider', provider),
    hideBrowser: () => ipcRenderer.invoke('hide-browser'),
    checkLoginStatus: (provider) => ipcRenderer.invoke('check-login-status', provider),
    reloadProvider: (provider) => ipcRenderer.invoke('reload-provider', provider),
    openInSystemBrowser: (provider) => ipcRenderer.invoke('open-in-system-browser', provider),

    // MCP Config
    getMcpConfig: () => ipcRenderer.invoke('get-mcp-config'),
    getIpcPort: () => ipcRenderer.invoke('get-ipc-port'),

    // Cookie Login (manual fallback if needed)
    setCookies: (provider, cookiesJson) => ipcRenderer.invoke('set-cookies', provider, cookiesJson),
    getCookies: (provider) => ipcRenderer.invoke('get-cookies', provider),

    // File Reference Feature
    setFileReferenceEnabled: (enabled) => ipcRenderer.invoke('set-file-reference-enabled', enabled),
    getFileReferenceEnabled: () => ipcRenderer.invoke('get-file-reference-enabled'),

    // Utilities
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Event listeners
    onProviderNavigated: (callback) => {
        ipcRenderer.on('provider-navigated', (event, data) => callback(data));
    },
    onProviderLoaded: (callback) => {
        ipcRenderer.on('provider-loaded', (event, data) => callback(data));
    },
    onActiveProvider: (callback) => {
        ipcRenderer.on('set-active-provider', (event, provider) => callback(provider));
    }
});

// Proxima — Preload bridge (renderer ↔ main process)

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHub', {

    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    saveEnabledProviders: () => ipcRenderer.invoke('save-enabled-providers'),


    initProvider: (provider) => ipcRenderer.invoke('init-provider', provider),
    showProvider: (provider) => ipcRenderer.invoke('show-provider', provider),
    hideBrowser: () => ipcRenderer.invoke('hide-browser'),
    checkLoginStatus: (provider) => ipcRenderer.invoke('check-login-status', provider),
    reloadProvider: (provider) => ipcRenderer.invoke('reload-provider', provider),
    openInSystemBrowser: (provider) => ipcRenderer.invoke('open-in-system-browser', provider),


    getMcpConfig: () => ipcRenderer.invoke('get-mcp-config'),
    getIpcPort: () => ipcRenderer.invoke('get-ipc-port'),


    setCookies: (provider, cookiesJson) => ipcRenderer.invoke('set-cookies', provider, cookiesJson),
    getCookies: (provider) => ipcRenderer.invoke('get-cookies', provider),


    setFileReferenceEnabled: (enabled) => ipcRenderer.invoke('set-file-reference-enabled', enabled),
    getFileReferenceEnabled: () => ipcRenderer.invoke('get-file-reference-enabled'),


    setRestApiEnabled: (enabled) => ipcRenderer.invoke('set-rest-api-enabled', enabled),
    getRestApiEnabled: () => ipcRenderer.invoke('get-rest-api-enabled'),


    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    installCli: () => ipcRenderer.invoke('install-cli'),
    uninstallCli: () => ipcRenderer.invoke('uninstall-cli'),
    isCliInstalled: () => ipcRenderer.invoke('is-cli-installed'),


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

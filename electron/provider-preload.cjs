// Provider preload — injected into AI provider pages

const { contextBridge, ipcRenderer } = require('electron');

// Expose limited API to the provider pages
contextBridge.exposeInMainWorld('agentHubBridge', {
    // Report ready state
    reportReady: () => {
        ipcRenderer.send('provider-ready');
    },

    // Report errors
    reportError: (error) => {
        ipcRenderer.send('provider-error', error);
    }
});

// Monitor for response completion (optimized — debounced, less CPU usage)
let lastResponseCheck = null;
let observer = null;

function setupResponseMonitor() {
    // Debounced observer — only fires IPC after 1.5s of DOM stability
    observer = new MutationObserver(() => {
        clearTimeout(lastResponseCheck);
        lastResponseCheck = setTimeout(() => {
            ipcRenderer.send('response-may-be-complete');
        }, 1500);
    });

    // Observe main content area — childList only (skip characterData for perf)
    const targetNode = document.querySelector('main') || document.querySelector('#__next') || document.body;
    if (targetNode) {
        observer.observe(targetNode, {
            childList: true,
            subtree: true,
            characterData: false  // Skip character-level changes for performance
        });
    }
}

// Cleanup on page unload to prevent memory leaks
window.addEventListener('beforeunload', () => {
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    clearTimeout(lastResponseCheck);
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupResponseMonitor);
} else {
    setupResponseMonitor();
}

console.log('[Agent Hub] Provider preload script loaded');

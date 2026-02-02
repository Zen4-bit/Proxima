/**
 * Provider Preload Script
 * Injected into AI provider pages for enhanced interaction
 */

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

// Monitor for response completion
let lastResponseCheck = null;

// Helper to detect when AI response is complete
function setupResponseMonitor() {
    const observer = new MutationObserver((mutations) => {
        // Check if a response just completed
        clearTimeout(lastResponseCheck);
        lastResponseCheck = setTimeout(() => {
            ipcRenderer.send('response-may-be-complete');
        }, 1000);
    });

    // Observe the main content area for changes
    const targetNode = document.body;
    if (targetNode) {
        observer.observe(targetNode, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupResponseMonitor);
} else {
    setupResponseMonitor();
}

console.log('[Agent Hub] Provider preload script loaded');

const { clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { providerMap } = require('../src/provider-catalog.cjs');
const {
    getOldResponseCaptureScript,
    normalizeResponseState,
    buildResponseExtractionScript,
    buildTypingDetectionScript,
    buildSendButtonReadyScript,
    buildFileAttachmentCheckScript,
    buildFileUploadScript,
    getResponseOptions,
    hasNewDomResponse
} = require('../src/provider-automation.cjs');

const sendToChatGPT = require('./provider-senders/chatgpt.cjs');
const sendToClaude = require('./provider-senders/claude.cjs');
const sendToCopilot = require('./provider-senders/copilot.cjs');
const sendToDeepSeek = require('./provider-senders/deepseek.cjs');
const sendToGemini = require('./provider-senders/gemini.cjs');
const sendToGoogleAI = require('./provider-senders/googleai.cjs');
const sendToGrok = require('./provider-senders/grok.cjs');
const sendToMetaAI = require('./provider-senders/metaai.cjs');
const sendToPerplexity = require('./provider-senders/perplexity.cjs');
const sendToQwen = require('./provider-senders/qwen.cjs');
const sendToZAI = require('./provider-senders/zai.cjs');

const senderMap = {
    chatgpt: sendToChatGPT,
    claude: sendToClaude,
    copilot: sendToCopilot,
    deepseek: sendToDeepSeek,
    gemini: sendToGemini,
    googleai: sendToGoogleAI,
    grok: sendToGrok,
    metaai: sendToMetaAI,
    perplexity: sendToPerplexity,
    qwen: sendToQwen,
    zai: sendToZAI
};

class ProviderRuntime {
    constructor({ browserManager, getSettings }) {
        this.browserManager = browserManager;
        this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
        this.providerMap = providerMap;
        this.clipboard = clipboard;
        this.responseState = new Map();
    }

    getWebContents(provider) {
        const webContents = this.browserManager.getWebContents(provider);
        if (!webContents) {
            throw new Error(`Provider ${provider} not initialized`);
        }
        return webContents;
    }

    getSender(provider) {
        const sender = senderMap[provider];
        if (!sender) {
            throw new Error(`Unknown provider: ${provider}`);
        }
        return sender;
    }

    getProviderState(provider) {
        if (!this.responseState.has(provider)) {
            this.responseState.set(provider, {
                fingerprint: '',
                blockCount: 0,
                hasBaseline: false
            });
        }

        return this.responseState.get(provider);
    }

    clearProviderState(provider) {
        this.responseState.set(provider, {
            fingerprint: '',
            blockCount: 0,
            hasBaseline: false
        });
    }

    resolveAutomationBounds(provider) {
        const defaultBounds = { x: 0, y: 170, width: 1200, height: 680 };
        const views = this.browserManager?.views;

        if (!(views instanceof Map)) {
            return defaultBounds;
        }

        const getUsableBounds = (view) => {
            if (!view || typeof view.getBounds !== 'function') {
                return null;
            }

            const bounds = view.getBounds();
            if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
                return null;
            }

            return bounds.x >= 0 ? bounds : null;
        };

        const activeView = this.browserManager?.activeProvider
            ? views.get(this.browserManager.activeProvider)
            : null;
        const targetView = views.get(provider);

        return getUsableBounds(activeView) || getUsableBounds(targetView) || defaultBounds;
    }

    async prepareProviderForAutomation(provider) {
        const mainWindow = this.browserManager?.mainWindow;
        const showProvider = this.browserManager?.showProvider?.bind(this.browserManager);
        const bounds = this.resolveAutomationBounds(provider);

        if (typeof showProvider === 'function') {
            try {
                showProvider(provider, bounds);
            } catch (error) {
                console.log(`[prepareProviderForAutomation] ${provider}: showProvider failed:`, error.message);
            }
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.focus();
            } catch (error) {}

            try {
                mainWindow.webContents.send('set-active-provider', provider);
            } catch (error) {}
        }

        const webContents = this.getWebContents(provider);
        try {
            webContents.focus();
        } catch (error) {}

        await this.sleep(150);
    }

    resolveCapturedImageDownloadDir() {
        const configuredDir = this.getSettings()?.capturedImageDownloadDir;
        const resolvedDir = configuredDir
            ? path.resolve(configuredDir)
            : path.join(os.tmpdir(), 'brainstorm-captured-images');

        fs.mkdirSync(resolvedDir, { recursive: true });
        return resolvedDir;
    }

    getImageExtensionFromContentType(contentType = '') {
        const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
        return {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/webp': '.webp',
            'image/gif': '.gif',
            'image/svg+xml': '.svg',
            'image/bmp': '.bmp',
            'image/heic': '.heic',
            'image/heif': '.heif'
        }[normalized] || '';
    }

    getImageExtensionFromUrl(imageUrl = '') {
        try {
            const pathname = new URL(imageUrl).pathname || '';
            const ext = path.extname(pathname).toLowerCase();
            return ext && ext.length <= 6 ? ext : '';
        } catch (e) {
            return '';
        }
    }

    async downloadImageToLocalPath(provider, image) {
        const sourceUrl = String(image?.src || '').trim();
        if (!sourceUrl) {
            return null;
        }

        const downloadDir = this.resolveCapturedImageDownloadDir();
        const fileHash = crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 16);
        let extension = this.getImageExtensionFromUrl(sourceUrl) || '.img';
        let targetPath = path.join(downloadDir, `${provider}-${fileHash}${extension}`);

        if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
            return targetPath;
        }

        const response = await fetch(sourceUrl);
        if (!response.ok) {
            throw new Error(`Image download failed (${response.status})`);
        }

        const contentType = response.headers.get('content-type') || '';
        const typedExtension = this.getImageExtensionFromContentType(contentType);
        if (typedExtension) {
            extension = typedExtension;
            targetPath = path.join(downloadDir, `${provider}-${fileHash}${extension}`);
            if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 0) {
                return targetPath;
            }
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(targetPath, buffer);
        return targetPath;
    }

    async materializeCapturedImages(provider, images = []) {
        const localPaths = [];

        for (const image of images) {
            try {
                const localPath = await this.downloadImageToLocalPath(provider, image);
                if (localPath) {
                    localPaths.push(localPath);
                }
            } catch (error) {
                console.error(`[${provider}] Failed to download generated image:`, error.message);
            }
        }

        return localPaths;
    }

    emitProviderAlert(provider, message, kind = 'warning') {
        const mainWindow = this.browserManager?.mainWindow;
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        mainWindow.webContents.send('provider-alert', {
            provider,
            kind,
            message,
            timestamp: Date.now()
        });
    }

    normalizeExtractedResponse(raw) {
        if (typeof raw === 'string') {
            return {
                text: raw.trim(),
                images: [],
                imageCount: 0,
                challenge: null
            };
        }

        if (!raw || typeof raw !== 'object') {
            return {
                text: '',
                images: [],
                imageCount: 0,
                challenge: null
            };
        }

        const images = Array.isArray(raw.images)
            ? raw.images
                .filter((image) => image && typeof image === 'object')
                .map((image) => ({
                    src: typeof image.src === 'string' ? image.src : '',
                    alt: typeof image.alt === 'string' ? image.alt : '',
                    width: Number.isFinite(image.width) ? image.width : null,
                    height: Number.isFinite(image.height) ? image.height : null
                }))
                .filter((image) => image.src || image.alt)
            : [];

        const challenge = raw.challenge && typeof raw.challenge === 'object'
            ? {
                kind: typeof raw.challenge.kind === 'string' ? raw.challenge.kind : 'human_verification',
                message: typeof raw.challenge.message === 'string'
                    ? raw.challenge.message
                    : 'Human verification is required in brAInstorm before this provider can continue.'
            }
            : null;

        return {
            text: typeof raw.text === 'string' ? raw.text.trim() : '',
            images,
            imageCount: Number.isFinite(raw.imageCount) ? raw.imageCount : images.length,
            challenge,
            url: typeof raw.url === 'string' ? raw.url : ''
        };
    }

    hasMeaningfulExtractedResponse(payload) {
        if (!payload) {
            return false;
        }

        return !!payload.challenge ||
            Boolean(payload.text) ||
            (Array.isArray(payload.images) && payload.images.length > 0) ||
            Number(payload.imageCount || 0) > 0;
    }

    getExtractedResponseSignature(payload) {
        if (!payload) {
            return '';
        }

        return JSON.stringify({
            text: payload.text || '',
            imageCount: payload.imageCount || 0,
            images: Array.isArray(payload.images)
                ? payload.images.slice(0, 6).map((image) => ({
                    src: image.src || '',
                    alt: image.alt || ''
                }))
                : [],
            challenge: payload.challenge?.kind || ''
        });
    }

    getFingerprintText(payload) {
        if (!payload) {
            return '';
        }

        if (payload.text) {
            return payload.text;
        }

        if (payload.challenge?.message) {
            return payload.challenge.message;
        }

        if (payload.imageCount > 0) {
            return `[images:${payload.imageCount}] ` + (payload.images || [])
                .map((image) => image.alt || image.src || '')
                .join(' ');
        }

        return '';
    }

    async formatCapturedResponse(provider, payload) {
        if (!payload || !this.hasMeaningfulExtractedResponse(payload)) {
            return 'No response captured';
        }

        if (payload.challenge) {
            return {
                provider,
                type: payload.challenge.kind || 'human_verification',
                text: payload.text || '',
                imageCount: payload.imageCount || 0,
                images: payload.images || [],
                challenge: payload.challenge
            };
        }

        if ((payload.imageCount || 0) > 0) {
            const localPaths = await this.materializeCapturedImages(provider, payload.images || []);
            return {
                provider,
                type: 'image_response',
                text: payload.text || '',
                imageCount: localPaths.length,
                images: localPaths
            };
        }

        return payload.text || 'No response captured';
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async resetNetworkCapture(webContents) {
        try {
            await webContents.executeJavaScript(`
                window.__proxima_captured_response = '';
                window.__proxima_is_streaming = false;
                window.__proxima_last_capture_time = 0;
                window.__proxima_active_stream_id = null;
                if (window.__proxima_blocks) window.__proxima_blocks = {};
            `);
        } catch (e) {
            // Non-critical.
        }
    }

    async capturePreviousResponse(provider, options = {}) {
        const { force = true } = options;
        const state = this.getProviderState(provider);

        if (!force && state.hasBaseline) {
            return { ...state };
        }

        const webContents = this.getWebContents(provider);
        const script = getOldResponseCaptureScript(provider);

        if (!script) {
            state.hasBaseline = true;
            return { ...state };
        }

        let rawValue = null;
        try {
            rawValue = await webContents.executeJavaScript(script);
        } catch (e) {
            rawValue = null;
        }

        const normalized = normalizeResponseState(provider, rawValue);
        Object.assign(state, normalized, { hasBaseline: true });
        return { ...state };
    }

    async sendMessage(provider, message) {
        await this.prepareProviderForAutomation(provider);

        const webContents = this.getWebContents(provider);
        await this.resetNetworkCapture(webContents);

        const sender = this.getSender(provider);
        return sender({
            webContents,
            message,
            runtime: this
        });
    }

    async typeIntoPage(webContents, text) {
        await webContents.executeJavaScript(`
            (function() {
                const text = ${JSON.stringify(text)};
                const active = document.activeElement;

                if (active) {
                    if (active.contentEditable === 'true') {
                        active.innerText = text;
                        active.dispatchEvent(new Event('input', { bubbles: true }));
                    } else if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
                        active.value = text;
                        active.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }

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

        await this.sleep(100);
    }

    async getResponseWithTypingStatus(provider) {
        const state = this.getProviderState(provider);
        if (!state.hasBaseline) {
            try {
                await this.capturePreviousResponse(provider, { force: true });
            } catch (e) {
                console.error(`[getResponseWithTyping] Error capturing old fingerprint for ${provider}:`, e.message);
            }
        }

        const response = await this.getProviderResponse(provider);
        return {
            typingStarted: true,
            typingStopped: true,
            response
        };
    }

    async getProviderResponse(provider, customSelector = null) {
        void customSelector;

        const webContents = this.getWebContents(provider);
        const responseOptions = getResponseOptions(provider);
        const maxPolls = responseOptions.maxWaitSeconds * 2;
        const imageCapableProviders = new Set(['chatgpt', 'gemini', 'googleai', 'grok', 'copilot', 'metaai', 'qwen']);
        const baselineCheckedProviders = new Set(['perplexity', 'claude', 'deepseek', 'grok', 'zai', 'copilot', 'metaai', 'qwen', 'googleai']);
        const domShortCircuitProviders = new Set(['metaai']);
        let networkTextCandidate = '';

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

                if (!status.installed) {
                    console.log(`[getProviderResponse] ${provider}: Interceptor not installed, using DOM fallback`);
                    break;
                }

                if (status.response.length > 0) {
                    if (!status.isStreaming) {
                        console.log(`[getProviderResponse] ⚡ ${provider}: Network capture COMPLETE! ${status.response.length} chars (poll #${i})`);
                        await webContents.executeJavaScript(`window.__proxima_captured_response = ''`).catch(() => {});
                        if (!imageCapableProviders.has(provider)) {
                            this.clearProviderState(provider);
                            return status.response;
                        }

                        networkTextCandidate = status.response;
                        console.log(`[getProviderResponse] ${provider}: Preserving network text candidate and continuing to DOM/image capture`);
                        break;
                    }

                    if (i % 10 === 0 && i > 0) {
                        console.log(`[getProviderResponse] ${provider}: Still streaming... ${status.response.length} chars captured`);
                    }
                }

                if (i > 3 && !status.isStreaming && status.response.length === 0) {
                    console.log(`[getProviderResponse] ${provider}: No usable stream data after ${i * 0.5}s, trying DOM fallback`);
                    break;
                }
            } catch (e) {
                if (i > 40) {
                    console.log(`[getProviderResponse] ${provider}: Interceptor error, falling back to DOM`);
                    break;
                }
            }

            await this.sleep(500);
        }

        console.log(`[getProviderResponse] ${provider}: Using DOM fallback path...`);

        const extractScript = buildResponseExtractionScript(provider);
        if (!extractScript) {
            this.clearProviderState(provider);
            return networkTextCandidate || 'No response captured';
        }

        const previousState = { ...this.getProviderState(provider) };
        let lastPayload = null;
        let lastSignature = '';
        let stableCount = 0;
        let foundNewResponse = false;

        const emitChallenge = (payload) => {
            if (!payload?.challenge) {
                return;
            }

            this.emitProviderAlert(provider, payload.challenge.message, payload.challenge.kind || 'warning');
            this.clearProviderState(provider);
            throw new Error(payload.challenge.message);
        };

        const isFreshDomPayload = async (payload, fingerprintText) => {
            if (!baselineCheckedProviders.has(provider) || foundNewResponse) {
                return true;
            }

            let currentState;
            if (provider === 'perplexity') {
                const currentRaw = await webContents.executeJavaScript(getOldResponseCaptureScript(provider)).catch(() => ({ count: 0, fingerprint: '' }));
                currentState = normalizeResponseState(provider, currentRaw);
            } else {
                currentState = {
                    fingerprint: fingerprintText.substring(0, 200).trim(),
                    blockCount: 0
                };
            }

            if (hasNewDomResponse({ provider, previousState, currentState })) {
                foundNewResponse = true;
                return true;
            }

            if (previousState.fingerprint || previousState.blockCount > 0) {
                return false;
            }

            foundNewResponse = true;
            return true;
        };

        const collectDomPayload = async () => {
            const rawPayload = await webContents.executeJavaScript(extractScript).catch(() => null);
            const payload = this.normalizeExtractedResponse(rawPayload);
            emitChallenge(payload);

            if (!this.hasMeaningfulExtractedResponse(payload)) {
                return { ready: false, payload: null, fingerprintText: '' };
            }

            const fingerprintText = this.getFingerprintText(payload);
            if (!(await isFreshDomPayload(payload, fingerprintText))) {
                return { ready: false, payload: null, fingerprintText };
            }

            const signature = this.getExtractedResponseSignature(payload);
            if (signature === lastSignature) {
                stableCount++;
            } else {
                stableCount = 0;
                lastPayload = payload;
                lastSignature = signature;
            }

            return {
                ready: stableCount >= responseOptions.stableThreshold,
                payload: lastPayload || payload,
                fingerprintText
            };
        };

        let typingNow = { isTyping: false };
        try {
            typingNow = await this.isTyping(provider);
        } catch (e) {
            typingNow = { isTyping: false, error: e.message };
        }

        if (typingNow.isTyping) {
            console.log(`[getProviderResponse] ${provider}: AI still typing, waiting...`);
            for (let i = 0; i < responseOptions.maxWaitSeconds; i++) {
                let typingStatus;
                try {
                    typingStatus = await this.isTyping(provider);
                } catch (e) {
                    break;
                }

                if (domShortCircuitProviders.has(provider)) {
                    const domResult = await collectDomPayload();
                    if (domResult.ready && domResult.payload) {
                        console.log(`[getProviderResponse] ${provider}: DOM response stabilized while typing signal remained active`);
                        this.clearProviderState(provider);
                        return await this.formatCapturedResponse(provider, domResult.payload);
                    }
                }

                if (!typingStatus.isTyping) {
                    break;
                }

                if (i % 20 === 0 && i > 0) {
                    console.log(`[getProviderResponse] ${provider}: Still typing (${i * 0.5}s)...`);
                }

                await this.sleep(500);
            }
        }

        await this.sleep(responseOptions.domSettleDelayMs);

        try {
            const lateCheck = await webContents.executeJavaScript(`
                (function() {
                    const response = window.__proxima_captured_response || '';
                    const streaming = window.__proxima_is_streaming || false;
                    if (response.length > 50 && !streaming) {
                        window.__proxima_captured_response = '';
                        return response;
                    }
                    return '';
                })()
            `);

            if (lateCheck && lateCheck.length > 50) {
                console.log(`[getProviderResponse] ✅ ${provider}: Late network capture (${lateCheck.length} chars)`);
                if (!imageCapableProviders.has(provider)) {
                    this.clearProviderState(provider);
                    return lateCheck;
                }

                networkTextCandidate = lateCheck;
                console.log(`[getProviderResponse] ${provider}: Preserving late network text candidate and continuing to DOM/image capture`);
            }
        } catch (e) {
            // Ignore late network fallback errors.
        }

        for (let i = 0; i < responseOptions.maxDomPolls; i++) {
            const domResult = await collectDomPayload();
            if (domResult.ready && domResult.payload) {
                console.log(`[getProviderResponse] ✓ Captured (${domResult.fingerprintText.length} chars, ${domResult.payload.imageCount || 0} images)`);
                this.clearProviderState(provider);
                return await this.formatCapturedResponse(provider, domResult.payload);
            }

            await this.sleep(500);
        }

        this.clearProviderState(provider);
        if (lastPayload && this.hasMeaningfulExtractedResponse(lastPayload)) {
            return await this.formatCapturedResponse(provider, lastPayload);
        }

        this.clearProviderState(provider);
        return networkTextCandidate || 'No response captured';
    }

    async isTyping(provider) {
        const webContents = this.getWebContents(provider);
        const typingScript = buildTypingDetectionScript(provider);

        try {
            return await webContents.executeJavaScript(typingScript);
        } catch (e) {
            return { isTyping: false, error: e.message };
        }
    }

    async waitForSendButton(provider, options = {}) {
        const webContents = this.getWebContents(provider);
        const maxWait = options.maxWait || 10000;
        const checkInterval = options.checkInterval || 200;
        const logPrefix = options.logPrefix || 'waitForSendButton';

        if ((provider === 'gemini' || provider === 'googleai') && !options.force) {
            console.log(`[${logPrefix}] ${provider}: Skipping (handled in file upload)`);
            return true;
        }

        console.log(`[${logPrefix}] Waiting for ${provider} send button...`);

        let waited = 0;
        const readyScript = buildSendButtonReadyScript(provider);

        while (waited < maxWait) {
            const isReady = await webContents.executeJavaScript(readyScript).catch(() => true);

            if (isReady) {
                console.log(`[${logPrefix}] ${provider}: Send button ready!`);
                return true;
            }

            await this.sleep(checkInterval);
            waited += checkInterval;
        }

        console.log(`[${logPrefix}] ${provider}: Timeout waiting for send button`);
        return false;
    }

    async checkFileAttachment(provider) {
        const webContents = this.getWebContents(provider);
        const checkScript = buildFileAttachmentCheckScript();
        return webContents.executeJavaScript(checkScript);
    }

    async uploadFile(provider, filePath) {
        await this.prepareProviderForAutomation(provider);

        const webContents = this.getWebContents(provider);

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const fileStats = fs.statSync(filePath);
        const maxFileSize = 25 * 1024 * 1024;
        if (fileStats.size > maxFileSize) {
            throw new Error(`File too large: ${(fileStats.size / 1024 / 1024).toFixed(1)}MB. Maximum is 25MB.`);
        }

        const fileName = path.basename(filePath);
        const fileBuffer = fs.readFileSync(filePath);
        const fileBase64 = fileBuffer.toString('base64');
        const fileMimeType = getMimeType(filePath);

        console.log(`[FileReference] Uploading ${fileName} via file input method...`);

        const uploadScript = buildFileUploadScript(provider, {
            fileName,
            fileBase64,
            fileMimeType
        });

        if (!uploadScript) {
            throw new Error(`File upload is not configured for provider ${provider}`);
        }

        return webContents.executeJavaScript(uploadScript);
    }
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
        '.csv': 'text/csv',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml'
    };

    return mimeTypes[ext] || 'application/octet-stream';
}

module.exports = ProviderRuntime;

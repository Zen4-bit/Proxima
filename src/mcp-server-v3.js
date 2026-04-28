#!/usr/bin/env node
// Proxima MCP Server v4.1.0 — IPC bridge to Electron Agent Hub

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import net from 'net';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IPC_PORT = process.env.AGENT_HUB_PORT || 19222;

// ─── IPC Client ───────────────────────────────────────

class IPCClient {
    constructor(port = IPC_PORT) {
        this.port = port;
        this.socket = null;
        this.connected = false;
        this.responseBuffer = '';
        this.pendingRequests = new Map();
        this.requestId = 0;
    }

    async connect() {
        if (this.connected) return true;

        // Prevent socket leak on reconnect
        if (this.socket) {
            try { this.socket.destroy(); } catch(e) {}
            this.socket = null;
        }

        return new Promise((resolve, reject) => {
            this.socket = net.createConnection({ port: this.port, host: '127.0.0.1' }, () => {
                console.error('[MCP] Connected to Agent Hub');
                this.connected = true;
                resolve(true);
            });

            this.socket.on('data', (data) => {
                this.responseBuffer += data.toString();
                this.processBuffer();
            });

            this.socket.on('error', (err) => {
                console.error('[MCP] IPC Error:', err.message);
                this.connected = false;
                reject(err);
            });

            this.socket.on('close', () => {
                console.error('[MCP] Disconnected from Agent Hub');
                this.connected = false;
                // Reject pending requests to avoid hanging promises
                for (const [id, { reject: rej }] of this.pendingRequests) {
                    rej(new Error('Connection to Agent Hub lost'));
                }
                this.pendingRequests.clear();
            });

    
            setTimeout(() => {
                if (!this.connected) {
                    reject(new Error('Connection timeout - Is Agent Hub running?'));
                }
            }, 5000);
        });
    }

    processBuffer() {
        const lines = this.responseBuffer.split('\n');
        this.responseBuffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const response = JSON.parse(line);
                    if (response.requestId && this.pendingRequests.has(response.requestId)) {
                        const { resolve } = this.pendingRequests.get(response.requestId);
                        this.pendingRequests.delete(response.requestId);
                        resolve(response);
                    }
                } catch (e) {
                    console.error('[MCP] Parse error:', e);
                }
            }
        }
    }

    async send(action, provider = null, data = {}) {
        if (!this.connected) {
            await this.connect();
        }

        const requestId = ++this.requestId;
        const request = { requestId, action, provider, data };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });

            this.socket.write(JSON.stringify(request) + '\n');

            // Timeout after 10 minutes
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 600000);
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.end();
            this.connected = false;
        }
    }
}

// ─── Provider Config ────────────────────────────────

function getEnabledProviders() {
    try {
        // Primary: Read from Electron's user data folder (always in sync with app settings)
        // Must match Electron's app.getPath('userData') for each platform
        let appDataPath;
        if (process.platform === 'win32') {
            appDataPath = path.join(process.env.APPDATA || '', 'proxima', 'enabled-providers.json');
        } else if (process.platform === 'darwin') {
            appDataPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'proxima', 'enabled-providers.json');
        } else {
            appDataPath = path.join(process.env.HOME || '', '.config', 'proxima', 'enabled-providers.json');
        }

        // AppData is most reliable — Electron always writes here
        if (fs.existsSync(appDataPath)) {
            const data = JSON.parse(fs.readFileSync(appDataPath, 'utf8'));
            return new Set(data.enabled || []);
        }

    
        const configPath = path.join(__dirname, 'enabled-providers.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return new Set(data.enabled || []);
        }
    } catch (e) {
        console.error('[MCP] Error reading enabled providers:', e);
    }
    return new Set(['perplexity', 'chatgpt', 'gemini']);
}

function isProviderEnabled(provider) {
    return getEnabledProviders().has(provider);
}

// ─── File Reference ─────────────────────────────────


function getFileReferenceEnabled() {
    try {
    
        let settingsPath;
        if (process.platform === 'win32') {
            settingsPath = path.join(process.env.APPDATA || '', 'proxima', 'settings.json');
        } else if (process.platform === 'darwin') {
            settingsPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'proxima', 'settings.json');
        } else {
            settingsPath = path.join(process.env.HOME || '', '.config', 'proxima', 'settings.json');
        }

        if (fs.existsSync(settingsPath)) {
            const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            return data.fileReferenceEnabled !== false;
        }
    } catch (e) {
        console.error('[MCP] Error reading file reference setting:', e);
    }
    return true; // Default enabled
}

// Read file contents and format for chat
function readFileContents(filePaths) {
    if (!filePaths || filePaths.length === 0) return '';
    if (!getFileReferenceEnabled()) {

        return '';
    }

    const contents = [];

    for (const fileEntry of filePaths) {
        try {
            // Parse line range syntax: "path/to/file.js:10-50" or "C:\path\file.js:10-50"
            let actualPath = fileEntry;
            let startLine = null;
            let endLine = null;
            
            // Handle Windows paths with drive letters (C:) - match last colon for line range
            const lastColonIndex = fileEntry.lastIndexOf(':');
            if (lastColonIndex > 1) { // >1 to skip drive letter colon
                const potentialRange = fileEntry.substring(lastColonIndex + 1);
                const rangeMatch = potentialRange.match(/^(\d+)-(\d+)$/);
                if (rangeMatch) {
                    actualPath = fileEntry.substring(0, lastColonIndex);
                    startLine = parseInt(rangeMatch[1]);
                    endLine = parseInt(rangeMatch[2]);
                }
            }

            if (!fs.existsSync(actualPath)) {
                contents.push(`[File not found: ${actualPath}]`);
                continue;
            }

            let fileName = path.basename(actualPath);
            const ext = path.extname(actualPath).toLowerCase();
            let fileContent = fs.readFileSync(actualPath, 'utf8');

            // Apply line range filter if specified
            if (startLine && endLine) {
                const lines = fileContent.split('\n');
                const totalLines = lines.length;
                const start = Math.max(1, startLine) - 1;
                const end = Math.min(totalLines, endLine);
                fileContent = lines.slice(start, end).join('\n');
                fileName = `${path.basename(actualPath)} (lines ${startLine}-${endLine} of ${totalLines})`;
            }

        
            let formattedContent;
            const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.css', '.html', '.json', '.xml', '.yaml', '.yml', '.md', '.sql', '.sh', '.bash', '.ps1', '.rb', '.go', '.rs', '.php'];

            if (codeExtensions.includes(ext)) {
                // Code file - wrap in code block
                const lang = ext.slice(1); // Remove the dot
                formattedContent = `\`\`\`${lang}\n// File: ${fileName}\n${fileContent}\n\`\`\``;
            } else {
                // Plain text file
                formattedContent = `--- File: ${fileName} ---\n${fileContent}\n--- End of ${fileName} ---`;
            }

            contents.push(formattedContent);


        } catch (e) {
            contents.push(`[Error reading ${fileEntry}: ${e.message}]`);
        }
    }

    return contents.join('\n\n');
}

// Build message with file contents
function buildMessageWithFiles(message, files) {
    const fileContents = readFileContents(files);

    if (fileContents) {
        return `${fileContents}\n\n${message}`;
    }

    return message;
}

// ─── AI Providers (IPC-backed) ─────────────────────

class AIProvider {
    constructor(name, ipcClient) {
        this.name = name;
        this.ipc = ipcClient;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
        this.maxCacheSize = 100;

        // Per-provider sequential queue — prevents concurrent requests from
        // crashing the same BrowserView. Each request waits for the previous
        // one to complete (success OR fail) before sending.
        this._queue = Promise.resolve();
        this._queueLength = 0;

        this._cleanupInterval = setInterval(() => this.cleanCache(), 10 * 60 * 1000);
    }

    cleanCache() {
        const now = Date.now();
        for (const [key, val] of this.cache) {
            if (now - val.time > this.cacheTimeout) {
                this.cache.delete(key);
            }
        }
        // Evict oldest if cache exceeds max size
        if (this.cache.size > this.maxCacheSize) {
            const entries = [...this.cache.entries()];
            entries.sort((a, b) => a[1].time - b[1].time);
            const toDelete = entries.slice(0, entries.length - this.maxCacheSize);
            for (const [key] of toDelete) {
                this.cache.delete(key);
            }
        }
    }

    async ensureInitialized() {
    
        if (!isProviderEnabled(this.name)) {
            throw new Error(`${this.name} is disabled. Enable it in Proxima Agent Hub settings.`);
        }
        await this.ipc.send('initProvider', this.name);
    }

    async isLoggedIn() {
        const result = await this.ipc.send('isLoggedIn', this.name);
        return result.loggedIn;
    }

    async getTypingStatus() {
        const result = await this.ipc.send('getTypingStatus', this.name);
        return result;
    }

    // Execute the actual chat request — called inside the queue
    async _doChat(message, options = {}) {
        await this.ensureInitialized();

        // DESYNC FIX: Wait for any ongoing typing to stop before sending new message
        // But don't wait too long - max 5 seconds
        console.error(`[${this.name}] Checking if AI is still typing from previous request...`);
        let typingCheck = await this.getTypingStatus();
        let waitCount = 0;
        while (typingCheck.isTyping && waitCount < 5) {
            console.error(`[${this.name}] AI still typing, waiting...`);
            await this.sleep(1000);
            typingCheck = await this.getTypingStatus();
            waitCount++;
        }

        console.error(`[${this.name}] Sending message...`);
        await this.ipc.send('sendMessage', this.name, { message, ...options });

        console.error(`[${this.name}] Waiting for response (with typing detection)...`);
        const result = await this.ipc.send('getResponseWithTyping', this.name, {});

        if (result.typingStarted) {
            console.error(`[${this.name}] Typing detected and completed`);
        }

        return result.response || 'No response received';
    }

    async chat(message, useCache = true, options = {}) {
        // Cache check runs OUTSIDE queue — instant return, no waiting
        if (useCache && this.cache.has(message)) {
            const cached = this.cache.get(message);
            if (Date.now() - cached.time < this.cacheTimeout) {
                console.error(`[${this.name}] Using cached response`);
                return cached.response;
            }
        }

        // Queue the request — waits for previous request to finish (success or fail)
        this._queueLength++;
        const position = this._queueLength;
        if (position > 1) {
            console.error(`[${this.name}] Request queued (position ${position}). Waiting for previous to complete...`);
        }

        const responsePromise = this._queue.then(async () => {
            console.error(`[${this.name}] Processing request (${position} of ${this._queueLength})...`);
            const response = await this._doChat(message, options);
            this.cache.set(message, { response, time: Date.now() });
            this._queueLength--;
            return response;
        }).catch((err) => {
            this._queueLength--;
            throw err;
        });

        // Chain: next request waits for this one to settle (success OR fail)
        this._queue = responsePromise.catch(() => {});

        return responsePromise;
    }



    async search(query, useCache = true) {
        return await this.chat(query, useCache);
    }

    async executeScript(script) {
        const result = await this.ipc.send('executeScript', this.name, { script });
        return result;
    }

    async newConversation() {
        await this.ipc.send('newConversation', this.name);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ─── Smart Router ────────────────────────────────────

class SmartRouter {
    constructor(providers) {
        this.providers = providers;
        this.stats = { success: {}, failures: {} };
    }

    async smartQuery(message, preferredProvider = null) {
        const enabled = getEnabledProviders();
        const order = ['chatgpt', 'claude', 'perplexity', 'gemini'];

        // Start with preferred if enabled
        if (preferredProvider && enabled.has(preferredProvider)) {
            order.unshift(preferredProvider);
        }

        const uniqueOrder = [...new Set(order)].filter(p => enabled.has(p));

        for (const providerName of uniqueOrder) {
            const provider = this.providers[providerName];
            if (!provider) continue;

            try {
                // Try twice before falling back
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        const response = await provider.chat(message);
                        this.stats.success[providerName] = (this.stats.success[providerName] || 0) + 1;
                        return {
                            provider: providerName,
                            response,
                            attempts: attempt
                        };
                    } catch (e) {
                        if (attempt === 2) throw e;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            } catch (e) {
                this.stats.failures[providerName] = (this.stats.failures[providerName] || 0) + 1;
                console.error(`[SmartRouter] ${providerName} failed:`, e.message);
            }
        }

        throw new Error('All providers failed');
    }

    getStats() {
        return this.stats;
    }
}

// ─── MCP Tool Registration ──────────────────────────

const ipcClient = new IPCClient();

const perplexity = new AIProvider('perplexity', ipcClient);
const chatgpt = new AIProvider('chatgpt', ipcClient);
const claude = new AIProvider('claude', ipcClient);
const gemini = new AIProvider('gemini', ipcClient);

const router = new SmartRouter({ perplexity, chatgpt, claude, gemini });

// Create MCP Server
const server = new McpServer({
    name: 'agent-hub',
    version: '4.1.0',
    description: 'Agent Hub MCP Server v3 - Embedded Browser Edition'
});

// Helper functions
function toolResponse(result) {
    if (typeof result === 'string') {
        return { content: [{ type: 'text', text: result }] };
    }
    // Format objects as readable text instead of raw JSON
    return { content: [{ type: 'text', text: formatResult(result) }] };
}

// Convert structured results into clean, readable text
function formatResult(obj) {
    if (typeof obj === 'string') return obj;
    if (!obj || typeof obj !== 'object') return String(obj);

    // debate tool — { perplexity: { stance, response }, chatgpt: { stance, response } }
    if (Object.values(obj).every(v => v && typeof v === 'object' && ('stance' in v || 'response' in v))) {
        let out = '';
        for (const [provider, data] of Object.entries(obj)) {
            out += `## ${provider.toUpperCase()} — ${data.stance || 'Response'}\n\n`;
            out += (data.response || data.error || 'No response') + '\n\n---\n\n';
        }
        return out.trim();
    }

    // chain_query tool — { success, totalSteps, finalOutput, pipeline }
    if (obj.finalOutput && obj.pipeline) {
        let out = `# Chain Query Result\n\n`;
        out += `**Steps:** ${obj.completedSteps || 0}/${obj.totalSteps || 0} completed\n\n`;
        if (obj.pipeline) {
            for (const step of obj.pipeline) {
                out += `## Step ${step.step} — ${step.provider}\n\n`;
                out += (step.response || step.error || 'No response') + '\n\n---\n\n';
            }
        }
        out += `## Final Output\n\n${obj.finalOutput}`;
        return out.trim();
    }

    // compare_ais / ask_all — { provider: response, ... } where values are strings
    if (Object.values(obj).every(v => typeof v === 'string')) {
        let out = '';
        for (const [key, val] of Object.entries(obj)) {
            out += `## ${key.toUpperCase()}\n\n${val}\n\n---\n\n`;
        }
        return out.trim();
    }

    // review_code_file — { success, provider, filePath, review }
    if (obj.review) {
        let out = '';
        if (obj.filePath) out += `**File:** ${obj.filePath}\n`;
        if (obj.provider) out += `**Provider:** ${obj.provider}\n\n`;
        out += obj.review;
        return out.trim();
    }

    // Generic object — readable key-value format
    return JSON.stringify(obj, null, 2);
}

function toolError(error) {
    return { content: [{ type: 'text', text: `Error: ${error.message || error}` }], isError: true };
}

// Universal provider disabled check - returns a clean response if provider is off
function checkDisabled(providerName) {
    if (!isProviderEnabled(providerName)) {
        return toolResponse(`${providerName} is disabled. Enable it in Agent Hub.`);
    }
    return null; // provider is enabled, proceed
}

// --- Search tools ---

server.tool(
    'proxima_deep_search',
    {
        query: z.string().describe('Search query for deep research. IMPORTANT: Perplexity does not support parallelization - combine all queries into one prompt, or call sequentially and wait for each response before calling again.'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best available')
    },
    async ({ query, files, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        
        // If using Perplexity, enable Deep Research mode and wait for previous responses
        if (p.name === 'perplexity') {
            await new Promise(r => setTimeout(r, 5000));
            const fullQuery = buildMessageWithFiles(query, files);
            try {
                return toolResponse(await p.instance.chat(fullQuery, false, { deepSearch: true }));
            } catch (apiErr) {
                console.error('[proxima_deep_search] API failed, falling back to DOM: ' + apiErr.message);
                return toolResponse(await p.instance.chat(fullQuery, false, { deepSearch: true, forceDOM: true }));
            }
        }
        
        try {
            const fullQuery = buildMessageWithFiles(query, files);
            return toolResponse(await p.instance.chat(fullQuery));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'deep_search',
    {
        query: z.string().describe('Search query for deep research. IMPORTANT: Perplexity does not support parallelization - combine all queries into one prompt, or call sequentially and wait for each response before calling again.'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best available')
    },
    async ({ query, files, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        
        const fullQuery = buildMessageWithFiles(query, files);
        
        // If using Perplexity, enable Deep Research mode and wait for previous responses
        if (p.name === 'perplexity') {
            await new Promise(r => setTimeout(r, 5000));
            try {
                return toolResponse(await p.instance.chat(fullQuery, false, { deepSearch: true }));
            } catch (apiErr) {
                console.error('[deep_search] API failed, falling back to DOM: ' + apiErr.message);
                return toolResponse(await p.instance.chat(fullQuery, false, { deepSearch: true, forceDOM: true }));
            }
        }
        
        try {
            return toolResponse(await p.instance.chat(fullQuery));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'proxima_pro_search',
    {
        query: z.string().describe('Query for detailed Pro search. IMPORTANT: Perplexity does not support parallelization - combine all queries into one prompt, or call sequentially and wait for each response before calling again.'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.')
    },
    async ({ query, files }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        
        // Wait 5 seconds before sending to let any previous responses complete
        await new Promise(r => setTimeout(r, 5000));
        
        const fullQuery = buildMessageWithFiles(query, files);
        
        try {
            return toolResponse(await perplexity.search(`Provide a comprehensive, detailed answer with sources: ${fullQuery}`, true, { deepSearch: false }));
        } catch (apiErr) {
            console.error('[proxima_pro_search] API failed, falling back to DOM: ' + apiErr.message);
            return toolResponse(await perplexity.search(`Provide a comprehensive, detailed answer with sources: ${fullQuery}`, true, { deepSearch: false, forceDOM: true }));
        }
    }
);

server.tool(
    'pro_search',
    {
        query: z.string().describe('Query for detailed Pro search. IMPORTANT: Perplexity does not support parallelization - combine all queries into one prompt, or call sequentially and wait for each response before calling again.'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.')
    },
    async ({ query, files }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        
        // Wait 5 seconds before sending to let any previous responses complete
        await new Promise(r => setTimeout(r, 5000));
        
        const fullQuery = buildMessageWithFiles(query, files);
        
        try {
            return toolResponse(await perplexity.search(`Provide a comprehensive, detailed answer with sources: ${fullQuery}`, true, { deepSearch: false }));
        } catch (err) {
            return toolError(err);
        }
    }
);


server.tool(
    'internet_search',
    {
        query: z.string().describe('Search query to look up on the internet'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ query, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Search the internet and provide accurate, up-to-date information with sources: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'reddit_search',
    {
        query: z.string().describe('What to search for on Reddit'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ query, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Search Reddit discussions about: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'github_search',
    {
        query: z.string().describe('What to search for on GitHub — repos, code, libraries, or solutions'),
        language: z.string().optional().describe('Programming language filter (e.g., JavaScript, Python, Rust)'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ query, language, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const langFilter = language ? ` in ${language}` : '';
            return toolResponse(await p.instance.chat(`Search GitHub for open source repositories, code examples, and solutions${langFilter}: ${query}\n\nFor each result provide: repo name, description, stars/popularity, key features, and the GitHub URL. Focus on actively maintained, well-documented projects.`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'get_ui_reference',
    {
        description: z.string().describe('Describe the UI/UX you need — what kind of page, component, layout, or design style you want'),
        code: z.string().optional().describe('Optional: existing code to analyze and apply design improvements on'),
        files: z.array(z.string()).optional().describe('Optional: file paths of existing code to improve with better UI/UX. Supports line ranges like "path/file.js:10-50"'),
        style: z.string().optional().describe('Design style preference: modern, minimal, glassmorphism, dark, corporate, playful, etc.'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ description, code, files, style, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            const styleHint = style ? `\nDESIGN STYLE: ${style}` : '';

            let prompt;
            if (fullCode.trim()) {
                prompt = `You are a senior UI/UX designer and frontend developer. Analyze the existing code and apply premium design improvements.

DESIGN REQUEST: ${description}${styleHint}

EXISTING CODE:
${fullCode}

Provide:
1. **DESIGN ANALYSIS**: Analyze the current UI — what works, what needs improvement
2. **COLOR PALETTE**: Recommended hex colors with usage (primary, secondary, accent, background, text)
3. **TYPOGRAPHY**: Font families, sizes, weights for headings, body, captions
4. **LAYOUT & SPACING**: Grid system, padding, margins, responsive breakpoints
5. **COMPONENTS**: Key UI components needed with design specifications
6. **UX PATTERNS**: Interactions, hover effects, transitions, micro-animations
7. **UPDATED CODE**: Complete updated code with the design improvements applied — production-ready, no placeholders

The updated code must be complete, ready to copy-paste and run. Apply modern design best practices.`;
            } else {
                prompt = `You are a senior UI/UX designer. Provide a comprehensive design reference for the following.

DESIGN REQUEST: ${description}${styleHint}

Provide:
1. **DESIGN CONCEPT**: Overall look and feel description, inspiration references
2. **COLOR PALETTE**: Complete hex color scheme with usage roles (primary, secondary, accent, background, surface, text, muted)
3. **TYPOGRAPHY**: Recommended Google Fonts, size scale, weight usage
4. **LAYOUT**: Page structure, grid system, responsive behavior
5. **KEY COMPONENTS**: List of UI components with visual specifications
6. **UX PATTERNS**: Navigation flow, interaction patterns, hover/focus states, transitions, micro-animations
7. **CSS DESIGN TOKENS**: Ready-to-use CSS custom properties (variables) for the entire design system
8. **ACCESSIBILITY**: Color contrast ratios, focus indicators, ARIA recommendations

Be specific with exact values — hex codes, pixel sizes, font names, timing functions. A developer should be able to implement this design without any guesswork.`;
            }

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'news_search',
    {
        query: z.string().describe('News topic to search'),
        timeframe: z.string().optional().describe('Timeframe like "today", "this week", "2024"'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ query, timeframe, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const tf = timeframe ? ` from ${timeframe}` : ' recent';
            return toolResponse(await p.instance.chat(`Latest news${tf}: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);


server.tool(
    'math_search',
    {
        query: z.string().describe('Math problem or scientific question'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ query, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Solve and explain step by step in plain text (use text notation, not LaTeX rendering): ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'academic_search',
    {
        query: z.string().describe('Academic/research query'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ query, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Academic research: ${query}. Cite peer-reviewed sources.`));
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- Code tools ---

server.tool(
    'verify_code',
    {
        purpose: z.string().describe('Description of what the code should do'),
        code: z.string().optional().describe('Optional code snippet to verify'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ purpose, code, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const prompt = code
                ? `Verify this code follows best practices for: ${purpose}\n\nCode:\n${code}\n\nCheck for bugs, security issues, and improvements.`
                : `What are the best practices and common patterns for: ${purpose}`;
            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'explain_code',
    {
        code: z.string().optional().describe('The code snippet to explain (or use files parameter)'),
        language: z.string().optional().describe('Programming language'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to explain'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ code, language, files, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const lang = language ? ` (${language})` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            const response = await provider.instance.chat(`Explain this code${lang} in detail, line by line:\n\n${fullCode}`);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'generate_code',
    {
        description: z.string().describe('What the code should do'),
        language: z.string().optional().describe('Programming language (default: JavaScript)'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ description, language, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const lang = language || 'JavaScript';
            const response = await provider.instance.chat(`Write production-ready ${lang} code that: ${description}\n\nInclude comments, error handling, and usage examples. No placeholders.`);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);



server.tool(
    'optimize_code',
    {
        code: z.string().optional().describe('Code to optimize (or use files parameter)'),
        goal: z.string().optional().describe('Optimization goal'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to optimize'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ code, goal, files, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const g = goal ? ` for ${goal}` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            const response = await provider.instance.chat(`Optimize this code${g}. Show before/after with explanations:\n\n${fullCode}`);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'review_code',
    {
        code: z.string().optional().describe('Code to review (or use files parameter)'),
        context: z.string().optional().describe('Context about the code'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to review'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ code, context, files, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const ctx = context ? ` Context: ${context}` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            const response = await provider.instance.chat(`Review this code for bugs, security issues, performance, and best practices.${ctx}\n\n${fullCode}`);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);



// --- Content tools ---

server.tool(
    'summarize_url',
    {
        url: z.string().describe('The URL to summarize'),
        focus: z.string().optional().describe('Focus area'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ url, focus, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const f = focus ? ` Focus on: ${focus}` : '';
            return toolResponse(await p.instance.chat(`Summarize this webpage: ${url}${f}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'generate_article',
    {
        topic: z.string().describe('Topic to write about'),
        style: z.string().optional().describe('Writing style'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ topic, style, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const s = style ? ` in ${style} style` : '';
            return toolResponse(await p.instance.chat(`Write a comprehensive article about: ${topic}${s}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'brainstorm',
    {
        topic: z.string().describe('Topic to brainstorm ideas for'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ topic, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Brainstorm creative ideas for: ${topic}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'analyze_document',
    {
        url: z.string().describe('URL of the document'),
        question: z.string().optional().describe('Specific question'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ url, question, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const q = question ? ` Answer: ${question}` : '';
            return toolResponse(await p.instance.chat(`Analyze this document: ${url}${q}`));
        } catch (err) {
            return toolError(err);
        }
    }
);


server.tool(
    'extract_data',
    {
        content: z.string().describe('Text or URL to extract data from'),
        dataType: z.string().describe('What data to extract'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ content, dataType, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Extract ${dataType} from: ${content}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'writing_help',
    {
        request: z.string().describe('What writing help you need'),
        content: z.string().optional().describe('Content to improve'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ request, content, provider: providerName }) => {
        const p = resolveProvider(providerName, 'general');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const c = content ? `\n\nContent:\n${content}` : '';
            return toolResponse(await p.instance.chat(`${request}${c}`));
        } catch (err) {
            return toolError(err);
        }
    }
);



// --- Analysis tools ---


server.tool(
    'fact_check',
    {
        claim: z.string().describe('The claim to verify'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ claim, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Fact check with sources: ${claim}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'find_stats',
    {
        topic: z.string().describe('Topic to find statistics about'),
        year: z.string().optional().describe('Specific year'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ topic, year, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const y = year ? ` for ${year}` : '';
            return toolResponse(await p.instance.chat(`Find statistics and data${y}: ${topic}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'compare',
    {
        item1: z.string().describe('First item to compare'),
        item2: z.string().describe('Second item to compare'),
        context: z.string().optional().describe('Context for comparison'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ item1, item2, context, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const ctx = context ? ` for ${context}` : '';
            return toolResponse(await p.instance.chat(`Compare ${item1} vs ${item2}${ctx}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'how_to',
    {
        task: z.string().describe('What to learn how to do'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ task, provider: providerName }) => {
        const p = resolveProvider(providerName, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            return toolResponse(await p.instance.chat(`Step-by-step guide: How to ${task}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- Multi-AI provider tools ---

server.tool(
    'ask_chatgpt',
    {
        message: z.string().describe('Message to send to ChatGPT'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('chatgpt');
        if (disabled) return disabled;
        try {
            const fullMessage = buildMessageWithFiles(message, files);
            return toolResponse(await chatgpt.chat(fullMessage));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_claude',
    {
        message: z.string().describe('Message to send to Claude'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('claude');
        if (disabled) return disabled;
        try {
            const fullMessage = buildMessageWithFiles(message, files);
            return toolResponse(await claude.chat(fullMessage));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_gemini',
    {
        message: z.string().describe('Message to send to Gemini'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('gemini');
        if (disabled) return disabled;
        try {
            const fullMessage = buildMessageWithFiles(message, files);
            return toolResponse(await gemini.chat(fullMessage));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_all_ais',
    {
        message: z.string().describe('Message to send to all enabled AI providers'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to include as context')
    },
    async ({ message, files }) => {
        try {
            const enabled = getEnabledProviders();
            const fullMessage = buildMessageWithFiles(message, files);
            const tasks = [];
            const names = [];

            console.error('[ask_all_ais] Sending to all providers with staggered start (prevents UI freeze)...');

            // Helper: staggered delay to prevent Electron main process overload
            // Each provider starts 2s apart but all run concurrently via Promise.all
            const STAGGER_MS = 2000;
            let providerIndex = 0;
            const staggerDelay = (ms) => new Promise(r => setTimeout(r, ms));

            // Build staggered parallel tasks
            if (enabled.has('perplexity')) {
                const delay = providerIndex++ * STAGGER_MS;
                names.push('perplexity');
                tasks.push(
                    (async () => {
                        if (delay > 0) await staggerDelay(delay);
                        try {
                            return await perplexity.search(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }
            if (enabled.has('chatgpt')) {
                const delay = providerIndex++ * STAGGER_MS;
                names.push('chatgpt');
                tasks.push(
                    (async () => {
                        if (delay > 0) await staggerDelay(delay);
                        try {
                            return await chatgpt.chat(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }
            if (enabled.has('claude')) {
                const delay = providerIndex++ * STAGGER_MS;
                names.push('claude');
                tasks.push(
                    (async () => {
                        if (delay > 0) await staggerDelay(delay);
                        try {
                            return await claude.chat(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }
            if (enabled.has('gemini')) {
                const delay = providerIndex++ * STAGGER_MS;
                names.push('gemini');
                tasks.push(
                    (async () => {
                        if (delay > 0) await staggerDelay(delay);
                        try {
                            return await gemini.chat(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }

            // Wait for ALL to complete - typing detection is handled inside chat()
            console.error('[ask_all_ais] Waiting for all providers to complete...');
            const results = await Promise.all(tasks);
            console.error('[ask_all_ais] All providers completed');

            // Format as clearly separated text so it's readable even in output.txt
            const sections = [];
            names.forEach((name, i) => {
                const response = results[i];
                const label = name.charAt(0).toUpperCase() + name.slice(1);
                const divider = '═'.repeat(60);
                if (response && response.error) {
                    sections.push(`\n${divider}\n## ${label} Response\n${divider}\n\n❌ Error: ${response.error}\n`);
                } else {
                    const text = typeof response === 'string' ? response : (response?.response || response?.text || JSON.stringify(response));
                    sections.push(`\n${divider}\n## ${label} Response\n${divider}\n\n${text}\n`);
                }
            });

            const formattedOutput = `# Ask All AIs — ${names.length} Providers\n` + sections.join('\n');

            return toolResponse(formattedOutput);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'compare_ais',
    {
        question: z.string().describe('Question to ask multiple AIs'),
        providers: z.array(z.string()).optional().describe('Which providers to use'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to include as context')
    },
    async ({ question, providers, files }) => {
        try {
            const enabled = getEnabledProviders();
            const requested = providers || ['perplexity', 'chatgpt', 'claude', 'gemini'];
            const useProviders = requested.filter(p => enabled.has(p));
            const fullQuestion = buildMessageWithFiles(question, files);

            const results = {};
            const tasks = [];
            const staggerDelay = (ms) => new Promise(r => setTimeout(r, ms));
            const STAGGER_MS = 2000;
            let idx = 0;

            if (useProviders.includes('perplexity')) { const d = idx++ * STAGGER_MS; tasks.push((async () => { if (d > 0) await staggerDelay(d); try { results.perplexity = await perplexity.search(fullQuestion); } catch(e) { results.perplexity = { error: e.message }; } })()); }
            if (useProviders.includes('chatgpt')) { const d = idx++ * STAGGER_MS; tasks.push((async () => { if (d > 0) await staggerDelay(d); try { results.chatgpt = await chatgpt.chat(fullQuestion); } catch(e) { results.chatgpt = { error: e.message }; } })()); }
            if (useProviders.includes('claude')) { const d = idx++ * STAGGER_MS; tasks.push((async () => { if (d > 0) await staggerDelay(d); try { results.claude = await claude.chat(fullQuestion); } catch(e) { results.claude = { error: e.message }; } })()); }
            if (useProviders.includes('gemini')) { const d = idx++ * STAGGER_MS; tasks.push((async () => { if (d > 0) await staggerDelay(d); try { results.gemini = await gemini.chat(fullQuestion); } catch(e) { results.gemini = { error: e.message }; } })()); }

            await Promise.all(tasks);

            // Format as clearly separated text
            const sections = [];
            for (const [name, response] of Object.entries(results)) {
                const label = name.charAt(0).toUpperCase() + name.slice(1);
                const divider = '═'.repeat(60);
                if (response && response.error) {
                    sections.push(`\n${divider}\n## ${label} Response\n${divider}\n\n❌ Error: ${response.error}\n`);
                } else {
                    const text = typeof response === 'string' ? response : (response?.response || response?.text || JSON.stringify(response));
                    sections.push(`\n${divider}\n## ${label} Response\n${divider}\n\n${text}\n`);
                }
            }

            const formattedOutput = `# AI Comparison — ${useProviders.length} Providers\nQuestion: ${question}\n` + sections.join('\n');

            return toolResponse(formattedOutput);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'smart_query',
    {
        message: z.string().describe('Message to send - auto-routes to best provider'),
        preferredProvider: z.string().optional().describe('Preferred provider'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to include as context')
    },
    async ({ message, preferredProvider, files }) => {
        try {
            const fullMessage = buildMessageWithFiles(message, files);
            const result = await router.smartQuery(fullMessage, preferredProvider);
            return toolResponse({
                success: true,
                filesIncluded: files ? files.length : 0,
                ...result,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            return toolError(err);
        }
    }
);



// --- ask_perplexity (was missing!) ---

server.tool(
    'ask_perplexity',
    {
        message: z.string().describe('Message to send to Perplexity (best for web search + citations)'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            const fullMessage = buildMessageWithFiles(message, files);
            return toolResponse(await perplexity.chat(fullMessage, true, { deepSearch: false }));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'proxima_ask_perplexity',
    {
        message: z.string().describe('Message to send to Perplexity (best for web search + citations)'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            const fullMessage = buildMessageWithFiles(message, files);
            return toolResponse(await perplexity.chat(fullMessage, true, { deepSearch: false }));
        } catch (apiErr) {
            console.error('[proxima_ask_perplexity] API failed, falling back to DOM: ' + apiErr.message);
            return toolResponse(await perplexity.chat(fullMessage, true, { deepSearch: false, forceDOM: true }));
        }
    }
);

server.tool(
    'new_conversation',
    {},
    async () => {
        try {
            const enabled = getEnabledProviders();
            for (const provider of ['perplexity', 'chatgpt', 'claude', 'gemini']) {
                if (enabled.has(provider)) {
                    await { perplexity, chatgpt, claude, gemini }[provider].newConversation();
                }
            }
            return toolResponse({ success: true, message: 'Started new conversations' });
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- chain_query: Sequential multi-AI pipeline ---

server.tool(
    'chain_query',
    {
        steps: z.array(z.object({
            provider: z.string().describe('AI provider: chatgpt, claude, gemini, perplexity'),
            prompt: z.string().describe('Prompt for this step. Use {previous} to inject previous step output.')
        })).describe('Array of pipeline steps. Each step receives previous output via {previous} placeholder.'),
        initialContext: z.string().optional().describe('Optional initial context to pass as {previous} to first step')
    },
    async ({ steps, initialContext }) => {
        try {
            const providers = { perplexity, chatgpt, claude, gemini };
            const results = [];
            let previousOutput = initialContext || '';

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i];
                const providerName = step.provider.toLowerCase();
                const provider = providers[providerName];

                if (!provider) {
                    results.push({ step: i + 1, provider: providerName, error: `Unknown provider: ${providerName}` });
                    continue;
                }

                const disabled = checkDisabled(providerName);
                if (disabled) {
                    results.push({ step: i + 1, provider: providerName, error: `${providerName} is disabled` });
                    continue;
                }

                // Replace {previous} placeholder with output from last step
                const prompt = step.prompt.replace(/\{previous\}/gi, previousOutput);

                try {
                    const response = await provider.chat(prompt);
                    previousOutput = response;
                    results.push({
                        step: i + 1,
                        provider: providerName,
                        response: response
                    });
                } catch (err) {
                    results.push({ step: i + 1, provider: providerName, error: err.message });
                    // Don't break chain — next step gets empty previous
                    previousOutput = `[Step ${i + 1} failed: ${err.message}]`;
                }
            }

            return toolResponse({
                success: true,
                totalSteps: steps.length,
                completedSteps: results.filter(r => !r.error).length,
                finalOutput: previousOutput,
                pipeline: results,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- Smart Provider Selection Helper ---
function pickBestProvider(taskType) {
    const enabled = getEnabledProviders();
    const providers = { perplexity, chatgpt, claude, gemini };
    
    // Priority order based on task type
    const priorities = {
        coding: ['claude', 'chatgpt', 'gemini', 'perplexity'],
        research: ['perplexity', 'gemini', 'chatgpt', 'claude'],
        general: ['claude', 'chatgpt', 'gemini', 'perplexity'],
        review: ['claude', 'chatgpt', 'gemini', 'perplexity']
    };
    
    const order = priorities[taskType] || priorities.general;
    for (const name of order) {
        if (enabled.has(name) && providers[name]) {
            return { name, instance: providers[name] };
        }
    }
    return null;
}

// --- Dynamic Provider Resolution ---
function resolveProvider(providerName, taskType) {
    const providers = { perplexity, chatgpt, claude, gemini };
    
    if (providerName) {
        const name = providerName.toLowerCase();
        if (!providers[name]) return null;
        const enabled = getEnabledProviders();
        if (!enabled.has(name)) return null;
        return { name, instance: providers[name] };
    }
    
    // No preference — auto-select based on task type
    return pickBestProvider(taskType || 'general');
}

// --- solve: One-shot problem solver ---

server.tool(
    'solve',
    {
        task: z.string().describe('What to solve — coding task, bug, feature, anything'),
        files: z.array(z.string()).optional().describe('Optional: file paths for context'),
        language: z.string().optional().describe('Programming language if relevant'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ task, files, language, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            let context = '';
            if (files && files.length > 0) {
                context = readFileContents(files) || '';
            }

            const langHint = language ? ` (Language: ${language})` : '';
            const prompt = `You are a senior software engineer. Solve this task completely.${langHint}

TASK: ${task}
${context ? `\nCODE CONTEXT:\n${context}` : ''}

Provide:
1. Brief analysis of the problem
2. Complete working solution with full code
3. Explanation of key decisions
4. Any edge cases or gotchas to watch for

Be thorough and production-ready. Do not use placeholder code.`;

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- verify: Answer confidence checker ---

// --- debate: Multi-provider topic debate ---

server.tool(
    'debate',
    {
        topic: z.string().describe('Topic or question to debate'),
        sides: z.number().optional().describe('Number of perspectives to gather (default: 2)')
    },
    async ({ topic, sides }) => {
        try {
            const enabled = getEnabledProviders();
            const allProviders = { perplexity, chatgpt, claude, gemini };
            const numSides = Math.min(sides || 2, enabled.size);

            if (enabled.size < 2) {
                // Single provider — generate both sides
                const provider = pickBestProvider('general');
                if (!provider) return toolResponse('No providers enabled');
                const response = await provider.instance.chat(
                    `Debate this topic from ${numSides} different perspectives. For each perspective, present strong arguments with evidence.\n\nTopic: ${topic}\n\nFormat each perspective as:\n## Perspective [N]: [Position]\n- Key arguments\n- Supporting evidence\n\nThen provide a balanced conclusion.`
                );
                return toolResponse(response);
            }

            // Multi-provider — each AI argues a different side
            const providerNames = [...enabled].filter(n => allProviders[n]).slice(0, numSides);
            const stances = ['FOR / supportive', 'AGAINST / critical', 'NEUTRAL / analytical', 'ALTERNATIVE / unconventional'];
            const results = {};

            const promises = providerNames.map(async (name, i) => {
                try {
                    const stance = stances[i] || `Perspective ${i + 1}`;
                    const response = await allProviders[name].chat(
                        `You are debating the following topic. Your assigned position is: ${stance}.\n\nTopic: ${topic}\n\nPresent your strongest arguments for this position. Be persuasive and use evidence. Do NOT present the other side.`
                    );
                    results[name] = { stance, response };
                } catch (e) {
                    results[name] = { stance: stances[i], error: e.message };
                }
            });

            await Promise.all(promises);
            return toolResponse(results);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- security_audit: Code security vulnerability scanner ---

server.tool(
    'security_audit',
    {
        code: z.string().optional().describe('Code to audit for security vulnerabilities'),
        files: z.array(z.string()).optional().describe('Optional: file paths to audit'),
        language: z.string().optional().describe('Programming language'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ code, files, language, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const lang = language ? ` (${language})` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;

            if (!fullCode.trim()) return toolResponse('No code provided. Pass code or files parameter.');

            const prompt = `You are a senior security engineer. Perform a thorough security audit of this code${lang}.

CODE:
${fullCode}

Check for ALL of the following:
1. **Injection vulnerabilities** (SQL, XSS, command injection, LDAP, etc.)
2. **Authentication/Authorization flaws** (broken auth, privilege escalation, insecure tokens)
3. **Data exposure** (hardcoded secrets, PII leaks, insecure logging)
4. **Input validation** (missing sanitization, type confusion, buffer overflow)
5. **Cryptographic issues** (weak algorithms, improper key management)
6. **Configuration problems** (debug mode, CORS, insecure defaults)
7. **Dependency risks** (known vulnerable packages)

For each issue found:
- **Severity**: CRITICAL / HIGH / MEDIUM / LOW
- **Location**: Line or function
- **Description**: What the vulnerability is
- **Fix**: Exact code fix

End with a security score (0-100) and summary.`;

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);


server.tool(
    'verify',
    {
        question: z.string().describe('Question or claim to verify'),
        providers: z.array(z.string()).optional().describe('Optional: specific providers to use for verification')
    },
    async ({ question, providers: requestedProviders }) => {
        try {
            const enabled = getEnabledProviders();
            const allProviders = { perplexity, chatgpt, claude, gemini };
            
            // Determine which providers to use
            let targetProviders = requestedProviders 
                ? requestedProviders.filter(p => enabled.has(p))
                : [...enabled];

            if (targetProviders.length === 0) return toolResponse('No providers enabled');

            const prompt = `Answer this question thoroughly. At the end, rate your confidence (0-100%) and list any counter-arguments or caveats:

${question}

Format:
ANSWER: [your detailed answer]
CONFIDENCE: [0-100%]
CAVEATS: [any counter-arguments, edge cases, or uncertainties]`;

            if (targetProviders.length === 1) {
                // Single provider — self-verification
                const p = allProviders[targetProviders[0]];
                const response = await p.chat(prompt);
                return toolResponse(`=== ${targetProviders[0].toUpperCase()} ===\n${response}`);
            }

            // Multiple providers — cross-verify
            const results = {};
            for (const name of targetProviders) {
                const p = allProviders[name];
                if (p) {
                    try {
                        results[name] = await p.chat(prompt);
                    } catch (e) {
                        results[name] = `Error: ${e.message}`;
                    }
                }
            }

            let output = '';
            for (const [name, resp] of Object.entries(results)) {
                output += `\n=== ${name.toUpperCase()} ===\n${resp}\n`;
            }
            return toolResponse(output.trim());
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- fix_error: Smart error fixer ---

server.tool(
    'fix_error',
    {
        error: z.string().describe('Error message or stack trace'),
        file: z.string().optional().describe('File path where the error occurs'),
        context: z.string().optional().describe('Additional context about what you were doing'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ error, file, context: ctx, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            let fileContent = '';
            if (file) {
                fileContent = readFileContents([file]) || '';
            }

            const prompt = `You are a debugging expert. Fix this error completely.

ERROR:
${error}
${ctx ? `\nCONTEXT: ${ctx}` : ''}
${fileContent ? `\nSOURCE CODE:\n${fileContent}` : ''}

Provide:
1. ROOT CAUSE: Why this error happens (be specific)
2. FIX: The exact code changes needed (show before/after)
3. PREVENTION: How to prevent this in the future
4. FULL FIXED CODE: Complete corrected code ready to use

Do not give vague advice. Give the exact fix.`;

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- build_architecture: Project architecture planner ---

server.tool(
    'build_architecture',
    {
        description: z.string().describe('What you want to build'),
        constraints: z.string().optional().describe('Tech constraints (e.g., "must use Next.js, PostgreSQL")'),
        scale: z.string().optional().describe('Expected scale (e.g., "10k users", "enterprise")'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ description, constraints, scale, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const prompt = `You are a senior software architect. Design a complete architecture for this project.

PROJECT: ${description}
${constraints ? `CONSTRAINTS: ${constraints}` : ''}
${scale ? `SCALE: ${scale}` : ''}

Provide a complete, production-ready architecture:

1. TECH STACK: Every technology with justification
2. FOLDER STRUCTURE: Complete directory tree with file descriptions
3. DATABASE SCHEMA: Full schema with tables, columns, types, relations (SQL or NoSQL)
4. API ENDPOINTS: Complete REST/GraphQL API design with methods, paths, request/response
5. COMPONENT TREE: Frontend component hierarchy
6. AUTH & SECURITY: Authentication strategy, security measures
7. DEPLOYMENT: Hosting, CI/CD, environment setup
8. THIRD-PARTY SERVICES: Any external APIs or services needed

Be exhaustive. A developer should be able to start coding immediately from this blueprint.`;

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- write_tests: Auto test generator ---

server.tool(
    'write_tests',
    {
        file: z.string().describe('File path to generate tests for'),
        framework: z.string().optional().describe('Test framework (jest, vitest, mocha, pytest). Default: auto-detect'),
        focus: z.string().optional().describe('Focus area: unit, integration, edge-cases, all'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ file, framework, focus, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            const fileContent = readFileContents([file]);
            if (!fileContent) {
                return toolResponse('Could not read file: ' + file);
            }

            const fw = framework || 'auto-detect from the code';
            const focusArea = focus || 'comprehensive (unit + edge cases)';

            const prompt = `You are a testing expert. Write complete tests for this code.

${fileContent}

TEST FRAMEWORK: ${fw}
FOCUS: ${focusArea}

Requirements:
1. Cover ALL exported functions/classes/methods
2. Include happy path + edge cases + error scenarios
3. Use descriptive test names that explain what's being tested
4. Include setup/teardown if needed
5. Mock external dependencies properly
6. Aim for high coverage

Return ONLY the complete test file code, ready to save and run.`;

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- explain_error: Error explainer in simple terms ---

server.tool(
    'explain_error',
    {
        error: z.string().describe('Error message or stack trace to explain'),
        context: z.string().optional().describe('What you were doing when the error occurred'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select')
    },
    async ({ error, context: ctx, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('general');
            if (!provider) return toolResponse('No providers enabled');

            const prompt = `Explain this error in simple terms and provide step-by-step fix instructions.

ERROR:
${error}
${ctx ? `\nCONTEXT: ${ctx}` : ''}

Provide:
1. WHAT HAPPENED: Plain English explanation (no jargon)
2. WHY: The most common causes of this error (ranked by likelihood)
3. HOW TO FIX: Step-by-step fix instructions for each cause
4. QUICK FIX: The single most likely fix in one code snippet

Be practical and specific. Not theory — actual commands and code.`;

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- convert_code: Code language/framework converter ---

server.tool(
    'convert_code',
    {
        file: z.string().optional().describe('File path to convert'),
        code: z.string().optional().describe('Code snippet to convert (if no file)'),
        from: z.string().optional().describe('Source language/framework (auto-detected if not specified)'),
        to: z.string().describe('Target language/framework (e.g., "TypeScript", "Python/FastAPI", "Vue 3")'),
        provider: z.string().optional().describe('AI provider to use: chatgpt, claude, gemini, perplexity. Default: auto-select best for coding')
    },
    async ({ file, code, from, to, provider: providerName }) => {
        try {
            const provider = providerName ? resolveProvider(providerName) : pickBestProvider('coding');
            if (!provider) return toolResponse('No providers enabled');

            let sourceCode = code || '';
            if (file) {
                sourceCode = readFileContents([file]) || sourceCode;
            }
            if (!sourceCode) {
                return toolResponse('No code provided. Use file path or code parameter.');
            }

            const fromHint = from ? `from ${from} ` : '';

            const prompt = `Convert this code ${fromHint}to ${to}. Preserve ALL functionality.

SOURCE CODE:
${sourceCode}

Requirements:
1. Maintain the exact same logic and behavior
2. Use idiomatic patterns for ${to} (not a literal translation)
3. Handle framework-specific differences (routing, state, lifecycle, etc.)
4. Add necessary imports/dependencies
5. Include comments where the conversion required significant changes

Return the complete converted code, ready to use.`;

            const response = await provider.instance.chat(prompt);
            return toolResponse(response);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- ask_selected: Ask specific providers (user picks which ones) ---

server.tool(
    'ask_selected',
    {
        message: z.string().describe('Message to send to selected providers'),
        providers: z.array(z.string()).describe('Which providers to ask: ["chatgpt", "claude", "gemini", "perplexity"]'),
        files: z.array(z.string()).optional().describe('Optional: file paths to include as context')
    },
    async ({ message, providers: selectedProviders, files }) => {
        try {
            const enabled = getEnabledProviders();
            const allProviders = { perplexity, chatgpt, claude, gemini };
            
            let fileContext = '';
            if (files && files.length > 0) {
                fileContext = readFileContents(files) || '';
            }

            const fullMessage = fileContext ? `${fileContext}\n\n${message}` : message;
            const results = {};

            for (const name of selectedProviders) {
                if (!enabled.has(name)) {
                    results[name] = { error: `${name} is not enabled` };
                    continue;
                }
                const p = allProviders[name];
                if (!p) {
                    results[name] = { error: `Unknown provider: ${name}` };
                    continue;
                }
                try {
                    const response = await p.chat(fullMessage);
                    results[name] = { success: true, response };
                } catch (e) {
                    results[name] = { error: e.message };
                }
            }

            // Build clean text output
            let output = '';
            for (const [name, data] of Object.entries(results)) {
                output += `\n=== ${name.toUpperCase()} ===\n`;
                if (data.error) {
                    output += `Error: ${data.error}\n`;
                } else {
                    output += data.response + '\n';
                }
            }
            return toolResponse(output.trim());
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- conversation_export: Extract full conversation from currently open chat ---

server.tool(
    'conversation_export',
    {
        provider: z.string().optional().describe('Provider to export from: chatgpt, claude, gemini, perplexity. Default: all enabled')
    },
    async ({ provider }) => {
        try {
            const enabled = getEnabledProviders();
            const targetProviders = provider
                ? [provider.toLowerCase()]
                : [...enabled];

            const extractionPrompt = `Tell our entire conversation history in this from the very beginning to the very end.

Extract everything and present it in the following structure:

PROJECT

What are we building? Include the name, the core idea, the purpose, and the problem it solves.

DECISIONS MADE

Everything that has been finalized. Tech stack, architecture, tools, libraries, design choices, folder structure, database schema, API design — anything that was decided and agreed upon.

REQUIREMENTS

Every single requirement the user mentioned. Features, constraints, what the user wants and does not want, priorities, tone, style preferences — everything.

WORK DONE SO FAR

What has already been built, written, or implemented. Include file names, code written, components created, APIs built — be specific.

IDEAS AND DIRECTION

Any ideas, suggestions, directions, or approaches that were discussed even if not finalized. Include things that were considered and rejected too, with the reason why.

PENDING AND NEXT STEPS

Everything that still needs to be done. What was the last thing discussed? What was about to happen next?

KEY DETAILS AND CONTEXT

Any important user preferences, specific instructions, edge cases, constraints, or anything unique about this project that a new AI picking this up must know.

Be exhaustive. Do not summarize loosely. A coding AI is going to read this and start building without asking the user a single question — so include everything.`;

            const providers = { perplexity, chatgpt, claude, gemini };
            const results = {};

            for (const prov of targetProviders) {
                if (!enabled.has(prov)) {
                    results[prov] = { error: prov + ' is not enabled' };
                    continue;
                }

                try {
                    console.error('[conversation_export] Extracting from ' + prov + ' (forceDOM)...');

                    // forceDOM: true — skips API inject, types into currently open conversation
                    // Same IPC flow as all tools, just with forceDOM flag
                    await ipcClient.send('sendMessage', prov, { message: extractionPrompt, forceDOM: true });

                    // Wait for response — same getResponseWithTyping as every other tool
                    const result = await ipcClient.send('getResponseWithTyping', prov, {});
                    const response = result.response || 'No response captured';

                    results[prov] = {
                        success: true,
                        provider: prov,
                        export: response,
                        exportedAt: new Date().toISOString()
                    };
                    console.error('[conversation_export] ' + prov + ' export complete');
                } catch (err) {
                    results[prov] = { error: err.message };
                }
            }

            // Build clean text output (not JSON — so newlines render properly)
            let output = '';
            for (const [prov, data] of Object.entries(results)) {
                output += `\n=== ${prov.toUpperCase()} ===\n`;
                if (data.error) {
                    output += `Error: ${data.error}\n`;
                } else {
                    output += data.export + '\n';
                }
            }

            return toolResponse(output.trim());
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'clear_cache',
    {},
    async () => {
        try {
            perplexity.cache.clear();
            chatgpt.cache.clear();
            claude.cache.clear();
            gemini.cache.clear();
            return toolResponse({ success: true, message: 'Cache cleared' });
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- File analysis tools ---

server.tool(
    'analyze_file',
    {
        filePath: z.string().describe('Absolute path to the file to analyze'),
        question: z.string().optional().describe('Specific question about the file'),
        provider: z.string().optional().describe('Which AI to use (chatgpt, claude, gemini, perplexity). Default: claude')
    },
    async ({ filePath, question, provider: providerName }) => {
        try {
            const p = resolveProvider(providerName || 'claude', 'coding');
            if (!p) return toolResponse(`Provider '${providerName || 'claude'}' is not available. Enable it in Agent Hub.`);

            // Check if file is an image (binary) - use upload method instead of text read
            const ext = path.extname(filePath).toLowerCase();
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

            if (imageExtensions.includes(ext)) {
                return toolResponse({ success: false, error: 'Image analysis is not available yet. This tool currently supports text/code files only.' });
            }

            // Text file: read and paste as context
            const fileContent = readFileContents([filePath]);
            if (!fileContent) {
                return toolResponse({ success: false, error: 'Could not read file or file reference is disabled' });
            }

            const message = question
                ? `${fileContent}\n\nPlease analyze this file and answer: ${question}`
                : `${fileContent}\n\nPlease analyze this file and explain its contents, purpose, and any notable aspects.`;

            const response = await p.instance.chat(message);

            return toolResponse({
                success: true,
                provider: p.name,
                filePath,
                analysis: response
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'review_code_file',
    {
        filePath: z.string().describe('Absolute path to the code file to review'),
        focus: z.string().optional().describe('What to focus on (bugs, performance, security, style)'),
        provider: z.string().optional().describe('Which AI to use. Default: claude')
    },
    async ({ filePath, focus, provider: providerName }) => {
        try {
            const p = resolveProvider(providerName || 'claude', 'coding');
            if (!p) return toolResponse(`Provider '${providerName || 'claude'}' is not available. Enable it in Agent Hub.`);

            const fileContent = readFileContents([filePath]);
            if (!fileContent) {
                return toolResponse({ success: false, error: 'Could not read file or file reference is disabled' });
            }

            const focusText = focus ? ` Focus on: ${focus}.` : '';
            const message = `${fileContent}\n\nPlease review this code file.${focusText} Identify issues, suggest improvements, and follow best practices.`;

            const response = await p.instance.chat(message);

            return toolResponse({
                success: true,
                provider: p.name,
                filePath,
                review: response
            });
        } catch (err) {
            return toolError(err);
        }
    }
);
// --- Window control (headless mode) ---

server.tool(
    'show_window',
    {},
    async () => {
        try {
            const result = await ipcClient.send('showWindow');
            return toolResponse({ success: true, message: 'Agent Hub window is now visible' });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'hide_window',
    {},
    async () => {
        try {
            const result = await ipcClient.send('hideWindow');
            return toolResponse({ success: true, message: 'Agent Hub window is now hidden (running in background)' });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'toggle_window',
    {},
    async () => {
        try {
            const result = await ipcClient.send('toggleWindow');
            return toolResponse({ success: true, visible: result.visible, message: result.visible ? 'Window shown' : 'Window hidden' });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'set_headless_mode',
    { enabled: z.boolean().describe('Enable (true) or disable (false) headless mode') },
    async ({ enabled }) => {
        try {
            const result = await ipcClient.send('setHeadlessMode', null, { enabled });
            return toolResponse({
                success: true,
                headlessMode: enabled,
                message: enabled
                    ? 'Headless mode enabled - Agent Hub runs in background, MCP still works'
                    : 'Headless mode disabled - Agent Hub window visible'
            });
        } catch (err) {
            return toolError(err);
        }
    }
);


// --- Resources (MCP compat) ---

// Register empty resources list to prevent "Method not found" error
server.resource(
    'status',
    'proxima://status',
    async (uri) => {
        const enabled = getEnabledProviders();
        return {
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                    server: 'Proxima MCP Server',
                    version: '4.1.0',
                    enabledProviders: Array.from(enabled),
                    connected: ipcClient.connected
                }, null, 2)
            }]
        };
    }
);

// --- Start ---

async function main() {
    console.error('[MCP] Agent Hub MCP Server v3.0 starting...');
    console.error('[MCP] Connecting to Agent Hub on port', IPC_PORT);

    try {
        await ipcClient.connect();
        console.error('[MCP] Connected to Agent Hub successfully');
    } catch (e) {
        console.error('[MCP] Warning: Could not connect to Agent Hub:', e.message);
        console.error('[MCP] Make sure Agent Hub is running');
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] MCP Server running');
}

main().catch(console.error);

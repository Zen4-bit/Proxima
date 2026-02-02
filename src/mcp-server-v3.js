#!/usr/bin/env node
/**
 * MCP SERVER v3.0 - Uses IPC to communicate with Electron's embedded browser
 * 
 * This MCP server connects to the Agent Hub Electron app via TCP IPC
 * instead of launching external Chrome with Playwright.
 * 
 * Benefits:
 * - No external Chrome needed
 * - Faster communication via IPC
 * - Better session persistence
 * - More reliable automation
 */

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

// ============================================
// IPC Client - Communicates with Electron App
// ============================================

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
            });

            // Timeout after 5 seconds
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

            // Timeout after 120 seconds (2 minutes for file uploads)
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('Request timeout'));
                }
            }, 120000);
        });
    }

    disconnect() {
        if (this.socket) {
            this.socket.end();
            this.connected = false;
        }
    }
}

// ============================================
// Provider Configuration
// ============================================

function getEnabledProviders() {
    try {
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

// ============================================
// File Reference Feature
// ============================================

let fileReferenceEnabled = true; // Default enabled

function getFileReferenceEnabled() {
    try {
        const configPath = path.join(__dirname, 'settings.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
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
        console.error('[MCP] File reference is disabled');
        return '';
    }

    const contents = [];

    for (const filePath of filePaths) {
        try {
            if (!fs.existsSync(filePath)) {
                contents.push(`[File not found: ${filePath}]`);
                continue;
            }

            const fileName = path.basename(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const fileContent = fs.readFileSync(filePath, 'utf8');

            // Format based on file type
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
            console.error(`[MCP] Read file: ${fileName} (${fileContent.length} chars)`);

        } catch (e) {
            contents.push(`[Error reading ${filePath}: ${e.message}]`);
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

// ============================================
// AI Provider Classes (using IPC)
// ============================================

class AIProvider {
    constructor(name, ipcClient) {
        this.name = name;
        this.ipc = ipcClient;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    }

    async ensureInitialized() {
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

    async chat(message, useCache = true) {
        // Check cache
        if (useCache && this.cache.has(message)) {
            const cached = this.cache.get(message);
            if (Date.now() - cached.time < this.cacheTimeout) {
                console.error(`[${this.name}] Using cached response`);
                return cached.response;
            }
        }

        await this.ensureInitialized();

        // DESYNC FIX: Wait for any ongoing typing to stop before sending new message
        // But don't wait too long - max 5 seconds
        console.error(`[${this.name}] Checking if AI is still typing from previous request...`);
        let typingCheck = await this.getTypingStatus();
        let waitCount = 0;
        while (typingCheck.isTyping && waitCount < 5) { // Max 5 seconds wait
            console.error(`[${this.name}] AI still typing, waiting...`);
            await this.sleep(1000);
            typingCheck = await this.getTypingStatus();
            waitCount++;
        }

        // Send message
        console.error(`[${this.name}] Sending message...`);
        await this.ipc.send('sendMessage', this.name, { message });

        // Use smart response capture with typing detection
        console.error(`[${this.name}] Waiting for response (with typing detection)...`);
        const result = await this.ipc.send('getResponseWithTyping', this.name, {});

        if (result.typingStarted) {
            console.error(`[${this.name}] Typing detected and completed`);
        }

        const response = result.response || 'No response received';

        // Cache the response
        this.cache.set(message, { response, time: Date.now() });

        return response;
    }

    // Chat with file attachment - Upload file first, then send message normally
    async chatWithFile(message, filePath, useCache = false) {
        await this.ensureInitialized();

        console.error(`[${this.name}] Uploading file first: ${filePath}`);

        // Step 1: Upload file
        const uploadResult = await this.ipc.send('uploadFile', this.name, { filePath });

        if (!uploadResult.success) {
            console.error(`[${this.name}] File upload failed, sending message without file`);
        } else {
            // Wait for send button to be ready after file upload
            console.error(`[${this.name}] Waiting for send button to be ready...`);
            await this.ipc.send('waitForSendButton', this.name, {});
        }

        // Step 2: Send message normally (this already has proper response capture)
        console.error(`[${this.name}] Sending message...`);
        const response = await this.chat(message, useCache);

        return {
            response,
            fileUploaded: uploadResult
        };
    }

    // Upload file only
    async uploadFile(filePath) {
        await this.ensureInitialized();

        console.error(`[${this.name}] Uploading file: ${filePath}`);
        const result = await this.ipc.send('uploadFile', this.name, { filePath });

        if (!result.success) {
            throw new Error(result.error || 'Failed to upload file');
        }

        return result;
    }

    // Legacy chat method (without typing detection)
    async chatSimple(message, useCache = true) {
        if (useCache && this.cache.has(message)) {
            const cached = this.cache.get(message);
            if (Date.now() - cached.time < this.cacheTimeout) {
                return cached.response;
            }
        }

        await this.ensureInitialized();
        await this.ipc.send('sendMessage', this.name, { message });
        await this.sleep(2000);
        const result = await this.ipc.send('getResponse', this.name, {});
        const response = result.response || 'No response received';
        this.cache.set(message, { response, time: Date.now() });
        return response;
    }

    async search(query, useCache = true) {
        return await this.chat(query, useCache);
    }

    async newConversation() {
        await this.ipc.send('newConversation', this.name);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================
// Smart Router
// ============================================

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

// ============================================
// Initialize
// ============================================

const ipcClient = new IPCClient();

const perplexity = new AIProvider('perplexity', ipcClient);
const chatgpt = new AIProvider('chatgpt', ipcClient);
const claude = new AIProvider('claude', ipcClient);
const gemini = new AIProvider('gemini', ipcClient);

const router = new SmartRouter({ perplexity, chatgpt, claude, gemini });

// Create MCP Server
const server = new McpServer({
    name: 'agent-hub',
    version: '3.0.0',
    description: 'Agent Hub MCP Server v3 - Embedded Browser Edition'
});

// Helper functions
function toolResponse(result) {
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
}

function toolError(error) {
    return { content: [{ type: 'text', text: `Error: ${error.message || error}` }], isError: true };
}

// ============================================
// SEARCH TOOLS
// ============================================

server.tool(
    'deep_search',
    {
        query: z.string().describe('The search query to send to Perplexity AI'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ query, files }) => {
        try {
            // If files provided, upload first then search
            if (files && files.length > 0) {
                const result = await perplexity.chatWithFile(query, files[0]);
                // Return just the response like backup format
                return toolResponse(result.response);
            }
            // Otherwise send normal query
            return toolResponse(await perplexity.search(query));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'pro_search',
    { query: z.string().describe('Query for detailed Pro search') },
    async ({ query }) => {
        try {
            return toolResponse(await perplexity.search(`Provide a comprehensive, detailed answer with sources: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'youtube_search',
    { query: z.string().describe('What to search for on YouTube') },
    async ({ query }) => {
        try {
            return toolResponse(await perplexity.search(`Find YouTube videos about: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'reddit_search',
    { query: z.string().describe('What to search for on Reddit') },
    async ({ query }) => {
        try {
            return toolResponse(await perplexity.search(`Search Reddit discussions about: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'news_search',
    {
        query: z.string().describe('News topic to search'),
        timeframe: z.string().optional().describe('Timeframe like "today", "this week", "2024"')
    },
    async ({ query, timeframe }) => {
        try {
            const tf = timeframe ? ` from ${timeframe}` : ' recent';
            return toolResponse(await perplexity.search(`Latest news${tf}: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'image_search',
    { query: z.string().describe('What images to find') },
    async ({ query }) => {
        try {
            return toolResponse(await perplexity.search(`Find images of: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'math_search',
    { query: z.string().describe('Math problem or scientific question') },
    async ({ query }) => {
        try {
            return toolResponse(await perplexity.search(`Solve and explain: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'academic_search',
    { query: z.string().describe('Academic/research query') },
    async ({ query }) => {
        try {
            return toolResponse(await perplexity.search(`Academic research: ${query}. Cite peer-reviewed sources.`));
        } catch (err) {
            return toolError(err);
        }
    }
);

// ============================================
// CODE TOOLS
// ============================================

server.tool(
    'verify_code',
    {
        purpose: z.string().describe('Description of what the code should do'),
        code: z.string().optional().describe('Optional code snippet to verify')
    },
    async ({ purpose, code }) => {
        try {
            const query = code
                ? `Verify this code follows best practices for: ${purpose}\n\nCode:\n${code}`
                : `What are the best practices and common patterns for: ${purpose}`;
            return toolResponse(await perplexity.search(query));
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
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to explain')
    },
    async ({ code, language, files }) => {
        try {
            const lang = language ? ` (${language})` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            return toolResponse(await perplexity.search(`Explain this code${lang} in detail:\n\n${fullCode}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'generate_code',
    {
        description: z.string().describe('What the code should do'),
        language: z.string().optional().describe('Programming language (default: JavaScript)')
    },
    async ({ description, language }) => {
        try {
            const lang = language || 'JavaScript';
            return toolResponse(await perplexity.search(`Write ${lang} code that: ${description}. Include comments and examples.`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'debug_code',
    {
        code: z.string().optional().describe('The code with bugs (or use files parameter)'),
        error: z.string().optional().describe('Error message if any'),
        language: z.string().optional().describe('Programming language'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to debug')
    },
    async ({ code, error, language, files }) => {
        try {
            const lang = language ? ` (${language})` : '';
            const errMsg = error ? `\nError: ${error}` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            return toolResponse(await perplexity.search(`Debug this code${lang}${errMsg}:\n\n${fullCode}`));
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
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to optimize')
    },
    async ({ code, goal, files }) => {
        try {
            const g = goal ? ` for ${goal}` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            return toolResponse(await perplexity.search(`Optimize this code${g}:\n\n${fullCode}`));
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
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to review')
    },
    async ({ code, context, files }) => {
        try {
            const ctx = context ? ` Context: ${context}` : '';
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = fileContent ? `${fileContent}\n\n${codeContent}` : codeContent;
            return toolResponse(await perplexity.search(`Review this code for issues, improvements, and best practices.${ctx}\n\n${fullCode}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'research_fix',
    { error: z.string().describe('The error message to research') },
    async ({ error }) => {
        try {
            return toolResponse(await perplexity.search(`How to fix this error: ${error}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

// ============================================
// CONTENT TOOLS
// ============================================

server.tool(
    'summarize_url',
    {
        url: z.string().describe('The URL to summarize'),
        focus: z.string().optional().describe('Focus area')
    },
    async ({ url, focus }) => {
        try {
            const f = focus ? ` Focus on: ${focus}` : '';
            return toolResponse(await perplexity.search(`Summarize this webpage: ${url}${f}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'generate_article',
    {
        topic: z.string().describe('Topic to write about'),
        style: z.string().optional().describe('Writing style')
    },
    async ({ topic, style }) => {
        try {
            const s = style ? ` in ${style} style` : '';
            return toolResponse(await perplexity.search(`Write a comprehensive article about: ${topic}${s}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'brainstorm',
    { topic: z.string().describe('Topic to brainstorm ideas for') },
    async ({ topic }) => {
        try {
            return toolResponse(await perplexity.search(`Brainstorm creative ideas for: ${topic}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'analyze_document',
    {
        url: z.string().describe('URL of the document'),
        question: z.string().optional().describe('Specific question')
    },
    async ({ url, question }) => {
        try {
            const q = question ? ` Answer: ${question}` : '';
            return toolResponse(await perplexity.search(`Analyze this document: ${url}${q}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'analyze_image_url',
    {
        imageUrl: z.string().describe('URL of the image'),
        focus: z.string().optional().describe('What to focus on')
    },
    async ({ imageUrl, focus }) => {
        try {
            const f = focus ? ` Focus on: ${focus}` : '';
            return toolResponse(await perplexity.search(`Describe and analyze this image: ${imageUrl}${f}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'extract_data',
    {
        content: z.string().describe('Text or URL to extract data from'),
        dataType: z.string().describe('What data to extract')
    },
    async ({ content, dataType }) => {
        try {
            return toolResponse(await perplexity.search(`Extract ${dataType} from: ${content}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'writing_help',
    {
        request: z.string().describe('What writing help you need'),
        content: z.string().optional().describe('Content to improve')
    },
    async ({ request, content }) => {
        try {
            const c = content ? `\n\nContent:\n${content}` : '';
            return toolResponse(await perplexity.search(`${request}${c}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'generate_image_prompt',
    {
        description: z.string().describe('What image you want'),
        style: z.string().optional().describe('Art style')
    },
    async ({ description, style }) => {
        try {
            const s = style ? ` in ${style} style` : '';
            return toolResponse(await perplexity.search(`Create a detailed AI image generation prompt for: ${description}${s}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

// ============================================
// ANALYSIS TOOLS
// ============================================

server.tool(
    'translate',
    {
        text: z.string().describe('Text to translate'),
        targetLanguage: z.string().describe('Target language'),
        sourceLanguage: z.string().optional().describe('Source language')
    },
    async ({ text, targetLanguage, sourceLanguage }) => {
        try {
            const from = sourceLanguage ? ` from ${sourceLanguage}` : '';
            return toolResponse(await perplexity.search(`Translate${from} to ${targetLanguage}: ${text}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'fact_check',
    { claim: z.string().describe('The claim to verify') },
    async ({ claim }) => {
        try {
            return toolResponse(await perplexity.search(`Fact check with sources: ${claim}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'find_stats',
    {
        topic: z.string().describe('Topic to find statistics about'),
        year: z.string().optional().describe('Specific year')
    },
    async ({ topic, year }) => {
        try {
            const y = year ? ` for ${year}` : '';
            return toolResponse(await perplexity.search(`Find statistics and data${y}: ${topic}`));
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
        context: z.string().optional().describe('Context for comparison')
    },
    async ({ item1, item2, context }) => {
        try {
            const ctx = context ? ` for ${context}` : '';
            return toolResponse(await perplexity.search(`Compare ${item1} vs ${item2}${ctx}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'how_to',
    { task: z.string().describe('What to learn how to do') },
    async ({ task }) => {
        try {
            return toolResponse(await perplexity.search(`Step-by-step guide: How to ${task}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

// ============================================
// MULTI-AI PROVIDER TOOLS
// ============================================

server.tool(
    'ask_chatgpt',
    {
        message: z.string().describe('Message to send to ChatGPT'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        if (!isProviderEnabled('chatgpt')) {
            return toolResponse({ success: false, error: 'ChatGPT is disabled. Enable it in Agent Hub.' });
        }
        try {
            // If files provided, upload first then chat
            if (files && files.length > 0) {
                const result = await chatgpt.chatWithFile(message, files[0]);
                return toolResponse(result.response);
            }
            // Otherwise send normal message
            return toolResponse(await chatgpt.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_claude',
    {
        message: z.string().describe('Message to send to Claude'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        if (!isProviderEnabled('claude')) {
            return toolResponse({ success: false, error: 'Claude is disabled. Enable it in Agent Hub.' });
        }
        try {
            // If files provided, upload first then chat
            if (files && files.length > 0) {
                const result = await claude.chatWithFile(message, files[0]);
                return toolResponse(result.response);
            }
            // Otherwise send normal message
            return toolResponse(await claude.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_gemini',
    {
        message: z.string().describe('Message to send to Gemini'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        if (!isProviderEnabled('gemini')) {
            return toolResponse({ success: false, error: 'Gemini is disabled. Enable it in Agent Hub.' });
        }
        try {
            // If files provided, upload first then chat
            if (files && files.length > 0) {
                const result = await gemini.chatWithFile(message, files[0]);
                return toolResponse(result.response);
            }
            // Otherwise send normal message
            return toolResponse(await gemini.chat(message));
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

            console.error('[ask_all_ais] Sending to all providers in parallel...');

            // Send to all providers in PARALLEL
            if (enabled.has('perplexity')) {
                names.push('perplexity');
                tasks.push(
                    (async () => {
                        try {
                            return await perplexity.search(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }
            if (enabled.has('chatgpt')) {
                names.push('chatgpt');
                tasks.push(
                    (async () => {
                        try {
                            return await chatgpt.chat(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }
            if (enabled.has('claude')) {
                names.push('claude');
                tasks.push(
                    (async () => {
                        try {
                            return await claude.chat(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }
            if (enabled.has('gemini')) {
                names.push('gemini');
                tasks.push(
                    (async () => {
                        try {
                            return await gemini.chat(fullMessage);
                        } catch (e) {
                            return { error: e.message };
                        }
                    })()
                );
            }

            // Wait for ALL to complete - typing detection is handled inside chat()
            console.error('[ask_all_ais] Waiting for all providers to complete typing...');
            const results = await Promise.all(tasks);
            console.error('[ask_all_ais] All providers completed');

            const responses = {};
            names.forEach((name, i) => {
                responses[name] = results[i];
            });

            return toolResponse({
                success: true,
                message,
                filesIncluded: files ? files.length : 0,
                enabledProviders: names,
                responses,
                timestamp: new Date().toISOString()
            });
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

            if (useProviders.includes('perplexity')) tasks.push(perplexity.search(fullQuestion).then(r => results.perplexity = r).catch(e => results.perplexity = { error: e.message }));
            if (useProviders.includes('chatgpt')) tasks.push(chatgpt.chat(fullQuestion).then(r => results.chatgpt = r).catch(e => results.chatgpt = { error: e.message }));
            if (useProviders.includes('claude')) tasks.push(claude.chat(fullQuestion).then(r => results.claude = r).catch(e => results.claude = { error: e.message }));
            if (useProviders.includes('gemini')) tasks.push(gemini.chat(fullQuestion).then(r => results.gemini = r).catch(e => results.gemini = { error: e.message }));

            await Promise.all(tasks);

            return toolResponse({
                success: true,
                question,
                filesIncluded: files ? files.length : 0,
                usedProviders: useProviders,
                comparison: results,
                timestamp: new Date().toISOString()
            });
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

server.tool(
    'router_stats',
    {},
    async () => {
        try {
            return toolResponse({
                success: true,
                stats: router.getStats(),
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            return toolError(err);
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

// ============================================
// FILE ANALYSIS TOOLS
// ============================================

server.tool(
    'analyze_file',
    {
        filePath: z.string().describe('Absolute path to the file to analyze'),
        question: z.string().optional().describe('Specific question about the file'),
        provider: z.string().optional().describe('Which AI to use (chatgpt, claude, gemini, perplexity). Default: claude')
    },
    async ({ filePath, question, provider }) => {
        try {
            const useProvider = provider || 'claude';
            const enabled = getEnabledProviders();

            if (!enabled.has(useProvider)) {
                return toolResponse({ success: false, error: `${useProvider} is disabled. Enable it in Agent Hub.` });
            }

            const fileContent = readFileContents([filePath]);
            if (!fileContent) {
                return toolResponse({ success: false, error: 'Could not read file or file reference is disabled' });
            }

            const message = question
                ? `${fileContent}\n\nPlease analyze this file and answer: ${question}`
                : `${fileContent}\n\nPlease analyze this file and explain its contents, purpose, and any notable aspects.`;

            const providers = { perplexity, chatgpt, claude, gemini };
            const response = await providers[useProvider].chat(message);

            return toolResponse({
                success: true,
                provider: useProvider,
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
    async ({ filePath, focus, provider }) => {
        try {
            const useProvider = provider || 'claude';
            const enabled = getEnabledProviders();

            if (!enabled.has(useProvider)) {
                return toolResponse({ success: false, error: `${useProvider} is disabled. Enable it in Agent Hub.` });
            }

            const fileContent = readFileContents([filePath]);
            if (!fileContent) {
                return toolResponse({ success: false, error: 'Could not read file or file reference is disabled' });
            }

            const focusText = focus ? ` Focus on: ${focus}.` : '';
            const message = `${fileContent}\n\nPlease review this code file.${focusText} Identify issues, suggest improvements, and follow best practices.`;

            const providers = { perplexity, chatgpt, claude, gemini };
            const response = await providers[useProvider].chat(message);

            return toolResponse({
                success: true,
                provider: useProvider,
                filePath,
                review: response
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

// ============================================
// WINDOW CONTROL TOOLS (Headless Mode)
// ============================================

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

// Tool to check typing status
server.tool(
    'get_typing_status',
    {
        provider: z.string().optional().describe('Provider to check (chatgpt, claude, perplexity, gemini). If not specified, checks all.')
    },
    async ({ provider }) => {
        try {
            const enabled = getEnabledProviders();
            const results = {};

            if (provider) {
                // Check specific provider
                if (!enabled.has(provider)) {
                    return toolResponse({ error: `${provider} is not enabled` });
                }
                const providers = { perplexity, chatgpt, claude, gemini };
                const p = providers[provider];
                if (p) {
                    const status = await p.getTypingStatus();
                    return toolResponse({ [provider]: status });
                }
            } else {
                // Check all enabled providers
                if (enabled.has('chatgpt')) {
                    results.chatgpt = await chatgpt.getTypingStatus();
                }
                if (enabled.has('claude')) {
                    results.claude = await claude.getTypingStatus();
                }
                if (enabled.has('perplexity')) {
                    results.perplexity = await perplexity.getTypingStatus();
                }
                if (enabled.has('gemini')) {
                    results.gemini = await gemini.getTypingStatus();
                }
            }

            return toolResponse(results);
        } catch (err) {
            return toolError(err);
        }
    }
);

// ============================================
// Resources Handler (for MCP compatibility)
// ============================================

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
                    version: '3.0.0',
                    enabledProviders: Array.from(enabled),
                    connected: ipcClient.connected
                }, null, 2)
            }]
        };
    }
);

// ============================================
// Start Server
// ============================================

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

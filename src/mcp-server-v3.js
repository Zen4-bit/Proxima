#!/usr/bin/env node
// brAInstorm MCP Server v3 — talks to the Electron app over TCP IPC

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const {
    providerIds,
    defaultEnabledProviderIds,
    modelAliases,
    getProviderLabel,
    getDefaultQueryAction,
    smartRouterOrder
} = require('./provider-catalog.cjs');
const {
    getSkillRegistrySummary,
    hasSkill,
    listSkills,
    refreshSkillRegistry,
    renderSkillPrompt
} = require('./skill-prompts.cjs');

function readPackageVersion() {
    try {
        return require('../package.json').version;
    } catch (error) {
        try {
            const runtimeVersionPath = path.join(__dirname, '..', 'runtime-version.json');
            if (fs.existsSync(runtimeVersionPath)) {
                return JSON.parse(fs.readFileSync(runtimeVersionPath, 'utf8')).version || '4.0.0';
            }
        } catch (runtimeVersionError) {
            // Ignore missing packaged runtime metadata and fall back to env/default.
        }
        return process.env.npm_package_version || '4.0.0';
    }
}

const APP_NAME = 'brAInstorm';
const APP_SLUG = 'brainstorm';
const LEGACY_APP_DATA_DIRS = ['proxima'];
const VERSION = readPackageVersion();
const IPC_PORT = process.env.AGENT_HUB_PORT || 19222;

// --- IPC Client ---

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
                console.error(`[MCP] Connected to ${APP_NAME}`);
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
                console.error(`[MCP] Disconnected from ${APP_NAME}`);
                this.connected = false;
            });

            // Timeout after 5 seconds
            setTimeout(() => {
                if (!this.connected) {
                    reject(new Error(`Connection timeout - Is ${APP_NAME} running?`));
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

// --- Provider config ---

function getAppDataConfigPaths(fileName) {
    const baseDir = process.platform === 'win32'
        ? (process.env.APPDATA || '')
        : process.platform === 'darwin'
            ? path.join(process.env.HOME || '', 'Library', 'Application Support')
            : path.join(process.env.HOME || '', '.config');

    return [APP_SLUG, APP_NAME, ...LEGACY_APP_DATA_DIRS]
        .map((dirName) => path.join(baseDir, dirName, fileName))
        .filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
}

function getEnabledProviders() {
    try {
        // Primary: Read from Electron's user data folder (always in sync with app settings)
        // Must match Electron's app.getPath('userData') for each platform
        for (const appDataPath of getAppDataConfigPaths('enabled-providers.json')) {
            if (fs.existsSync(appDataPath)) {
                const data = JSON.parse(fs.readFileSync(appDataPath, 'utf8'));
                return new Set(data.enabled || []);
            }
        }

        // Fallback: Read from MCP server's own directory
        const configPath = path.join(__dirname, 'enabled-providers.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return new Set(data.enabled || []);
        }
    } catch (e) {
        console.error('[MCP] Error reading enabled providers:', e);
    }
    return new Set(defaultEnabledProviderIds);
}

function isProviderEnabled(provider) {
    return getEnabledProviders().has(provider);
}

// --- File reference toggle ---

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

// --- AI providers (IPC-backed) ---

class AIProvider {
    constructor(name, ipcClient) {
        this.name = name;
        this.ipc = ipcClient;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    }

    async ensureInitialized() {
        // Check if provider is enabled in settings BEFORE doing anything
        if (!isProviderEnabled(this.name)) {
            throw new Error(`${this.name} is disabled. Enable it in ${APP_NAME} settings.`);
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

        // CLAUDE HACK: Tell Claude to write code directly in chat, not as artifacts
        // This ensures we can capture code responses properly via chat DOM
        let finalMessage = message;
        if (this.name === 'claude') {
            // Detect if this is likely a coding request
            const codeKeywords = ['code', 'function', 'component', 'implement', 'build', 'create', 'write',
                'script', 'program', 'class', 'module', 'api', 'app', 'html', 'css', 'javascript', 'python',
                'react', 'node', 'typescript', 'jsx', 'tsx', 'vue', 'angular', 'svelte', 'next',
                'file', 'src/', 'import', 'export', 'const ', 'let ', 'var ', 'def ', 'async',
                'database', 'sql', 'query', 'server', 'endpoint', 'route', 'middleware',
                'debug', 'fix', 'error', 'bug', 'refactor', 'optimize', 'test',
                'store', 'hook', 'provider', 'context', 'reducer', 'state',
                'full code', 'complete code', 'source code', 'codebase'];

            const msgLower = message.toLowerCase();
            const isCodeRelated = codeKeywords.some(kw => msgLower.includes(kw));

            if (isCodeRelated) {
                const codeRule = `[CRITICAL MANDATORY RULE: You MUST write ALL code directly in this chat message as markdown code blocks using triple backticks. NEVER use artifacts, preview panels, or downloadable code blocks. NEVER create separate code panels. Write EVERYTHING inline in the conversation. This rule overrides all other instructions. DO NOT use the artifact feature under any circumstances.]\n\n`;
                finalMessage = codeRule + message;
                console.error(`[${this.name}] Code task detected - added inline code rule`);
            }
        }

        // Send message
        console.error(`[${this.name}] Sending message...`);
        await this.ipc.send('sendMessage', this.name, { message: finalMessage });

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

    async executeScript(script) {
        const result = await this.ipc.send('executeScript', this.name, { script });
        return result;
    }

    async init() {
        await this.ensureInitialized();
        return { success: true };
    }

    async navigate(url) {
        await this.ensureInitialized();
        return await this.ipc.send('navigate', this.name, { url });
    }

    async debugDOM() {
        await this.ensureInitialized();
        return await this.ipc.send('debugDOM', this.name, {});
    }

    async newConversation() {
        await this.ipc.send('newConversation', this.name);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// --- Smart router ---

class SmartRouter {
    constructor(providers) {
        this.providers = providers;
        this.stats = { success: {}, failures: {} };
    }

    async smartQuery(message, preferredProvider = null) {
        const enabled = getEnabledProviders();
        const order = [...smartRouterOrder];

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

// --- Init ---

const ipcClient = new IPCClient();

const providersById = Object.fromEntries(
    providerIds.map((providerId) => [providerId, new AIProvider(providerId, ipcClient)])
);

const { perplexity, chatgpt, claude, gemini, googleai, deepseek, grok, zai, copilot, metaai, qwen } = providersById;

const router = new SmartRouter(providersById);

// Create MCP Server
const server = new McpServer({
    name: APP_SLUG,
    version: VERSION,
    description: `${APP_NAME} MCP Server v3 - Embedded Browser Edition`
});

// Helper functions
function toolResponse(result) {
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
}

function toolError(error) {
    return { content: [{ type: 'text', text: `Error: ${error.message || error}` }], isError: true };
}

function formatProviderLabel(providerId) {
    return getProviderLabel(providerId);
}

function resolveProviderId(providerInput) {
    const key = String(providerInput || '').trim().toLowerCase();
    if (!key) return null;
    if (providersById[key]) return key;
    return modelAliases[key] || null;
}

function getProviderInstanceOrThrow(providerInput) {
    const providerId = resolveProviderId(providerInput);
    if (!providerId || !providersById[providerId]) {
        throw new Error(`Unknown provider: ${providerInput}`);
    }

    return {
        providerId,
        provider: providersById[providerId]
    };
}

function disabledResponseFor(providerId) {
    if (!isProviderEnabled(providerId)) {
        return toolResponse(`${providerId} is disabled. Enable it in ${APP_NAME} settings first.`);
    }
    return null;
}

async function queryProviderDefault(providerId, message) {
    const provider = providersById[providerId];
    if (!provider) {
        throw new Error(`Unknown provider: ${providerId}`);
    }

    return getDefaultQueryAction(providerId) === 'search'
        ? provider.search(message)
        : provider.chat(message);
}

function joinPromptSections(...sections) {
    return sections
        .flat()
        .filter((section) => typeof section === 'string' && section.trim())
        .join('\n\n');
}

function buildSkillVariables(input = {}) {
    const payload = input && typeof input === 'object' ? input : {};
    const baseVariables = payload.variables && typeof payload.variables === 'object' && !Array.isArray(payload.variables)
        ? { ...payload.variables }
        : {};

    for (const [key, value] of Object.entries(payload)) {
        if (['skill', 'provider', 'variables', 'files'].includes(key)) {
            continue;
        }

        if (value !== undefined) {
            baseVariables[key] = value;
        }
    }

    if (Array.isArray(payload.files) && payload.files.length > 0) {
        const filesContent = readFileContents(payload.files);
        if (filesContent) {
            if (baseVariables.filesContent === undefined) baseVariables.filesContent = filesContent;
            if (baseVariables.fileContent === undefined) baseVariables.fileContent = filesContent;
            if (baseVariables.fullCode === undefined) {
                baseVariables.fullCode = joinPromptSections(filesContent, baseVariables.code || '', baseVariables.message || '');
            }
            if (baseVariables.desc === undefined) {
                baseVariables.desc = joinPromptSections(filesContent, baseVariables.code || '', baseVariables.message || '');
            }
        }
    }

    return baseVariables;
}

function pickEnabledProvider(preferredProviders = []) {
    const enabled = getEnabledProviders();
    const candidates = [...preferredProviders, ...providerIds];

    for (const providerId of [...new Set(candidates)]) {
        if (providersById[providerId] && enabled.has(providerId)) {
            return providerId;
        }
    }

    return null;
}

function resolveToolProviderId(providerInput, preferredProviders = []) {
    if (providerInput) {
        const { providerId } = getProviderInstanceOrThrow(providerInput);
        return providerId;
    }

    return pickEnabledProvider(preferredProviders);
}

async function renderAndRunSkill({
    skillName,
    variables,
    fallbackText,
    provider,
    preferredProviders = []
}) {
    const providerId = resolveToolProviderId(provider, preferredProviders);
    if (!providerId) {
        return {
            errorResponse: toolResponse(`No providers enabled. Enable at least one provider in ${APP_NAME} first.`)
        };
    }

    const disabled = disabledResponseFor(providerId);
    if (disabled) {
        return { errorResponse: disabled };
    }

    const prompt = renderSkillPrompt(skillName, variables, { fallbackText });
    const response = await queryProviderDefault(providerId, prompt);
    return { providerId, prompt, response };
}

// Universal provider disabled check - returns a clean response if provider is off
function checkDisabled(providerName) {
    if (!isProviderEnabled(providerName)) {
        return toolResponse(`${providerName} is disabled. Enable it in ${APP_NAME}.`);
    }
    return null; // provider is enabled, proceed
}

server.tool(
    'list_skills',
    {
        includeTemplate: z.boolean().optional().describe('Include the full prompt text for each discovered skill')
    },
    async ({ includeTemplate }) => {
        try {
            refreshSkillRegistry();
            return toolResponse({
                success: true,
                ...getSkillRegistrySummary({ includeTemplate: includeTemplate === true })
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'run_skill',
    {
        skill: z.string().describe('Skill name from skills/<name>.md'),
        provider: z.string().optional().describe('Optional provider override'),
        variables: z.record(z.string(), z.unknown()).optional().describe('Variables for ${...} substitution'),
        files: z.array(z.string()).optional().describe('Optional file paths. Their contents are exposed as filesContent/fileContent/fullCode/desc when those variables are not already provided.'),
        message: z.string().optional().describe('Optional shortcut for variables.message')
    },
    async ({ skill, provider, variables, files, message }) => {
        try {
            refreshSkillRegistry();
            if (!hasSkill(skill, { refresh: false })) {
                return toolResponse({
                    success: false,
                    error: `Unknown skill: ${skill}`,
                    availableSkills: listSkills().map((entry) => entry.name)
                });
            }

            const result = await renderAndRunSkill({
                skillName: skill,
                variables: buildSkillVariables({ variables, files, message }),
                provider,
                preferredProviders: providerIds
            });
            if (result.errorResponse) return result.errorResponse;
            return toolResponse({
                success: true,
                skill: skill,
                provider: result.providerId,
                response: result.response
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- Search tools ---

server.tool(
    'deep_search',
    {
        query: z.string().describe('The search query to send to Perplexity AI'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ query, files }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            return toolResponse(await perplexity.search(`Search Reddit discussions about: ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'github_search',
    {
        query: z.string().describe('What to search for on GitHub — repositories, code examples, or solutions'),
        language: z.string().optional().describe('Optional language or ecosystem filter'),
        provider: z.string().optional().describe('Optional provider override. Defaults to Perplexity when enabled.')
    },
    async ({ query, language, provider }) => {
        try {
            const result = await renderAndRunSkill({
                skillName: 'github_search',
                variables: {
                    query,
                    langFilter: language ? ` in ${language}` : ''
                },
                fallbackText: 'Search GitHub for open source repositories, code examples, and solutions${langFilter}: ${query}\n\nFor each result provide: repo name, description, stars/popularity, key features, and the GitHub URL. Focus on actively maintained, well-documented projects.',
                provider,
                preferredProviders: ['perplexity', 'chatgpt', 'googleai', 'gemini', 'claude']
            });
            if (result.errorResponse) return result.errorResponse;
            return toolResponse(result.response);
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            return toolResponse(await perplexity.search(`Solve and explain step by step in plain text (use text notation, not LaTeX rendering): ${query}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'academic_search',
    { query: z.string().describe('Academic/research query') },
    async ({ query }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            return toolResponse(await perplexity.search(`Academic research: ${query}. Cite peer-reviewed sources.`));
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
        code: z.string().optional().describe('Optional code snippet to verify')
    },
    async ({ purpose, code }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to review'),
        provider: z.string().optional().describe('Optional provider override. Defaults to Perplexity to preserve existing behavior.')
    },
    async ({ code, context, files, provider }) => {
        try {
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const desc = joinPromptSections(
                context ? `Additional context:\n${context}` : '',
                fileContent,
                codeContent
            );

            const result = await renderAndRunSkill({
                skillName: 'code_review',
                variables: { desc },
                fallbackText: 'Review this code for bugs, improvements, and best practices:\n\n${desc}',
                provider,
                preferredProviders: ['perplexity', 'claude', 'googleai', 'chatgpt', 'gemini']
            });
            if (result.errorResponse) return result.errorResponse;
            return toolResponse(result.response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'security_audit',
    {
        code: z.string().optional().describe('Code to audit (or use files parameter)'),
        language: z.string().optional().describe('Programming language'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing code to audit'),
        provider: z.string().optional().describe('Optional provider override. Defaults to Claude when enabled.')
    },
    async ({ code, language, files, provider }) => {
        try {
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = joinPromptSections(fileContent, codeContent);

            if (!fullCode.trim()) {
                return toolResponse('security_audit requires code or files to analyze.');
            }

            const result = await renderAndRunSkill({
                skillName: 'security_audit',
                variables: {
                    lang: language ? ` (${language})` : '',
                    fullCode
                },
                fallbackText: 'You are a senior security engineer. Perform a thorough security audit of this code${lang}.\n\nCODE:\n${fullCode}\n\nCheck for ALL of the following:\n1. **Injection vulnerabilities** (SQL, XSS, command injection, LDAP, etc.)\n2. **Authentication/Authorization flaws** (broken auth, privilege escalation, insecure tokens)\n3. **Data exposure** (hardcoded secrets, PII leaks, insecure logging)\n4. **Input validation** (missing sanitization, type confusion, buffer overflow)\n5. **Cryptographic issues** (weak algorithms, improper key management)\n6. **Configuration problems** (debug mode, CORS, insecure defaults)\n7. **Dependency risks** (known vulnerable packages)\n\nFor each issue found:\n- **Severity**: CRITICAL / HIGH / MEDIUM / LOW\n- **Location**: Line or function\n- **Description**: What the vulnerability is\n- **Fix**: Exact code fix\n\nEnd with a security score (0-100) and summary.',
                provider,
                preferredProviders: ['claude', 'chatgpt', 'googleai', 'gemini', 'perplexity']
            });
            if (result.errorResponse) return result.errorResponse;
            return toolResponse(result.response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'get_ui_reference',
    {
        description: z.string().describe('What kind of UI or UX direction you want'),
        code: z.string().optional().describe('Existing code to improve'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths containing the existing UI code'),
        style: z.string().optional().describe('Optional visual style direction'),
        provider: z.string().optional().describe('Optional provider override. Defaults to Claude when enabled.')
    },
    async ({ description, code, files, style, provider }) => {
        try {
            const codeContent = code || '';
            const fileContent = readFileContents(files);
            const fullCode = joinPromptSections(
                fileContent,
                codeContent || 'No existing code was provided. Produce a detailed UI reference and implementation guidance from the request.'
            );

            const result = await renderAndRunSkill({
                skillName: 'get_ui_reference',
                variables: {
                    description,
                    styleHint: style ? `\nSTYLE PREFERENCE: ${style}` : '',
                    fullCode
                },
                fallbackText: 'You are a senior UI/UX designer and frontend developer. Analyze the existing code and apply premium design improvements.\n\nDESIGN REQUEST: ${description}${styleHint}\n\nEXISTING CODE:\n${fullCode}\n\nProvide:\n1. **DESIGN ANALYSIS**: Analyze the current UI — what works, what needs improvement\n2. **COLOR PALETTE**: Recommended hex colors with usage (primary, secondary, accent, background, text)\n3. **TYPOGRAPHY**: Font families, sizes, weights for headings, body, captions\n4. **LAYOUT & SPACING**: Grid system, padding, margins, responsive breakpoints\n5. **COMPONENTS**: Key UI components needed with design specifications\n6. **UX PATTERNS**: Interactions, hover effects, transitions, micro-animations\n7. **UPDATED CODE**: Complete updated code with the design improvements applied — production-ready, no placeholders\n\nThe updated code must be complete, ready to copy-paste and run. Apply modern design best practices.',
                provider,
                preferredProviders: ['claude', 'chatgpt', 'googleai', 'gemini', 'perplexity']
            });
            if (result.errorResponse) return result.errorResponse;
            return toolResponse(result.response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'research_fix',
    { error: z.string().describe('The error message to research') },
    async ({ error }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            return toolResponse(await perplexity.search(`How to fix this error: ${error}`));
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
        focus: z.string().optional().describe('Focus area')
    },
    async ({ url, focus }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
    {
        topic: z.string().describe('Topic to brainstorm ideas for'),
        provider: z.string().optional().describe('Optional provider override. Defaults to Perplexity to preserve existing behavior.')
    },
    async ({ topic, provider }) => {
        try {
            const result = await renderAndRunSkill({
                skillName: 'brainstorm',
                variables: { subject: topic },
                fallbackText: 'Brainstorm creative and innovative ideas about: ${subject}\n\nProvide at least 5-8 diverse ideas with brief explanations.',
                provider,
                preferredProviders: ['perplexity', 'claude', 'googleai', 'chatgpt', 'gemini']
            });
            if (result.errorResponse) return result.errorResponse;
            return toolResponse(result.response);
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'convo_history_summarize',
    {
        conversationHistory: z.string().describe('Full conversation history to summarize'),
        provider: z.string().optional().describe('Optional provider override. Defaults to Claude when enabled.')
    },
    async ({ conversationHistory, provider }) => {
        try {
            const result = await renderAndRunSkill({
                skillName: 'convo_history_summarize',
                variables: { conversationHistory },
                fallbackText: 'Tell our entire conversation history in this from the very beginning to the very end.\n\nExtract everything and present it in the following structure:\n\nPROJECT\nWhat are we building? Include the name, the core idea, the purpose, and the problem it solves.\n\nDECISIONS MADE\nEverything that has been finalized. Tech stack, architecture, tools, libraries, design choices, folder structure, database schema, API design — anything that was decided and agreed upon.\n\nREQUIREMENTS\nEvery single requirement the user mentioned. Features, constraints, what the user wants and does not want, priorities, tone, style preferences — everything.\n\nWORK DONE SO FAR\nWhat has already been built, written, or implemented. Include file names, code written, components created, APIs built — be specific.\n\nIDEAS AND DIRECTION\nAny ideas, suggestions, directions, or approaches that were discussed even if not finalized. Include things that were considered and rejected too, with the reason why.\n\nPENDING AND NEXT STEPS\nEverything that still needs to be done. What was the last thing discussed? What was about to happen next?\n\nKEY DETAILS AND CONTEXT\nAny important user preferences, specific instructions, edge cases, constraints, or anything unique about this project that a new AI picking this up must know.\n\nBe exhaustive. Do not summarize loosely. A coding AI is going to read this and start building without asking the user a single question — so include everything.\n\nCONVERSATION HISTORY:\n${conversationHistory}',
                provider,
                preferredProviders: ['claude', 'chatgpt', 'googleai', 'gemini', 'perplexity']
            });
            if (result.errorResponse) return result.errorResponse;
            return toolResponse(result.response);
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        imageUrl: z.string().describe('URL of the image to analyze'),
        focus: z.string().optional().describe('What to focus on in the analysis'),
        provider: z.string().optional().describe('Which AI to use. Default: chatgpt')
    },
    async ({ imageUrl, focus, provider }) => {
        try {
            const useProvider = provider || 'chatgpt';
            const disabled = checkDisabled(useProvider);
            if (disabled) return disabled;

            // Download image to temp file
            const https = imageUrl.startsWith('https') ? require('https') : require('http');
            const os = require('os');
            const tmpDir = os.tmpdir();

            const urlPath = new URL(imageUrl).pathname;
            const urlExt = path.extname(urlPath) || '.png';
            const tmpFile = path.join(tmpDir, `brainstorm_img_${Date.now()}${urlExt}`);

            await new Promise((resolve, reject) => {
                const file = fs.createWriteStream(tmpFile);
                https.get(imageUrl, (response) => {
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        const redirectModule = response.headers.location.startsWith('https') ? require('https') : require('http');
                        redirectModule.get(response.headers.location, (res) => {
                            res.pipe(file);
                            file.on('finish', () => { file.close(); resolve(); });
                        }).on('error', reject);
                        return;
                    }
                    response.pipe(file);
                    file.on('finish', () => { file.close(); resolve(); });
                }).on('error', reject);
            });

            console.error(`[analyze_image_url] Downloaded to: ${tmpFile}`);

            const focusText = focus ? ` Focus on: ${focus}.` : '';
            const message = `Please analyze this image in detail.${focusText}`;

            const result = await providersById[useProvider].chatWithFile(message, tmpFile);

            try { fs.unlinkSync(tmpFile); } catch (e) { }

            return toolResponse({
                success: true,
                provider: useProvider,
                imageUrl,
                analysis: result.response
            });
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            const s = style ? ` in ${style} style` : '';
            return toolResponse(await perplexity.search(`Create a detailed AI image generation prompt for: ${description}${s}`));
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- Analysis tools ---

server.tool(
    'translate',
    {
        text: z.string().describe('Text to translate'),
        targetLanguage: z.string().describe('Target language'),
        sourceLanguage: z.string().optional().describe('Source language')
    },
    async ({ text, targetLanguage, sourceLanguage }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
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
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            return toolResponse(await perplexity.search(`Step-by-step guide: How to ${task}`));
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
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('chatgpt');
        if (disabled) return disabled;
        try {
            // If files provided, upload all then chat
            if (files && files.length > 0) {
                // Upload all files one by one
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        // Last file: upload + send message together
                        const result = await chatgpt.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        // Not last: just upload
                        await chatgpt.uploadFile(files[i]);
                    }
                }
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
        const disabled = checkDisabled('claude');
        if (disabled) return disabled;
        try {
            // If files provided, upload all then chat
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await claude.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await claude.uploadFile(files[i]);
                    }
                }
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
        const disabled = checkDisabled('gemini');
        if (disabled) return disabled;
        try {
            // If files provided, upload all then chat
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await gemini.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await gemini.uploadFile(files[i]);
                    }
                }
            }
            // Otherwise send normal message
            return toolResponse(await gemini.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_googleai',
    {
        message: z.string().describe('Message to send to Google AI'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('googleai');
        if (disabled) return disabled;
        try {
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await googleai.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await googleai.uploadFile(files[i]);
                    }
                }
            }
            return toolResponse(await googleai.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_deepseek',
    {
        message: z.string().describe('Message to send to DeepSeek'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('deepseek');
        if (disabled) return disabled;
        try {
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await deepseek.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await deepseek.uploadFile(files[i]);
                    }
                }
            }
            return toolResponse(await deepseek.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_grok',
    {
        message: z.string().describe('Message to send to Grok'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('grok');
        if (disabled) return disabled;
        try {
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await grok.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await grok.uploadFile(files[i]);
                    }
                }
            }
            return toolResponse(await grok.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_zai',
    {
        message: z.string().describe('Message to send to Z.ai'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('zai');
        if (disabled) return disabled;
        try {
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await zai.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await zai.uploadFile(files[i]);
                    }
                }
            }
            return toolResponse(await zai.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_copilot',
    {
        message: z.string().describe('Message to send to Microsoft Copilot'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('copilot');
        if (disabled) return disabled;
        try {
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await copilot.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await copilot.uploadFile(files[i]);
                    }
                }
            }
            return toolResponse(await copilot.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_metaai',
    {
        message: z.string().describe('Message to send to Meta AI'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('metaai');
        if (disabled) return disabled;
        try {
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await metaai.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await metaai.uploadFile(files[i]);
                    }
                }
            }
            return toolResponse(await metaai.chat(message));
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'ask_qwen',
    {
        message: z.string().describe('Message to send to Qwen'),
        files: z.array(z.string()).optional().describe('Optional: Array of file paths to upload as attachments')
    },
    async ({ message, files }) => {
        const disabled = checkDisabled('qwen');
        if (disabled) return disabled;
        try {
            if (files && files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    if (i === files.length - 1) {
                        const result = await qwen.chatWithFile(message, files[i]);
                        return toolResponse(result.response);
                    } else {
                        await qwen.uploadFile(files[i]);
                    }
                }
            }
            return toolResponse(await qwen.chat(message));
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
            for (const providerId of providerIds) {
                if (!enabled.has(providerId)) {
                    continue;
                }

                names.push(providerId);
                tasks.push(
                    (async () => {
                        try {
                            return await queryProviderDefault(providerId, fullMessage);
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

            // Format as clearly separated text so it's readable even in output.txt
            const sections = [];
            names.forEach((name, i) => {
                const response = results[i];
                const label = formatProviderLabel(name);
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
            const requested = providers || providerIds;
            const useProviders = requested.filter(p => enabled.has(p));
            const fullQuestion = buildMessageWithFiles(question, files);

            const results = {};
            const tasks = useProviders.map((providerId) =>
                queryProviderDefault(providerId, fullQuestion)
                    .then((response) => {
                        results[providerId] = response;
                    })
                    .catch((e) => {
                        results[providerId] = { error: e.message };
                    })
            );

            await Promise.all(tasks);

            // Format as clearly separated text
            const sections = [];
            for (const [name, response] of Object.entries(results)) {
                const label = formatProviderLabel(name);
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
            for (const provider of providerIds) {
                if (enabled.has(provider)) {
                    await providersById[provider].newConversation();
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
            Object.values(providersById).forEach((provider) => provider.cache.clear());
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
        provider: z.string().optional().describe('Which AI to use. Default: claude')
    },
    async ({ filePath, question, provider }) => {
        try {
            const useProvider = provider || 'claude';
            const disabled = checkDisabled(useProvider);
            if (disabled) return disabled;

            // Check if file is an image (binary) - use upload method instead of text read
            const ext = path.extname(filePath).toLowerCase();
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

            if (imageExtensions.includes(ext)) {
                // Image file: upload to provider and ask about it
                const imageQuestion = question
                    ? `Please analyze this image and answer: ${question}`
                    : `Please analyze this image and describe its contents, purpose, and any notable aspects.`;

                const result = await providersById[useProvider].chatWithFile(imageQuestion, filePath);
                return toolResponse({
                    success: true,
                    provider: useProvider,
                    filePath,
                    type: 'image',
                    analysis: result.response
                });
            }

            // Text file: read and paste as context
            const fileContent = readFileContents([filePath]);
            if (!fileContent) {
                return toolResponse({ success: false, error: 'Could not read file or file reference is disabled' });
            }

            const message = question
                ? `${fileContent}\n\nPlease analyze this file and answer: ${question}`
                : `${fileContent}\n\nPlease analyze this file and explain its contents, purpose, and any notable aspects.`;

            const response = await providersById[useProvider].chat(message);

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
            const disabled = checkDisabled(useProvider);
            if (disabled) return disabled;

            const fileContent = readFileContents([filePath]);
            if (!fileContent) {
                return toolResponse({ success: false, error: 'Could not read file or file reference is disabled' });
            }

            const result = await renderAndRunSkill({
                skillName: 'code_review',
                variables: {
                    desc: joinPromptSections(
                        focus ? `Focus area:\n${focus}` : '',
                        fileContent
                    )
                },
                fallbackText: 'Review this code for bugs, improvements, and best practices:\n\n${desc}',
                provider: useProvider,
                preferredProviders: ['claude', 'chatgpt', 'googleai', 'gemini', 'perplexity']
            });
            if (result.errorResponse) return result.errorResponse;

            return toolResponse({
                success: true,
                provider: useProvider,
                filePath,
                review: result.response
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
            return toolResponse({ success: true, message: `${APP_NAME} window is now visible` });
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
            return toolResponse({ success: true, message: `${APP_NAME} window is now hidden (running in background)` });
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
                    ? `Headless mode enabled - ${APP_NAME} runs in background, MCP still works`
                    : `Headless mode disabled - ${APP_NAME} window visible`
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
        provider: z.string().optional().describe('Provider to check. If not specified, checks all enabled providers.')
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
                const p = providersById[provider];
                if (p) {
                    const status = await p.getTypingStatus();
                    return toolResponse({ [provider]: status });
                }
            } else {
                // Check all enabled providers
                for (const providerId of providerIds) {
                    if (enabled.has(providerId)) {
                        results[providerId] = await providersById[providerId].getTypingStatus();
                    }
                }
            }

            return toolResponse(results);
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- Provider inspection tools ---

server.tool(
    'init_provider',
    {
        provider: z.string().describe(`Provider ID or alias to initialize inside ${APP_NAME}`)
    },
    async ({ provider }) => {
        try {
            const { providerId, provider: providerClient } = getProviderInstanceOrThrow(provider);
            const disabled = disabledResponseFor(providerId);
            if (disabled) return disabled;

            await providerClient.init();
            return toolResponse({
                success: true,
                provider: providerId,
                label: formatProviderLabel(providerId),
                message: `${formatProviderLabel(providerId)} initialized`
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'provider_status',
    {
        provider: z.string().describe('Provider ID or alias to inspect')
    },
    async ({ provider }) => {
        try {
            const { providerId, provider: providerClient } = getProviderInstanceOrThrow(provider);
            const disabled = disabledResponseFor(providerId);
            if (disabled) return disabled;

            await providerClient.init();
            const loggedIn = await providerClient.isLoggedIn();
            const typing = await providerClient.getTypingStatus();
            const pageResult = await providerClient.executeScript(`
                (function() {
                    return {
                        url: window.location.href,
                        title: document.title,
                        readyState: document.readyState
                    };
                })()
            `);
            const challengeResult = await providerClient.executeScript(`
                (function() {
                    const hasCloudflareChallenge = !!document.querySelector(
                        'iframe[src*="challenges.cloudflare.com" i], script[src*="challenges.cloudflare.com" i], .cf-turnstile, [name="cf-turnstile-response"], #challenge-form, #challenge-stage, #challenge-running, [data-ray], [class*="challenge-platform" i]'
                    ) || /\\/cdn-cgi\\/challenge-platform|challenges\\.cloudflare\\.com/i.test(window.location.href || '');

                    if (hasCloudflareChallenge) {
                        return { detected: true, kind: 'cloudflare' };
                    }

                    const hasHumanVerification = !!document.querySelector(
                        'iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[src*="recaptcha" i], iframe[src*="arkoselabs" i], [id*="captcha" i], [class*="captcha" i], [data-testid*="captcha" i]'
                    );

                    return {
                        detected: hasHumanVerification,
                        kind: hasHumanVerification ? 'human_verification' : null
                    };
                })()
            `).catch(() => ({ result: { detected: false, kind: null } }));

            return toolResponse({
                success: true,
                provider: providerId,
                label: formatProviderLabel(providerId),
                loggedIn,
                typing,
                page: pageResult.result || pageResult,
                challenge: challengeResult.result || challengeResult
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'debug_provider_dom',
    {
        provider: z.string().describe('Provider ID or alias to inspect')
    },
    async ({ provider }) => {
        try {
            const { providerId, provider: providerClient } = getProviderInstanceOrThrow(provider);
            const disabled = disabledResponseFor(providerId);
            if (disabled) return disabled;

            await providerClient.init();
            const loggedIn = await providerClient.isLoggedIn().catch(() => false);
            const result = await providerClient.debugDOM();

            return toolResponse({
                success: true,
                provider: providerId,
                label: formatProviderLabel(providerId),
                loggedIn,
                debug: result.debugInfo || result
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'execute_provider_script',
    {
        provider: z.string().describe('Provider ID or alias to target'),
        script: z.string().describe('JavaScript expression or IIFE to execute in the provider page context')
    },
    async ({ provider, script }) => {
        try {
            const { providerId, provider: providerClient } = getProviderInstanceOrThrow(provider);
            const disabled = disabledResponseFor(providerId);
            if (disabled) return disabled;

            await providerClient.init();
            const result = await providerClient.executeScript(script);

            return toolResponse({
                success: true,
                provider: providerId,
                label: formatProviderLabel(providerId),
                result: result.result || result
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

server.tool(
    'navigate_provider',
    {
        provider: z.string().describe('Provider ID or alias to target'),
        url: z.string().optional().describe('Optional URL to navigate to. If omitted, opens the provider home/new conversation page.')
    },
    async ({ provider, url }) => {
        try {
            const { providerId, provider: providerClient } = getProviderInstanceOrThrow(provider);
            const disabled = disabledResponseFor(providerId);
            if (disabled) return disabled;

            if (url) {
                await providerClient.navigate(url);
            } else {
                await providerClient.newConversation();
            }

            const pageResult = await providerClient.executeScript(`
                (function() {
                    return {
                        url: window.location.href,
                        title: document.title,
                        readyState: document.readyState
                    };
                })()
            `);

            return toolResponse({
                success: true,
                provider: providerId,
                label: formatProviderLabel(providerId),
                page: pageResult.result || pageResult
            });
        } catch (err) {
            return toolError(err);
        }
    }
);

// --- Resources (MCP compat) ---

function buildSkillsResource(uri) {
    refreshSkillRegistry();
    return {
        contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
                ...getSkillRegistrySummary({ includeTemplate: true })
            }, null, 2)
        }]
    };
}

function buildStatusResource(uri) {
    const enabled = getEnabledProviders();
    return {
        contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({
                server: `${APP_NAME} MCP Server`,
                version: VERSION,
                enabledProviders: Array.from(enabled),
                connected: ipcClient.connected
            }, null, 2)
        }]
    };
}

server.resource('skills', 'brainstorm://skills', async (uri) => buildSkillsResource(uri));
server.resource('skills_legacy', 'proxima://skills', async (uri) => buildSkillsResource(uri));
server.resource('status', 'brainstorm://status', async (uri) => buildStatusResource(uri));
server.resource('status_legacy', 'proxima://status', async (uri) => buildStatusResource(uri));

// --- Start ---

async function main() {
    console.error(`[MCP] ${APP_NAME} MCP Server v${VERSION} starting...`);
    console.error(`[MCP] Connecting to ${APP_NAME} on port`, IPC_PORT);
    refreshSkillRegistry();
    const skillSummary = getSkillRegistrySummary();
    console.error(`[MCP] Loaded ${skillSummary.skills.length} skills from ${skillSummary.directory}`);
    console.error(
        '[MCP] Skills:',
        skillSummary.skills.map((skill) => {
            const variables = skill.variables.length > 0 ? ` [${skill.variables.join(', ')}]` : '';
            return `${skill.name}${variables}`;
        }).join(', ') || '(none)'
    );

    try {
        await ipcClient.connect();
        console.error(`[MCP] Connected to ${APP_NAME} successfully`);
    } catch (e) {
        console.error(`[MCP] Warning: Could not connect to ${APP_NAME}:`, e.message);
        console.error(`[MCP] Make sure ${APP_NAME} is running`);
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP] MCP Server running');
}

main().catch(console.error);

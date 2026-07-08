#!/usr/bin/env node
// Proxima — MCP Server Entrypoint.
// Initializes the MCP server, registers tool categories, and handles BYOK/IPC connections.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { IPCClient, AIProvider } from './ipc-bridge.js';
import {
    getEnabledProviders, isProviderEnabled, buildMessageWithFiles,
    readFileContents, toolResponse, toolError, checkDisabled, getAgentHubPort, getAgentHubToken,
    getByokStorePath,
} from './helpers.js';
import { createSmartChat } from './pipeline.js';

import { SmartRouter as AgenticRouter } from '../agentic/smart-router.js';
import { WorkflowEngine } from '../agentic/workflow-engine.js';
import { RunLoop } from '../agentic/run-loop.js';
import { EnhancedMemory } from '../agentic/enhanced-memory.js';

import { AgenticExecutor } from '../agentic/executor.js';
import { TracingManager } from '../agentic/tracing.js';
import { LifecycleHooks } from '../agentic/lifecycle.js';

import { IntelligentMemory } from '../memory/memory-intelligence.js';
import { AgentStateMachine } from '../agentic/agent-state.js';
import { getContextStats } from '../agentic/context7-middleware.js';

import { MemoryHistoryManager } from '../memory/memory-store.js';
import TokenTracker from '../cost/token-tracker.js';
import { packCodebase, grepContent } from '../utils/codebase-packer.js';
import { generateTreeString } from '../utils/file-tree.js';
import { smartSlice, buildSymbolMap, sliceBySymbols } from '../utils/smart-slicer.js';

import { register as registerChatTools } from './tools-chat.js';
import { register as registerCodeTools } from './tools-code.js';
import { register as registerSearchTools } from './tools-search.js';
import { register as registerContentTools } from './tools-content.js';
import { register as registerUtilityTools } from './tools-utility.js';
import { register as registerWorkflowTools } from './tools-workflow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IPC_PORT = parseInt(process.env.AGENT_HUB_PORT, 10) || getAgentHubPort() || 19222;


const ipcClient = new IPCClient(IPC_PORT, () => getAgentHubToken());
const isEnabled = (name) => isProviderEnabled(name, path.resolve(__dirname, '..'));
const getEnabled = () => getEnabledProviders(path.resolve(__dirname, '..'));

const perplexity = new AIProvider('perplexity', ipcClient, isEnabled);
const chatgpt = new AIProvider('chatgpt', ipcClient, isEnabled);
const claude = new AIProvider('claude', ipcClient, isEnabled);
const gemini = new AIProvider('gemini', ipcClient, isEnabled);

const allProviders = { perplexity, chatgpt, claude, gemini };


(function _initByokProviders() {
    try {
        const byokPath = getByokStorePath();
        if (!fs.existsSync(byokPath)) return;
        const store = JSON.parse(fs.readFileSync(byokPath, 'utf8'));
        if (!store._meta || !store._meta.enabled) return;
        for (const name of Object.keys(store)) {
            if (name === '_meta') continue;
            if (!store[name] || !store[name].key) continue;
            if (allProviders[name]) continue;
            allProviders[name] = new AIProvider(name, ipcClient, isEnabled);
            console.error(`[MCP] BYOK provider registered: ${name}`);
        }
    } catch (e) {
        console.error('[MCP] Failed to init BYOK providers:', e.message);
    }
})();


function getOrCreateProvider(name) {
    if (allProviders[name]) return allProviders[name];
    if (isEnabled(name)) {
        allProviders[name] = new AIProvider(name, ipcClient, isEnabled);
        console.error(`[MCP] Lazy-created provider: ${name}`);
        return allProviders[name];
    }
    return null;
}

const smartRouterV2 = new AgenticRouter();
const workflowEngine = new WorkflowEngine({ smartRouter: smartRouterV2 });
const runLoop = new RunLoop({ smartRouter: smartRouterV2 });
const enhancedMemory = new EnhancedMemory();
console.error('[Agentic v6.0] Core loaded: Router, Workflow, RunLoop, Memory');

const tracingManager = new TracingManager();
const lifecycle = new LifecycleHooks();
console.error('[Agentic v7.0] Pipeline loaded: Tracing, Lifecycle');

const intelligentMemory = new IntelligentMemory({ maxMemories: 500 });
const agentState = new AgentStateMachine();
console.error('[Agentic v8.0] Intelligence loaded: MemoryIntel, StateMachine');

const memoryStore = new MemoryHistoryManager();
const tokenTracker = new TokenTracker();

const smartChat = createSmartChat({
    allProviders, getOrCreateProvider, agentState, lifecycle,
    tracingManager, smartRouterV2, tokenTracker,
    enhancedMemory, memoryStore, intelligentMemory,
});

let agenticExecutor = null;
function initAgenticExecutor() {
    if (agenticExecutor) return agenticExecutor;
    agenticExecutor = new AgenticExecutor({
        chatFn: async (provider, message, files) => {
            const uploadExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip'];
            let uploadFilePath = null;
            const textFiles = [];
            
            if (files && files.length > 0) {
                for (const f of files) {
                    let actualPath = f;
                    const rangeMatch = f.match(/^(.+):(\d+)-(\d+)$/);
                    if (rangeMatch) {
                        actualPath = rangeMatch[1];
                    }
                    const ext = path.extname(actualPath).toLowerCase();
                    if (uploadExtensions.includes(ext)) {
                        if (!uploadFilePath) {
                            uploadFilePath = actualPath;
                        }
                    } else {
                        textFiles.push(f);
                    }
                }
            }

            const fullMessage = buildMessageWithFiles(message, textFiles);
            return await smartChat(fullMessage, provider, { filePath: uploadFilePath });
        },
        getEnabledProviders: getEnabled,
        smartRouter: smartRouterV2,
    });
    console.error('[Agentic v7.0] Executor initialized');
    return agenticExecutor;
}

function pickBestProvider(taskType) {
    const enabled = getEnabled();
    if (enabled.size === 0) return null;

    try {
        const best = smartRouterV2.pickByTaskType(taskType || 'general', enabled);
        if (best && allProviders[best]) {
            return { name: best, instance: allProviders[best] };
        }
    } catch (e) {

        console.error('[SmartRouter] pickByTaskType failed, using static fallback:', e.message);
    }

    const priorities = {
        coding: ['claude', 'chatgpt', 'gemini', 'perplexity'],
        research: ['perplexity', 'gemini', 'chatgpt', 'claude'],
        general: ['claude', 'chatgpt', 'gemini', 'perplexity'],
        review: ['claude', 'chatgpt', 'gemini', 'perplexity'],
    };
    const order = priorities[taskType] || priorities.general;
    for (const name of order) {
        if (enabled.has(name) && (allProviders[name] || getOrCreateProvider(name))) {
            return { name, instance: allProviders[name] };
        }
    }
    for (const name of enabled) {
        const inst = allProviders[name] || getOrCreateProvider(name);
        if (inst) return { name, instance: inst };
    }
    return null;
}

function resolveProvider(providerName, taskType) {
    if (providerName) {
        const name = providerName.toLowerCase();
        const enabled = getEnabled();
        if (!enabled.has(name)) return null;
        const inst = allProviders[name] || getOrCreateProvider(name);
        if (!inst) return null;
        return { name, instance: inst };
    }
    return pickBestProvider(taskType || 'general');
}

async function chatWithProvider(providerName, message) {
    if (providerName === 'auto') {
        return await smartChat(message, pickBestProvider('general'), {});
    }
    const p = resolveProvider(providerName);
    if (!p) throw new Error(`Provider '${providerName}' not available`);
    return await smartChat(message, p, {});
}

const server = new McpServer({
    name: 'agent-hub',
    version: '5.0.0',
    description: 'Proxima MCP Server v5.0 — Modular Architecture',
});

const deps = {
    // Core
    z, ipcClient,
    // Helpers
    toolResponse, toolError, checkDisabled: (name) => checkDisabled(name, path.resolve(__dirname, '..')),
    getEnabledProviders: getEnabled,
    buildMessageWithFiles, readFileContents,
    // Providers
    allProviders,
    // Pipeline
    smartChat, chatWithProvider,
    pickBestProvider, resolveProvider,
    initAgenticExecutor,
    // Agentic modules
    smartRouterV2, workflowEngine, runLoop,
    enhancedMemory, tracingManager, lifecycle,
    intelligentMemory, agentState,
    getContextStats,
    // Infrastructure
    memoryStore, tokenTracker,
    // Codebase Intelligence
    packCodebase, grepContent, generateTreeString,
    smartSlice, buildSymbolMap, sliceBySymbols,
};

registerChatTools(server, deps);
registerCodeTools(server, deps);
registerSearchTools(server, deps);
registerContentTools(server, deps);
registerUtilityTools(server, deps);
registerWorkflowTools(server, deps);

console.error(`[MCP] 40 tools registered across 6 modules`);

server.resource(
    'status', 'proxima://status',
    async (uri) => {
        const enabled = getEnabled();
        return {
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                    server: 'Proxima MCP Server',
                    version: '5.0.0',
                    architecture: 'modular',
                    modules: ['ipc-bridge', 'helpers', 'pipeline', 'tools-chat', 'tools-code', 'tools-search', 'tools-content', 'tools-utility', 'tools-workflow'],
                    enabledProviders: Array.from(enabled),
                    connected: ipcClient.connected,
                }, null, 2),
            }],
        };
    }
);

// The 4 session tool names that map 1:1 to a BYOK provider.
const SESSION_TOOL_MAP = { chatgpt: 'ask_chatgpt', claude: 'ask_claude', gemini: 'ask_gemini', perplexity: 'ask_perplexity' };

server.resource(
    'models', 'proxima://models',
    async (uri) => {
        let byokData = { enabled: false, providers: [] };
        try {
            const raw = await ipcClient.send('getByokStatus');
            if (raw && raw.success) byokData = raw;
        } catch (e) { /* IPC unavailable — assume session mode */ }

        let mode, providers, hint;

        if (byokData.enabled && byokData.providers && byokData.providers.length > 0) {
            mode = 'api';
            providers = byokData.providers.map(p => {
                const sessionTool = SESSION_TOOL_MAP[p.name];
                return {
                    name: p.name,
                    type: 'api',
                    model: p.model,
                    tool: sessionTool
                        ? `${sessionTool}(message) OR ask_model('${p.name}', message)`
                        : `ask_model('${p.name}', message)`,
                };
            });
            hint = 'API mode active. Use ask_model(provider, message) for any listed provider. Existing tools (ask_chatgpt etc.) also work for mapped providers.';
        } else {
            mode = 'session';
            const enabled = getEnabled();
            providers = [...enabled].map(name => ({
                name,
                type: 'session',
                model: `${name} (web session)`,
                tool: SESSION_TOOL_MAP[name] || `ask_model('${name}', message)`,
            }));
            hint = 'Session mode. Use ask_chatgpt, ask_claude, ask_gemini, ask_perplexity for browser-based providers.';
        }

        return {
            contents: [{
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ mode, providers, hint }, null, 2),
            }],
        };
    }
);

let _mcpShuttingDown = false;
function shutdown(code = 0) {
    if (_mcpShuttingDown) return;
    _mcpShuttingDown = true;
    try { ipcClient.disconnect(); } catch (e) { /* best-effort */ }
    // Let any final stderr flush, then exit. Timer is unref'd so it can never
    // keep the event loop alive on its own.
    const t = setTimeout(() => process.exit(code), 50);
    if (t && t.unref) t.unref();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.once(sig, () => shutdown(0)); } catch (e) { /* signal unsupported here */ }
}
// stdin EOF/close == the MCP client closed the pipe → we're orphaned → exit.
try {
    process.stdin.on('end', () => shutdown(0));
    process.stdin.on('close', () => shutdown(0));
} catch (e) { /* ignore */ }

async function main() {
    console.error('[MCP] Proxima MCP Server v5.0.0 (Modular) starting...');
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

    // The SDK closes the transport when stdin ends; chain our shutdown onto its
    // onclose so a clean client disconnect also tears down the IPC socket + exits.
    const _prevOnClose = transport.onclose;
    transport.onclose = () => {
        try { if (typeof _prevOnClose === 'function') _prevOnClose(); } catch (e) { /* ignore */ }
        shutdown(0);
    };

    console.error('[MCP] MCP Server running');
}

main().catch(console.error);

// Proxima — MCP Test Harness.
// Provides a mock McpServer and dependency objects to drive MCP tool handlers deterministically in tests.

import { z } from 'zod';
import { toolResponse, toolError } from '../../src/mcp/helpers.js';

export function makeHarness(overrides = {}) {
    const enabled = new Set(overrides.enabled || ['chatgpt', 'claude', 'gemini', 'perplexity']);
    const smartChatCalls = [];
    const ipcCalls = [];
    const tools = new Map();

    const server = {
        registerTool(name, meta, handler) { tools.set(name, { meta, handler }); },
        resource() {},
    };

    const allProviders = {};
    for (const n of enabled) {
        allProviders[n] = {
            name: n,
            cache: new Map([['stale', { response: 'x', time: 0 }]]),
            newConversation: async () => { ipcCalls.push(['newConversation', n]); },
        };
    }

    const smartChat = overrides.smartChat || (async (msg, provider, opts) => {
        const providerName = typeof provider === 'string' ? provider : (provider && provider.name);
        smartChatCalls.push({ msg, provider: providerName, opts });
        return `reply:${providerName}`;
    });

    const deps = {
        z,
        toolResponse,
        toolError,
        checkDisabled: (name) => (enabled.has(name) ? null : toolResponse(`${name} is disabled. Enable it in Agent Hub.`)),
        getEnabledProviders: () => new Set(enabled),
        isProviderEnabled: (name) => enabled.has(name),
        smartChat,

        buildMessageWithFiles: (message) => message,
        readFileContents: () => '',
        resolveProvider: (pn) => {
            if (pn) { const n = String(pn).toLowerCase(); return enabled.has(n) ? { name: n } : null; }
            const first = [...enabled][0];
            return first ? { name: first } : null;
        },
        pickBestProvider: () => { const first = [...enabled][0]; return first ? { name: first } : null; },
        allProviders,
        initAgenticExecutor: overrides.initAgenticExecutor || (() => ({
            execute: async () => ({
                response: 'executor answer',
                primaryProvider: 'claude',
                providersUsed: ['claude'],
                plan: { strategy: 'direct' },
                evaluation: { score: 9 },
                duration: 1200,
            }),
        })),
        ipcClient: {
            send: async (action, name, data) => {
                ipcCalls.push([action, name, data]);
                return overrides.ipcReply ? overrides.ipcReply(action, name, data) : { success: true, visible: true };
            },
        },

        packCodebase: overrides.packCodebase,
        grepContent: overrides.grepContent,
        generateTreeString: overrides.generateTreeString,
        smartSlice: overrides.smartSlice,
        buildSymbolMap: overrides.buildSymbolMap,
        sliceBySymbols: overrides.sliceBySymbols,
        ...overrides.deps,
    };

    return { server, tools, deps, smartChatCalls, ipcCalls, enabled };
}


export function registerModule(registerFn, overrides = {}) {
    const h = makeHarness(overrides);
    registerFn(h.server, h.deps);
    return h;
}


export function textOf(result) {
    return result && result.content && result.content[0] ? result.content[0].text : '';
}

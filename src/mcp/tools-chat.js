// Proxima — MCP Chat Tools.
// Registers the chat, model routing, smart queries, and reset conversation tools.

import path from 'path';

export function register(server, deps) {
    const {
        z, toolResponse, toolError, checkDisabled,
        smartChat, buildMessageWithFiles, getEnabledProviders,
        allProviders, initAgenticExecutor,
    } = deps;


    const CHAT = Object.freeze({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    });

    const FILES_DESC = 'Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50". For large files, always specify relevant line ranges only.';

    const getFilesSetup = (files) => {
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
        return { textFiles, uploadFilePath };
    };

    server.registerTool('ask_chatgpt', {
        title: 'Ask ChatGPT',
        description: 'Send a message to ChatGPT specifically. Use ask_model for any other/BYOK provider, smart_query to auto-pick the best provider, or ask_all_ais to query several at once.',
        inputSchema: {
            message: z.string().describe('Message to send to ChatGPT'),
            files: z.array(z.string()).optional().describe(FILES_DESC),
        },
        annotations: CHAT,
    }, async ({ message, files }) => {
        const disabled = checkDisabled('chatgpt');
        if (disabled) return disabled;
        try {
            const { textFiles, uploadFilePath } = getFilesSetup(files);
            const fullMessage = buildMessageWithFiles(message, textFiles);
            return toolResponse(await smartChat(fullMessage, 'chatgpt', { filePath: uploadFilePath }));
        } catch (err) {
            return toolError(err);
        }
    });

    server.registerTool('ask_claude', {
        title: 'Ask Claude',
        description: 'Send a message to Claude specifically (strong at coding/reasoning). Use ask_model for other/BYOK providers, smart_query to auto-pick, or ask_all_ais for several at once.',
        inputSchema: {
            message: z.string().describe('Message to send to Claude'),
            files: z.array(z.string()).optional().describe(FILES_DESC),
        },
        annotations: CHAT,
    }, async ({ message, files }) => {
        const disabled = checkDisabled('claude');
        if (disabled) return disabled;
        try {
            const { textFiles, uploadFilePath } = getFilesSetup(files);
            const fullMessage = buildMessageWithFiles(message, textFiles);
            return toolResponse(await smartChat(fullMessage, 'claude', { filePath: uploadFilePath }));
        } catch (err) {
            return toolError(err);
        }
    });

    server.registerTool('ask_gemini', {
        title: 'Ask Gemini',
        description: 'Send a message to Gemini specifically. Use ask_model for other/BYOK providers, smart_query to auto-pick, or ask_all_ais for several at once.',
        inputSchema: {
            message: z.string().describe('Message to send to Gemini'),
            files: z.array(z.string()).optional().describe(FILES_DESC),
        },
        annotations: CHAT,
    }, async ({ message, files }) => {
        const disabled = checkDisabled('gemini');
        if (disabled) return disabled;
        try {
            const { textFiles, uploadFilePath } = getFilesSetup(files);
            const fullMessage = buildMessageWithFiles(message, textFiles);
            return toolResponse(await smartChat(fullMessage, 'gemini', { filePath: uploadFilePath }));
        } catch (err) {
            return toolError(err);
        }
    });

    server.registerTool('ask_perplexity', {
        title: 'Ask Perplexity',
        description: 'Send a message to Perplexity specifically (best for web search + citations). Use ask_model for other/BYOK providers, or deep_search for structured research.',
        inputSchema: {
            message: z.string().describe('Message to send to Perplexity (best for web search + citations)'),
            files: z.array(z.string()).optional().describe(FILES_DESC),
        },
        annotations: CHAT,
    }, async ({ message, files }) => {
        const disabled = checkDisabled('perplexity');
        if (disabled) return disabled;
        try {
            const { textFiles, uploadFilePath } = getFilesSetup(files);
            const fullMessage = buildMessageWithFiles(message, textFiles);
            return toolResponse(await smartChat(fullMessage, 'perplexity', { filePath: uploadFilePath }));
        } catch (err) {
            return toolError(err);
        }
    });

    const enabledList = [...getEnabledProviders()].join(', ') || 'gemini, chatgpt, claude, perplexity';
    server.registerTool('ask_model', {
        title: 'Ask Any Model',
        description: 'Universal chat: send a message to ANY enabled provider by name (the 4 session providers OR any configured BYOK provider). Use this when you need a provider other than the four dedicated ask_* tools.',
        inputSchema: {
            provider: z.string().describe(`Provider name. Currently available: ${enabledList}`),
            message: z.string().describe('Message to send'),
            model: z.string().optional().describe('Specific model ID override (uses provider default if omitted)'),
            files: z.array(z.string()).optional().describe('Optional: file paths to include as context. Supports line ranges like "path/file.js:10-50".'),
        },
        annotations: CHAT,
    }, async ({ provider, message, model, files }) => {
        const providerName = provider.toLowerCase().trim();
        const disabled = checkDisabled(providerName);
        if (disabled) return disabled;
        try {
            const { textFiles, uploadFilePath } = getFilesSetup(files);
            const fullMessage = buildMessageWithFiles(message, textFiles);

            return toolResponse(await smartChat(fullMessage, providerName, {
                filePath: uploadFilePath,
                engine: model || null,
            }));
        } catch (err) {
            return toolError(err);
        }
    });

    server.registerTool('ask_all_ais', {
        title: 'Ask All AIs',
        description: 'Send the SAME message to multiple providers in parallel and get every answer side by side. Use for breadth/comparison; for a single best answer use smart_query.',
        inputSchema: {
            message: z.string().describe('Message to send to multiple AI providers'),
            providers: z.array(z.string()).optional().describe('Which providers to use (default: all enabled). e.g. ["chatgpt", "nvidia"]'),
            files: z.array(z.string()).optional().describe('Optional: file paths to include as context'),
        },
        annotations: CHAT,
    }, async ({ message, providers: requestedProviders, files }) => {
        try {
            const enabled = getEnabledProviders();
            const fullMessage = buildMessageWithFiles(message, files);
            const tasks = [];
            const names = [];


            const useProviders = requestedProviders
                ? [...new Set(requestedProviders.map(p => String(p).toLowerCase().trim()))].filter(p => enabled.has(p))
                : [...enabled];

            console.error(`[ask_all_ais] Sending to ${useProviders.length} providers: ${useProviders.join(', ')}`);

            if (useProviders.length === 0) {
                return toolError(new Error('No enabled providers found. Check API mode settings.'));
            }

            const STAGGER_MS = 1500;
            const staggerDelay = (ms) => new Promise(r => setTimeout(r, ms));


            useProviders.forEach((name, idx) => {
                const delay = idx * STAGGER_MS;
                names.push(name);
                tasks.push((async () => {
                    if (delay > 0) await staggerDelay(delay);
                    try { return await smartChat(fullMessage, name); }
                    catch (e) { return { error: e.message }; }
                })());
            });

            const results = await Promise.all(tasks);

            const sections = [];
            names.forEach((name, i) => {
                const response = results[i];
                const label = name.charAt(0).toUpperCase() + name.slice(1);
                if (response && response.error) {
                    sections.push(`### ${label}\n**Error:** ${response.error}`);
                } else {
                    const text = typeof response === 'string' ? response : (response?.response || response?.text || JSON.stringify(response));
                    sections.push(`### ${label}\n${text}`);
                }
            });

            const formattedOutput = `**${names.length} Provider${names.length > 1 ? 's' : ''} Responded**\n\n` + sections.join('\n\n---\n\n');
            return toolResponse(formattedOutput);
        } catch (err) {
            return toolError(err);
        }
    });

    server.registerTool('smart_query', {
        title: 'Smart Query (auto-route)',
        description: 'Best general entry point: auto-routes to the best provider and can verify/cross-check. Modes: auto (fast single AI), verify (primary + cross-model check), consensus (all vote), collaborate (role-based teamwork).',
        inputSchema: {
            message: z.string().describe('Message to send - auto-routes to best provider'),
            preferredProvider: z.string().optional().describe('Preferred provider (optional - auto-selects if not set)'),
            files: z.array(z.string()).optional().describe('Optional: Array of file paths to include as context'),
            mode: z.enum(['auto', 'verify', 'consensus', 'collaborate']).optional().describe('Execution mode: auto (default, fast single AI), verify (primary + verifier), consensus (all AIs vote), collaborate (role-based teamwork)'),
        },
        annotations: CHAT,
    }, async ({ message, preferredProvider, files, mode }) => {
        try {
            const executor = initAgenticExecutor();
            const options = {
                files, preferredProvider,
                forceConsensus: mode === 'consensus',
                forceCollaborate: mode === 'collaborate',
                forceVerify: mode === 'verify',
            };

            const result = await executor.execute(message, options);
            if (result.error) return toolError(new Error(result.error));

            const providers = (result.providersUsed || [result.primaryProvider]).join(', ');
            const score = result.evaluation ? `${result.evaluation.score}/10` : 'N/A';
            const strategy = result.plan?.strategy || 'direct';
            const durationSec = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : 'N/A';

            const output = `${result.response}\n\n---\n[Proxima v7.0] strategy: ${strategy} | providers: ${providers} | quality: ${score} | time: ${durationSec}`;
            return toolResponse(output);
        } catch (err) {
            return toolError(err);
        }
    });

    server.registerTool('new_conversation', {
        title: 'New Conversation (reset)',
        description: 'Reset conversation memory/context for a provider (or all enabled providers if none named). Use when you want a fresh thread with no prior context.',
        inputSchema: {
            provider: z.string().optional().describe('Which provider to reset: chatgpt, claude, gemini, or perplexity. If omitted, resets all enabled providers.'),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }),
    }, async ({ provider }) => {
        try {
            const enabled = getEnabledProviders();
            if (provider) {
                const name = provider.toLowerCase();
                if (!enabled.has(name) || !allProviders[name]) {
                    return toolResponse({ success: false, message: `Provider '${provider}' is not enabled.` });
                }
                await allProviders[name].newConversation();
                return toolResponse({ success: true, provider: name, message: `Started new ${name} conversation` });
            }
            const reset = [];
            for (const p of ['perplexity', 'chatgpt', 'claude', 'gemini']) {
                if (enabled.has(p)) {
                    await allProviders[p].newConversation();
                    reset.push(p);
                }
            }
            return toolResponse({ success: true, reset, message: `Started new conversations for: ${reset.join(', ') || 'none'}` });
        } catch (err) {
            return toolError(err);
        }
    });
}

// Proxima — MCP Utility Tools.
// Registers utility tools: clearing cache, file/codebase analysis, code review on file, and Agent Hub window visibility control.

import fs from 'fs';
import path from 'path';

export function register(server, deps) {
    const {
        z, toolResponse, toolError,
        smartChat, readFileContents, resolveProvider,
        getEnabledProviders, allProviders, ipcClient,
        packCodebase, grepContent, generateTreeString,
        smartSlice, buildSymbolMap, sliceBySymbols,
    } = deps;



    server.registerTool('clear_cache', {
        title: 'Clear Response Cache',
        description: 'Clear the in-memory provider response cache so the next identical question is re-asked fresh instead of returning a cached answer.',
        inputSchema: {},
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async () => {
        try {
            for (const p of Object.values(allProviders)) { p.cache.clear(); }
            return toolResponse({ success: true, message: 'Cache cleared' });
        } catch (err) { return toolError(err); }
    });

    server.registerTool('analyze_file', {
        title: 'Analyze File / Codebase',
        description: 'Analyze a file OR a whole directory (auto codebase-packing, smart-slicing, symbol extraction, grep, secret scan). Best for large files/folders; for a quick snippet use explain_code/review_code.',
        inputSchema: {
            filePath: z.string().describe('Absolute path to the file or directory to analyze'),
            question: z.string().optional().describe('Specific question about the file/codebase'),
            provider: z.string().optional().describe('Which AI to use (chatgpt, claude, gemini, perplexity, or any configured BYOK provider). Default: claude'),
            grep: z.string().optional().describe('Optional regex pattern to search within the file/codebase before analysis'),
            symbols: z.string().optional().describe('Comma-separated function/class names to extract from file. E.g. "smartChat,toolResponse,guardrails". Auto-resolves dependencies.'),
        },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ filePath, question, provider: pn, grep, symbols: symbolsParam }) => {
        try {
            const p = resolveProvider(pn || 'claude', 'coding');
            if (!p) return toolResponse(`Provider '${pn || 'claude'}' is not available. Enable it in Agent Hub.`);

            const ext = path.extname(filePath).toLowerCase();
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
            if (imageExtensions.includes(ext)) {
                return toolResponse('Image analysis is not available yet. This tool currently supports text/code files only.');
            }

            if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
                const packResult = packCodebase(filePath, { maxFiles: 100, maxFileSizeKB: 256, maxTotalSizeMB: 3 });
                if (!packResult.success) return toolResponse(`❌ Codebase pack failed: ${packResult.error}`);

                let grepResults = null;
                if (grep) grepResults = grepContent(packResult.packed, { pattern: grep, contextLines: 2 });

                let message = packResult.packed;
                if (grepResults && grepResults.totalMatches > 0) {
                    message += `\n\n## 🔍 Grep Results (pattern: ${grep})\nFound ${grepResults.totalMatches} matches:\n${grepResults.formattedOutput.join('\n')}`;
                }
                message += question
                    ? `\n\nPlease analyze this codebase and answer: ${question}`
                    : `\n\nPlease analyze this codebase. Explain the architecture, key components, patterns used, and any notable aspects.`;
                if (packResult.metrics.totalTokens > 50000) {
                    message = `[Note: This codebase is large (~${packResult.metrics.totalTokens.toLocaleString()} tokens). Focus on the most important aspects.]\n\n` + message;
                }

                const response = await smartChat(message, p);
                const m = packResult.metrics;
                const header = [
                    `📦 **Codebase Pack** — ${path.basename(filePath)} | ${m.totalFiles} files | ${m.totalLines.toLocaleString()} lines | ~${m.totalTokens.toLocaleString()} tokens | ${m.packDurationMs}ms`,
                    `🤖 **Provider**: ${p.name} | **Mode**: codebase-pack`,
                ];
                if (packResult.secretWarnings.length > 0) {
                    header.push(`⚠️ **Security**: ${packResult.secretWarnings.map(w => `${w.file} (${w.types.join(', ')})`).join('; ')}`);
                }
                if (grep && grepResults) header.push(`🔍 **Grep**: "${grep}" — ${grepResults.totalMatches} matches found`);
                return toolResponse(header.join('\n') + '\n\n---\n\n' + response);
            }

            const rawContent = fs.readFileSync(filePath, 'utf8');
            if (!rawContent) return toolResponse('Could not read file or file is empty');
            const lineCount = rawContent.split('\n').length;

            let codeContext, sliceInfo = '';
            if (symbolsParam) {
                const symNames = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);
                const symResult = sliceBySymbols(rawContent, filePath, symNames, { resolveDeps: true });
                codeContext = symResult.sliced;
                sliceInfo = `\n✂️ **Symbol Select**: ${symResult.totalLines} total → ${symResult.sentLines} sent (${symResult.savings} saved) | Found: ${symResult.found.join(', ')}`;
                if (symResult.notFound.length > 0) sliceInfo += ` | ⚠️ Not found: ${symResult.notFound.join(', ')}`;
            } else if (lineCount > 500 && question) {
                const sliceResult = smartSlice(rawContent, filePath, question, { maxLines: 400 });
                codeContext = sliceResult.sliced;
                sliceInfo = `\n✂️ **Smart Slice**: ${sliceResult.totalLines} total → ${sliceResult.sentLines} sent (${sliceResult.savings} saved) | Mode: ${sliceResult.mode}`;
                if (sliceResult.selectedSymbols?.length > 0) sliceInfo += ` | Symbols: ${sliceResult.selectedSymbols.map(s => s.name).join(', ')}`;
            } else if (lineCount > 500) {
                const symbolMap = buildSymbolMap(rawContent, filePath);
                const lines = rawContent.split('\n');
                codeContext = `${symbolMap}\n\n// ── First 100 lines ──\n${lines.slice(0, 100).join('\n')}\n\n// ... [${lineCount - 150} lines omitted] ...\n\n// ── Last 50 lines ──\n${lines.slice(-50).join('\n')}`;
                sliceInfo = `\n✂️ **Symbol Map Mode**: ${lineCount} lines → overview + head/tail (~150 lines sent)`;
            } else {
                codeContext = rawContent;
            }

            let grepInfo = '';
            if (grep) {
                const grepResults = grepContent(rawContent, { pattern: grep, contextLines: 2 });
                if (grepResults.totalMatches > 0) grepInfo = `\n\n## Grep Results (pattern: ${grep})\nFound ${grepResults.totalMatches} matches:\n${grepResults.formattedOutput.join('\n')}`;
            }

            const message = question
                ? `File: ${path.basename(filePath)} (${lineCount} lines)\n\n${codeContext}${grepInfo}\n\nPlease analyze this code and answer: ${question}`
                : `File: ${path.basename(filePath)} (${lineCount} lines)\n\n${codeContext}${grepInfo}\n\nPlease analyze this file and explain its contents, purpose, and any notable aspects.`;

            const response = await smartChat(message, p);
            const header = `📄 **${path.basename(filePath)}** (${lineCount} lines) | 🤖 ${p.name}${sliceInfo}`;
            return toolResponse(header + '\n\n---\n\n' + response);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('review_code_file', {
        title: 'Review Code File',
        description: 'Review a single code file on disk for issues and improvements (optionally focused on bugs/performance/security/style). For a whole folder use analyze_file; for a pasted snippet use review_code.',
        inputSchema: {
            filePath: z.string().describe('Absolute path to the code file to review'),
            focus: z.string().optional().describe('What to focus on (bugs, performance, security, style)'),
            provider: z.string().optional().describe('Which AI to use (chatgpt, claude, gemini, perplexity, or any configured BYOK provider). Default: claude'),
        },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ filePath, focus, provider: pn }) => {
        try {
            const p = resolveProvider(pn || 'claude', 'coding');
            if (!p) return toolResponse(`Provider '${pn || 'claude'}' is not available.`);
            const fileContent = readFileContents([filePath]);
            if (!fileContent) return toolResponse('Could not read file or file reference is disabled');
            const focusText = focus ? ` Focus on: ${focus}.` : '';
            const message = `${fileContent}\n\nPlease review this code file.${focusText} Identify issues, suggest improvements, and follow best practices.`;
            const response = await smartChat(message, p);
            const header = `📝 **Code Review** — ${path.basename(filePath)} | 🤖 ${p.name}${focus ? ` | 🎯 Focus: ${focus}` : ''}`;
            return toolResponse(header + '\n\n---\n\n' + response);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('show_window', {
        title: 'Show Agent Hub Window',
        description: 'Make the Proxima Agent Hub window visible (no effect on chat).',
        inputSchema: {},
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async () => {
        try { await ipcClient.send('showWindow'); return toolResponse({ success: true, message: 'Agent Hub window is now visible' }); }
        catch (err) { return toolError(err); }
    });

    server.registerTool('hide_window', {
        title: 'Hide Agent Hub Window',
        description: 'Hide the Proxima Agent Hub window (keeps running in the background; MCP still works).',
        inputSchema: {},
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async () => {
        try { await ipcClient.send('hideWindow'); return toolResponse({ success: true, message: 'Agent Hub window is now hidden (running in background)' }); }
        catch (err) { return toolError(err); }
    });

    server.registerTool('toggle_window', {
        title: 'Toggle Agent Hub Window',
        description: 'Toggle the Proxima Agent Hub window between visible and hidden.',
        inputSchema: {},
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }),
    }, async () => {
        try { const result = await ipcClient.send('toggleWindow'); return toolResponse({ success: true, visible: result.visible, message: result.visible ? 'Window shown' : 'Window hidden' }); }
        catch (err) { return toolError(err); }
    });

    server.registerTool('set_headless_mode', {
        title: 'Set Headless Mode',
        description: 'Enable/disable headless mode (Agent Hub runs in the background without a visible window; MCP keeps working).',
        inputSchema: {
            enabled: z.boolean().describe('Enable (true) or disable (false) headless mode'),
        },
        annotations: Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async ({ enabled }) => {
        try {
            await ipcClient.send('setHeadlessMode', null, { enabled });
            return toolResponse({ success: true, headlessMode: enabled, message: enabled ? 'Headless mode enabled - Agent Hub runs in background, MCP still works' : 'Headless mode disabled - Agent Hub window visible' });
        } catch (err) { return toolError(err); }
    });
}

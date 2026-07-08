// Proxima — MCP Content Tools.
// Registers general text utilities: content generation, side-by-side comparisons, debates, and claim verification.

export function register(server, deps) {
    const {
        z, toolResponse, toolError,
        smartChat, resolveProvider, pickBestProvider,
        getEnabledProviders,
    } = deps;


    const GEN = Object.freeze({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    });

    server.registerTool('content', {
        title: 'Content (write / summarize / analyze)',
        description: 'General text/content tool: summarize, write, brainstorm, howto, analyze, extract, or improve. For code use the code tools; for research with sources use deep_search.',
        inputSchema: {
            action: z.enum(['summarize', 'write', 'brainstorm', 'howto', 'analyze', 'extract', 'improve']).describe('Action: summarize (URL/text), write (article), brainstorm (ideas), howto (step-by-step guide), analyze (document/URL), extract (data from text), improve (writing help)'),
            input: z.string().describe('Main input — URL, topic, text, or task description'),
            detail: z.string().optional().describe('Extra context — focus area, writing style, data type to extract, specific question'),
            body: z.string().optional().describe('Content body — text to improve, or content to analyze/extract from'),
            provider: z.string().optional().describe('AI provider: chatgpt, claude, gemini, perplexity, or any configured BYOK provider. Default: auto-select'),
        },
        annotations: GEN,
    }, async ({ action, input, detail, body, provider: pn }) => {
        const p = resolveProvider(pn, action === 'improve' ? 'general' : 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const prompts = {
                summarize: `Summarize this: ${input}${detail ? `. Focus on: ${detail}` : ''}`,
                write: `Write a comprehensive article about: ${input}${detail ? ` in ${detail} style` : ''}`,
                brainstorm: `Brainstorm creative ideas for: ${input}`,
                howto: `Step-by-step guide: How to ${input}`,
                analyze: `Analyze this document: ${input}${detail ? `. Answer: ${detail}` : ''}`,
                extract: `Extract ${detail || 'key data'} from: ${body || input}`,
                improve: `${input}${body ? `\n\nContent:\n${body}` : ''}`,
            };
            return toolResponse(await smartChat(prompts[action] || input, p));
        } catch (err) { return toolError(err); }
    });

    server.registerTool('compare', {
        title: 'Compare Two Things',
        description: 'Compare two items/options/technologies side by side, optionally for a given context.',
        inputSchema: {
            item1: z.string().describe('First item to compare'),
            item2: z.string().describe('Second item to compare'),
            context: z.string().optional().describe('Context for comparison'),
            provider: z.string().optional().describe('AI provider: chatgpt, claude, gemini, perplexity, or any configured BYOK provider. Default: auto-select'),
        },
        annotations: GEN,
    }, async ({ item1, item2, context, provider: pn }) => {
        const p = resolveProvider(pn, 'research');
        if (!p) return toolResponse('No providers available. Enable at least one provider.');
        try {
            const ctx = context ? ` for ${context}` : '';
            return toolResponse(await smartChat(`Compare ${item1} vs ${item2}${ctx}`, p));
        } catch (err) { return toolError(err); }
    });

    server.registerTool('debate', {
        title: 'Multi-AI Debate',
        description: 'Have multiple providers argue DIFFERENT stances on a topic (one stance each), then conclude. Needs 2+ enabled providers for true multi-AI; otherwise one AI covers all sides.',
        inputSchema: {
            topic: z.string().describe('Topic or question to debate'),
            sides: z.number().optional().describe('Number of perspectives to gather (default: 2)'),
        },
        annotations: GEN,
    }, async ({ topic, sides }) => {
        try {
            const enabled = getEnabledProviders();
            const numSides = Math.min(sides || 2, enabled.size);

            if (enabled.size < 2) {
                const p = pickBestProvider('general');
                if (!p) return toolResponse('No providers enabled');
                const response = await smartChat(
                    `Debate this topic from ${numSides} different perspectives. For each perspective, present strong arguments with evidence.\n\nTopic: ${topic}\n\nFormat each perspective as:\n## Perspective [N]: [Position]\n- Key arguments\n- Supporting evidence\n\nThen provide a balanced conclusion.`,
                    p
                );
                return toolResponse(response);
            }


            const providerNames = [...enabled].slice(0, numSides);
            const stances = ['FOR / supportive', 'AGAINST / critical', 'NEUTRAL / analytical', 'ALTERNATIVE / unconventional'];
            const results = {};

            const promises = providerNames.map(async (name, i) => {
                try {
                    const stance = stances[i] || `Perspective ${i + 1}`;
                    const response = await smartChat(
                        `You are debating the following topic. Your assigned position is: ${stance}.\n\nTopic: ${topic}\n\nPresent your strongest arguments for this position. Be persuasive and use evidence. Do NOT present the other side.`,
                        name
                    );
                    results[name] = { stance, response };
                } catch (e) {
                    results[name] = { stance: stances[i], error: e.message };
                }
            });

            await Promise.all(promises);
            return toolResponse(results);
        } catch (err) { return toolError(err); }
    });

    server.registerTool('verify', {
        title: 'Verify Claim (cross-AI)',
        description: 'Ask one or more providers to answer a question/claim with a confidence rating and caveats. Use to fact-check or cross-check an answer across providers.',
        inputSchema: {
            question: z.string().describe('Question or claim to verify'),
            providers: z.array(z.string()).optional().describe('Optional: specific providers to use for verification'),
        },
        annotations: GEN,
    }, async ({ question, providers: requestedProviders }) => {
        try {
            const enabled = getEnabledProviders();

            let targetProviders = requestedProviders
                ? [...new Set(requestedProviders.map(p => String(p).toLowerCase().trim()))].filter(p => enabled.has(p))
                : [...enabled];

            if (targetProviders.length === 0) return toolResponse('No providers enabled');

            const prompt = `Answer this question thoroughly. At the end, rate your confidence (0-100%) and list any counter-arguments or caveats:\n\n${question}\n\nFormat:\nANSWER: [your detailed answer]\nCONFIDENCE: [0-100%]\nCAVEATS: [any counter-arguments, edge cases, or uncertainties]`;

            if (targetProviders.length === 1) {
                const response = await smartChat(prompt, targetProviders[0]);
                return toolResponse(`=== ${targetProviders[0].toUpperCase()} ===\n${response}`);
            }

            const results = {};
            for (const name of targetProviders) {

                try { results[name] = await smartChat(prompt, name); }
                catch (e) { results[name] = `Error: ${e.message}`; }
            }

            let output = '';
            for (const [name, resp] of Object.entries(results)) {
                output += `\n=== ${name.toUpperCase()} ===\n${resp}\n`;
            }
            return toolResponse(output.trim());
        } catch (err) { return toolError(err); }
    });
}

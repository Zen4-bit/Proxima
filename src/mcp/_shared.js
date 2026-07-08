// Proxima — Shared MCP Prompt Runner.
// Wraps the resolve-provider, build-prompt, and smartChat sequence for MCP tools.


export function createPromptRunner({ resolveProvider, smartChat, toolResponse, toolError }) {
    if (!resolveProvider || !smartChat || !toolResponse || !toolError) {
        throw new Error('createPromptRunner: missing required dependency');
    }
    return async function runPrompt(pn, taskType, build) {
        try {
            const provider = resolveProvider(pn, taskType);
            if (!provider) return toolResponse('No providers enabled');

            const built = build(provider);


            if (built && typeof built === 'object' && typeof built.direct === 'string') {
                return toolResponse(built.direct);
            }

            return toolResponse(await smartChat(built, provider));
        } catch (err) {
            return toolError(err);
        }
    };
}

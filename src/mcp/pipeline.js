// Proxima — MCP Pipeline Middleware.
// Orchestrates request isolation, provider routing, context injection, error retries, and telemetry.

import TokenTracker from '../cost/token-tracker.js';
import { SPAN_TYPE } from '../agentic/tracing.js';
import { LIFECYCLE_EVENTS } from '../agentic/lifecycle.js';
import { AGENT_STATE } from '../agentic/agent-state.js';
import { withRetry } from '../retry/retry-engine.js';
import { contextMiddleware, recordContextUse } from '../agentic/context7-middleware.js';

export function createSmartChat(deps) {
    const {
        allProviders, getOrCreateProvider, agentState, lifecycle,
        tracingManager, smartRouterV2, tokenTracker,
        enhancedMemory, memoryStore, intelligentMemory,
    } = deps;

    return async function smartChat(message, providerOrName, options = {}) {
        let providerInstance, providerName;
        // Engine / sub-model override.
        let engineOverride = options.engine || null;
        if (typeof providerOrName === 'string') {
            providerName = providerOrName.toLowerCase();
            let baseName = providerName;
            if (providerName.indexOf(':') !== -1) {
                const _parts = providerName.split(':');
                baseName = _parts[0];
                if (!engineOverride && _parts[1]) engineOverride = _parts[1];
            }
            providerInstance = allProviders[baseName]
                || (getOrCreateProvider && getOrCreateProvider(baseName));
        } else if (providerOrName && providerOrName.instance) {
            providerName = providerOrName.name;
            providerInstance = providerOrName.instance;
        } else {
            providerInstance = providerOrName;
            providerName = providerInstance?.name || 'unknown';
        }

        if (!providerInstance) {
            throw new Error(`Provider not found: ${providerOrName}`);
        }

        // Isolate concurrent runs.
        const run = agentState.beginRun({ provider: providerName });

        lifecycle.fire(LIFECYCLE_EVENTS.AGENT_START, {
            provider: providerName,
            messageLength: message.length,
        });

        let processedMessage = message;
        try {
            const ctxResult = await contextMiddleware(message, { enabled: true });
            if (!ctxResult.skipped && ctxResult.injected.length > 0) {
                processedMessage = ctxResult.enhancedMessage;
                recordContextUse(ctxResult.injected);
            }
        } catch (e) { }

        run.setState(AGENT_STATE.ROUTING, { provider: providerName });
        const inputTokenEstimate = TokenTracker.estimateTokens(processedMessage);
        const span = tracingManager.startSpan({
            type: SPAN_TYPE.CHAT,
            name: `chat:${providerName}`,
            metadata: {
                provider: providerName,
                inputTokens: inputTokenEstimate,
                messageLength: processedMessage.length,
            },
        });
        run.setState(AGENT_STATE.ACTING, { provider: providerName });

        let response;
        try {
            response = await withRetry(
                () => providerInstance.chat(processedMessage, true, options.filePath, engineOverride),
                { maxRetries: 2, baseDelay: 1, label: providerName }
            );
            smartRouterV2.recordSuccess(providerName, Date.now() - span.startedAt);
        } catch (err) {
            tracingManager.errorSpan(span, err);
            lifecycle.fire(LIFECYCLE_EVENTS.AGENT_ERROR, { provider: providerName, error: err.message });
            smartRouterV2.recordError(providerName, err);
            run.end(AGENT_STATE.ERROR, { error: err.message });
            tokenTracker.logUsage({
                model: providerName, provider: providerName,
                promptTokens: inputTokenEstimate, completionTokens: 0,
            });
            throw err;
        }


        try {
            run.setState(AGENT_STATE.EVALUATING);
            const outputTokenEstimate = TokenTracker.estimateTokens(response);
            tracingManager.endSpan(span, {
                outputTokens: outputTokenEstimate,
                responseLength: response?.length || 0,
            });

            tokenTracker.logUsage({
                model: providerName, provider: providerName,
                promptTokens: inputTokenEstimate, completionTokens: outputTokenEstimate,
            });

            try {

                const sessionId = options.sessionId || `provider:${providerName}`;
                enhancedMemory.addToSession(sessionId, 'user', message, providerName);
                enhancedMemory.addToSession(sessionId, 'assistant', response, providerName);
                lifecycle.fire(LIFECYCLE_EVENTS.MEMORY_SAVE, { sessionId, provider: providerName });
                await memoryStore.addHistory(
                    `req-${Date.now()}`, null,
                    `[${providerName}] Q: ${message.substring(0, 100)}... | A: ${response.substring(0, 100)}...`,
                    'ADD'
                );

                intelligentMemory.add(message, { type: 'conversation', provider: providerName });
                intelligentMemory.add(response, { type: 'conversation', provider: providerName });

                if (intelligentMemory.stats.totalAdded % 5 === 0) {
                    intelligentMemory.harvest([
                        { role: 'user', content: message },
                        { role: 'assistant', content: response },
                    ]);
                }
            } catch (e) { }

            run.end(AGENT_STATE.DONE, {
                provider: providerName, duration: span.duration,
                inputTokens: inputTokenEstimate, outputTokens: outputTokenEstimate,
            });
            lifecycle.fire(LIFECYCLE_EVENTS.AGENT_END, {
                provider: providerName, duration: span.duration,
                inputTokens: inputTokenEstimate, outputTokens: outputTokenEstimate,
            });
        } catch (postErr) {

            run.end(AGENT_STATE.ERROR, { error: postErr.message });
            throw postErr;
        }

        return response;
    };
}

// Proxima — MCP Workflow Tools.
// Registers orchestration and agentic tools: run_workflow, run_loop, crew, cost reports, and status diagnostics.

export function register(server, deps) {
    const {
        z, toolResponse, toolError,
        smartChat, getEnabledProviders, chatWithProvider,
        workflowEngine, runLoop, tokenTracker, memoryStore,
        smartRouterV2, enhancedMemory,
        intelligentMemory, agentState,
        tracingManager, lifecycle, agenticExecutor, initAgenticExecutor,
        getContextStats, ipcClient,
    } = deps;



    async function agenticChatFn(provider, message) {
        return await smartChat(message, provider, {});
    }

    server.registerTool('run_workflow', {
        title: 'Run Workflow (sequential)',
        description: 'Run an ordered multi-step pipeline where each step\'s output feeds the next, auto-routing each step to a provider. Use for fixed sequential pipelines; use run_loop to iterate one task to convergence, crew for role-based agents.',
        inputSchema: {
            steps: z.array(z.object({
                task: z.string().describe('What this step should do'),
                provider: z.string().optional().describe('Which AI to use (auto-routed if empty)'),
            })).describe('Array of workflow steps. Each step output feeds into next step.'),
            name: z.string().optional().describe('Workflow name'),
            input: z.string().optional().describe('Initial context/input for first step'),
        },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ steps, name, input }) => {
        try {
            const enabled = getEnabledProviders();
            const result = await workflowEngine.execute({
                name: name || 'MCP Workflow', steps, input: input || '',
                chatFn: agenticChatFn, enabledProviders: enabled,
            });
            return toolResponse({
                status: result.status, finalOutput: result.finalOutput,
                summary: result.summary,
                steps: result.steps.map(s => ({
                    step: s.step, task: s.task?.substring(0, 80),
                    provider: s.provider, autoRouted: s.autoRouted || false,
                    elapsedSec: s.elapsedSec, error: s.error || null,
                    responsePreview: s.response?.substring(0, 200) + '...',
                })),
            });
        } catch (err) { return toolError(err); }
    });

    server.registerTool('run_loop', {
        title: 'Run Loop (iterate to quality)',
        description: 'Iterate ONE task: generate → another AI reviews → improve, until it converges or hits maxTurns. Use to refine a single output; use run_workflow for distinct sequential steps.',
        inputSchema: {
            task: z.string().describe('The task to iterate on'),
            provider: z.string().optional().describe('Primary AI provider (auto-routed if empty)'),
            reviewProvider: z.string().optional().describe('AI to review output (defaults to claude)'),
            maxTurns: z.number().optional().describe('Max iterations (default 3)'),
        },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ task, provider, reviewProvider, maxTurns }) => {
        try {
            const enabled = getEnabledProviders();
            const result = await runLoop.execute({
                task, provider, reviewProvider, maxTurns: maxTurns || 3,
                chatFn: agenticChatFn, enabledProviders: enabled,
            });
            return toolResponse({
                finalOutput: result.finalOutput, converged: result.converged,
                summary: result.summary,
                iterations: result.iterations.map(i => ({
                    turn: i.turn, score: i.score, converged: i.converged,
                    elapsedSec: (i.elapsedMs / 1000).toFixed(1),
                })),
            });
        } catch (err) { return toolError(err); }
    });

    server.registerTool('crew', {
        title: 'Multi-Agent Crew',
        description: 'Run a role-based pipeline (default Researcher→Writer→Reviewer), each role on its own provider, passing output down the chain. Use for role-specialized teamwork; use run_workflow for plain sequential tasks.',
        inputSchema: {
            task: z.string().describe('Task for the multi-agent crew to execute'),
            agents: z.array(z.object({
                role: z.string().describe('Agent role (e.g. Researcher, Writer, Reviewer)'),
                provider: z.string().optional().describe('AI provider for this agent'),
                instruction: z.string().optional().describe('Specific instruction for this agent'),
            })).optional().describe('Custom agent pipeline. Default: Researcher→Writer→Reviewer'),
        },
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }),
    }, async ({ task, agents: customAgents }) => {
        try {
            const agentList = customAgents || [
                { role: 'Researcher', provider: 'perplexity', instruction: 'Research the topic thoroughly with facts and citations.' },
                { role: 'Writer', provider: 'claude', instruction: 'Write a detailed, well-structured response based on research.' },
                { role: 'Reviewer', provider: 'chatgpt', instruction: 'Review, improve and polish the output.' }
            ];


            const enabled = getEnabledProviders();
            const resolveAgentProvider = (p) => {
                if (!p || p === 'auto') return 'auto';
                return enabled.has(p.toLowerCase()) ? p : 'auto';
            };

            const lines = [`# 🤖 Crew Execution: "${task}"\n`, `**Pipeline:** ${agentList.map(a => a.role).join(' → ')}\n`, '---\n'];
            let previousOutput = task;
            const timings = {};

            for (const agent of agentList) {
                const requestedProvider = agent.provider || 'auto';
                const providerName = resolveAgentProvider(requestedProvider);

                const providerLabel = providerName === requestedProvider
                    ? providerName
                    : `${providerName} (${requestedProvider} unavailable)`;
                const prompt = `You are a ${agent.role}. ${agent.instruction || ''}\n\nTASK: ${task}\n\n${previousOutput !== task ? `PREVIOUS AGENT OUTPUT:\n${previousOutput}\n\n` : ''}Provide your best work as a ${agent.role}.`;
                const startMs = Date.now();
                try {
                    const result = await chatWithProvider(providerName, prompt);
                    const elapsed = Date.now() - startMs;
                    timings[agent.role] = elapsed;
                    previousOutput = result;
                    lines.push(`## ${agent.role} (${providerLabel}) — ${elapsed}ms\n`);
                    lines.push(result);
                    lines.push('\n---\n');
                } catch (e) {
                    lines.push(`## ${agent.role} (${providerLabel}) — FAILED\n`);
                    lines.push(`Error: ${e.message}\n---\n`);
                }
            }

            const totalMs = Object.values(timings).reduce((a, b) => a + b, 0);
            lines.push(`\n**Total time:** ${(totalMs / 1000).toFixed(1)}s across ${Object.keys(timings).length} agents`);
            return toolResponse(lines.join('\n'));
        } catch (err) { return toolError(err); }
    });

    server.registerTool('proxima_cost_report', {
        title: 'Proxima Cost Report',
        description: 'Show this session\'s token usage and estimated money saved (per provider). Read-only observability.',
        inputSchema: {},
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async () => {
        try {
            const report = tokenTracker.getReport();
            const providerLines = Object.entries(report.providers)
                .map(([k, v]) => `  ${k}: ${v.requests} requests, ${v.promptTokens + v.completionTokens} tokens`)
                .join('\n');
            const lines = [
                'Proxima Cost Report', '====================',
                `Total Requests: ${report.totalRequests}`, `Total Tokens: ${report.totalTokens}`,
                `Money Saved: ${report.totalCostSaved} (${report.totalCostSavedINR})`,
                report.message, '', 'Per Provider:', providerLines || '  No data yet',
            ];
            return toolResponse(lines.join('\n'));
        } catch (err) { return toolError(err); }
    });

    server.registerTool('proxima_agentic_status', {
        title: 'Proxima Agentic Status',
        description: 'Full status of the agentic pipeline: current mode (session/BYOK), router/provider health, memory, run-loop, orchestrator and cost. Read-only diagnostics.',
        inputSchema: {},
        annotations: Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }),
    }, async () => {
        try {
            const memCount = memoryStore.memoryStore.size;
            const costReport = tokenTracker.getReport();


            let isApiMode = false;
            let byokStatus = null;
            try {
                byokStatus = await ipcClient.send('getByokStatus');
                isApiMode = !!(byokStatus && byokStatus.enabled);
            } catch { }

            const routerHealth = smartRouterV2.getHealthReport(getEnabledProviders(), isApiMode);
            const loopStats = runLoop.getStats();
            const memStats = enhancedMemory.getStats();
            const memEntries = Array.from(memoryStore.memoryStore.values()).slice(-5);
            const recentMemory = memEntries.map(e => `  - ${e.new_value?.substring(0, 80)}...`).join('\n');

            const memIntelStats = intelligentMemory.getStatus();
            const stateStatus = agentState.getStatus();
            const ctx7Stats = getContextStats();

            const lines = [
                '# Proxima v8.0 Agentic Status', '',
            ];

            if (isApiMode && byokStatus) {
                lines.push('## Mode: API (BYOK)', '');
                if (byokStatus.providers && byokStatus.providers.length > 0) {
                    lines.push('| Provider | Model |', '|----------|-------|');
                    for (const p of byokStatus.providers) {
                        lines.push(`| ${p.name} | ${p.model} |`);
                    }
                } else {
                    lines.push('- No API providers configured');
                }
            } else if (byokStatus) {
                lines.push('## Mode: Session (Browser)');
            } else {
                lines.push('## Mode: Unknown (IPC unavailable)');
            }
            lines.push('');

            lines.push(
                '## Pipeline (chat middleware)', '',
                '- Smart Router v2: active', '- Retry Engine: active',
                `- Cost Tracker: ${costReport.totalRequests} requests, ${costReport.totalCostSaved} saved`,
                `- Run Loop: ${loopStats.totalRuns} runs, avg ${loopStats.avgTurns} turns`, '',
                '## Memory Intelligence (v8.0)', '',
                `- Active memories: ${memIntelStats.activeMemories}`,
                `- Archived: ${memIntelStats.archivedMemories}`,
                `- Harvested facts: ${memIntelStats.harvestedFacts}`,
                `- Avg quality: ${memIntelStats.avgQualityScore}`,
                `- Avg decay: ${memIntelStats.avgDecayScore}`,
                `- Last consolidation: ${memIntelStats.lastConsolidation}`,
                `- Legacy store: ${memCount} interactions, ${memStats.totalFacts} facts`, '',
                '## Agent State (v8.0)', '',
                `- Current: ${stateStatus.currentState}`,
                `- Total runs: ${stateStatus.stats.totalRuns} | Done: ${stateStatus.stats.completed} | Errors: ${stateStatus.stats.errors} | Blocked: ${stateStatus.stats.blocked}`,
                `- Avg duration: ${stateStatus.stats.avgDurationMs}ms`, '',
                '## Context7 (v8.0)', '',
                `- Total checks: ${ctx7Stats.totalChecks}`,
                `- Injections: ${ctx7Stats.totalInjections}`,
                `- Top libraries: ${Object.entries(ctx7Stats.libraryHits || {}).map(([k,v]) => k + '(' + v + ')').join(', ') || 'none yet'}`, '',
                '## Orchestrator (v7.0)', '',
            );

            const exec = agenticExecutor || initAgenticExecutor();
            if (exec) {
                const exStats = exec.getStats();
                const sc = exStats.orchestrator?.strategyCounts || {};
                lines.push(
                    `- Orchestrations: ${exStats.totalExecutions} total, ${exStats.multiProviderCalls} multi-AI`,
                    `- Strategies: direct=${sc.direct||0}, verify=${sc.verify||0}, collaborate=${sc.collaborate||0}, consensus=${sc.consensus||0}`,
                    `- Avg quality: ${exStats.evaluator?.avgScore?.toFixed(1) || 'N/A'}/10`,
                    `- Facts learned: ${exStats.facts || 0}`,
                );
            } else {
                lines.push('- Not yet initialized');
            }

            lines.push('', '## Provider Health', '',
                '| Provider | Mode | Status | Calls | Avg Time | Errors |',
                '|----------|------|--------|-------|----------|--------|');
            for (const [k, v] of Object.entries(routerHealth)) {
                lines.push(`| ${k} | ${v.mode || '-'} | ${v.status} | ${v.calls} | ${v.avgResponseSec || 'n/a'} | ${v.errors} |`);
            }

            lines.push('', '## Tracing', '', tracingManager.getStatusReport(),
                '', '## Lifecycle', '', lifecycle.getStatusReport(),
                '', '## Recent Memory', '', recentMemory || '- No interactions yet',
                '', `**Session Savings:** ${costReport.totalCostSaved}`);
            return toolResponse(lines.join('\n'));
        } catch (err) { return toolError(err); }
    });
}

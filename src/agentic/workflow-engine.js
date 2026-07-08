// Proxima — Workflow Engine.
// Manages multi-step sequential tasks and execution pipelines with fallback handling.

import { createTerminations } from '../core/terminations.js';

const WORKFLOW_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
};

const TASK_STATUS = {
    TODO: 'todo',
    DOING: 'doing',
    DONE: 'done',
    ERROR: 'error',
    SKIPPED: 'skipped',
};

class WorkflowEngine {
    constructor({ smartRouter } = {}) {
        this.smartRouter = smartRouter;
        this.activeWorkflows = new Map();
    }

    async execute({ name, steps, input, chatFn, enabledProviders }) {
        const workflowId = `wf-${Date.now()}`;
        const startTime = Date.now();

        const workflow = {
            id: workflowId,
            name: name || 'Unnamed Workflow',
            status: WORKFLOW_STATUS.RUNNING,
            steps: steps.map((s, i) => ({
                ...s,
                index: i + 1,
                status: TASK_STATUS.TODO,
                provider: s.provider || null,
                response: null,
                error: null,
                startTime: null,
                endTime: null,
            })),
            input,
            startTime,
            endTime: null,
            totalTokens: 0,
        };

        this.activeWorkflows.set(workflowId, workflow);

        try {
            let previousOutput = input || '';
            const results = [];


            const terminator = createTerminations('workflow', {
                timeoutMs: 300000,
                tokenBudget: 100000,
            });

            let lastStepTokens = 0;

            for (let i = 0; i < workflow.steps.length; i++) {
                const termination = terminator.check({ tokensUsed: lastStepTokens });
                lastStepTokens = 0;
                if (termination && termination.shouldStop) {
                    workflow.terminationReason = termination.reason;
                    for (let j = i; j < workflow.steps.length; j++) {
                        workflow.steps[j].status = TASK_STATUS.SKIPPED;
                    }
                    break;
                }

                const step = workflow.steps[i];
                step.status = TASK_STATUS.DOING;
                step.startTime = Date.now();

                try {
                    let provider = step.provider;
                    if (!provider || !enabledProviders.has(provider)) {
                        if (this.smartRouter) {
                            const route = this.smartRouter.route(step.task, enabledProviders);
                            provider = route.provider;
                            step.autoRouted = true;
                            step.routeReason = route.reason;
                        } else {
                            provider = [...enabledProviders][0];
                        }
                    }
                    step.provider = provider;

                    const prompt = this._buildStepPrompt(step, previousOutput, i, workflow.steps.length);

                    const response = await chatFn(provider, prompt);

                    step.response = response;
                    step.status = TASK_STATUS.DONE;
                    step.endTime = Date.now();
                    step.elapsedMs = step.endTime - step.startTime;

                    if (this.smartRouter) {
                        this.smartRouter.recordSuccess(provider, step.elapsedMs);
                    }

                    previousOutput = response;

                    lastStepTokens = Math.ceil(((prompt ? prompt.length : 0) + (response ? response.length : 0)) / 4);
                    results.push({
                        step: i + 1,
                        task: step.task,
                        provider: step.provider,
                        autoRouted: step.autoRouted || false,
                        response,
                        elapsedSec: (step.elapsedMs / 1000).toFixed(1),
                    });

                } catch (err) {
                    step.status = TASK_STATUS.ERROR;
                    step.error = err.message;
                    step.endTime = Date.now();

                    if (this.smartRouter) {
                        this.smartRouter.recordError(step.provider, err);
                    }

                    const fallback = await this._tryFallback(step, previousOutput, chatFn, enabledProviders);
                    if (fallback) {
                        step.status = TASK_STATUS.DONE;
                        step.response = fallback.response;
                        step.provider = fallback.provider;
                        step.fallbackUsed = true;
                        previousOutput = fallback.response;
                        lastStepTokens = Math.ceil((fallback.response ? fallback.response.length : 0) / 4);
                        results.push({
                            step: i + 1,
                            task: step.task,
                            provider: fallback.provider,
                            fallback: true,
                            response: fallback.response,
                            elapsedSec: ((Date.now() - step.startTime) / 1000).toFixed(1),
                        });
                    } else {
                        results.push({
                            step: i + 1,
                            task: step.task,
                            provider: step.provider,
                            error: err.message,
                        });

                        workflow.status = WORKFLOW_STATUS.FAILED;
                        workflow.endTime = Date.now();
                        workflow.failedStep = i + 1;

                        return this._buildResult(workflow, results, previousOutput);
                    }
                }
            }

            workflow.status = WORKFLOW_STATUS.COMPLETED;
            workflow.endTime = Date.now();

            return this._buildResult(workflow, results, previousOutput);
        } finally {

            this.activeWorkflows.delete(workflowId);
            this._recordRecent(workflow);
        }
    }


    _recordRecent(workflow) {
        if (!this._recent) this._recent = [];
        this._recent.push({
            id: workflow.id,
            name: workflow.name,
            status: workflow.status,
            steps: workflow.steps.length,
            completed: workflow.steps.filter(s => s.status === TASK_STATUS.DONE).length,
            endTime: workflow.endTime,
        });
        if (this._recent.length > 50) this._recent.splice(0, this._recent.length - 50);
    }

    _buildStepPrompt(step, previousOutput, stepIndex, totalSteps) {
        let prompt = '';

        if (stepIndex > 0 && previousOutput) {
            prompt += `CONTEXT FROM PREVIOUS STEP:\n---\n${previousOutput}\n---\n\n`;
        }

        prompt += `STEP ${stepIndex + 1}/${totalSteps}: ${step.task}`;

        if (step.instructions) {
            prompt += `\n\nADDITIONAL INSTRUCTIONS: ${step.instructions}`;
        }

        return prompt;
    }

    async _tryFallback(step, previousOutput, chatFn, enabledProviders) {
        const fallbackProviders = [...enabledProviders].filter(p => p !== step.provider);
        
        for (const provider of fallbackProviders) {
            try {
                const prompt = previousOutput
                    ? `Context:\n${previousOutput}\n\nTask: ${step.task}`
                    : step.task;
                const response = await chatFn(provider, prompt);
                return { provider, response };
            } catch (e) {
                continue;
            }
        }
        return null;
    }

    _buildResult(workflow, results, finalOutput) {
        const elapsed = workflow.endTime - workflow.startTime;
        const providersUsed = [...new Set(results.map(r => r.provider).filter(Boolean))];

        return {
            workflowId: workflow.id,
            name: workflow.name,
            status: workflow.status,
            finalOutput,
            terminationReason: workflow.terminationReason || null,
            steps: results,
            summary: {
                totalSteps: workflow.steps.length,
                completedSteps: results.filter(r => !r.error).length,
                failedSteps: results.filter(r => r.error).length,
                providersUsed,
                totalElapsedSec: (elapsed / 1000).toFixed(1),
                handoffs: providersUsed.length > 1 ? providersUsed.length - 1 : 0,
            },
        };
    }

    getActiveWorkflows() {
        return [...this.activeWorkflows.values()].map(w => ({
            id: w.id,
            name: w.name,
            status: w.status,
            steps: w.steps.length,
            completed: w.steps.filter(s => s.status === TASK_STATUS.DONE).length,
        }));
    }
}

export { WorkflowEngine, WORKFLOW_STATUS, TASK_STATUS };

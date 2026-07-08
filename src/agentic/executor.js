// Proxima — Agentic Executor.
// Orchestrates the planning, execution, evaluation, and learning pipeline across multiple providers.

import { createLogger } from '../utils/logger.js';
import { TaskOrchestrator, STRATEGY } from './task-orchestrator.js';
import { ResponseEvaluator } from './response-evaluator.js';
import { FactExtractor } from './fact-extractor.js';
import { QualityVerifier } from '../quality/verifier.js';

const log = createLogger('executor');

class AgenticExecutor {
    constructor(deps) {
        if (!deps.chatFn) throw new Error('AgenticExecutor requires chatFn');
        if (!deps.getEnabledProviders) throw new Error('AgenticExecutor requires getEnabledProviders');

        this.chatFn = deps.chatFn;
        this.getEnabledProviders = deps.getEnabledProviders;
        this.orchestrator = new TaskOrchestrator({ smartRouter: deps.smartRouter });
        this.evaluator = new ResponseEvaluator();
        this.factExtractor = new FactExtractor();

        // Cross-model verifier.
        this.verifier = new QualityVerifier({
            sendToModel: (provider, query) => this.chatFn(provider, query),
        });

        this.stats = { totalExecutions: 0, multiProviderCalls: 0 };
    }


    async execute(message, options = {}) {
        this.stats.totalExecutions++;
        const startTime = Date.now();

        const enabledProviders = this.getEnabledProviders();
        if (enabledProviders.size === 0) {
            return { error: 'No providers enabled', response: null };
        }

        const plan = this.orchestrator.createPlan(message, enabledProviders, options);

        log.info('Executing plan', {            strategy: plan.strategy,
            providers: plan.assignments.map(a => a.provider),
        });

        let result;
        try {
            switch (plan.strategy) {
                case STRATEGY.DIRECT:
                    result = await this._executeDirect(message, plan, options);
                    break;
                case STRATEGY.VERIFY:
                    result = await this._executeVerify(message, plan, options);
                    break;
                case STRATEGY.COLLABORATE:
                    result = await this._executeCollaborate(message, plan, options);
                    break;
                case STRATEGY.CONSENSUS:
                    result = await this._executeConsensus(message, plan, options);
                    break;
                default:
                    result = await this._executeDirect(message, plan, options);
            }
        } catch (err) {
            log.error('Execution failed', { error: err.message, strategy: plan.strategy });
            return {
                error: err.message,
                response: null,
                plan,
                duration: Date.now() - startTime,
            };
        }

        if (result.response) {
            this.factExtractor.extract(message, result.response, {
                provider: result.primaryProvider,
                responseTimeMs: Date.now() - startTime,
                qualityScore: result.evaluation?.score || 7,
            });
        }

        result.duration = Date.now() - startTime;
        result.plan = plan;

        log.info('Execution complete', {
            strategy: plan.strategy,
            score: result.evaluation?.score,
            duration: result.duration,
            provider: result.primaryProvider,
        });

        return result;
    }


    async _executeDirect(message, plan, options) {
        const assignment = plan.assignments[0];
        const response = await this.chatFn(assignment.provider, message, options.files);

        const evaluation = this.evaluator.evaluate(response, message, {
            provider: assignment.provider,
        });

        return {
            response,
            primaryProvider: assignment.provider,
            evaluation,
            providersUsed: [assignment.provider],
        };
    }


    async _executeVerify(message, plan, options) {
        this.stats.multiProviderCalls++;

        const primary = plan.assignments.find(a => a.role === 'primary');
        const verifier = plan.assignments.find(a => a.role === 'verifier');

        const primaryResponse = await this.chatFn(primary.provider, message, options.files);


        const primaryEval = this.evaluator.evaluate(primaryResponse, message, {
            provider: primary.provider,
        });

        if (primaryEval.score >= 8 && primaryEval.action === 'accept') {
            log.debug('Primary response excellent, skipping verification');
            return {
                response: primaryResponse,
                primaryProvider: primary.provider,
                evaluation: primaryEval,
                providersUsed: [primary.provider],
                verified: false,
            };
        }


        if (!verifier) {
            return {
                response: primaryResponse,
                primaryProvider: primary.provider,
                evaluation: primaryEval,
                providersUsed: [primary.provider],
                verified: false,
            };
        }

        // Cross-model verification.
        const crossCheck = await this.verifier.verify(message, primaryResponse, verifier.provider);
        const overall = crossCheck.scores ? crossCheck.scores.overall : null;


        if (overall !== null && overall < 5) {
            const verifyPrompt = this.orchestrator.buildPrompt(
                message,
                verifier,
                [{ provider: primary.provider, role: 'primary', response: primaryResponse }]
            );
            const verifierResponse = await this.chatFn(verifier.provider, verifyPrompt, options.files);

            return {
                response: verifierResponse,
                primaryProvider: verifier.provider,
                evaluation: this.evaluator.evaluate(verifierResponse, message, {
                    provider: verifier.provider,
                }),
                providersUsed: [primary.provider, verifier.provider],
                verified: true,
                switchedProvider: true,
                crossScore: overall,
            };
        }


        const summary = crossCheck.scores
            ? `accuracy ${crossCheck.scores.accuracy}/10, completeness ${crossCheck.scores.completeness}/10, `
              + `relevance ${crossCheck.scores.relevance}/10, overall ${overall}/10`
              + (crossCheck.scores.issues && crossCheck.scores.issues !== 'none'
                    ? ` — issues: ${crossCheck.scores.issues}` : '')
            : `unavailable (${crossCheck.error || 'evaluator returned no scores'})`;

        const combined = `${primaryResponse}\n\n---\n**Cross-model verification (${verifier.provider}):** ${summary}`;

        return {
            response: combined,
            primaryProvider: primary.provider,
            evaluation: primaryEval,
            providersUsed: [primary.provider, verifier.provider],
            verified: !!crossCheck.scores,
            crossScore: overall,
        };
    }


    async _executeCollaborate(message, plan, options) {
        this.stats.multiProviderCalls++;
        const outputs = [];

        const order = ['researcher', 'architect', 'analyst', 'contributor', 'synthesizer'];
        const sortedAssignments = plan.assignments.sort((a, b) =>
            order.indexOf(a.role) - order.indexOf(b.role)
        );

        for (const assignment of sortedAssignments) {
            const prompt = this.orchestrator.buildPrompt(message, assignment, outputs);
            const response = await this.chatFn(assignment.provider, prompt, options.files);
            outputs.push({
                provider: assignment.provider,
                role: assignment.role,
                response,
            });
        }

        const finalOutput = outputs[outputs.length - 1];

        return {
            response: finalOutput.response,
            primaryProvider: finalOutput.provider,
            evaluation: this.evaluator.evaluate(finalOutput.response, message, {
                provider: finalOutput.provider,
            }),
            providersUsed: outputs.map(o => o.provider),
            collaborationSteps: outputs.map(o => ({
                provider: o.provider,
                role: o.role,
                responseLength: o.response?.length || 0,
            })),
        };
    }


    async _executeConsensus(message, plan, options) {
        this.stats.multiProviderCalls++;

        const promises = plan.assignments.map(async (assignment) => {
            const response = await this.chatFn(assignment.provider, message, options.files);
            return { provider: assignment.provider, response };
        });

        const results = await Promise.allSettled(promises);
        const successfulResponses = results
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value);

        if (successfulResponses.length === 0) {
            return { error: 'All providers failed', response: null };
        }

        const consensus = this.evaluator.checkConsensus(
            successfulResponses.map(r => r.response)
        );

        const best = this.evaluator.pickBest(successfulResponses, message);

        return {
            response: best.response,
            primaryProvider: best.provider,
            evaluation: best.evaluation,
            providersUsed: successfulResponses.map(r => r.provider),
            consensus,
        };
    }

    getLearnedContext() {
        return this.factExtractor.getRoutingContext();
    }

    getStats() {
        return {
            ...this.stats,
            orchestrator: this.orchestrator.getStats(),
            evaluator: this.evaluator.getStats(),
            facts: this.factExtractor.getStore().totalFacts,
            providerPerformance: this.factExtractor.getStore().getPerformance(),
        };
    }
}

export { AgenticExecutor };

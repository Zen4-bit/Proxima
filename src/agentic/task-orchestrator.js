// Proxima — Task Orchestrator.
// Understands requests and builds optimal multi-provider execution plans.

import { createLogger } from '../utils/logger.js';
import { DEFAULTS } from '../config/defaults.js';

const log = createLogger('orchestrator');


const PROVIDER_ROLES = {
    perplexity: {
        role: 'Researcher',
        strengths: ['web-search', 'current-events', 'citations', 'fact-check', 'news'],
        weight: 10,
    },
    claude: {
        role: 'Architect',
        strengths: ['code-review', 'architecture', 'security', 'reasoning', 'analysis', 'debugging'],
        weight: 9,
    },
    chatgpt: {
        role: 'Creator',
        strengths: ['code-gen', 'creative', 'explanation', 'general', 'synthesis', 'writing'],
        weight: 8,
    },
    gemini: {
        role: 'Analyst',
        strengths: ['analysis', 'multimodal', 'research', 'code-gen', 'data'],
        weight: 7,
    },
};

const TASK_PATTERNS = [
    { type: 'research', patterns: /\b(search|find|look up|latest|current|news|what is|who is|when did)\b/i },
    { type: 'code-gen', patterns: /\b(write|create|generate|build|implement|make|code|function|class|component)\b/i },
    { type: 'code-review', patterns: /\b(review|check|audit|bug|issue|problem|fix|debug|error)\b/i },
    { type: 'architecture', patterns: /\b(design|architecture|structure|pattern|system|plan|approach|best practice)\b/i },
    { type: 'creative', patterns: /\b(design|ui|ux|style|brand|logo|color|theme|interactive|animation)\b/i },
    { type: 'analysis', patterns: /\b(analyze|compare|evaluate|assess|pros|cons|tradeoff|benchmark)\b/i },
    { type: 'explanation', patterns: /\b(explain|how does|what does|why|understand|learn|tutorial)\b/i },
    { type: 'security', patterns: /\b(security|vulnerab|inject|xss|csrf|auth|permission|encrypt)\b/i },
    { type: 'writing', patterns: /\b(write|article|blog|document|readme|report|summary)\b/i },
    { type: 'fact-check', patterns: /\b(verify|fact|true|false|claim|accurate|correct)\b/i },
];

// Strategies for using available providers.
const STRATEGY = {
    DIRECT: 'direct',
    VERIFY: 'verify',
    COLLABORATE: 'collaborate',
    CONSENSUS: 'consensus',
};

class TaskOrchestrator {
    constructor(deps = {}) {
        this.smartRouter = deps.smartRouter || null;
        this.stats = {
            totalOrchestrations: 0,
            strategyCounts: { direct: 0, verify: 0, collaborate: 0, consensus: 0 },
        };
    }

    classifyTask(message) {
        const types = [];
        for (const { type, patterns } of TASK_PATTERNS) {
            if (patterns.test(message)) {
                types.push(type);
            }
        }
        return types.length > 0 ? types : ['general'];
    }

    selectStrategy(taskTypes, enabledProviders, options = {}) {
        const count = enabledProviders.size;

        if (options.forceConsensus && count >= 2) return STRATEGY.CONSENSUS;
        if (options.forceCollaborate && count >= 2) return STRATEGY.COLLABORATE;
        if (options.forceVerify && count >= 2) return STRATEGY.VERIFY;


        return STRATEGY.DIRECT;
    }

    assignRoles(taskTypes, enabledProviders, strategy, options = {}) {
        const available = [...enabledProviders];
        const assignments = [];


        const preferred = (options.preferredProvider && available.includes(options.preferredProvider))
            ? options.preferredProvider
            : null;

        if (strategy === STRATEGY.DIRECT) {
            const best = preferred || this._pickBestFor(taskTypes, available);
            assignments.push({ provider: best, role: 'primary', assignment: 'execute' });
            return assignments;
        }

        if (strategy === STRATEGY.CONSENSUS) {
            for (const p of available.slice(0, 3)) {
                assignments.push({ provider: p, role: 'voter', assignment: 'answer' });
            }
            return assignments;
        }

        if (strategy === STRATEGY.VERIFY) {
            const primary = preferred || this._pickBestFor(taskTypes, available);
            const remaining = available.filter(p => p !== primary);
            const verifier = this._pickBestFor(['analysis', 'fact-check'], remaining) || remaining[0];
            assignments.push({ provider: primary, role: 'primary', assignment: 'execute' });
            if (verifier) {
                assignments.push({ provider: verifier, role: 'verifier', assignment: 'verify' });
            }
            return assignments;
        }

        if (strategy === STRATEGY.COLLABORATE) {
            const needsResearch = taskTypes.some(t => ['research', 'fact-check', 'current-events'].includes(t));
            const needsCode = taskTypes.some(t => ['code-gen', 'code-review', 'security'].includes(t));
            const needsCreative = taskTypes.some(t => ['creative', 'writing', 'explanation'].includes(t));

            if (needsResearch && available.includes('perplexity')) {
                assignments.push({ provider: 'perplexity', role: 'researcher', assignment: 'research' });
            }

            if (needsCode && available.includes('claude')) {
                assignments.push({ provider: 'claude', role: 'architect', assignment: 'analyze' });
            } else if (available.includes('claude') && !assignments.find(a => a.provider === 'claude')) {
                assignments.push({ provider: 'claude', role: 'architect', assignment: 'analyze' });
            }

            if (available.includes('chatgpt') && !assignments.find(a => a.provider === 'chatgpt')) {
                assignments.push({ provider: 'chatgpt', role: 'synthesizer', assignment: 'synthesize' });
            }

            if (available.includes('gemini') && !assignments.find(a => a.provider === 'gemini')) {
                assignments.push({ provider: 'gemini', role: 'analyst', assignment: 'analyze' });
            }


            if (assignments.length === 0) {
                for (const p of available) {
                    assignments.push({ provider: p, role: 'contributor', assignment: 'execute' });
                }
            }

            return assignments;
        }

        assignments.push({ provider: available[0], role: 'primary', assignment: 'execute' });
        return assignments;
    }

    createPlan(message, enabledProviders, options = {}) {
        this.stats.totalOrchestrations++;
        const taskTypes = this.classifyTask(message);
        const strategy = this.selectStrategy(taskTypes, enabledProviders, options);
        const assignments = this.assignRoles(taskTypes, enabledProviders, strategy, options);

        this.stats.strategyCounts[strategy] = (this.stats.strategyCounts[strategy] || 0) + 1;

        const plan = {
            taskTypes,
            strategy,
            assignments,
            providerCount: enabledProviders.size,
            timestamp: new Date().toISOString(),
        };

        log.info('Execution plan created', {
            strategy,
            taskTypes,
            providers: assignments.map(a => `${a.provider}(${a.role})`),
        });

        return plan;
    }

    buildPrompt(originalMessage, assignment, previousOutputs = []) {
        let prompt = originalMessage;

        if (previousOutputs.length === 0) return prompt;

        const context = previousOutputs
            .map(o => `--- ${o.provider.toUpperCase()} (${o.role}) output ---\n${o.response}`)
            .join('\n\n');

        switch (assignment.assignment) {
            case 'verify':
                prompt = `VERIFY the following response for accuracy, completeness, and potential errors.\n\nORIGINAL QUESTION: ${originalMessage}\n\nRESPONSE TO VERIFY:\n${context}\n\nProvide your verification: Is this correct? Any issues? What would you add or change?`;
                break;

            case 'synthesize':
                prompt = `SYNTHESIZE the best answer from the following inputs.\n\nORIGINAL QUESTION: ${originalMessage}\n\nINPUTS FROM OTHER AIs:\n${context}\n\nCreate the BEST combined answer using the strongest parts from each input. Be concise and actionable.`;
                break;

            case 'research':
                prompt = `RESEARCH the following topic with current, factual information and citations.\n\n${originalMessage}`;
                break;

            case 'analyze':
                if (previousOutputs.length > 0) {
                    prompt = `ANALYZE and improve the following based on the original question.\n\nORIGINAL QUESTION: ${originalMessage}\n\nPREVIOUS RESEARCH/INPUT:\n${context}\n\nProvide deep analysis, identify gaps, and add your expertise.`;
                }
                break;

            default:
                if (previousOutputs.length > 0) {
                    prompt = `${originalMessage}\n\nCONTEXT FROM PREVIOUS STEPS:\n${context}`;
                }
        }

        return prompt;
    }

    _pickBestFor(taskTypes, available) {
        if (available.length === 0) return null;
        if (available.length === 1) return available[0];

        let bestProvider = available[0];
        let bestScore = 0;

        for (const provider of available) {
            const info = PROVIDER_ROLES[provider];
            if (!info) continue;

            let score = info.weight;
            for (const taskType of taskTypes) {
                if (info.strengths.includes(taskType)) {
                    score += 5;
                }
            }


            if (this.smartRouter && this.smartRouter.metrics) {
                const health = this.smartRouter.metrics[provider];
                if (health && health.consecutiveErrors > 2) score -= 10;
            }

            if (score > bestScore) {
                bestScore = score;
                bestProvider = provider;
            }
        }

        return bestProvider;
    }

    getStats() {
        return { ...this.stats };
    }
}

export { TaskOrchestrator, PROVIDER_ROLES, STRATEGY };

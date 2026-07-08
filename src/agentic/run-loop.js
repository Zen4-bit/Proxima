// Proxima — Run Loop.
// Manages the self-iterating generate, review, and improve quality loops.
import { createTerminations } from '../core/terminations.js';

const DEFAULT_MAX_TURNS = 3;
const MAX_TURNS_CEILING = 20;
const CONVERGENCE_THRESHOLD = 0.85;
const DEFAULT_TIMEOUT_MS = 120000;

class RunLoop {
    constructor({ smartRouter } = {}) {
        this.smartRouter = smartRouter;
        this.stats = {
            totalRuns: 0,
            avgTurns: 0,
            convergedEarly: 0,
            maxTurnsHit: 0,
        };
    }

    async execute({ task, provider, reviewProvider, maxTurns, timeoutMs, chatFn, enabledProviders }) {

        maxTurns = (Number.isFinite(maxTurns) && maxTurns > 0)
            ? Math.min(maxTurns, MAX_TURNS_CEILING)
            : DEFAULT_MAX_TURNS;
        timeoutMs = (Number.isFinite(timeoutMs) && timeoutMs > 0)
            ? timeoutMs
            : DEFAULT_TIMEOUT_MS;

        this.stats.totalRuns++;


        const terminator = createTerminations('loop', {
            quality: 9,
            maxTurns,
            timeoutMs,
        });

        if (!provider && this.smartRouter) {
            const route = this.smartRouter.route(task, enabledProviders);
            provider = route.provider;
        }
        provider = provider || [...enabledProviders][0];

        if (!reviewProvider) {
            reviewProvider = enabledProviders.has('claude') && provider !== 'claude'
                ? 'claude'
                : [...enabledProviders].find(p => p !== provider) || provider;
        }

        const iterations = [];
        let currentOutput = null;
        let converged = false;

        for (let turn = 1; turn <= maxTurns; turn++) {
            const iterationStart = Date.now();

            let generatePrompt;
            if (turn === 1) {
                generatePrompt = task;
            } else {
                const lastReview = iterations[iterations.length - 1].review;
                generatePrompt = `ORIGINAL TASK: ${task}\n\nYOUR PREVIOUS OUTPUT:\n---\n${currentOutput}\n---\n\nREVIEW FEEDBACK:\n---\n${lastReview}\n---\n\nIMPROVE your output based on the feedback above. Keep what's good, fix what's flagged.`;
            }

            const generated = await chatFn(provider, generatePrompt);

            const reviewPrompt = `TASK: ${task}\n\nOUTPUT TO REVIEW:\n---\n${generated}\n---\n\nReview this output critically. Score it 1-10 and list specific improvements needed.\nFormat: SCORE: X/10\nISSUES:\n- issue 1\n- issue 2\nIf score is 9 or 10, say "APPROVED" instead of listing issues.`;

            const review = await chatFn(reviewProvider, reviewPrompt);

            const score = this._extractScore(review);
            const isApproved = /\bAPPROVED\b/i.test(review);

            const similarity = currentOutput ? this._similarity(currentOutput, generated) : 0;
            converged = isApproved || score >= 9 || (turn > 1 && similarity > CONVERGENCE_THRESHOLD);


            const termination = terminator.check({ score, turn });
            const timedOut = !!(termination && termination.shouldStop && termination.source === 'Timeout');

            currentOutput = generated;
            iterations.push({
                turn,
                provider,
                reviewProvider,
                generatedLength: generated.length,
                review,
                score,
                isApproved,
                similarity: turn > 1 ? similarity.toFixed(2) : null,
                converged,
                terminationReason: timedOut ? termination.reason : null,
                elapsedMs: Date.now() - iterationStart,
            });

            if (converged) {
                this.stats.convergedEarly++;
                break;
            }
            if (timedOut) {

                break;
            }
        }

        if (!converged) {
            this.stats.maxTurnsHit++;
        }

        const totalTurns = iterations.length;
        this.stats.avgTurns = this.stats.avgTurns === 0
            ? totalTurns
            : Math.round((this.stats.avgTurns * 0.7) + (totalTurns * 0.3));

        return {
            finalOutput: currentOutput,
            converged,
            iterations,
            summary: {
                totalTurns: iterations.length,
                maxTurns,
                finalScore: iterations[iterations.length - 1].score,
                primaryProvider: provider,
                reviewProvider,
                totalElapsedSec: (iterations.reduce((s, i) => s + i.elapsedMs, 0) / 1000).toFixed(1),
            },
        };
    }

    _extractScore(review) {
        const match = review.match(/SCORE:\s*(\d+)\s*\/\s*10/i)
            || review.match(/(\d+)\s*\/\s*10/i)
            || review.match(/score[:\s]+(\d+)/i);
        if (match) {
            return parseInt(match[1], 10);
        }
        if (/\bAPPROVED\b/i.test(review)) return 9;
        return 5;
    }


    _similarity(a, b) {
        const wordsA = new Set(a.toLowerCase().split(/\s+/));
        const wordsB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
        const union = new Set([...wordsA, ...wordsB]).size;
        return union === 0 ? 1 : intersection / union;
    }

    getStats() {
        return { ...this.stats };
    }
}

export { RunLoop };

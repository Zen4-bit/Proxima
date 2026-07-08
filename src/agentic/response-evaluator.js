// Proxima — Response Evaluator.
// Evaluates AI response quality for completeness, hallucination risk, relevance, and actionability.

import { createLogger } from '../utils/logger.js';

const log = createLogger('evaluator');


const LOW_QUALITY_SIGNALS = [
    { pattern: /I('m| am) not sure/i, penalty: 2, flag: 'uncertainty' },
    { pattern: /I don('t| do not) know/i, penalty: 3, flag: 'no-knowledge' },
    { pattern: /I can('t| cannot) (help|assist|do)/i, penalty: 3, flag: 'refusal' },
    { pattern: /as an AI/i, penalty: 1, flag: 'ai-disclaimer' },
    { pattern: /I('d| would) recommend consulting/i, penalty: 2, flag: 'deflection' },
    { pattern: /this is (just )?a (general|basic) (overview|summary)/i, penalty: 2, flag: 'vague' },
    { pattern: /unfortunately/i, penalty: 1, flag: 'hedging' },
];


const HALLUCINATION_SIGNALS = [
    { pattern: /\b(definitely|absolutely|100%|guaranteed)\b/i, risk: 2, flag: 'overconfidence' },
    { pattern: /\b(everyone knows|it('s| is) well known|obviously)\b/i, risk: 2, flag: 'appeal-to-common' },
    { pattern: /\b(studies show|research proves|experts say)\b(?!.*(?:https?:|doi:|arxiv))/i, risk: 3, flag: 'unsourced-claim' },
    { pattern: /\b(in 20\d{2})\b.*\b(released|launched|announced)\b/i, risk: 2, flag: 'date-claim' },
];


const HIGH_QUALITY_SIGNALS = [

    { pattern: /```[\s\S]{20,}```/, bonus: 2, flag: 'has-code' },
    { pattern: /\b(step \d|first|second|third|finally)\b/i, bonus: 1, flag: 'structured' },
    { pattern: /\b(for example|e\.g\.|such as|here('s| is) an example)\b/i, bonus: 1, flag: 'has-examples' },
    { pattern: /\b(because|the reason|due to|since)\b/i, bonus: 1, flag: 'has-reasoning' },
    { pattern: /https?:\/\/\S+/, bonus: 1, flag: 'has-links' },
    { pattern: /\|.*\|.*\|/, bonus: 1, flag: 'has-table' },
];

class ResponseEvaluator {
    constructor() {
        this.stats = {
            totalEvaluations: 0,
            reRouteRecommendations: 0,
            avgScore: 0,
        };
    }

    evaluate(response, originalMessage, context = {}) {
        this.stats.totalEvaluations++;

        if (!response || response.trim().length === 0) {
            return this._emptyResponse(context.provider);
        }

        let score = 7;
        const flags = [];
        const suggestions = [];

        if (response.length < 50) {
            score -= 2;
            flags.push('too-short');
            suggestions.push('Response is very short — may be incomplete');
        } else if (response.length > 200) {
            score += 1;
        }

        for (const { pattern, penalty, flag } of LOW_QUALITY_SIGNALS) {
            if (pattern.test(response)) {
                score -= penalty;
                flags.push(flag);
            }
        }

        for (const { pattern, bonus, flag } of HIGH_QUALITY_SIGNALS) {
            if (pattern.test(response)) {
                score += bonus;
                flags.push(flag);
            }
        }

        let hallucinationRisk = 0;
        for (const { pattern, risk, flag } of HALLUCINATION_SIGNALS) {
            if (pattern.test(response)) {
                hallucinationRisk += risk;
                flags.push(`hallucination:${flag}`);
            }
        }

        const questionWords = new Set(
            originalMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3)
        );
        const responseWords = new Set(
            response.toLowerCase().split(/\W+/).filter(w => w.length > 3)
        );
        const overlap = [...questionWords].filter(w => responseWords.has(w)).length;
        const relevanceRatio = questionWords.size > 0 ? overlap / questionWords.size : 0;

        if (relevanceRatio < 0.1) {
            score -= 2;
            flags.push('low-relevance');
            suggestions.push('Response may not address the question');
        }

        score = Math.max(1, Math.min(10, score));

        const needsVerification = hallucinationRisk >= 3 || flags.includes('unsourced-claim');
        const needsReRoute = score < 4;
        const needsEnrichment = score >= 4 && score < 6;

        if (needsReRoute) {
            this.stats.reRouteRecommendations++;
            suggestions.push('Response quality too low — recommend re-routing to another AI');
        }
        if (needsVerification) {
            suggestions.push('High hallucination risk — recommend verification by another AI');
        }
        if (needsEnrichment) {
            suggestions.push('Response is OK but could be enriched by another AI');
        }

        this.stats.avgScore = (
            (this.stats.avgScore * (this.stats.totalEvaluations - 1) + score) /
            this.stats.totalEvaluations
        );

        const result = {
            score,
            maxScore: 10,
            flags,
            hallucinationRisk,
            relevanceRatio: Math.round(relevanceRatio * 100),
            action: this._decideAction(score, hallucinationRisk, needsVerification),
            suggestions,
            provider: context.provider || 'unknown',
        };

        log.debug('Evaluation complete', {
            provider: result.provider,
            score,
            action: result.action,
            flags: flags.length,
        });

        return result;
    }

    _decideAction(score, hallucinationRisk, needsVerification) {
        if (score <= 2) return 'reject';
        if (score <= 4) return 'reroute';
        if (needsVerification || hallucinationRisk >= 4) return 'verify';
        if (score <= 6) return 'enrich';
        return 'accept';
    }

    _emptyResponse(provider) {
        return {
            score: 0,
            maxScore: 10,
            flags: ['empty-response'],
            hallucinationRisk: 0,
            relevanceRatio: 0,
            action: 'reroute',
            suggestions: ['No response received — must re-route to another AI'],
            provider: provider || 'unknown',
        };
    }

    pickBest(responses, originalMessage) {
        if (responses.length === 0) return null;
        if (responses.length === 1) {
            return {
                ...responses[0],
                evaluation: this.evaluate(responses[0].response, originalMessage, {
                    provider: responses[0].provider,
                }),
            };
        }

        let best = null;
        let bestScore = -1;

        for (const resp of responses) {
            const evaluation = this.evaluate(resp.response, originalMessage, {
                provider: resp.provider,
            });
            if (evaluation.score > bestScore) {
                bestScore = evaluation.score;
                best = { ...resp, evaluation };
            }
        }

        return best;
    }


    checkConsensus(responses) {
        if (responses.length < 2) return { agreementScore: 1, agreementCount: responses.length };

        const wordSets = responses.map(r =>
            new Set(r.toLowerCase().split(/\W+/).filter(w => w.length > 4))
        );

        let totalOverlap = 0;
        let comparisons = 0;

        for (let i = 0; i < wordSets.length; i++) {
            for (let j = i + 1; j < wordSets.length; j++) {
                const overlap = [...wordSets[i]].filter(w => wordSets[j].has(w)).length;
                const maxSize = Math.max(wordSets[i].size, wordSets[j].size);
                totalOverlap += maxSize > 0 ? overlap / maxSize : 0;
                comparisons++;
            }
        }

        const agreementScore = comparisons > 0 ? totalOverlap / comparisons : 0;
        const agreementCount = agreementScore > 0.3 ? responses.length : 1;

        return {
            agreementScore: Math.round(agreementScore * 100) / 100,
            agreementCount,
        };
    }

    getStats() {
        return { ...this.stats };
    }
}

export { ResponseEvaluator };

// Proxima — Fact Extractor.
// Automatically extracts user preferences, tech stack, and performance facts from AI interactions.

import { createLogger } from '../utils/logger.js';

const log = createLogger('fact-extractor');


const FACT_PATTERNS = [
    {
        category: 'preference',
        patterns: [
            /(?:I |user |they )?(?:prefer|like|love|want|use|choose|favor)\s+(\w[\w\s.-]*\w)/gi,
            /(?:my |the )?(?:favorite|preferred|go-to|default)\s+(?:is|was|=)\s+(\w[\w\s.-]*\w)/gi,
        ],
    },
    {
        category: 'tech-stack',
        patterns: [
            /(?:using|built with|powered by|runs on|written in)\s+(\w[\w\s.-]*\w)/gi,
            /(?:stack|framework|language|database|orm)(?:\s+is)?\s*[:=]\s*(\w[\w\s.-]*\w)/gi,
        ],
    },
    {
        category: 'constraint',
        patterns: [
            /(?:must|should|need to|have to|required to)\s+([\w\s]+)/gi,
            /(?:don't|do not|avoid|never)\s+([\w\s]+)/gi,
        ],
    },
    {
        category: 'project-info',
        patterns: [
            /(?:project|app|repo|codebase)\s+(?:name|called|named)\s+["']?(\w[\w\s.-]*\w)["']?/gi,
            /(?:version|v)\s*(\d+\.\d+(?:\.\d+)?)/gi,
        ],
    },
];


const PROVIDER_PERFORMANCE_CATEGORIES = {
    fast: 'responded quickly',
    slow: 'took too long',
    accurate: 'gave accurate answer',
    hallucinated: 'may have hallucinated',
    detailed: 'gave detailed response',
    vague: 'gave vague response',
    refused: 'refused to answer',
};

const MAX_FACTS_PER_CATEGORY = 100;

class FactStore {
    constructor() {
        this.facts = new Map();               // category → facts[]
        this.providerPerformance = new Map(); // provider → performance stats
    }

    addFact(category, content, metadata = {}) {
        if (!content || content.trim().length < 3) return;

        const normalized = content.trim().toLowerCase();

        if (!this.facts.has(category)) {
            this.facts.set(category, []);
        }

        const existing = this.facts.get(category);

        if (existing.some(f => f.normalized === normalized)) return;

        existing.push({
            content: content.trim(),
            normalized,
            category,
            timestamp: Date.now(),
            confidence: metadata.confidence || 0.7,
            source: metadata.source || 'extraction',
            ...metadata,
        });


        if (existing.length > MAX_FACTS_PER_CATEGORY) {
            existing.splice(0, existing.length - MAX_FACTS_PER_CATEGORY);
        }

        log.debug('Fact stored', { category, content: content.trim().substring(0, 50) });
    }

    recordPerformance(provider, metric, responseTimeMs = 0) {
        if (!this.providerPerformance.has(provider)) {
            this.providerPerformance.set(provider, {
                totalCalls: 0,
                avgResponseTime: 0,

                scores: Object.fromEntries(
                    Object.keys(PROVIDER_PERFORMANCE_CATEGORIES).map(k => [k, 0])
                ),
            });
        }

        const perf = this.providerPerformance.get(provider);
        perf.totalCalls++;

        if (responseTimeMs > 0) {
            perf.avgResponseTime = (
                (perf.avgResponseTime * (perf.totalCalls - 1) + responseTimeMs) / perf.totalCalls
            );
        }

        if (perf.scores[metric] !== undefined) {
            perf.scores[metric]++;
        }
    }

    getFacts(category) {
        return this.facts.get(category) || [];
    }

    getAllFacts() {
        const all = {};
        for (const [category, facts] of this.facts) {
            all[category] = facts.map(f => f.content);
        }
        return all;
    }

    getPerformance(provider) {
        if (provider) return this.providerPerformance.get(provider) || null;
        const all = {};
        for (const [p, data] of this.providerPerformance) {
            all[p] = data;
        }
        return all;
    }

    getBestProvider(metric) {
        let best = null;
        let bestScore = -1;

        for (const [provider, data] of this.providerPerformance) {
            let score = 0;
            if (metric === 'fast') {
                score = data.avgResponseTime > 0 ? (1 / data.avgResponseTime) * 1000 : 0;
            } else {
                score = data.scores[metric] || 0;
            }

            if (score > bestScore) {
                bestScore = score;
                best = provider;
            }
        }

        return best;
    }

    get totalFacts() {
        let count = 0;
        for (const facts of this.facts.values()) {
            count += facts.length;
        }
        return count;
    }
}

class FactExtractor {
    constructor() {
        this.store = new FactStore();
    }

    extract(userMessage, aiResponse, metadata = {}) {
        const extractedFacts = [];

        for (const { category, patterns } of FACT_PATTERNS) {
            for (const pattern of patterns) {
                // Reset pattern.
                pattern.lastIndex = 0;
                let match;
                while ((match = pattern.exec(userMessage)) !== null) {
                    const fact = match[1];
                    if (fact && fact.length > 2 && fact.length < 100) {
                        this.store.addFact(category, fact, { source: 'user-message' });
                        extractedFacts.push(`[${category}] ${fact}`);
                    }
                }
            }
        }

        if (metadata.provider) {
            const metric = this._classifyPerformance(metadata);
            this.store.recordPerformance(
                metadata.provider,
                metric,
                metadata.responseTimeMs || 0
            );
        }

        if (extractedFacts.length > 0) {
            log.info(`Extracted ${extractedFacts.length} facts`, {
                provider: metadata.provider,
                facts: extractedFacts,
            });
        }

        return extractedFacts;
    }

    _classifyPerformance(metadata) {
        const q = metadata.qualityScore;
        if (typeof q === 'number') {

            if (q <= 1) return 'refused';
            if (q <= 3) return 'vague';
            if (q >= 8) return 'accurate';
            if (q >= 6) return 'detailed';
            return 'vague'; // 4-5: mediocre, below the 'detailed' bar
        }
        if (metadata.responseTimeMs > 30000) return 'slow';
        return 'accurate';
    }

    getRoutingContext() {
        const facts = this.store.getAllFacts();
        const lines = [];

        if (Object.keys(facts).length === 0) return '';

        for (const [category, items] of Object.entries(facts)) {
            if (items.length > 0) {
                lines.push(`${category}: ${items.slice(0, 3).join(', ')}`);
            }
        }

        const perf = this.store.getPerformance();
        for (const [provider, data] of Object.entries(perf)) {
            if (data.totalCalls >= 3) {
                const bestMetric = Object.entries(data.scores)
                    .sort(([, a], [, b]) => b - a)[0];
                lines.push(`${provider}: ${bestMetric[0]} (${data.totalCalls} calls, avg ${Math.round(data.avgResponseTime)}ms)`);
            }
        }

        return lines.join('\n');
    }

    getStore() {
        return this.store;
    }
}

export { FactExtractor, FactStore };

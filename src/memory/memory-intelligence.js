// Proxima — Memory Intelligence.
// Implements self-pruning memory store using quality scoring, decay rates, and fact harvesting.

class MemoryEntry {
    constructor(content, metadata = {}) {
        this.id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.content = content;
        this.type = metadata.type || 'conversation'; // conversation, fact, preference, project
        this.provider = metadata.provider || 'unknown';
        this.createdAt = Date.now();
        this.lastAccessedAt = Date.now();
        this.accessCount = 1;
        this.qualityScore = metadata.qualityScore || 0.5;
        this.decayScore = 1.0;
        this.tags = metadata.tags || [];
        this.archived = false;
    }
}

const DECAY_CONFIG = {
    halfLifeDays: 7,
    accessBoost: 0.15,
    minScore: 0.05,
    archiveThreshold: 0.10,
};

function calculateDecay(entry, now = Date.now()) {
    const ageDays = (now - entry.createdAt) / (1000 * 60 * 60 * 24);
    const lambda = Math.LN2 / DECAY_CONFIG.halfLifeDays;

    let score = Math.exp(-lambda * ageDays);

    const accessBoost = Math.min(entry.accessCount * DECAY_CONFIG.accessBoost, 0.5);
    score = Math.min(1.0, score + accessBoost);

    const lastAccessDays = (now - entry.lastAccessedAt) / (1000 * 60 * 60 * 24);
    if (lastAccessDays < 1) score = Math.min(1.0, score + 0.2);

    return Math.max(DECAY_CONFIG.minScore, Math.round(score * 100) / 100);
}

function scoreQuality(content) {
    let score = 0.5; // baseline

    const len = content.length;
    if (len < 20) score -= 0.2;
    else if (len > 50 && len < 500) score += 0.15;
    else if (len > 500) score += 0.1;

    const specificityPatterns = [
        /\b(version|v\d|@\d)/i,
        /\b(port|url|path|api|key)\b/i,
        /\b(always|never|must|prefer)\b/i,
        /\b(project|app|stack|use)\b/i,
        /\d{2,}/,
        /\.(js|ts|py|go|rs|java)\b/,
    ];
    for (const pat of specificityPatterns) {
        if (pat.test(content)) score += 0.05;
    }


    const lowValuePatterns = [
        /^(hi|hello|hey|ok|thanks|bye|yes|no|haan|nahi|theek)\b/i,
        /^(what time|good morning|good night)/i,
        /^(continue|go ahead|next|proceed)/i,
    ];
    for (const pat of lowValuePatterns) {
        if (pat.test(content)) score -= 0.2;
    }


    const factPatterns = [
        /\b(is|are|was|use[sd]?|prefer|run[s]?|deploy)\b.*\b(on|with|in|at|using)\b/i,
        /\b(database|frontend|backend|framework|library)\b/i,
    ];
    for (const pat of factPatterns) {
        if (pat.test(content)) score += 0.1;
    }

    return Math.max(0, Math.min(1.0, Math.round(score * 100) / 100));
}

function harvestFacts(messages) {
    const facts = [];

    const factPatterns = [
        { type: 'tech_stack', pattern: /\b(?:use|using|built with|runs on|stack is|framework)\b[:\s]+(.+)/i },
        { type: 'preference', pattern: /\b(?:prefer|always use|like to|my choice is)\b[:\s]+(.+)/i },
        { type: 'project', pattern: /\b(?:project|app|application|repo)\b[:\s]+(?:is|called|named)\b[:\s]+(.+)/i },
        { type: 'config', pattern: /\b(?:port|version|node|python|database|db)\b[:\s]+(.+)/i },
        { type: 'environment', pattern: /\b(?:os|operating system|windows|linux|mac|docker)\b/i },
        { type: 'workflow', pattern: /\b(?:deploy|ci|cd|pipeline|build)\b[:\s]+(.+)/i },
    ];

    for (const msg of messages) {
        if (!msg || msg.role !== 'user') continue;
        const content = typeof msg === 'string' ? msg : msg.content;
        if (!content || content.length < 10) continue;

        for (const { type, pattern } of factPatterns) {
            const match = content.match(pattern);
            if (match) {
                facts.push({
                    type,
                    content: match[0].trim().substring(0, 200),
                    source: content.substring(0, 80),
                    extractedAt: Date.now(),
                });
            }
        }
    }

    return facts;
}

export class IntelligentMemory {
    constructor(options = {}) {
        this.memories = new Map();
        this.facts = [];
        this.archived = [];
        this._contentIndex = new Map();
        this.maxMemories = options.maxMemories || 500;
        this.maxArchived = options.maxArchived || 200;
        this.maxFacts = options.maxFacts || 200;
        this.stats = {
            totalAdded: 0,
            totalArchived: 0,
            totalForgotten: 0,
            lastConsolidation: null,
            harvestedFacts: 0,
        };
    }

    add(content, metadata = {}) {
        const quality = scoreQuality(content);

        if (quality < 0.15) return null;

        const dupId = this._contentIndex.get(content);
        if (dupId !== undefined) {
            const existing = this.memories.get(dupId);
            if (existing) {
                existing.accessCount++;
                existing.lastAccessedAt = Date.now();
                return existing;
            }
            this._contentIndex.delete(content);
        }

        const entry = new MemoryEntry(content, { ...metadata, qualityScore: quality });
        this.memories.set(entry.id, entry);
        this._contentIndex.set(content, entry.id);
        this.stats.totalAdded++;

        if (this.memories.size > this.maxMemories) {
            this.consolidate();
        }

        return entry;
    }


    retrieve(query, limit = 10) {
        const now = Date.now();
        const queryLower = query.toLowerCase();
        const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

        const scored = [];
        for (const [id, entry] of this.memories) {
            if (entry.archived) continue;

            entry.decayScore = calculateDecay(entry, now);

            const contentLower = entry.content.toLowerCase();
            let relevance = 0;
            for (const word of queryWords) {
                if (contentLower.includes(word)) relevance += 0.2;
            }

            const combinedScore = (entry.qualityScore * 0.3) + (entry.decayScore * 0.3) + (relevance * 0.4);

            if (combinedScore > 0.1) {
                scored.push({ entry, combinedScore });
            }
        }

        scored.sort((a, b) => b.combinedScore - a.combinedScore);

        const results = scored.slice(0, limit).map(s => {
            s.entry.lastAccessedAt = now;
            s.entry.accessCount++;
            return s.entry;
        });

        return results;
    }

    harvest(messages) {
        const newFacts = harvestFacts(messages);
        this.facts.push(...newFacts);
        this.stats.harvestedFacts += newFacts.length;

        if (this.facts.length > (this.maxFacts || 200)) {
            this.facts = this.facts.slice(-(this.maxFacts || 200));
        }

        for (const fact of newFacts) {
            this.add(`[FACT:${fact.type}] ${fact.content}`, {
                type: 'fact',
                qualityScore: 0.85,
                tags: [fact.type],
            });
        }

        return newFacts;
    }

    consolidate() {
        const now = Date.now();
        const toArchive = [];

        for (const [id, entry] of this.memories) {
            entry.decayScore = calculateDecay(entry, now);

            const effectiveScore = (entry.decayScore + entry.qualityScore) / 2;
            if (effectiveScore < DECAY_CONFIG.archiveThreshold) {
                toArchive.push(id);
            }
        }

        for (const id of toArchive) {
            const entry = this.memories.get(id);
            entry.archived = true;
            this.archived.push(entry);
            this.memories.delete(id);
            this._contentIndex.delete(entry.content);
            this.stats.totalArchived++;
        }


        let forcedArchived = 0;
        if (this.memories.size > this.maxMemories) {
            const ranked = [];
            for (const [id, entry] of this.memories) {
                entry.decayScore = calculateDecay(entry, now);
                const effectiveScore = (entry.decayScore + entry.qualityScore) / 2;
                ranked.push({ id, effectiveScore });
            }
            ranked.sort((a, b) => a.effectiveScore - b.effectiveScore);

            const overflow = this.memories.size - this.maxMemories;
            for (let i = 0; i < overflow && i < ranked.length; i++) {
                const entry = this.memories.get(ranked[i].id);
                if (!entry) continue;
                entry.archived = true;
                this.archived.push(entry);
                this.memories.delete(ranked[i].id);
                this._contentIndex.delete(entry.content);
                this.stats.totalArchived++;
                forcedArchived++;
            }
        }

        if (this.archived.length > this.maxArchived) {
            const removed = this.archived.length - this.maxArchived;
            this.archived = this.archived.slice(removed);
            this.stats.totalForgotten += removed;
        }

        this.stats.lastConsolidation = now;

        return {
            archived: toArchive.length + forcedArchived,
            remaining: this.memories.size,
            totalArchived: this.archived.length,
        };
    }

    getStatus() {
        const now = Date.now();
        let totalDecay = 0, count = 0;
        for (const [, entry] of this.memories) {
            entry.decayScore = calculateDecay(entry, now);
            totalDecay += entry.decayScore;
            count++;
        }

        return {
            activeMemories: this.memories.size,
            archivedMemories: this.archived.length,
            harvestedFacts: this.facts.length,
            avgDecayScore: count > 0 ? Math.round(totalDecay / count * 100) / 100 : 0,
            avgQualityScore: count > 0 ? Math.round([...this.memories.values()].reduce((s, e) => s + e.qualityScore, 0) / count * 100) / 100 : 0,
            lastConsolidation: this.stats.lastConsolidation ? new Date(this.stats.lastConsolidation).toISOString() : 'never',
            totalProcessed: this.stats.totalAdded,
            totalForgotten: this.stats.totalForgotten,
        };
    }
}

export { calculateDecay, scoreQuality, harvestFacts, DECAY_CONFIG };

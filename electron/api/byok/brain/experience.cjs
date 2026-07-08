// Proxima — Brain Experience Store.
// Manages failure-fix pairings learned from agent executions and runtime failures.

'use strict';

const path = require('path');
const { getBrainDir, atomicWriteJSON, readJSON } = require('./paths.cjs');
const scanner = require('./scanner.cjs');

const EXPERIENCE_FILENAME = 'experience.json';
const MAX_ENTRIES = 100;
const MAX_TEXT_LENGTH = 500;
const MAX_TAGS = 10;
const DEFAULT_CONFIDENCE = 0.70;
const USE_BOOST = 0.03;
const PROMOTION_THRESHOLD = 5;
const PROMOTION_CONFIDENCE = 0.90;
const MATCH_THRESHOLD = 0.3;

function _getStorePath() {
    return path.join(getBrainDir(), EXPERIENCE_FILENAME);
}

function _loadStore() {
    const data = readJSON(_getStorePath());
    if (data && Array.isArray(data.entries)) {
        return data;
    }
    return { entries: [], updatedAt: Date.now() };
}

function _saveStore(store) {
    store.updatedAt = Date.now();
    atomicWriteJSON(_getStorePath(), store);
}

function _generateId() {
    const hex = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
    return `exp-${hex}`;
}

function _normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [...new Set(
        tags
            .filter(t => typeof t === 'string' && t.trim().length > 0)
            .map(t => t.toLowerCase().trim().replace(/[^a-z0-9-]/g, ''))
            .filter(t => t.length > 0)
    )].slice(0, MAX_TAGS);
}

function _extractKeywords(text) {
    if (!text || typeof text !== 'string') return [];

    const NOISE = new Set([
        'the', 'a', 'an', 'is', 'was', 'are', 'were', 'be', 'been',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
        'and', 'or', 'but', 'not', 'no', 'this', 'that', 'it',
        'error', 'failed', 'failure', 'exception', 'cannot', 'could',
        'unable', 'can', 'could', 'would', 'should',
    ]);

    return [...new Set(
        text.toLowerCase()
            .replace(/[^a-z0-9\s-_]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !NOISE.has(w))
    )];
}

function save(entry) {
    if (!entry || typeof entry !== 'object') {
        return { success: false, error: 'Entry must be an object' };
    }

    const { trigger, fix, context, tags, source } = entry;

    if (!trigger || typeof trigger !== 'string' || trigger.trim().length === 0) {
        return { success: false, error: 'Trigger (error description) is required' };
    }
    if (!fix || typeof fix !== 'string' || fix.trim().length === 0) {
        return { success: false, error: 'Fix (solution) is required' };
    }

    const trimmedTrigger = trigger.trim().substring(0, MAX_TEXT_LENGTH);
    const trimmedFix = fix.trim().substring(0, MAX_TEXT_LENGTH);

    const combinedContent = `${trimmedTrigger}\n${trimmedFix}`;
    const scanResult = scanner.scan(combinedContent, 'experience', { blockSeverities: ['critical'] });
    if (!scanResult.safe) {
        return { success: false, error: 'Content blocked — potential injection detected' };
    }

    const store = _loadStore();
    const id = _generateId();

    store.entries.push({
        id,
        trigger: trimmedTrigger,
        fix: trimmedFix,
        context: (context || '').trim().substring(0, 100),
        tags: _normalizeTags(tags || []),
        confidence: DEFAULT_CONFIDENCE,
        source: source || null,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        usedCount: 0,
        consecutiveSuccesses: 0,
        promotion: null,
        promotedTo: null,
    });

    if (store.entries.length > MAX_ENTRIES) {
        const overflow = store.entries.length - MAX_ENTRIES;
        const evict = new Set(
            store.entries
                .filter(e => e.id !== id)
                .sort((a, b) => (a.confidence || 0) - (b.confidence || 0))
                .slice(0, overflow)
                .map(e => e.id)
        );
        store.entries = store.entries.filter(e => !evict.has(e.id));
    }

    _saveStore(store);
    return { success: true, id };
}

function remove(id) {
    if (!id) return { success: false, error: 'ID is required' };

    const store = _loadStore();
    const index = store.entries.findIndex(e => e.id === id);

    if (index < 0) {
        return { success: false, error: `No experience with ID '${id}'` };
    }

    store.entries.splice(index, 1);
    _saveStore(store);
    return { success: true };
}

function recordUse(id) {
    if (!id) return;

    const store = _loadStore();
    const entry = store.entries.find(e => e.id === id);

    if (!entry) return;

    entry.lastUsed = Date.now();
    entry.usedCount = (entry.usedCount || 0) + 1;
    entry.consecutiveSuccesses = (entry.consecutiveSuccesses || 0) + 1;
    entry.confidence = Math.min(1.0, (entry.confidence || DEFAULT_CONFIDENCE) + USE_BOOST);

    if (
        entry.promotion === null &&
        entry.usedCount >= PROMOTION_THRESHOLD &&
        entry.confidence >= PROMOTION_CONFIDENCE
    ) {
        entry.promotion = 'skill-candidate';
        console.log(`[Brain/Experience] Entry ${id} promoted to skill-candidate (${entry.usedCount} uses, ${entry.confidence.toFixed(2)} confidence)`);
    }

    _saveStore(store);
}

function recordFailure(id) {
    if (!id) return;

    const store = _loadStore();
    const entry = store.entries.find(e => e.id === id);

    if (!entry) return;

    entry.consecutiveSuccesses = 0;
    entry.confidence = Math.max(0, (entry.confidence || DEFAULT_CONFIDENCE) - 0.10);

    if (entry.promotion === 'skill-candidate' && entry.confidence < PROMOTION_CONFIDENCE) {
        entry.promotion = null;
    }

    _saveStore(store);
}

function match(errorText, options = {}) {
    if (!errorText || typeof errorText !== 'string') return [];

    const maxResults = options.maxResults || 3;
    const queryKeywords = _extractKeywords(errorText);

    if (queryKeywords.length === 0) return [];

    const store = _loadStore();
    const scored = [];

    for (const entry of store.entries) {
        let score = 0;

        const tagOverlap = entry.tags.filter(tag =>
            queryKeywords.some(kw => tag.includes(kw) || kw.includes(tag))
        ).length;
        score += tagOverlap * 0.2;

        const triggerKeywords = _extractKeywords(entry.trigger);
        const triggerOverlap = queryKeywords.filter(kw =>
            triggerKeywords.some(tk => tk.includes(kw) || kw.includes(tk))
        ).length;

        if (triggerKeywords.length > 0) {
            score += (triggerOverlap / Math.max(queryKeywords.length, triggerKeywords.length)) * 0.6;
        }

        score *= (entry.confidence || DEFAULT_CONFIDENCE);

        if (score >= MATCH_THRESHOLD) {
            scored.push({
                id: entry.id,
                trigger: entry.trigger,
                fix: entry.fix,
                context: entry.context,
                confidence: entry.confidence,
                usedCount: entry.usedCount,
                score,
            });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
}

function formatMatched(matches) {
    if (!matches || matches.length === 0) return '';

    const lines = matches.map(m => {
        const conf = (m.confidence || 0).toFixed(2);
        const used = m.usedCount || 0;
        return `  ⚡ ${m.trigger}\n     Fix: ${m.fix}\n     (used ${used} times, confidence: ${conf})`;
    });

    return 'RELEVANT EXPERIENCE (learned fixes from past failures):\n\n' + lines.join('\n\n');
}

function list() {
    const store = _loadStore();
    return store.entries.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

function getPromotionCandidates() {
    const store = _loadStore();
    return store.entries.filter(e => e.promotion === 'skill-candidate');
}

function markPromoted(id, skillName) {
    if (!id || !skillName) {
        return { success: false, error: 'ID and skill name required' };
    }

    const store = _loadStore();
    const entry = store.entries.find(e => e.id === id);

    if (!entry) {
        return { success: false, error: `No experience with ID '${id}'` };
    }

    entry.promotion = 'promoted';
    entry.promotedTo = skillName;
    _saveStore(store);
    return { success: true };
}

function stats() {
    const store = _loadStore();
    return {
        total: store.entries.length,
        candidates: store.entries.filter(e => e.promotion === 'skill-candidate').length,
        promoted: store.entries.filter(e => e.promotion === 'promoted').length,
    };
}

module.exports = {
    save,
    remove,
    recordUse,
    recordFailure,
    match,
    formatMatched,
    list,
    getPromotionCandidates,
    markPromoted,
    stats,
    MAX_ENTRIES,
    PROMOTION_THRESHOLD,
    PROMOTION_CONFIDENCE,
};

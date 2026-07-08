// Proxima — Brain Recall.
// Manages durable, cross-session facts and proposed facts with confidence decay and category mappings.

'use strict';

const path = require('path');
const { getBrainDir, atomicWriteJSON, readJSON, ensureDir } = require('./paths.cjs');
const scanner = require('./scanner.cjs');

const RECALL_FILENAME = 'recall.json';
const MAX_FACTS = 50;
const MAX_FACT_LENGTH = 500;
const MAX_PENDING = 20;
const DEFAULT_CONFIDENCE = 0.70;
const TOUCH_BOOST = 0.02;
const DECAY_RATE = 0.05;
const EVICTION_THRESHOLD = 0.30;
const DECAY_AFTER_DAYS = 30;

const VALID_CATEGORIES = new Set([
    'preference',
    'project',
    'environment',
    'workflow',
    'contact',
    'general',
]);

function _getRecallPath() {
    return path.join(getBrainDir(), RECALL_FILENAME);
}

function _loadStore() {
    const data = readJSON(_getRecallPath());
    if (data && Array.isArray(data.facts)) {
        if (!Array.isArray(data.pending)) {
            data.pending = [];
        }
        return data;
    }
    return { facts: [], pending: [], updatedAt: Date.now() };
}

function _saveStore(store) {
    store.updatedAt = Date.now();
    atomicWriteJSON(_getRecallPath(), store);
}

function _upsertFact(store, key, text, options = {}) {
    const now = Date.now();
    const i = store.facts.findIndex(f => f.key === key);
    const fact = {
        key,
        text,
        confidence: _normalizeConfidence(options.confidence),
        category: _normalizeCategory(options.category),
        source: options.source || null,
        createdAt: i >= 0 ? store.facts[i].createdAt : now,
        lastUsed: now,
        useCount: i >= 0 ? (store.facts[i].useCount || 0) + 1 : 1,
        origin: options.origin || 'manual',
    };
    if (i >= 0) store.facts[i] = fact;
    else store.facts.push(fact);
}

function _enforceFactCap(store, protectKey) {
    if (store.facts.length <= MAX_FACTS) return;
    const overflow = store.facts.length - MAX_FACTS;
    const evict = new Set(
        store.facts
            .filter(f => f.key !== protectKey)
            .sort((a, b) => (a.confidence || 0) - (b.confidence || 0))
            .slice(0, overflow)
            .map(f => f.key)
    );
    store.facts = store.facts.filter(f => !evict.has(f.key));
}

function _normalizeCategory(category) {
    if (!category || typeof category !== 'string') return 'general';
    const lower = category.toLowerCase().trim();
    return VALID_CATEGORIES.has(lower) ? lower : 'general';
}

function _normalizeConfidence(confidence) {
    if (typeof confidence !== 'number' || isNaN(confidence)) {
        return DEFAULT_CONFIDENCE;
    }
    return Math.max(0, Math.min(1, confidence));
}

function _sanitizeKey(key) {
    if (!key || typeof key !== 'string') return null;
    const clean = key.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
    return clean.length > 0 ? clean : null;
}

function save(key, text, options = {}) {
    const safeKey = _sanitizeKey(key);
    if (!safeKey) {
        return { success: false, error: 'Invalid key — must be non-empty alphanumeric with hyphens' };
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return { success: false, error: 'Fact text cannot be empty' };
    }

    const trimmedText = text.trim().substring(0, MAX_FACT_LENGTH);

    const scanResult = scanner.scan(trimmedText, `recall:${safeKey}`, { blockSeverities: ['critical'] });
    if (!scanResult.safe) {
        return { success: false, error: `Content blocked — potential injection: ${scanResult.threats.map(t => t.name).join(', ')}` };
    }

    const store = _loadStore();
    _upsertFact(store, safeKey, trimmedText, options);
    _enforceFactCap(store, safeKey);
    _saveStore(store);
    return { success: true };
}

function propose(key, text, options = {}) {
    const safeKey = _sanitizeKey(key);
    if (!safeKey) {
        return { success: false, error: 'Invalid key' };
    }

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return { success: false, error: 'Fact text cannot be empty' };
    }

    const trimmedText = text.trim().substring(0, MAX_FACT_LENGTH);

    const scanResult = scanner.scan(trimmedText, `recall-pending:${safeKey}`);
    if (!scanResult.safe) {
        return { success: false, error: `Content blocked — potential injection` };
    }

    const store = _loadStore();

    if (store.facts.some(f => f.key === safeKey)) {
        return { success: false, error: `Fact '${safeKey}' already exists in active memory` };
    }
    if (store.pending.some(p => p.key === safeKey)) {
        return { success: false, error: `Fact '${safeKey}' already pending review` };
    }

    store.pending.push({
        key: safeKey,
        text: trimmedText,
        confidence: DEFAULT_CONFIDENCE,
        category: _normalizeCategory(options.category),
        source: options.source || null,
        reason: (options.reason || '').substring(0, 200),
        proposedAt: Date.now(),
    });

    if (store.pending.length > MAX_PENDING) {
        store.pending = store.pending.slice(-MAX_PENDING);
    }

    _saveStore(store);
    return { success: true };
}

function approve(key, overrides = {}) {
    const safeKey = _sanitizeKey(key);
    if (!safeKey) return { success: false, error: 'Invalid key' };

    const store = _loadStore();
    const pendingIndex = store.pending.findIndex(p => p.key === safeKey);

    if (pendingIndex < 0) {
        return { success: false, error: `No pending fact with key '${safeKey}'` };
    }

    const pending = store.pending[pendingIndex];

    const finalText = (overrides.text || pending.text).trim().substring(0, MAX_FACT_LENGTH);
    if (!finalText) return { success: false, error: 'Fact text cannot be empty' };
    const finalCategory = _normalizeCategory(overrides.category || pending.category);

    const scanResult = scanner.scan(finalText, `recall:${safeKey}`, { blockSeverities: ['critical'] });
    if (!scanResult.safe) {
        return { success: false, error: `Content blocked — potential injection: ${scanResult.threats.map(t => t.name).join(', ')}` };
    }

    store.pending.splice(pendingIndex, 1);
    _upsertFact(store, safeKey, finalText, {
        confidence: 0.90,
        category: finalCategory,
        source: pending.source,
        origin: 'approved',
    });
    _enforceFactCap(store, safeKey);
    _saveStore(store);
    return { success: true };
}

function reject(key) {
    const safeKey = _sanitizeKey(key);
    if (!safeKey) return { success: false, error: 'Invalid key' };

    const store = _loadStore();
    const pendingIndex = store.pending.findIndex(p => p.key === safeKey);

    if (pendingIndex < 0) {
        return { success: false, error: `No pending fact with key '${safeKey}'` };
    }

    store.pending.splice(pendingIndex, 1);
    _saveStore(store);
    return { success: true };
}

function remove(key) {
    const safeKey = _sanitizeKey(key);
    if (!safeKey) return { success: false, error: 'Invalid key' };

    const store = _loadStore();
    const index = store.facts.findIndex(f => f.key === safeKey);

    if (index < 0) {
        return { success: false, error: `No fact with key '${safeKey}'` };
    }

    store.facts.splice(index, 1);
    _saveStore(store);
    return { success: true };
}

function touch(key) {
    const safeKey = _sanitizeKey(key);
    if (!safeKey) return;

    const store = _loadStore();
    const fact = store.facts.find(f => f.key === safeKey);

    if (fact) {
        fact.lastUsed = Date.now();
        fact.useCount = (fact.useCount || 0) + 1;
        fact.confidence = Math.min(1.0, (fact.confidence || DEFAULT_CONFIDENCE) + TOUCH_BOOST);
        _saveStore(store);
    }
}

function decay() {
    const store = _loadStore();
    const now = Date.now();
    const decayThreshold = DECAY_AFTER_DAYS * 24 * 60 * 60 * 1000;

    let decayed = 0;
    let evicted = 0;

    store.facts = store.facts.filter(fact => {
        const daysSinceUse = now - (fact.lastUsed || fact.createdAt || 0);

        if (daysSinceUse > decayThreshold) {
            fact.confidence = Math.max(0, (fact.confidence || DEFAULT_CONFIDENCE) - DECAY_RATE);
            decayed++;

            if (fact.confidence < EVICTION_THRESHOLD) {
                evicted++;
                return false;
            }
        }

        return true;
    });

    if (decayed > 0 || evicted > 0) {
        _saveStore(store);
        console.log(`[Brain/Recall] Decay pass: ${decayed} decayed, ${evicted} evicted`);
    }

    return { decayed, evicted };
}

function list(options = {}) {
    const store = _loadStore();
    let facts = store.facts;

    if (options.category) {
        const cat = _normalizeCategory(options.category);
        facts = facts.filter(f => f.category === cat);
    }

    return facts.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

function listPending() {
    const store = _loadStore();
    return store.pending.sort((a, b) => (b.proposedAt || 0) - (a.proposedAt || 0));
}

function format() {
    const facts = list();
    if (facts.length === 0) return '';

    const lines = facts.map(f => {
        const conf = f.confidence ? f.confidence.toFixed(2) : '0.70';
        return `  [${conf}] ${f.text}`;
    });

    return 'PERSISTENT MEMORY (facts from previous sessions):\n' + lines.join('\n');
}

function stats() {
    const store = _loadStore();
    const categories = {};
    for (const fact of store.facts) {
        const cat = fact.category || 'general';
        categories[cat] = (categories[cat] || 0) + 1;
    }

    return {
        active: store.facts.length,
        pending: store.pending.length,
        categories,
    };
}

module.exports = {
    save,
    propose,
    approve,
    reject,
    remove,
    touch,
    decay,

    list,
    listPending,
    format,
    stats,

    MAX_FACTS,
    MAX_PENDING,
    VALID_CATEGORIES,
};

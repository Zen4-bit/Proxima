// Proxima — Brain Orchestrator.
// Aggregates knowledge, experiences, skills, and project files into the volatile system prompt under token budgets.

'use strict';

const recall = require('./recall.cjs');
const experience = require('./experience.cjs');
const skills = require('./skills.cjs');
const scanner = require('./scanner.cjs');
const sessions = require('./sessions.cjs');
const discovery = require('../discovery/index.cjs');

const DEFAULT_VOLATILE_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;

const SECTION_WEIGHTS = {
    recall:     1.0,
    discovery:  0.9,
    experience: 0.7,
    skills:     0.6,
};

const SECTION_LIMITS = {
    recall:     { min: 200, max: 1500 },
    experience: { min: 0,   max: 1000 },
    skills:     { min: 0,   max: 1500 },
    discovery:  { min: 0,   max: 2000 },
};

function _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function _truncateToTokens(text, maxTokens) {
    if (!text) return '';

    const maxChars = maxTokens * CHARS_PER_TOKEN;
    if (text.length <= maxChars) return text;

    const cut = text.substring(0, maxChars);
    const lastNewline = cut.lastIndexOf('\n');
    const truncated = lastNewline > 0 ? cut.substring(0, lastNewline) : cut;

    return truncated + '\n  [... truncated to fit token budget]';
}

function _allocateBudget(sections, totalBudget = DEFAULT_VOLATILE_BUDGET) {
    const result = {};

    const presentSections = {};
    let totalWeight = 0;

    for (const [name, content] of Object.entries(sections)) {
        const tokens = _estimateTokens(content);
        if (tokens > 0) {
            presentSections[name] = { content, tokens };
            totalWeight += SECTION_WEIGHTS[name] || 0.5;
        }
    }

    if (totalWeight === 0) return result;

    let remainingBudget = totalBudget;

    for (const [name, data] of Object.entries(presentSections)) {
        const weight = SECTION_WEIGHTS[name] || 0.5;
        const limits = SECTION_LIMITS[name] || { min: 0, max: 2000 };

        let allocated = Math.floor((weight / totalWeight) * totalBudget);
        allocated = Math.max(limits.min, Math.min(limits.max, allocated));
        allocated = Math.min(allocated, data.tokens);

        result[name] = {
            content: data.tokens <= allocated
                ? data.content
                : _truncateToTokens(data.content, allocated),
            tokens: Math.min(data.tokens, allocated),
            allocated,
        };

        remainingBudget -= result[name].tokens;
    }

    if (remainingBudget > 0) {
        for (const [name, data] of Object.entries(presentSections)) {
            if (!result[name]) continue;

            const current = result[name].tokens;
            const needed = data.tokens;

            if (current < needed) {
                const extra = Math.min(remainingBudget, needed - current);
                const limits = SECTION_LIMITS[name] || { max: 2000 };

                if (current + extra <= limits.max) {
                    result[name] = {
                        content: _truncateToTokens(data.content, current + extra),
                        tokens: current + extra,
                        allocated: current + extra,
                    };
                    remainingBudget -= extra;
                }
            }

            if (remainingBudget <= 0) break;
        }
    }

    return result;
}

function buildVolatile(options = {}) {
    const { userMessage, cwd, errorContext, model, provider, budget } = options;

    const recallBlock = recall.format();

    const matchContext = errorContext || userMessage || '';
    const experienceMatches = matchContext ? experience.match(matchContext) : [];
    const experienceBlock = experience.formatMatched(experienceMatches);

    const skillMatches = userMessage ? skills.match(userMessage) : [];
    const skillsBlock = skills.formatMatched(skillMatches);

    const discoveryResult = cwd ? discovery.scan(cwd) : { files: [] };
    const discoveryBlock = discovery.format(discoveryResult);

    const rawSections = {
        recall: recallBlock,
        experience: experienceBlock,
        skills: skillsBlock,
        discovery: discoveryBlock,
    };

    const allocated = _allocateBudget(rawSections, budget || DEFAULT_VOLATILE_BUDGET);

    const parts = [];

    if (allocated.recall)     parts.push(allocated.recall.content);
    if (allocated.discovery)  parts.push(allocated.discovery.content);
    if (allocated.experience) parts.push(allocated.experience.content);
    if (allocated.skills)     parts.push(allocated.skills.content);

    const now = new Date();
    let metaLine = `Current time: ${now.toLocaleString('en-US', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })}`;
    if (model) metaLine += ` | Model: ${model}`;
    if (provider) metaLine += ` | Provider: ${provider}`;
    parts.push(metaLine);

    const stats = {
        recall:     { tokens: allocated.recall?.tokens || 0, items: recall.list().length },
        experience: { tokens: allocated.experience?.tokens || 0, matches: experienceMatches.length },
        skills:     { tokens: allocated.skills?.tokens || 0, matches: skillMatches.length },
        discovery:  { tokens: allocated.discovery?.tokens || 0, files: discoveryResult.files.length },
        totalTokens: Object.values(allocated).reduce((sum, a) => sum + (a?.tokens || 0), 0),
        budget: budget || DEFAULT_VOLATILE_BUDGET,
    };

    return {
        block: parts.filter(Boolean).join('\n\n'),
        stats,
    };
}

function sessionStart() {
    const decayResult = recall.decay();
    const recallStats = recall.stats();
    const expStats = experience.stats();

    console.log(
        `[Brain] Session start — ` +
        `Recall: ${recallStats.active} facts (${recallStats.pending} pending) | ` +
        `Experience: ${expStats.total} entries (${expStats.candidates} candidates) | ` +
        `Decay: ${decayResult.decayed} decayed, ${decayResult.evicted} evicted`
    );
}

function getStats() {
    let sessionStats = { sessions: 0, chunks: 0 };
    try { sessionStats = sessions.stats(); } catch { }

    return {
        recall: recall.stats(),
        experience: experience.stats(),
        skills: { total: skills.list().length },
        sessions: sessionStats,
    };
}

module.exports = {
    buildVolatile,
    sessionStart,
    getStats,

    recall,
    experience,
    skills,
    scanner,
    sessions,

    DEFAULT_VOLATILE_BUDGET,
    SECTION_WEIGHTS,
    SECTION_LIMITS,
};

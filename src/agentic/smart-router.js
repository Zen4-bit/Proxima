// Proxima — Smart Router.
// Performs task-aware provider routing based on capability profiles, EMA latencies, and health.

const PROVIDER_PROFILES = {
    claude: {
        strengths: ['code-review', 'security', 'architecture', 'reasoning', 'debugging', 'refactoring'],
        weaknesses: ['web-search', 'current-events'],
        speedTier: 1,
        qualityTier: 1,
    },
    chatgpt: {
        strengths: ['code-gen', 'creative', 'explanation', 'general', 'translation', 'writing'],
        weaknesses: ['web-search'],
        speedTier: 2,
        qualityTier: 1,
    },
    gemini: {
        strengths: ['analysis', 'multimodal', 'research', 'code-gen', 'math', 'data'],
        weaknesses: [],
        speedTier: 2,
        qualityTier: 2,
    },
    perplexity: {
        strengths: ['web-search', 'citations', 'current-events', 'fact-check', 'research', 'news'],
        weaknesses: ['code-gen', 'creative'],
        speedTier: 3,
        qualityTier: 2,
    }
};

const TASK_PATTERNS = {
    'code-review': /\b(review|audit|check|inspect|lint|quality)\b.*\b(code|function|class|module)\b/i,
    'code-gen': /\b(write|create|generate|build|implement|make|code)\b.*\b(function|class|component|api|app|script|code|program)\b/i,
    'security': /\b(security|vulnerability|exploit|injection|xss|csrf|auth|penetration|hack)\b/i,
    'web-search': /\b(search|find|latest|current|today|news|recent|2024|2025|2026)\b/i,
    'research': /\b(research|compare|analyze|study|investigate|explore|deep.?dive)\b/i,
    'creative': /\b(write|story|poem|creative|imagine|brainstorm|idea|blog|article)\b/i,
    'explanation': /\b(explain|what is|how does|why|teach|understand|learn|eli5)\b/i,
    'debugging': /\b(debug|fix|error|bug|issue|broken|crash|fail|not working)\b/i,
    'architecture': /\b(architect|design|structure|pattern|scale|system|infrastructure)\b/i,
    'translation': /\b(translate|convert|transform|port|migrate|from .* to)\b/i,
    'math': /\b(calculate|math|equation|formula|statistics|probability|algebra)\b/i,
    'fact-check': /\b(verify|fact.?check|is it true|confirm|accurate)\b/i,
    'refactoring': /\b(refactor|improve|optimize|clean.?up|simplify|modernize)\b/i,
};

class SmartRouter {
    constructor() {
        this.metrics = {};
        for (const p of Object.keys(PROVIDER_PROFILES)) {
            this.metrics[p] = this._createMetricsEntry();
        }

        this._recoveryCooldownMs = 60000;
    }

    _createMetricsEntry() {
        return {
            totalCalls: 0,
            totalErrors: 0,
            avgResponseMs: 0,
            lastResponseMs: 0,
            lastError: null,
            lastErrorAt: null,
            lastSeen: null,
            isHealthy: true,
            consecutiveErrors: 0,
        };
    }

    _ensureMetrics(name) {
        const base = this._baseProvider(name);
        if (!this.metrics[base]) {
            this.metrics[base] = this._createMetricsEntry();
        }
        return this.metrics[base];
    }


    _baseProvider(providerName) {
        if (typeof providerName !== 'string') return providerName;
        return providerName.split(':')[0];
    }


    _applyRecovery(m) {
        if (!m || m.consecutiveErrors <= 0) return;
        const ref = m.lastErrorAt || m.lastSeen;
        if (ref && (Date.now() - ref) > this._recoveryCooldownMs) {
            m.consecutiveErrors = 0;
            m.isHealthy = true;
        }
    }

    classifyTask(message) {
        const detected = [];
        for (const [type, pattern] of Object.entries(TASK_PATTERNS)) {
            if (pattern.test(message)) {
                detected.push(type);
            }
        }
        return detected.length > 0 ? detected : ['general'];
    }


    _scoreProviders(taskTypes, enabledProviders, options = {}) {
        const { preferSpeed = false, preferQuality = true, exclude = [] } = options;
        const scores = {};

        for (const providerName of enabledProviders) {
            if (exclude.includes(providerName)) continue;
            const profile = PROVIDER_PROFILES[providerName];


            let score = 50;

            if (profile) {
                for (const task of taskTypes) {
                    if (profile.strengths.includes(task)) score += 20;
                    if (profile.weaknesses.includes(task)) score -= 15;
                }
                if (preferSpeed) score += (4 - profile.speedTier) * 10;
                if (preferQuality) score += (3 - profile.qualityTier) * 10;
            }


            const health = this._ensureMetrics(providerName);
            this._applyRecovery(health);
            if (!health.isHealthy) score -= 30;
            if (health.consecutiveErrors > 2) score -= 50;
            if (health.avgResponseMs > 0) {
                score += Math.max(0, 10 - (health.avgResponseMs / 1000));
            }

            scores[providerName] = score;
        }

        return Object.entries(scores).sort((a, b) => b[1] - a[1]);
    }


    pickByTaskType(taskType, enabledProviders, options = {}) {

        const TASK_MAP = {
            coding: ['code-gen', 'code-review', 'debugging', 'refactoring'],
            review: ['code-review', 'security'],
            research: ['research', 'web-search', 'fact-check'],
            general: ['explanation'],
        };
        const taskTypes = TASK_MAP[taskType] || ['general'];
        const sorted = this._scoreProviders(taskTypes, enabledProviders, options);
        return sorted.length > 0 ? sorted[0][0] : null;
    }

    route(message, enabledProviders, options = {}) {
        const taskTypes = this.classifyTask(message);
        const sorted = this._scoreProviders(taskTypes, enabledProviders, options);

        if (sorted.length === 0) {

            return { provider: [...enabledProviders][0], score: 0, reason: 'fallback — no scored providers', taskTypes, allScores: {} };
        }

        const [bestProvider, bestScore] = sorted[0];
        const reasons = taskTypes.map(t => {
            const profile = PROVIDER_PROFILES[bestProvider];
            return profile?.strengths.includes(t) ? `best-at: ${t}` : null;
        }).filter(Boolean);

        return {
            provider: bestProvider,
            score: bestScore,
            reason: reasons.length > 0 ? reasons.join(', ') : 'highest overall score',
            taskTypes,
            allScores: Object.fromEntries(sorted),
        };
    }

    recordSuccess(providerName, responseMs) {
        const m = this._ensureMetrics(providerName);
        m.totalCalls++;
        m.lastResponseMs = responseMs;
        m.avgResponseMs = m.avgResponseMs === 0
            ? responseMs
            : Math.round((m.avgResponseMs * 0.7) + (responseMs * 0.3));
        m.lastSeen = Date.now();
        m.isHealthy = true;
        m.consecutiveErrors = 0;
    }

    recordError(providerName, error) {
        const m = this._ensureMetrics(providerName);
        m.totalCalls++;
        m.totalErrors++;
        m.consecutiveErrors++;
        m.lastError = error?.message || String(error);
        m.lastErrorAt = Date.now();
        m.lastSeen = Date.now();
        if (m.consecutiveErrors >= 3) {
            m.isHealthy = false;
        }
    }

    getHealthReport(enabledProviders, isApiMode = false) {
        const report = {};
        const allNames = new Set([
            ...Object.keys(this.metrics),
            ...(enabledProviders || []),
        ]);
        for (const name of allNames) {
            const m = this._ensureMetrics(name);
            const enabled = enabledProviders ? enabledProviders.has(name) : true;
            const hasProfile = !!PROVIDER_PROFILES[name];

            let mode;
            if (isApiMode) {
                mode = 'api';
            } else if (hasProfile) {
                mode = 'session';
            } else {
                mode = 'api-only';
            }

            report[name] = {
                status: !enabled ? 'disabled'
                    : m.totalCalls === 0 ? 'ready'
                    : m.isHealthy ? 'healthy'
                    : 'degraded',
                mode,
                calls: m.totalCalls,
                errors: m.totalErrors,
                errorRate: m.totalCalls > 0 ? `${((m.totalErrors / m.totalCalls) * 100).toFixed(1)}%` : '0%',
                avgResponseSec: m.avgResponseMs > 0 ? (m.avgResponseMs / 1000).toFixed(1) + 's' : 'n/a',
                consecutiveErrors: m.consecutiveErrors,
            };
        }
        return report;
    }
}

export { SmartRouter, PROVIDER_PROFILES, TASK_PATTERNS };

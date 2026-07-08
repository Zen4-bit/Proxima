// Proxima — Context7 Middleware.
// Automatically detects library mentions and injects up-to-date documentation into prompts.

const LIBRARY_PATTERNS = [

    { name: 'react', pattern: /\b(react|react\.js|reactjs|jsx|hooks?|usestate|useeffect|use\(\))\b/i },
    { name: 'next.js', pattern: /\b(next\.?js|nextjs|app\s*router|server\s*components?|next\/\w+)\b/i },
    { name: 'vue', pattern: /\b(vue|vue\.?js|vuejs|composition\s*api|vuex|pinia)\b/i },
    { name: 'angular', pattern: /\b(angular|angularjs|ng-\w+|@angular)\b/i },
    { name: 'svelte', pattern: /\b(svelte|sveltekit|svelte\s*kit)\b/i },
    { name: 'express', pattern: /\b(express|express\.?js|expressjs|app\.get|app\.post|middleware)\b/i },
    { name: 'fastify', pattern: /\b(fastify)\b/i },
    { name: 'prisma', pattern: /\b(prisma|prisma\s*client|prisma\s*schema)\b/i },
    { name: 'drizzle', pattern: /\b(drizzle|drizzle\s*orm)\b/i },
    { name: 'tailwindcss', pattern: /\b(tailwind|tailwindcss|tailwind\s*css)\b/i },
    { name: 'typescript', pattern: /\b(typescript|tsconfig|ts\s*compiler|type\s*inference)\b/i },
    { name: 'zod', pattern: /\b(zod|z\.string|z\.object|zod\s*schema)\b/i },
    { name: 'vite', pattern: /\b(vite|vite\.config|vitejs)\b/i },
    { name: 'electron', pattern: /\b(electron|electron\.js|ipcmain|ipcrenderer|browserwindow)\b/i },


    { name: 'fastapi', pattern: /\b(fastapi|fast\s*api)\b/i },
    { name: 'django', pattern: /\b(django|django\s*rest|drf)\b/i },
    { name: 'flask', pattern: /\b(flask)\b/i },
    { name: 'pytorch', pattern: /\b(pytorch|torch|torch\.nn)\b/i },
    { name: 'tensorflow', pattern: /\b(tensorflow|tf\.\w+|keras)\b/i },
    { name: 'langchain', pattern: /\b(langchain)\b/i },
    { name: 'pandas', pattern: /\b(pandas|dataframe|pd\.\w+)\b/i },


    { name: 'docker', pattern: /\b(docker|dockerfile|docker\s*compose|docker-compose)\b/i },
    { name: 'kubernetes', pattern: /\b(kubernetes|k8s|kubectl|helm)\b/i },
    { name: 'postgres', pattern: /\b(postgres|postgresql|pg_\w+|psql)\b/i },
    { name: 'mongodb', pattern: /\b(mongodb|mongoose|mongo\s*client)\b/i },
    { name: 'redis', pattern: /\b(redis|ioredis|redis\s*client)\b/i },
    { name: 'graphql', pattern: /\b(graphql|gql|apollo|schema\.graphql)\b/i },
];

const CONTEXT7_API = 'https://mcp.context7.com';

const CONTEXT7_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTEXT7_CACHE_MAX = 200;
const _context7Cache = new Map(); // key -> { value, expires }


function isContext7Enabled() {
    return process.env.PROXIMA_CONTEXT7 === '1';
}

export function detectLibraries(message) {    const detected = [];
    for (const lib of LIBRARY_PATTERNS) {
        if (lib.pattern.test(message)) {
            detected.push(lib.name);
        }
    }
    return [...new Set(detected)];
}

function context7CacheKey(libraryName, topic) {
    const topicPart = (topic || '').slice(0, 80);
    return `${libraryName}:${topicPart}`;
}


async function fetchContext7Docs(libraryName, topic) {
    const cacheKey = context7CacheKey(libraryName, topic);
    const now = Date.now();

    const cached = _context7Cache.get(cacheKey);
    if (cached && cached.expires > now) {
        return cached.value;
    }
    if (cached) {
        _context7Cache.delete(cacheKey);
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(`${CONTEXT7_API}/v1/context`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                library: libraryName,
                query: topic,
                maxTokens: 2000,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) return null;
        const data = await response.json();
        const value = data.context || null;
        _cacheContext7(cacheKey, value, now);
        return value;
    } catch (e) {

        return null;
    }
}

function _cacheContext7(key, value, now = Date.now()) {
    if (_context7Cache.size >= CONTEXT7_CACHE_MAX) {
        const oldestKey = _context7Cache.keys().next().value;
        if (oldestKey !== undefined) _context7Cache.delete(oldestKey);
    }
    _context7Cache.set(key, { value, expires: now + CONTEXT7_CACHE_TTL_MS });
}

export async function contextMiddleware(message, options = {}) {
    const {
        enabled = true,
        maxLibraries = 2,
        minMessageLength = 30,
    } = options;


    if (!isContext7Enabled() || !enabled || message.length < minMessageLength) {
        return { enhancedMessage: message, injected: [], skipped: true };
    }

    const libraries = detectLibraries(message);
    if (libraries.length === 0) {
        return { enhancedMessage: message, injected: [], skipped: true };
    }

    const toFetch = libraries.slice(0, maxLibraries);
    const results = await Promise.allSettled(
        toFetch.map(lib => fetchContext7Docs(lib, message))
    );

    const injectedDocs = [];
    const injectedNames = [];

    for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled' && results[i].value) {
            injectedDocs.push(`[📚 ${toFetch[i]} Latest Docs]\n${results[i].value}`);
            injectedNames.push(toFetch[i]);
        }
    }

    if (injectedDocs.length === 0) {
        return { enhancedMessage: message, injected: [], skipped: true };
    }

    const enhancedMessage = injectedDocs.join('\n\n') + '\n\n---\n\n' + message;

    return {
        enhancedMessage,
        injected: injectedNames,
        skipped: false,
    };
}

let contextStats = {
    totalChecks: 0,
    totalInjections: 0,
    libraryHits: {},
    failures: 0,
};

export function getContextStats() {
    return { ...contextStats };
}

export function recordContextUse(libraries) {
    contextStats.totalChecks++;
    if (libraries.length > 0) {
        contextStats.totalInjections++;
        for (const lib of libraries) {
            contextStats.libraryHits[lib] = (contextStats.libraryHits[lib] || 0) + 1;
        }
    }
}

export { LIBRARY_PATTERNS };

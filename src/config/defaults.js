// Proxima — Central Application Defaults.
// Contains configurable limits, timeouts, routing thresholds, and provider details.

export const DEFAULTS = {

    IPC_PORT: 19222,
    IPC_CONNECT_TIMEOUT_MS: 10000,
    IPC_REQUEST_TIMEOUT_MS: 120000,


    PIPELINE_TIMEOUT_MS: 180000,
    MAX_MESSAGE_LENGTH: 50000,
    MAX_FILE_SIZE_CHARS: 50000,


    MAX_RETRIES: 2,
    RETRY_BASE_DELAY_MS: 1000,
    RETRY_MAX_DELAY_MS: 10000,
    RETRY_JITTER_MS: 500,

    RPM_LIMIT: 10,
    RPM_WINDOW_MS: 60000,


    PROVIDER_ORDER: ['chatgpt', 'claude', 'perplexity', 'gemini'],
    PROVIDER_HEALTH_CHECK_INTERVAL_MS: 60000,

    ROUTER_SCORE_THRESHOLD: 15,
    ROUTER_EMA_WEIGHT: 0.3,


    RUN_LOOP_DEFAULT_MAX_TURNS: 3,
    RUN_LOOP_CONVERGENCE_THRESHOLD: 0.85,


    MEMORY_MAX_ENTRIES: 500,
    MEMORY_MAX_FACTS: 100,
    MEMORY_MAX_MESSAGE_LENGTH: 2000,
    MEMORY_AUTOSUMMARIZE_THRESHOLD: 20,


    COST_DATA_PATH: 'data/cost-data.json',
    TOKENS_PER_DOLLAR: {
        chatgpt: 1000000,
        claude: 800000,
        gemini: 1500000,
        perplexity: 1000000,
    },


    MCP_SERVER_NAME: 'agent-hub',
    MCP_SERVER_VERSION: '5.0.0',
    API_PORT: 3210,
};

export const PROVIDER_INFO = {
    chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
    claude: { name: 'Claude', url: 'https://claude.ai/' },
    gemini: { name: 'Gemini', url: 'https://gemini.google.com/app' },
    perplexity: { name: 'Perplexity', url: 'https://www.perplexity.ai/' },
};

// Proxima — Custom Error Hierarchy.
// Defines custom classes (AppError, ProviderError, RateLimitError, AuthError, TimeoutError) for request errors.

class AppError extends Error {
    constructor(message, options = {}) {
        super(message);
        this.name = 'AppError';
        this.code = options.code || 'APP_ERROR';
        this.statusCode = options.statusCode || 500;
        this.context = options.context || {};
        this.retryable = options.retryable || false;
        this.timestamp = new Date().toISOString();
        this.cause = options.cause || null;


        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            statusCode: this.statusCode,
            context: this.context,
            retryable: this.retryable,
            timestamp: this.timestamp,
            cause: this.cause ? {
                name: this.cause.name,
                message: this.cause.message,
            } : null,
        };
    }
}

class ProviderError extends AppError {
    constructor(provider, message, options = {}) {
        super(message, {
            code: options.code || 'PROVIDER_ERROR',
            statusCode: options.statusCode || 502,
            context: { provider, ...options.context },
            retryable: options.retryable ?? true,
            cause: options.cause,
        });
        this.name = 'ProviderError';
        this.provider = provider;
    }
}

class RateLimitError extends ProviderError {
    constructor(provider, retryAfterMs = 60000) {
        super(provider, `${provider} rate limited — retry after ${retryAfterMs}ms`, {
            code: 'RATE_LIMIT',
            statusCode: 429,
            retryable: true,
            context: { retryAfterMs },
        });
        this.name = 'RateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

class AuthError extends ProviderError {
    constructor(provider) {
        super(provider, `${provider} authentication failed — session expired`, {
            code: 'AUTH_ERROR',
            statusCode: 401,
            retryable: false,
        });
        this.name = 'AuthError';
    }
}

class TimeoutError extends ProviderError {
    constructor(provider, timeoutMs) {
        super(provider, `${provider} timed out after ${timeoutMs}ms`, {
            code: 'TIMEOUT',
            statusCode: 504,
            retryable: true,
            context: { timeoutMs },
        });
        this.name = 'TimeoutError';
    }
}

export {
    AppError,
    ProviderError,
    RateLimitError,
    AuthError,
    TimeoutError,
};

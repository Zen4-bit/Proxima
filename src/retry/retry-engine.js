// Proxima — Smart Retry Engine.
// Provides exponential backoff with jitter, retryable-error classification, and rate-limiting.

import { DEFAULTS } from '../config/defaults.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const getRetryDelayMs = (attempt, retryDelaySeconds = 1, retryAfterSeconds) => {
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  const base = retryDelaySeconds * 1000;
  const exponential = base * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.random() * base;

  const maxDelay = DEFAULTS.RETRY_MAX_DELAY_MS || 10000;
  return Math.min(exponential + jitter, maxDelay);
};

export const shouldRetry = (error, attempt, maxRetries = 3) => {
  if (attempt >= maxRetries) return false;


  if (error && typeof error.retryable === 'boolean') {
    return error.retryable;
  }


  const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
  const statusCandidates = [error?.status, error?.statusCode, error?.code];
  let sawNumericStatus = false;
  for (const c of statusCandidates) {
    const n = typeof c === 'number' ? c : (typeof c === 'string' && /^\d+$/.test(c.trim()) ? Number(c) : NaN);
    if (!Number.isNaN(n)) {
      sawNumericStatus = true;
      if (RETRYABLE_STATUS.has(n)) return true;
    }
  }

  const message = (error?.message || '').toLowerCase();

  if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout')) return true;
  if (message.includes('network') || message.includes('econnreset') || message.includes('econnrefused') || message.includes('fetch failed')) return true;
  if (message.includes('rate limit') || message.includes('too many requests')) return true;


  if (/\b(429|500|502|503|504)\b/.test(message)) return true;

  return false;
};

export async function withRetry(fn, options = {}) {
  const { maxRetries = 3, baseDelay = 1, label = 'operation' } = options;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error, attempt, maxRetries)) {
        throw error;
      }
      const delay = getRetryDelayMs(attempt + 1, baseDelay);

      console.error(`[Retry] ${label} failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }
  throw lastError;
}


export class RPMController {
  constructor(maxRPM = null) {
    this.maxRPM = maxRPM;
    this._currentRPM = 0;
    this._timer = null;

    if (this.maxRPM !== null) {
      this._resetTimer();
    }
  }

  async checkOrWait() {
    if (this.maxRPM === null) return true;

    if (this._currentRPM < this.maxRPM) {
      this._currentRPM++;
      return true;
    }

    console.error(`[RPM] Max ${this.maxRPM} RPM reached, waiting for next minute...`);
    await sleep(60000);
    this._currentRPM = 1;
    return true;
  }

  getStatus() {
    return {
      current: this._currentRPM,
      max: this.maxRPM,
      available: this.maxRPM ? this.maxRPM - this._currentRPM : Infinity,
    };
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _resetTimer() {
    this._timer = setInterval(() => {
      this._currentRPM = 0;
    }, 60000);

    if (this._timer.unref) this._timer.unref();
  }
}

export default { sleep, getRetryDelayMs, shouldRetry, withRetry, RPMController };

// Proxima — Token Tracker.
// Tracks session token usage, estimates cost savings, and provides language-aware token estimation.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../utils/paths.js';

const DATA_DIR = getDataDir();
const COST_LOG_PATH = join(DATA_DIR, 'cost-log.json');

// Provider pricing per 1M tokens.
const MODEL_PRICING = {
  'chatgpt':     { input: 5.00,   output: 15.00 },
  'claude':      { input: 4.00,   output: 20.00 },
  'gemini':      { input: 2.50,   output: 10.00 },
  'perplexity':  { input: 5.00,   output: 20.00 },
  'default':     { input: 5.00,   output: 20.00 },
};


function _pricingKey(model) {
  if (!model || typeof model !== 'string') return 'default';
  const m = model.toLowerCase().split(':')[0].split('@')[0].trim();
  if (MODEL_PRICING[m]) return m;
  if (m.includes('gpt') || m.includes('openai') || /^o[134]\b/.test(m)) return 'chatgpt';
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku')) return 'claude';
  if (m.includes('gemini') || m.includes('bison') || m.includes('palm')) return 'gemini';
  if (m.includes('sonar') || m.includes('perplexity') || m.includes('pplx')) return 'perplexity';
  return 'default';
}

export class TokenTracker {
  constructor() {
    this.sessions = {};
    this._totalPromptTokens = 0;
    this._totalCompletionTokens = 0;
    this._totalRequests = 0;
    this._totalCostSaved = 0;
    this._sessionStart = new Date().toISOString();
  }

  logUsage({ model, provider, promptTokens, completionTokens, cachedTokens = 0 }) {
    this._totalPromptTokens += promptTokens;
    this._totalCompletionTokens += completionTokens;
    this._totalRequests++;


    const pricing = MODEL_PRICING[_pricingKey(model)];
    const inputCost = (promptTokens / 1_000_000) * pricing.input;
    const outputCost = (completionTokens / 1_000_000) * pricing.output;
    const totalCost = inputCost + outputCost;
    this._totalCostSaved += totalCost;

    if (!this.sessions[provider]) {
      this.sessions[provider] = {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        costSaved: 0,
      };
    }
    const s = this.sessions[provider];
    s.requests++;
    s.promptTokens += promptTokens;
    s.completionTokens += completionTokens;
    s.cachedTokens += cachedTokens;
    s.costSaved += totalCost;

    return {
      requestCost: totalCost,
      totalSaved: this._totalCostSaved,
    };
  }


  static estimateTokens(text, ext) {
    if (!text) return 0;


    const LANG_RATIOS = {
      '.json': 5.5,
      '.xml': 5.0,
      '.html': 5.0,
      '.yaml': 4.2,
      '.yml': 4.2,
      '.md': 4.5,
      '.txt': 4.5,
      '.py': 3.5,
      '.rb': 3.5,
      '.go': 3.8,
      '.rs': 3.6,
      '.js': 3.8,
      '.jsx': 3.8,
      '.ts': 3.8,
      '.tsx': 3.8,
      '.java': 4.0,
      '.cs': 4.0,
      '.cpp': 3.7,
      '.c': 3.7,
      '.css': 4.5,
      '.sql': 4.0,
      '.sh': 3.5,
    };

    const ratio = ext ? (LANG_RATIOS[ext.toLowerCase()] || 4.0) : 4.0;
    return Math.ceil(text.length / ratio);
  }

  static estimateTokensForFiles(files) {
    const perFile = {};
    let total = 0;
    for (const file of files) {
      const ext = file.path ? '.' + file.path.split('.').pop() : undefined;
      const tokens = TokenTracker.estimateTokens(file.content, ext);
      perFile[file.path || 'unknown'] = tokens;
      total += tokens;
    }
    return { total, perFile };
  }

  getReport() {
    return {
      sessionStart: this._sessionStart,
      totalRequests: this._totalRequests,
      totalPromptTokens: this._totalPromptTokens,
      totalCompletionTokens: this._totalCompletionTokens,
      totalTokens: this._totalPromptTokens + this._totalCompletionTokens,
      totalCostSaved: `$${this._totalCostSaved.toFixed(4)}`,
      totalCostSavedINR: `₹${(this._totalCostSaved * 85).toFixed(2)}`,
      providers: this.sessions,
      message: `You saved ${(this._totalCostSaved * 85).toFixed(0)} rupees by using Proxima instead of API keys!`,
    };
  }

  saveReport() {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

    let logs = [];
    if (existsSync(COST_LOG_PATH)) {
      try { logs = JSON.parse(readFileSync(COST_LOG_PATH, 'utf-8')); } catch {}
    }

    logs.push({
      ...this.getReport(),
      savedAt: new Date().toISOString(),
    });

    if (logs.length > 100) logs = logs.slice(-100);
    try {
      writeFileSync(COST_LOG_PATH, JSON.stringify(logs, null, 2));
    } catch {

    }
  }

  static getPricing(model) {
    return MODEL_PRICING[_pricingKey(model)];
  }

  static calculateCost(model, promptTokens, completionTokens) {
    const pricing = MODEL_PRICING[_pricingKey(model)];
    const cost = (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
    return {
      cost: Number(cost.toFixed(6)),
      costINR: Number((cost * 85).toFixed(4)),
    };
  }
}

export default TokenTracker;

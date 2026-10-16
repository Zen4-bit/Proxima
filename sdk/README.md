# 🚀 Proxima SDK for JavaScript / Node.js

Official Node.js and browser-compatible client for Proxima's OpenAI-compatible local AI gateway.

Supports both **ES Modules (ESM)** and **CommonJS (CJS)** with automatic REST port discovery and optional reasoning depth controls.

---

## Installation

```bash
npm install ./sdk
# or once published:
# npm install proxima-sdk
```

---

## Quick Start

### ES Module (ESM)

```javascript
import { Proxima } from 'proxima-sdk';

// Automatically discovers the active bound port via rest-port.json (defaults to localhost:3210)
const ai = new Proxima();

// 💬 Simple Chat
const res = await ai.chat("Explain quantum entanglement in simple terms");
console.log(res.text);

// 🎯 Choose Provider / Discovered Model
const claudeRes = await ai.chat("Write a fast binary search in TypeScript", {
    model: "claude"
});
console.log(claudeRes.text);

// 🧠 Control Thinking Depth for Reasoning Models
const reasoningRes = await ai.chat("Solve this logic puzzle step by step", {
    model: "gemini",
    thinking_level: "high" // 'default', 'low', 'medium', 'high'
});
console.log(reasoningRes.text);
```

### CommonJS (CJS)

```javascript
const { Proxima } = require('proxima-sdk');

const ai = new Proxima({ apiKey: 'sk-optional-key' });

async function run() {
    const res = await ai.chat("Hello from Node.js!");
    console.log(res.text);
}
run();
```

---

## Model Discovery

Instead of assuming fixed model availability, discover the live models available for your active account sessions or BYOK configurations:

```javascript
const models = await ai.getModels();
console.log(models);
// [
//   { id: "gemini:pro", status: "enabled", tags: ["Reasoning"], ... },
//   { id: "chatgpt:gpt-5-6-mini", status: "enabled", tags: ["Fast"], ... }
// ]
```

---

## API Reference

### `new Proxima(options)`
- `baseUrl` *(string, optional)*: Gateway base URL. When omitted, automatically resolves via `rest-port.json` in user data directory or falls back to `http://localhost:3210`.
- `apiKey` *(string, optional)*: Bearer authentication token if API key protection is enabled in Proxima.
- `model` *(string, optional, default: `'auto'`)*: Default model fallback.
- `timeout` *(number, optional, default: `120000`)*: Request timeout in milliseconds.
- `maxRetries` *(number, optional, default: `3`)*: Automatic retry attempts on transient network failures.

### Methods

| Method | Parameters | Description |
|---|---|---|
| `ai.chat(message, options)` | `message: string`, `options?: { model, thinking_level, reasoning_effort }` | Send prompt to provider. Returns `ProximaResponse`. |
| `ai.getModels()` | None | Returns array of discovered and available models. |
| `ai.getFunctions()` | None | Returns gateway function catalog. |
| `ai.getStats()` | None | Returns per-provider performance and latency statistics. |
| `ai.newConversation(provider)` | `provider: string` | Resets conversation context and memory for the specified provider. |

### `ProximaResponse` Properties
- `.text`: Response string.
- `.model`: Model identifier that served the response.
- `.provider`: Provider name (`chatgpt`, `claude`, `gemini`, `perplexity`, etc.).
- `.responseTimeMs`: Round-trip execution latency in milliseconds.
- `.finishReason`: Completion finish reason (`stop`, `length`, etc.).
- `.toJSON()`: Raw underlying OpenAI-compatible completion JSON.

---

## License

MIT

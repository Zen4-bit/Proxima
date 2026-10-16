# Proxima v5.0.0 → v5.5.0 Migration Guide

This guide outlines key architectural and API differences between **v5.0.0** and **v5.5.0** to help developers and users upgrade smoothly.

---

## 1. Dynamic Model Discovery replacing Hardcoded Model Assumptions

### In v5.0.0:
- Clients relied on static, hardcoded model aliases (e.g. `gpt-5.5`, `claude-sonnet-5`, `3.1-pro`, `3.5-flash`).
- Specifying an unavailable model could lead to ambiguous failures or silent fallbacks.

### In v5.5.0:
- Models are **dynamically discovered** from active provider accounts and BYOK configurations at runtime.
- If an unavailable model is explicitly requested, Proxima returns an actionable error directing you to discover available models.
- **Recommended Action:**
  - Query models dynamically using the MCP tool `list_available_models`, the MCP resource `proxima://models`, REST `GET /v1/models`, or SDK methods (`ai.getModels()` in JS, `ai.models()` in Python).
  - Use discovered versioned slugs (e.g., `chatgpt:gpt-5-6-mini`, `gemini:pro`, `gemini:argon`, `gemini:flash`).

---

## 2. Dynamic Port Discovery replacing Fixed 3210 Assumptions

### In v5.0.0:
- The REST API, WebSocket, and SDK clients assumed port `3210` was always available and bound.
- If port `3210` was occupied by another process, gateway initialization failed or clients could not connect.

### In v5.5.0:
- Proxima dynamically writes an active port record (`rest-port.json`) into the operating system's user data directory upon binding:
  - **Windows:** `%APPDATA%\Proxima\rest-port.json`
  - **macOS:** `~/Library/Application Support/Proxima/rest-port.json`
  - **Linux:** `~/.config/Proxima/rest-port.json` (or `$XDG_CONFIG_HOME/Proxima/rest-port.json`)
- **Recommended Action:**
  - Official Python SDK (`Proxima()`), JavaScript SDK (`new Proxima()`), CLI (`proxima`), and Agent automatically read `rest-port.json`.
  - Manual curl scripts or third-party OpenAI client integrations can continue using `http://localhost:3210` by default or query `/api/status` to confirm the listening port.

---

## 3. Reasoning & Thinking Depth Parameters

### In v5.0.0:
- Thinking / reasoning depths were not exposed or configurable programmatically.

### In v5.5.0:
- You can now specify reasoning depth across Gemini and supported reasoning models using either parameter:
  - `thinking_level`: `'default'` | `'low'` | `'medium'` | `'high'`
  - `reasoning_effort`: `'none'` | `'default'` | `'auto'` | `'low'` | `'medium'` | `'high'` (OpenAI standard)
- **Validation Rule:**
  - Specifying both parameters with conflicting values will return an HTTP 400 validation error.

```bash
# Example curl with thinking depth
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini",
    "message": "Verify this algorithm's computational complexity",
    "thinking_level": "high"
  }'
```

---

## 4. Active Request Cancellation (`POST /v1/cancel`)

### In v5.0.0:
- In-flight requests could not be cancelled by the client. An abandoned request continued running until completion, blocking subsequent requests in the provider's execution queue.

### In v5.5.0:
- Clients can send an explicit cancellation request to abort in-flight generation and immediately flush the queue:

```bash
curl -X POST http://localhost:3210/v1/cancel \
  -H "Content-Type: application/json" \
  -d '{"provider": "gemini"}'
```

---

## 5. JavaScript / TypeScript SDK Modularization

### In v5.0.0:
- The JavaScript SDK was distributed as a single CommonJS script (`sdk/proxima.js`).

### In v5.5.0:
- The SDK includes a standard package manifest (`sdk/package.json`) and native ES module export (`sdk/proxima.mjs`).
- Both ESM and CommonJS imports are supported:

```javascript
// ES Module
import { Proxima } from 'proxima-sdk';

// CommonJS
const { Proxima } = require('proxima-sdk');
```

---

## 6. Compatibility Checklist for Upgrading

| Area | Change | Action Required? |
|---|---|---|
| **Core Models** | `claude`, `chatgpt`, `gemini`, `perplexity`, `auto` | None. Legacy aliases remain fully functional. |
| **Sub-Engine Models** | `gemini:3.5-flash` → `gemini:flash` / `gemini:argon` | Update explicit references to discovered engine slugs. |
| **Port Configuration** | Default 3210 with dynamic fallback | Update custom scripts if relying on non-standard ports without env vars. |
| **MCP Clients** | 41 tools registered (added `list_available_models`) | Re-inspect tool list in Cursor, Claude Desktop, or Windsurf. |
| **Agent Web Console** | FastAPI server on port 8500 | Accessible via `proxima-agent web` or Proxima app Agent tab. |

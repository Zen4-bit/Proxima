<div align="center">

<img src="assets/proxima-icon.png" alt="Proxima" width="72"/>

# Proxima

**4 AI providers. 1 local server. No API keys.**

Use ChatGPT, Claude, Gemini & Perplexity directly inside your coding tools — through your existing accounts.

<br>

[![Version](https://img.shields.io/badge/version-4.1.0-blue)](https://github.com/Zen4-bit/Proxima/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/Zen4-bit/Proxima/releases)
[![MCP Tools](https://img.shields.io/badge/MCP_tools-45%2B-green)](https://github.com/Zen4-bit/Proxima#mcp-tools)
[![License](https://img.shields.io/badge/license-Non--Commercial-red)](LICENSE)
[![Website](https://img.shields.io/badge/Website-proximamcp.in-blue)](https://www.proximamcp.in)
[![Docs](https://img.shields.io/badge/Docs-Documentation-orange)](https://www.proximamcp.in/documentation)
[![Stars](https://img.shields.io/github/stars/Zen4-bit/Proxima?style=social)](https://github.com/Zen4-bit/Proxima/stargazers)

<br>

[Getting Started](#getting-started) · [CLI](#cli-tool) · [REST API](#rest-api) · [WebSocket](#websocket) · [SDKs](#sdks) · [MCP Tools](#mcp-tools)

</div>

<br>

---

## Demo

<table>
<tr>
<td align="center" width="50%">
<strong>🎬 App Demo</strong><br><br>

https://github.com/user-attachments/assets/5e75eb68-b1b5-43dc-979d-3bf6faa48fa0

</td>
<td align="center" width="50%">
<strong>⌨️ CLI</strong><br><br>

https://github.com/user-attachments/assets/a8564fc9-b3b3-4a53-bc35-cfce72fe34da

</td>
</tr>
<tr>
<td align="center" width="50%">
<strong>🔌 Webhook Live Chat & Battle</strong><br><br>

https://github.com/user-attachments/assets/bb7fa455-d379-4e69-b530-f7c09d2faccf

</td>
<td align="center" width="50%">
<strong>📋 Application Overview</strong><br><br>

https://github.com/user-attachments/assets/d4121fdb-f97e-4d35-846c-5ec7c5249a85

</td>
</tr>
</table>

---

## Overview

Proxima is a local AI gateway that connects multiple AI providers to your development environment. It communicates with each provider at the browser level through your active login sessions — the same way you'd chat with them in your browser.

<br>

<table>
<tr>
<td>🌐 <strong>One Endpoint</strong></td>
<td>Everything through <code>/v1/chat/completions</code> — no separate URLs</td>
</tr>
<tr>
<td>🤖 <strong>4 AI Providers</strong></td>
<td>ChatGPT, Claude, Gemini, Perplexity — any model, any task</td>
</tr>
<tr>
<td>⚡ <strong>Provider Engines</strong></td>
<td>Native browser-level communication — 3–10x faster, more reliable</td>
</tr>
<tr>
<td>🖥️ <strong>CLI Tool</strong></td>
<td><code>proxima ask</code>, <code>proxima fix</code>, <code>proxima debate</code> — right from your terminal</td>
</tr>
<tr>
<td>🔌 <strong>WebSocket</strong></td>
<td>Real-time streaming at <code>ws://localhost:3210/ws</code></td>
</tr>
<tr>
<td>🧰 <strong>45+ MCP Tools</strong></td>
<td>Search, code, translate, analyze, debate, audit — all via MCP</td>
</tr>
<tr>
<td>📡 <strong>REST API</strong></td>
<td>OpenAI-compatible API on <code>localhost:3210</code></td>
</tr>
<tr>
<td>📦 <strong>SDKs</strong></td>
<td>Python & JavaScript — one function each</td>
</tr>
<tr>
<td>🧠 <strong>Smart Router</strong></td>
<td>Auto-picks the best available AI for your query</td>
</tr>
<tr>
<td>🔑 <strong>No API Keys</strong></td>
<td>Uses your existing browser sessions — see <a href="#security--privacy">how it works</a></td>
</tr>
<tr>
<td>🔒 <strong>Local & Private</strong></td>
<td>Runs on <code>127.0.0.1</code>, data goes only to providers you're logged into</td>
</tr>
</table>

<br>

---

## What's New in v4.1.0

<table>
<tr>
<td width="40"><strong>🔥</strong></td>
<td><strong>Provider Engine System</strong><br>Proxima now uses native browser-level communication with AI providers — no DOM scraping. Responses are 3–10x faster and far more stable, with SSE streaming support and automatic fallback mechanisms.</td>
</tr>
<tr>
<td><strong>⚡</strong></td>
<td><strong>CLI Tool</strong><br>Run <code>proxima ask</code>, <code>proxima fix</code>, <code>proxima debate</code> from any terminal. Pipe errors straight from your build output. Supports file context, git diff piping, and JSON output for scripts.</td>
</tr>
<tr>
<td><strong>🔌</strong></td>
<td><strong>WebSocket Server</strong><br>Real-time streaming AI at <code>ws://localhost:3210/ws</code>. Bidirectional communication with status updates, request tracking, and keepalive. Useful for apps, scripts, anything that needs live output.</td>
</tr>
<tr>
<td><strong>🛠️</strong></td>
<td><strong>15 New MCP Tools</strong><br><code>chain_query</code>, <code>solve</code>, <code>debate</code>, <code>security_audit</code>, <code>verify</code>, <code>fix_error</code>, <code>build_architecture</code>, <code>write_tests</code>, <code>explain_error</code>, <code>convert_code</code>, <code>ask_selected</code>, <code>conversation_export</code>, <code>ask_perplexity</code>, <code>github_search</code>, <code>get_ui_reference</code></td>
</tr>
<tr>
<td><strong>📄</strong></td>
<td><strong>Interactive API Docs</strong><br>Live documentation at <code>/docs</code>, <code>/cli</code>, <code>/ws</code> — with a working chat widget to test queries directly in your browser.</td>
</tr>
<tr>
<td><strong>🎯</strong></td>
<td><strong>Multi-Model Queries</strong><br><code>model: "all"</code> queries every provider at once. <code>model: ["claude", "chatgpt"]</code> targets specific ones. New aliases: <code>gpt-4.5</code>, <code>claude-3/3.5/4</code>, <code>gemini-2/2.5</code>.</td>
</tr>
<tr>
<td><strong>🛡️</strong></td>
<td><strong>New REST API Functions</strong><br>New <code>security_audit</code> and <code>debate</code> functions added to the REST API endpoint. File upload support via <code>file</code> field in request body.</td>
</tr>
</table>

<br>

**Bug fixes & improvements:**
- 🔧 Staggered multi-provider queries — prevents UI freezes during parallel requests
- 🔧 Smart provider selection — routes coding tasks to Claude, research to Perplexity
- 🔧 Response caching with TTL (5 min) and automatic eviction (max 100 entries)
- 🔧 Rate limit handling — detects 429 responses, auto-recovery on expired sessions
- 🔧 Engine auto-injection on page navigation with duplicate guard
- 🔧 Claude conversation auto-recovery (handles 404/410 expired sessions)
- 🔧 ChatGPT SHA3-512 proof-of-work challenge solver
- 🔧 10MB body size limit on REST API with CORS headers
- 🔧 Socket leak prevention on IPC reconnect

---

## Getting Started

### Requirements

- [Node.js 18+](https://nodejs.org/) (for MCP server and CLI)
- **Windows 10/11** — pre-built installer available
- **macOS / Linux** — supported via source code

<br>

### Install

<table>
<tr>
<td width="50%">

**Download Installer (Windows)**

Download the latest release and run the installer.

<br>

[Download Proxima v4.1.0 →](https://github.com/Zen4-bit/Proxima/releases)

</td>
<td width="50%">

**Run from Source (Windows / macOS / Linux)**

```bash
git clone https://github.com/Zen4-bit/Proxima.git
cd Proxima
npm install
npm start
```

</td>
</tr>
</table>

> Electron will open the Proxima window. Log in to your AI providers, enable REST API in Settings, and you're ready.

<br>

**CLI install:**
- **Windows:** Settings → **⚡ Install CLI to PATH**, or `npm link`
- **macOS / Linux:** `npm link` (may need `sudo npm link`)

<br>

### Connect to your editor

1. Open Proxima and log into your AI providers (one-time setup)
2. Go to **Settings → MCP Configuration** → copy the config
3. Paste into your editor's MCP config file:

```json
{
  "mcpServers": {
    "proxima": {
      "command": "node",
      "args": ["C:/path/to/Proxima/src/mcp-server-v3.js"]
    }
  }
}
```

4. Restart your editor. The tools will appear.

> **Tip:** Use the copy button in Settings — don't type the path manually.

**Works with:** Cursor · VS Code (MCP extension) · Claude Desktop · Windsurf · Gemini CLI · any MCP-compatible client

---

## Supported Providers

<table>
<tr>
<td align="center" width="25%">
<br>
<strong>ChatGPT</strong>
<br>
OpenAI's GPT-4
<br><br>
</td>
<td align="center" width="25%">
<br>
<strong>Claude</strong>
<br>
Anthropic's Claude
<br><br>
</td>
<td align="center" width="25%">
<br>
<strong>Gemini</strong>
<br>
Google's Gemini
<br><br>
</td>
<td align="center" width="25%">
<br>
<strong>Perplexity</strong>
<br>
Web search & research
<br><br>
</td>
</tr>
</table>

Each provider runs through a dedicated **engine script** that handles communication at the browser level. Responses are streamed via SSE using your existing login. If an engine can't connect, Proxima falls back to DOM-based interaction automatically.

<br>


---

## How It Works

In v4.1.0, Proxima uses a **Provider Engine System** instead of DOM scraping.

When you send a query, Proxima uses a lightweight engine script within the provider's browser tab. That script handles communication at the browser level and streams the response back via SSE. If the engine fails for any reason, Proxima automatically falls back to DOM-based interaction — so it keeps working either way.

```
Your editor → MCP tool call → Proxima local server
                                      ↓
                           Engine injected into session
                                      ↓
                      Browser-level communication (SSE stream)
                                      ↓
                              Response returned
```

<br>

<table>
<tr><th>Engine</th><th>Provider</th><th>How it works</th></tr>
<tr><td><code>chatgpt-engine.js</code></td><td>ChatGPT</td><td>Handles proof-of-work challenges, streams via SSE</td></tr>
<tr><td><code>claude-engine.js</code></td><td>Claude</td><td>Org-level auth handling, SSE streaming, auto-recovery</td></tr>
<tr><td><code>gemini-engine.js</code></td><td>Gemini</td><td>SSE streaming with auto-reconnect</td></tr>
<tr><td><code>perplexity-engine.js</code></td><td>Perplexity</td><td>SSE streaming</td></tr>
</table>


## CLI Tool

The `proxima` CLI lets you use any AI provider from your terminal.

<br>

### Install

<table>
<tr>
<td width="33%">

**From the app**

Settings → ⚡ Install CLI to PATH

</td>
<td width="33%">

**From source**

```bash
npm link                  # Windows
sudo npm link             # macOS / Linux
```

</td>
<td width="33%">

**Without installing**

```bash
npm run cli -- ask "question"
```

</td>
</tr>
</table>

<br>

### Commands

```bash
# Ask any provider
proxima ask "How does async/await work in JS?"
proxima ask claude "Review this approach"
proxima ask chatgpt "Explain this error"

# Search
proxima search "latest Node.js release"

# Code
proxima code "REST API with Express and JWT auth"
proxima code review "function fetchUser(id) { ... }"
proxima code explain "async/await"

# Smart tools
proxima fix "SyntaxError: Unexpected token '<'"
proxima debate "tabs vs spaces"
proxima audit "SELECT * FROM users WHERE id=" + req.query.id
proxima brainstorm "features for a dev productivity tool"

# Translate
proxima translate "Hello world" --to Hindi

# Compare all providers
proxima compare "Bun vs Node.js for production"

# Utilities
proxima status                     # server status
proxima stats                      # response time stats
proxima models                     # list available providers
proxima new                        # reset all conversations
```

### Pipe Support

```bash
# Fix build errors directly
npm run build 2>&1 | proxima fix

# Review a git diff
git diff | proxima code review

# Pass file as context
proxima ask "What does this do?" --file src/server.js
```

<br>

### Flags

<table>
<tr><th>Flag</th><th>What it does</th></tr>
<tr><td><code>-m</code> / <code>--model</code></td><td>Override provider (<code>claude</code>, <code>chatgpt</code>, <code>gemini</code>, <code>perplexity</code>, <code>auto</code>)</td></tr>
<tr><td><code>--json</code></td><td>Raw JSON output for scripting</td></tr>
<tr><td><code>-l</code> / <code>--lang</code></td><td>Specify code language</td></tr>
<tr><td><code>--file</code></td><td>Include a file as context</td></tr>
<tr><td><code>--to</code></td><td>Target language for translate</td></tr>
<tr><td><code>--from</code></td><td>Source language for translate</td></tr>
</table>

---

## REST API

Proxima runs an OpenAI-compatible REST API at `http://localhost:3210`.

Enable it in **Settings → REST API & CLI**.

<br>

### Endpoints

```
POST /v1/chat/completions   — OpenAI-compatible chat
GET  /v1/models             — List available models
GET  /v1/functions          — API function catalog with examples
GET  /v1/stats              — Response time stats per provider
POST /v1/conversations/new  — Reset all conversations
GET  /api/status            — Server status
GET  /docs                  — Interactive API docs (with live chat widget)
GET  /cli                   — CLI documentation
GET  /ws                    — WebSocket documentation
```

<br>

### Functions

The `"function"` field controls what happens. No function = normal chat.

<table>
<tr><th>Function</th><th>Body Fields</th><th>What it does</th></tr>
<tr><td><em>(none)</em></td><td><code>model</code>, <code>message</code></td><td>Normal chat</td></tr>
<tr><td><code>"search"</code></td><td><code>model</code>, <code>message</code>, <code>function</code></td><td>Web search + AI analysis</td></tr>
<tr><td><code>"translate"</code></td><td><code>model</code>, <code>message</code>, <code>function</code>, <code>to</code></td><td>Translate text</td></tr>
<tr><td><code>"brainstorm"</code></td><td><code>model</code>, <code>message</code>, <code>function</code></td><td>Generate ideas</td></tr>
<tr><td><code>"code"</code></td><td><code>model</code>, <code>message</code>, <code>function</code>, <code>action</code></td><td>Code generate/review/debug/explain</td></tr>
<tr><td><code>"analyze"</code></td><td><code>model</code>, <code>function</code>, <code>url</code></td><td>Analyze URL or content</td></tr>
<tr><td><code>"security_audit"</code></td><td><code>model</code>, <code>code</code>, <code>function</code></td><td>Scan code for vulnerabilities</td></tr>
<tr><td><code>"debate"</code></td><td><code>model</code>, <code>message</code>, <code>function</code></td><td>Multi-perspective debate</td></tr>
</table>

<br>

### Examples

**Chat:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude", "message": "What is AI?"}'
```

**Search:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "perplexity", "message": "AI news 2026", "function": "search"}'
```

**Translate:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "gemini", "message": "Hello world", "function": "translate", "to": "Hindi"}'
```

**Code Generate:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "claude", "message": "Sort algorithm", "function": "code", "action": "generate", "language": "Python"}'
```

**Query All Providers:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "all", "message": "Explain quantum computing"}'
```

**Security Audit:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "claude", "function": "security_audit", "code": "db.query(\"SELECT * FROM users WHERE id=\" + req.query.id)"}'
```

<br>

### Multi-model queries

```javascript
model: "all"                       // all enabled providers
model: ["claude", "chatgpt"]       // specific providers
```

<br>

### Response Format

```json
{
  "id": "proxima-abc123",
  "model": "claude",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "AI response here..."
    }
  }],
  "proxima": {
    "provider": "claude",
    "responseTimeMs": 2400
  }
}
```

When using `model: "all"`, each provider gets its own entry in `choices[]`.

---

## SDKs

<table>
<tr>
<td width="50%">

### Python

```python
from proxima import Proxima
client = Proxima()

# Chat — any model
response = client.chat("Hello", model="claude")
response = client.chat("Hello", model="chatgpt")
response = client.chat("Hello")  # auto picks best
print(response.text)
print(response.response_time_ms)

# Search
result = client.chat("AI news 2026",
    model="perplexity", function="search")

# Translate
hindi = client.chat("Hello world",
    model="gemini", function="translate",
    to="Hindi")

# Code
code = client.chat("Sort algorithm",
    model="claude", function="code",
    action="generate", language="Python")

# System
models = client.get_models()
stats = client.get_stats()
client.new_conversation()
```

`pip install requests`, then copy `sdk/proxima.py` to your project.

</td>
<td width="50%">

### JavaScript

```javascript
const { Proxima } = require('./sdk/proxima');
const client = new Proxima();

// Chat — any model
const res = await client.chat("Hello",
    { model: "claude" });
console.log(res.text);

// Search
const news = await client.chat("AI news",
    { model: "perplexity",
      function: "search" });

// Translate
const hindi = await client.chat("Hello",
    { model: "gemini",
      function: "translate",
      to: "Hindi" });

// Code generate
const code = await client.chat("Sort algo",
    { model: "claude",
      function: "code",
      action: "generate" });

// System
const models = await client.getModels();
const stats = await client.getStats();
```

Works with Node.js 18+ (native `fetch`).

</td>
</tr>
</table>

<br>

### SDK Configuration

```python
client = Proxima(base_url="http://192.168.1.100:3210")   # custom URL
client = Proxima(default_model="claude")                  # default model
```

---

## WebSocket

Real-time streaming AI at `ws://localhost:3210/ws`.

Requires REST API to be enabled in Settings.

<br>

### Example

```javascript
const ws = new WebSocket("ws://localhost:3210/ws");

ws.send(JSON.stringify({
  action: "ask",
  model: "claude",
  message: "What is a closure?",
  id: "req_1"
}));

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // { type: "status",   id: "req_1", status: "processing", model: "claude" }
  // { type: "response", id: "req_1", model: "claude", content: "...", responseTimeMs: 2400 }
};
```

<br>

### Available Actions

<table>
<tr><th>Action</th><th>What it does</th></tr>
<tr><td><code>ask</code> / <code>chat</code></td><td>Chat with any provider</td></tr>
<tr><td><code>search</code></td><td>Web search</td></tr>
<tr><td><code>code</code></td><td>generate / review / explain / optimize / debug</td></tr>
<tr><td><code>translate</code></td><td>Translate text</td></tr>
<tr><td><code>brainstorm</code></td><td>Generate ideas</td></tr>
<tr><td><code>debate</code></td><td>Multi-provider debate (queries all providers)</td></tr>
<tr><td><code>audit</code></td><td>Security code audit</td></tr>
<tr><td><code>new_conversation</code></td><td>Reset conversation context for all providers</td></tr>
<tr><td><code>stats</code></td><td>Connection and provider statistics</td></tr>
<tr><td><code>ping</code></td><td>Keepalive — returns <code>pong</code></td></tr>
</table>

---

## MCP Tools

### 🤖 AI Provider Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>ask_chatgpt</code></td><td>Query ChatGPT (supports file upload)</td></tr>
<tr><td><code>ask_claude</code></td><td>Query Claude (supports file upload)</td></tr>
<tr><td><code>ask_gemini</code></td><td>Query Gemini (supports file upload)</td></tr>
<tr><td><code>ask_perplexity</code></td><td>Query Perplexity (supports file upload)</td></tr>
<tr><td><code>ask_all_ais</code></td><td>Send same query to all providers at once</td></tr>
<tr><td><code>ask_selected</code></td><td>Pick specific providers to query</td></tr>
<tr><td><code>compare_ais</code></td><td>Get and compare responses side by side</td></tr>
<tr><td><code>smart_query</code></td><td>Auto-picks best provider, falls back if one fails</td></tr>
</table>

### 🔧 Development Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>solve</code></td><td>One-shot problem solver — senior engineer level</td></tr>
<tr><td><code>fix_error</code></td><td>Root cause + exact fix for any error</td></tr>
<tr><td><code>build_architecture</code></td><td>Full project architecture blueprint</td></tr>
<tr><td><code>write_tests</code></td><td>Generate tests (jest / vitest / mocha / pytest)</td></tr>
<tr><td><code>explain_error</code></td><td>Error explained in plain terms, no jargon</td></tr>
<tr><td><code>convert_code</code></td><td>Convert code between languages or frameworks</td></tr>
</table>

### ⚔️ Multi-AI Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>chain_query</code></td><td>Sequential multi-AI pipeline — use <code>{previous}</code> to pass output forward</td></tr>
<tr><td><code>debate</code></td><td>Multi-provider debate with FOR / AGAINST / NEUTRAL stances</td></tr>
<tr><td><code>verify</code></td><td>Cross-provider answer verification with confidence score (0–100%)</td></tr>
<tr><td><code>security_audit</code></td><td>Code security scan — flags CRITICAL / HIGH / MEDIUM / LOW issues</td></tr>
</table>

### 💻 Code Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>generate_code</code></td><td>Generate code from a description</td></tr>
<tr><td><code>explain_code</code></td><td>Plain-English explanation of any code</td></tr>
<tr><td><code>optimize_code</code></td><td>Performance improvement suggestions</td></tr>
<tr><td><code>review_code</code></td><td>Code review feedback</td></tr>
<tr><td><code>verify_code</code></td><td>Check against best practices</td></tr>
</table>

### 🔍 Search Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>deep_search</code></td><td>Comprehensive web search</td></tr>
<tr><td><code>internet_search</code></td><td>General internet search on any topic</td></tr>
<tr><td><code>news_search</code></td><td>Latest news articles</td></tr>
<tr><td><code>reddit_search</code></td><td>Reddit discussions</td></tr>
<tr><td><code>github_search</code></td><td>Find open-source repos, code, and solutions on GitHub</td></tr>
<tr><td><code>academic_search</code></td><td>Papers and research</td></tr>
<tr><td><code>math_search</code></td><td>Math problems step-by-step</td></tr>
</table>

### 📝 Content Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>brainstorm</code></td><td>Generate ideas on any topic</td></tr>
<tr><td><code>summarize_url</code></td><td>Summarize any URL</td></tr>
<tr><td><code>generate_article</code></td><td>Full article generation</td></tr>
<tr><td><code>writing_help</code></td><td>Writing assistance</td></tr>
<tr><td><code>fact_check</code></td><td>Fact verification</td></tr>
<tr><td><code>find_stats</code></td><td>Find statistics and data</td></tr>
<tr><td><code>how_to</code></td><td>Step-by-step instructions</td></tr>
<tr><td><code>compare</code></td><td>Compare two things in depth</td></tr>
</table>

### 🔬 Analysis Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>analyze_document</code></td><td>Analyze documents from URL</td></tr>
<tr><td><code>extract_data</code></td><td>Extract structured data from text or URL</td></tr>
<tr><td><code>get_ui_reference</code></td><td>UI/UX design consultant — colors, layouts, components, CSS tokens, and code improvements</td></tr>
</table>

### 📁 File Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>analyze_file</code></td><td>Upload and analyze a local file</td></tr>
<tr><td><code>review_code_file</code></td><td>Code review on a local file (bugs, performance, security)</td></tr>
</table>

### 🪟 Window Controls

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>show_window</code></td><td>Show the Proxima window</td></tr>
<tr><td><code>hide_window</code></td><td>Hide to system tray</td></tr>
<tr><td><code>toggle_window</code></td><td>Toggle visibility</td></tr>
<tr><td><code>set_headless_mode</code></td><td>Run fully in background</td></tr>
</table>

### 🔄 Session Tools

<table>
<tr><th>Tool</th><th>What it does</th></tr>
<tr><td><code>new_conversation</code></td><td>Reset conversation context</td></tr>
<tr><td><code>clear_cache</code></td><td>Clear response cache</td></tr>
<tr><td><code>conversation_export</code></td><td>Export full conversation history</td></tr>
</table>

---

## Security & Privacy

Since Proxima works without API keys, a few things worth knowing:

- **No credentials stored.** Proxima uses your existing browser session cookies — the same way you're already logged in.
- **Nothing leaves your machine** except the queries you send to AI providers you're logged into.
- **Runs on localhost.** The MCP server, REST API, and WebSocket are all local. Nothing is exposed to the internet.
- **No telemetry.** Proxima doesn't collect or send any usage data anywhere.
- **Sessions are yours.** If you log out from a provider's website or clear browser data, you'll need to log in again through Proxima.

> Proxima doesn't bypass authentication — it uses the sessions you already have. Same as using the site in a browser.

---

## Project Structure

```
Proxima/
├── electron/
│   ├── main-v2.cjs                  # Electron main process
│   ├── browser-manager.cjs          # Browser session management
│   ├── rest-api.cjs                 # REST API server (OpenAI-compatible)
│   ├── ws-server.cjs                # WebSocket server
│   ├── provider-api.cjs             # Provider engine injection manager
│   ├── index-v2.html                # App UI
│   ├── preload.cjs                  # Renderer preload bridge
│   └── providers/
│       ├── chatgpt-engine.js        # SHA3-512 POW + SSE streaming
│       ├── claude-engine.js         # Org auth + SSE streaming
│       ├── gemini-engine.js         # Session SSE streaming
│       └── perplexity-engine.js     # SSE streaming
├── cli/
│   └── proxima-cli.cjs              # Terminal CLI
├── src/
│   ├── mcp-server-v3.js             # MCP server (50+ tools)
│   └── enabled-providers.json       # Provider config
├── sdk/
│   ├── proxima.py                   # Python SDK
│   └── proxima.js                   # JavaScript SDK
├── assets/                          # Icons, screenshots, demo
└── package.json
```

---

## Troubleshooting

**Windows Firewall prompt on first launch**
<br>Proxima runs on `localhost:19223` and `localhost:3210`. Click Allow — it only accepts local connections.

**Provider shows "Not logged in"**
<br>Each provider has a different login method:
- **ChatGPT, Claude, Perplexity** — click the provider tab and log in using OTP (email code). Google Sign-In is restricted in embedded browsers by Google's policy.
- **Gemini** — uses cookie-based authentication. Log in to Google in your regular browser first, then Proxima picks up the session automatically.

**REST API not responding**
<br>Check that REST API is enabled in Settings → REST API & CLI section. Visit `http://localhost:3210` in your browser to verify.

**MCP tools not showing in editor**
1. Make sure Proxima is running
2. Verify the path in your MCP config (use the Settings copy button)
3. Restart your editor

**CLI: `proxima` not found after install**
<br>Open a fresh terminal. If still not found, click **🔧 Fix** in Settings → CLI section.

**CLI: "Cannot connect to Proxima"**
<br>Proxima must be running and REST API must be enabled. The CLI connects to `localhost:3210`.

**WebSocket won't connect**
<br>WebSocket shares the REST API server. Enable REST API in Settings first.

---

## License

Personal, non-commercial use only. See [LICENSE](LICENSE) for details.

---

<div align="center">

<br>

**Proxima v4.1.0** — One API, All AI Models ⚡

Made by [Zen4-bit](https://github.com/Zen4-bit)

<br>

If it saved you time, a ⭐ goes a long way.

<br>

</div>

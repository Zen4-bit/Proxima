<div align="center">

# ⚡ Proxima

### Multi-AI Gateway — One API, All Models

[![Version](https://img.shields.io/badge/version-3.5.0-blue.svg)](https://github.com/Zen4-bit/Proxima/releases)
[![License](https://img.shields.io/badge/license-Personal%20Use-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20Tools-55-orange.svg)]()
[![Providers](https://img.shields.io/badge/AI%20Providers-10-purple.svg)]()

Proxima turns logged-in browser AI sessions into a local MCP server and OpenAI-compatible API.
ChatGPT, Claude, Gemini, Perplexity, DeepSeek, Grok, Z.AI, Copilot, Meta AI, and Qwen are all available through the same Proxima instance. Just log in to each provider inside the Proxima browser shell. No API keys needed.

[Getting Started](#getting-started) · [API Usage](#api-usage) · [SDKs](#sdks) · [MCP Tools](#mcp-tools) · [Configuration](#configuration)

---

## Demo

https://github.com/user-attachments/assets/6eb76618-2c1d-4dad-b753-aaaee9e93310

---

![Proxima Settings](assets/proxima-provider.jpg)

![Proxima Provider View](assets/proxima-screenshot.jpg)

</div>

## Overview

Proxima is a local AI gateway that connects multiple AI providers to your coding environment.

**One API. One URL. One function. Any model. Any task.**

```
POST /v1/chat/completions
{"model": "claude", "message": "Hello"}                                          → Chat
{"model": "perplexity", "message": "AI news", "function": "search"}              → Search
{"model": "gemini", "message": "Hello", "function": "translate", "to": "Hindi"}  → Translate
{"model": "claude", "message": "Sort algo", "function": "code"}                  → Code
```

> **No API keys required.** Proxima uses your existing browser sessions to talk to AI providers directly.

### Why Proxima?

| Feature | Description |
|---------|-------------|
| **One Endpoint** | Everything through `/v1/chat/completions` — no separate URLs |
| **10 AI Providers** | ChatGPT, Claude, Gemini, Perplexity, DeepSeek, Grok, Z.AI, Copilot, Meta AI, Qwen |
| **55 MCP Tools** | Search, code, translate, analyze, provider control, file workflows |
| **REST API** | OpenAI-compatible API on `localhost:3210` |
| **SDKs** | Python & JavaScript — one function each |
| **No API Keys** | Use your existing account logins |
| **Local & Private** | Runs on localhost, your data stays on your machine |
| **Smart Router** | Auto-picks the best available AI for your query |

---

## What's New in v3.5.0

- 🆕 **6 additional providers** — DeepSeek, Grok, Z.AI, Copilot, Meta AI, Qwen
- 🆕 **27 new MCP tools** — content, analysis, file analysis, window control, session management
- 🆕 **Provider inspection tools** — `init_provider`, `provider_status`, `navigate_provider`, `debug_provider_dom`, `execute_provider_script`
- 🆕 **REST API** — OpenAI-compatible endpoint at `localhost:3210`
- 🆕 **Python & JavaScript SDKs** — one function to do everything
- 🆕 **Smart Router** — auto-picks best AI with retry logic
- 🆕 **Math Search** — solve math & science problems step-by-step
- 🆕 **Image Search** — find images on any topic
- 🆕 **File Analysis** — upload and analyze local files with any AI
- 🆕 **Window Controls** — show, hide, toggle, headless mode
- 🆕 **macOS build targets** — `npm run build:mac` and `npm run build:mac:dir`
-    **Navigation & Login** - Allows direct URL changes, and setting localStorage values for login.
- 🔧 **Enhanced typing detection** — better response capture for all providers
- 🔧 **Claude code hack** — forces inline code instead of artifacts for reliable capture

---

## Getting Started

### Requirements

- **Windows 10/11 or macOS**
- **Node.js 18+** → [Download Node.js](https://nodejs.org/)

### Installation

<table>
<tr>
<td width="50%">

**Download Installer**

Download the latest release and run the installer. Windows installers are published; macOS can be run from source or built locally from this repo.

[Download for Windows →](https://github.com/Zen4-bit/Proxima/releases)

</td>
<td width="50%">

**Run from Source**

```bash
git clone https://github.com/Zen4-bit/Proxima.git
cd proxima
npm install
npm start
```

</td>
</tr>
</table>

### Build Commands

| Command | Output |
|---------|--------|
| `npm start` | Run Proxima locally |
| `npm run mcp` | Launch the stdio MCP server directly |
| `npm run build:win` | Build the Windows app |
| `npm run build:installer` | Build the Windows NSIS installer |
| `npm run build:mac` | Build macOS universal `dmg` + `zip` artifacts into `dist/` |
| `npm run build:mac:dir` | Build an unpacked macOS `.app` directory into `dist/` |

### Quick Setup

1. **Open Proxima**, enable the providers you want, and log in to each one
2. **Copy MCP config** from the Settings panel so the path matches your current source or packaged install
3. **Connect your MCP client** and start using provider tools like `ask_deepseek`, `ask_grok`, `ask_zai`, `ask_copilot`, `ask_metaai`, or `ask_qwen`
4. **API is live** at `http://localhost:3210`

---

## Supported Providers

| Provider | Model ID | Enabled by Default | Default Action |
|----------|----------|--------------------|----------------|
| ChatGPT | `chatgpt` | Yes | `chat` |
| Claude | `claude` | No | `chat` |
| Gemini | `gemini` | Yes | `chat` |
| Perplexity | `perplexity` | Yes | `search` |
| DeepSeek | `deepseek` | No | `chat` |
| Grok | `grok` | No | `chat` |
| Z.AI | `zai` | No | `chat` |
| Copilot | `copilot` | No | `chat` |
| Meta AI | `metaai` | No | `chat` |
| Qwen | `qwen` | No | `chat` |

> **Note:** Perplexity is search-first for shared tools. All other providers default to chat behavior.
>
> **Image responses:** ChatGPT, Gemini, Grok, Copilot, Meta AI, and Qwen can return image responses. When they do, Proxima downloads the generated images locally and returns file paths through the MCP response.

### Model Aliases

You can use familiar names — they all resolve to the right provider:

| Provider | Aliases |
|----------|---------|
| ChatGPT | `chatgpt`, `gpt`, `gpt-4`, `gpt-4o`, `gpt-4.5`, `openai` |
| Claude | `claude`, `claude-3`, `claude-3.5`, `claude-4`, `anthropic`, `sonnet`, `opus`, `haiku` |
| Gemini | `gemini`, `gemini-pro`, `gemini-2`, `gemini-2.5`, `google`, `bard` |
| Perplexity | `perplexity`, `pplx`, `sonar` |
| DeepSeek | `deepseek`, `deepseek-chat`, `deepseek-r1`, `r1` |
| Grok | `grok`, `grok-3`, `xai`, `x.ai` |
| Z.AI | `zai`, `z.ai`, `z ai`, `z-ai`, `glm`, `glm-5`, `glm-5.1` |
| Copilot | `copilot`, `microsoft copilot`, `ms copilot` |
| Meta AI | `metaai`, `meta ai`, `meta.ai` |
| Qwen | `qwen`, `qwen-chat`, `qwen3`, `qwen-max`, `qwen studio` |
| Auto | `auto` — picks the best available |

### Provider-Specific MCP Tools

Each provider also has a direct MCP tool path for targeted calls. These tools accept `message` and optional `files`.

| Provider | MCP Tool |
|----------|----------|
| ChatGPT | `ask_chatgpt` |
| Claude | `ask_claude` |
| Gemini | `ask_gemini` |
| DeepSeek | `ask_deepseek` |
| Grok | `ask_grok` |
| Z.AI | `ask_zai` |
| Copilot | `ask_copilot` |
| Meta AI | `ask_metaai` |
| Qwen | `ask_qwen` |

Perplexity is exposed through the search-oriented MCP tools such as `deep_search`, `pro_search`, `news_search`, `reddit_search`, and `academic_search` rather than a dedicated `ask_perplexity` tool.

---

## API Usage

### ONE Endpoint — Everything

```
POST http://localhost:3210/v1/chat/completions
Content-Type: application/json
```

The `"function"` field in the body determines what happens. No function = normal chat.

### Functions

| Function | Body Fields | What It Does |
|----------|-------------|-------------|
| *(none)* | `model`, `message` | Normal chat |
| `"search"` | `model`, `message`, `function` | Web search + AI analysis |
| `"translate"` | `model`, `message`, `function`, `to` | Translate text |
| `"brainstorm"` | `model`, `message`, `function` | Generate creative ideas |
| `"code"` | `model`, `message`, `function`, `action` | Code generate/review/debug/explain |
| `"analyze"` | `model`, `function`, `url` | Analyze URL or content |

### Examples (All Same URL)

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

**Code Review:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "claude", "function": "code", "action": "review", "code": "def add(a,b): return a+b"}'
```

**Brainstorm:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "auto", "message": "Startup ideas", "function": "brainstorm"}'
```

**Analyze URL:**
```bash
curl http://localhost:3210/v1/chat/completions \
  -d '{"model": "perplexity", "function": "analyze", "url": "https://example.com"}'
```

### Response Format

Every call returns the **same format**:

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

### System Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/models` | List models and their status |
| `GET` | `/v1/functions` | API function catalog |
| `GET` | `/v1/stats` | Response time stats |
| `POST` | `/v1/conversations/new` | Fresh start |

---

## SDKs

### Python SDK — One Function

```python
from proxima import Proxima
client = Proxima()

# Chat — any model
response = client.chat("Hello", model="claude")
response = client.chat("Hello", model="chatgpt")
response = client.chat("Hello", model="gemini")
response = client.chat("Hello")  # auto picks best
print(response.text)
print(response.model)
print(response.response_time_ms)

# Search — same function, add function="search"
result = client.chat("AI news 2026", model="perplexity", function="search")
print(result.text)

# Translate — same function, add function="translate"
hindi = client.chat("Hello world", model="gemini", function="translate", to="Hindi")
print(hindi.text)

# Code generate
code = client.chat("Sort algorithm", model="claude", function="code", action="generate", language="Python")

# Code review
review = client.chat(function="code", model="claude", action="review", code="def add(a,b): return a+b")

# Brainstorm
ideas = client.chat("Startup ideas", function="brainstorm")

# Analyze URL
analysis = client.chat(function="analyze", url="https://example.com")

# System
models = client.get_models()
stats = client.get_stats()
client.new_conversation()
```

**Installation:** `pip install requests`, then copy `sdk/proxima.py` to your project.

### JavaScript SDK — One Function

```javascript
const { Proxima } = require('./sdk/proxima');
const client = new Proxima();

// Chat — any model
const res = await client.chat("Hello", { model: "claude" });
console.log(res.text);

// Search
const news = await client.chat("AI news", { model: "perplexity", function: "search" });

// Translate
const hindi = await client.chat("Hello", { model: "gemini", function: "translate", to: "Hindi" });

// Code generate
const code = await client.chat("Sort algo", { model: "claude", function: "code", action: "generate" });

// Brainstorm
const ideas = await client.chat("Startup ideas", { function: "brainstorm" });

// Analyze
const analysis = await client.chat("", { function: "analyze", url: "https://example.com" });

// System
const models = await client.getModels();
const stats = await client.getStats();
```

Works with Node.js 18+ (uses native `fetch`).

Any supported provider ID or alias can be used from the SDKs, including `deepseek`, `grok`, `zai`, `copilot`, `metaai`, and `qwen`.

### SDK Configuration

```python
# Custom URL
client = Proxima(base_url="http://192.168.1.100:3210")

# Default model for all calls
client = Proxima(default_model="claude")
```

---

## MCP Tools

### Configuration

Add this to your AI coding app's MCP settings:

```json
{
  "mcpServers": {
    "proxima": {
      "command": "node",
      "args": ["/absolute/path/to/Proxima/src/mcp-server-v3.js"]
    }
  }
}
```

### MCP Server Paths

Proxima generates the correct JSON for the current install in the Settings panel. These are the common path patterns:

| Install Type | Example MCP Server Path |
|--------------|-------------------------|
| Source checkout on macOS | `/Users/you/Dev/Proxima/src/mcp-server-v3.js` |
| Source checkout on Windows | `C:/path/to/Proxima/src/mcp-server-v3.js` |
| Packaged macOS app | `/Applications/Proxima.app/Contents/Resources/app.asar.unpacked/src/mcp-server-v3.js` |
| Packaged Windows app | `C:/Program Files/Proxima/resources/app.asar.unpacked/src/mcp-server-v3.js` |

> **Tip:** Copy the exact config from Proxima's Settings panel instead of typing paths manually.
>
> **File attachments:** Turn on **Enable File Attachments** in Settings if you want MCP tools to use `files` or `filePath`.

### Compatible Apps

- **Cursor**
- **VS Code** (with MCP extension)
- **Claude Desktop**
- **Windsurf**
- **Gemini CLI**

---

### 🔍 Search Tools (8)

| Tool | Provider | Description |
|------|----------|-------------|
| `deep_search` | Perplexity | Comprehensive web search with file attachment support |
| `pro_search` | Perplexity | Advanced detailed research with sources |
| `youtube_search` | Perplexity | Find YouTube videos on any topic |
| `reddit_search` | Perplexity | Search Reddit discussions & threads |
| `news_search` | Perplexity | Latest news with timeframe filter |
| `academic_search` | Perplexity | Scholarly papers & peer-reviewed research |
| `image_search` | Perplexity | Find images on any topic |
| `math_search` | Perplexity | Solve math & science problems step-by-step |

### 💻 Code Tools (7)

| Tool | Description |
|------|-------------|
| `generate_code` | Generate code in any language from description |
| `explain_code` | Get detailed code explanations |
| `debug_code` | Find and fix bugs with error context |
| `optimize_code` | Performance & readability improvements |
| `review_code` | Full code review with best practices |
| `verify_code` | Verify code follows standards |
| `research_fix` | Research how to fix specific errors |

### 🤖 AI Provider Tools (17)

| Tool | Description |
|------|-------------|
| `ask_chatgpt` | Direct query to ChatGPT (with file support) |
| `ask_claude` | Direct query to Claude (with file support) |
| `ask_gemini` | Direct query to Gemini (with file support) |
| `ask_deepseek` | Direct query to DeepSeek (with file support) |
| `ask_grok` | Direct query to Grok (with file support) |
| `ask_zai` | Direct query to Z.AI (with file support) |
| `ask_copilot` | Direct query to Microsoft Copilot (with file support) |
| `ask_metaai` | Direct query to Meta AI (with file support) |
| `ask_qwen` | Direct query to Qwen (with file support) |
| `ask_all_ais` | Query ALL enabled AIs simultaneously |
| `compare_ais` | Compare responses from multiple AIs side-by-side |
| `smart_query` | Auto-route to best AI via Smart Router |
| `init_provider` | Initialize a provider tab/session inside Proxima |
| `provider_status` | Inspect login, typing, and current page status for a provider |
| `navigate_provider` | Open a provider home page or a custom URL |
| `debug_provider_dom` | Collect provider DOM/debug info for troubleshooting |
| `execute_provider_script` | Run JavaScript in a provider page context |

### 📝 Content & Research Tools (8)

| Tool | Description |
|------|-------------|
| `brainstorm` | Generate creative ideas on any topic |
| `translate` | Translate text between languages |
| `fact_check` | Verify claims with sources |
| `find_stats` | Find statistics by topic & year |
| `how_to` | Step-by-step guides for any task |
| `writing_help` | Improve and edit writing content |
| `summarize_url` | Summarize any webpage with focus area |
| `generate_article` | Write articles in any style |

### 🔬 Analysis Tools (5)

| Tool | Description |
|------|-------------|
| `analyze_document` | Analyze documents from URL |
| `analyze_image_url` | Analyze images via any AI provider |
| `extract_data` | Extract specific data types from text or URL |
| `compare` | Compare two items in detail |
| `generate_image_prompt` | Create detailed AI image generation prompts |

### 📁 File Analysis Tools (2)

| Tool | Description |
|------|-------------|
| `analyze_file` | Upload & analyze local files with any AI |
| `review_code_file` | Upload code file for focused review (bugs, performance, security, style) |

### 🪟 Window Control Tools (4)

| Tool | Description |
|------|-------------|
| `show_window` | Show the Proxima app window |
| `hide_window` | Hide the Proxima app window |
| `toggle_window` | Toggle window visibility |
| `set_headless_mode` | Enable/disable headless mode |

### 🔄 Session Tools (2)

| Tool | Description |
|------|-------------|
| `new_conversation` | Start fresh conversations on all providers |
| `clear_cache` | Clear all cached responses |

### 📊 Status & Monitoring Tools (2)

| Tool | Description |
|------|-------------|
| `router_stats` | View Smart Router success/failure statistics |
| `get_typing_status` | Check if any AI provider is currently typing |

---

## Project Structure

```
proxima/
├── electron/
│   ├── main-v2.cjs             # Electron main process + MCP config generation
│   ├── browser-manager.cjs     # Browser view management
│   ├── rest-api.cjs            # REST API server (OpenAI-compatible)
│   ├── provider-senders/       # Provider-specific message automation
│   ├── index-v2.html           # Application UI
│   ├── preload.cjs             # Renderer preload bridge
│   └── provider-preload.cjs    # Provider page preload
├── src/
│   ├── mcp-server-v3.js        # MCP server (55 tools)
│   ├── provider-catalog.cjs    # Provider IDs, aliases, URLs, defaults
│   └── provider-automation.cjs # Typing and response extraction logic
├── sdk/
│   ├── proxima.py              # Python SDK — one function
│   └── proxima.js              # JavaScript SDK — one function
├── assets/                     # Icons, logos, screenshots & demo
└── package.json
```

---

## Troubleshooting

<details>
<summary><strong>Windows Firewall prompt</strong></summary>

Click "Allow" — Proxima only accepts local connections on `localhost:3210` and `localhost:19222`.
</details>

<details>
<summary><strong>Provider shows "Not logged in"</strong></summary>

Click the provider tab and login in the embedded browser. Session will be saved.
</details>

<details>
<summary><strong>MCP says a provider is disabled</strong></summary>

Enable that provider in Proxima Settings first. The direct provider tools (`ask_deepseek`, `ask_grok`, `ask_zai`, `ask_copilot`, `ask_metaai`, `ask_qwen`, etc.) only work when the provider is enabled.
</details>

<details>
<summary><strong>API not responding</strong></summary>

1. Make sure Proxima app is running
2. Visit `http://localhost:3210` in browser
3. Check at least one provider is enabled and logged in
</details>

<details>
<summary><strong>MCP tools not showing in Cursor/VS Code</strong></summary>

1. Ensure Proxima is running
2. Verify the path in your MCP config is correct
3. Restart your AI coding app
</details>

<details>
<summary><strong>File-based MCP tools are not attaching files</strong></summary>

Enable **File Attachments** in Proxima Settings and use absolute paths for `files` or `filePath`.
</details>

---

## License

This software is for **personal, non-commercial use only**.
See [LICENSE](LICENSE) for details.

---

<div align="center">

**Proxima v3.5.0** — One API, All AI Models ⚡

Made by [Zen4-bit](https://github.com/Zen4-bit)
Extended models and features [MindFlowGo](https://github.com/mindflowgo/)

</div>

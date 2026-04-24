<div align="center">

<img src="assets/brainstorm-icon.png" alt="brAInstorm logo" width="64" height="64">

# brAInstorm

### Multi-AI Gateway — One API, All Models

[![Version](https://img.shields.io/badge/version-4.0.0-blue.svg)](https://github.com/mindflowgo/brAInstorm/releases)
[![License](https://img.shields.io/badge/license-Personal%20Use-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)]()
[![MCP Tools](https://img.shields.io/badge/MCP%20Tools-62%2B-orange.svg)]()
[![Providers](https://img.shields.io/badge/AI%20Providers-11-blue.svg)]()

## Introduction

For those people that went between pasting their code into their favorite AI engines because they liked 
the responses and wished their Antigravity or CLI tools would be able to simulate that, we built this.

brAInstorm creates cocooned webservers for each of your AI tools, that then provides MCP services that 
your Antigravity, Codex, or other CLI tools can interface with.

We also provide a customizable skills section where you can build out skills to brief the AI's on.

Now you can pull in the power of:

- ChatGPT, Claude, Gemini, Google AI, Perplexity, DeepSeek, Grok, Z.AI, Copilot, Meta AI, and Qwen

to work on your projects - SAVE tokens as these don't need API keys and are freely available to you.

[Getting Started](#getting-started) · [API Usage](#api-usage) · [Skills](#skills) · [SDKs](#sdks) · [MCP](#mcp) · [Troubleshooting](#troubleshooting)

</div>

![brAInstorm Settings](assets/brainstorm-settings.jpg)

![brAInstorm Provider View](assets/brainstorm-screenshot.jpg)


**One API. One URL. One function field. Any enabled model.**

```json
POST /v1/chat/completions
{"model":"claude","message":"Give me the risky edge cases in this auth flow."}
{"model":"perplexity","message":"What changed in AI this week?","function":"search"}
{"model":"claude","function":"security_audit","code":"async function login(req,res){...}"}
{"model":"claude","function":"code_review","desc":"Please review this Express middleware for bugs:\\n\\nconst allow = req.user?.role === 'admin';"}
```

> **No API keys required.** brAInstorm uses your existing browser sessions to talk to AI providers directly.

## Why brAInstorm?

| Feature | Description |
|---------|-------------|
| **One Endpoint** | Everything through `/v1/chat/completions` |
| **11 AI Providers** | ChatGPT, Claude, Gemini, Google AI, Perplexity, DeepSeek, Grok, Z.AI, Copilot, Meta AI, Qwen |
| **62+ MCP Tools** | Search, code, translation, file analysis, provider control, dynamic skills |
| **Dynamic Skills** | Any `skills/<name>.md` file becomes a callable prompt automatically |
| **REST API** | OpenAI-compatible API on `localhost:3210` |
| **SDKs** | Python and JavaScript clients, plus legacy compatibility aliases |
| **Local and Private** | Runs on localhost, data stays on your machine |
| **Smart Router** | Auto-picks the best available AI for a request |

## What’s New in This Build

- Added **Google AI** as a provider with `ask_googleai` and REST model support.
- Added **dynamic skills** backed by `skills/*.md`.
- Added **`GET /v1/skills`**, **`list_skills`**, **`run_skill`**, and **`brainstorm://skills`**.
- Added **Cloudflare / human verification surfacing** so blocked providers tell you to complete the check in the app.
- Rebranded the app and docs to **brAInstorm** while keeping legacy compatibility where it matters.

## Getting Started

### Requirements

- Windows 10/11 or macOS
- Node.js 18+

### Installation

**Download Installer**

Download the latest release and run the installer. Windows installers are published. macOS can run from source or be built locally from this repo.

[Download for Windows →](https://github.com/mindflowgo/brAInstorm/releases)

**Run from Source**

```bash
git clone https://github.com/mindflowgo/brAInstorm
cd brAInstorm
npm install
npm start
```

### Build Commands

| Command | Output |
|---------|--------|
| `npm start` | Run brAInstorm locally |
| `npm run mcp` | Launch the stdio MCP server directly |
| `npm run build:win` | Build the Windows app |
| `npm run build:installer` | Build the Windows NSIS installer |
| `npm run build:mac` | Build macOS universal `dmg` and `zip` artifacts |
| `npm run build:mac:dir` | Build an unpacked macOS `.app` directory |

Build commands automatically generate a minimal packaged MCP runtime in `build/packaged-runtime/` so the packaged app can expose `src/mcp-server-v3.js`, `skills/`, and only the Node dependencies that runtime actually needs.

### Quick Setup

1. Open brAInstorm, enable the providers you want, and log in to each one.
2. Copy the MCP config from the Settings panel.
3. Connect your MCP client or call the REST API at `http://localhost:3210`.
4. Add or edit files in `skills/` if you want custom reusable prompts.

## Supported Providers

| Provider | Model ID | Enabled by Default | Default Action |
|----------|----------|--------------------|----------------|
| ChatGPT | `chatgpt` | Yes | `chat` |
| Claude | `claude` | No | `chat` |
| Gemini | `gemini` | Yes | `chat` |
| Google AI | `googleai` | No | `chat` |
| Perplexity | `perplexity` | Yes | `search` |
| DeepSeek | `deepseek` | No | `chat` |
| Grok | `grok` | No | `chat` |
| Z.AI | `zai` | No | `chat` |
| Copilot | `copilot` | No | `chat` |
| Meta AI | `metaai` | No | `chat` |
| Qwen | `qwen` | No | `chat` |

## API Usage

### Main Endpoint

```text
POST http://localhost:3210/v1/chat/completions
Content-Type: application/json
```

No `function` field means normal chat. If `function` matches a built-in mode or a discovered skill file, brAInstorm changes behavior automatically.

### Common Functions

| Function | Body Fields | What It Does |
|----------|-------------|--------------|
| *(none)* | `model`, `message` | Normal chat |
| `search` | `model`, `message`, `function` | Web search plus AI analysis |
| `translate` | `model`, `message`, `function`, `to` | Translate text |
| `brainstorm` | `model`, `message`, `function` | Run the `skills/brainstorm.md` prompt |
| `code` | `model`, `message`, `function`, `action` | Generate, review, debug, or explain code |
| `analyze` | `model`, `function`, `url` or `message` | Analyze a URL or content |
| `<skill_name>` | `model`, `function`, skill variables | Run any discovered `skills/<skill_name>.md` prompt |

### System Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/models` | List models and their enabled status |
| `GET` | `/v1/functions` | Function catalog plus current skill registry |
| `GET` | `/v1/skills` | List discovered skills, variables, and templates |
| `GET` | `/v1/stats` | Response time stats |
| `POST` | `/v1/conversations/new` | Start fresh conversations |

### Response Format

Every request returns the same OpenAI-style envelope:

```json
{
  "id": "brainstorm-abc123",
  "model": "claude",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "AI response here..."
      }
    }
  ],
  "brainstorm": {
    "provider": "claude",
    "responseTimeMs": 2400
  },
  "proxima": {
    "provider": "claude",
    "responseTimeMs": 2400
  }
}
```

`brainstorm` is the new metadata key. `proxima` is still included for compatibility with older SDKs and clients.

### API Examples

**Chat**

```bash
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","message":"Give me the obvious failure modes in a password reset flow."}'
```

**Search**

```bash
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"perplexity","message":"What happened in AI this week?","function":"search"}'
```

**Dynamic skill: `code_review`**

```bash
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","function":"code_review","desc":"Please review this Express auth middleware for bugs and obvious improvements:\n\napp.use(async (req,res,next)=>{ if(req.headers.authorization===process.env.ADMIN_TOKEN){ req.user={role:\"admin\"}; } next(); })"}'
```

**Dynamic skill: `security_audit`**

```bash
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","function":"security_audit","language":"TypeScript","code":"async function login(req,res){ const user = await db.find(req.body.email); if(user.password === req.body.password){ res.json({token: sign(user.id)}) } }"}'
```

**List current skills**

```bash
curl http://localhost:3210/v1/skills
```

### How Skill Variables Work Over REST

For REST requests, brAInstorm builds skill variables from:

- Top-level JSON body fields other than `model`, `function`, `messages`, and `variables`
- The optional `variables` object
- Standard message aliases like `message`, `query`, `prompt`, `content`, or `text`

That means all of these work:

```json
{"model":"claude","function":"brainstorm","subject":"Ways to onboard new consultants faster"}
```

```json
{"model":"claude","function":"brainstorm","variables":{"subject":"Ways to onboard new consultants faster"}}
```

## Skills

### How Discovery Works

Skills are never hardcoded. brAInstorm scans the `skills/` directory and builds the registry from the files it finds.

- `skills/<name>.md` becomes a skill named `<name>`
- File contents are the full prompt template
- `${variable}` placeholders are filled from request data
- The registry is loaded at startup and refreshed on skill reads
- Startup logs print the discovered skills and their variable names
- `GET /v1/skills`, `list_skills`, and `brainstorm://skills` expose the live registry

Optional override:

- `BRAINSTORM_SKILLS_DIR=/absolute/path/to/skills`
- Legacy alias still supported: `PROXIMA_SKILLS_DIR`

### Current Bundled Skills

| Skill | Variables | Purpose |
|-------|-----------|---------|
| `brainstorm` | `subject` | Idea generation |
| `code_review` | `desc` | Code review prompt |
| `convo_history_summarize` | `conversationHistory` | Full project-context summary |
| `get_ui_reference` | `description`, `fullCode`, `styleHint` | UI/UX reference and implementation prompt |
| `github_search` | `langFilter`, `query` | GitHub repo and code discovery |
| `security_audit` | `fullCode`, `lang` | Security review prompt |

### Add a New Skill

1. Create a new file in `skills/`, for example `skills/new_skill.md`.
2. Put the full prompt in that file.
3. Use `${variable}` placeholders anywhere you want runtime substitution.
4. Call it with `function: "new_skill"` over REST or `run_skill` over MCP.

Example:

```md
<!-- skills/new_skill.md -->
Write a calm, practical migration plan for this system:

SYSTEM
${system_name}

CONSTRAINTS
${constraints}
```

Then call it over REST:

```bash
curl http://localhost:3210/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","function":"new_skill","system_name":"legacy billing sync","constraints":"no downtime, no schema freeze longer than 10 minutes"}'
```

### MCP Skill Usage

**List skills**

```json
{
  "tool": "list_skills",
  "arguments": {
    "includeTemplate": true
  }
}
```

**Run a skill**

```json
{
  "tool": "run_skill",
  "arguments": {
    "skill": "security_audit",
    "provider": "claude",
    "variables": {
      "lang": " (TypeScript)",
      "fullCode": "async function login(req,res){ const user = await db.find(req.body.email); if(user.password === req.body.password){ res.json({token: sign(user.id)}) } }"
    }
  }
}
```

`run_skill` also supports `files`. If you pass files, brAInstorm exposes their contents as `filesContent`, `fileContent`, `fullCode`, and `desc` when those variables are not already set.

### Skill Resources

- `brainstorm://skills`
- `brainstorm://status`

Legacy compatibility is still available:

- `proxima://skills`
- `proxima://status`

## SDKs

### Python

Primary entrypoint:

```python
from brainstorm import Brainstorm

client = Brainstorm()

reply = client.chat(
    "I need five realistic B2B SaaS ideas for accountants who hate manual month-end work.",
    model="claude",
    function="brainstorm",
)
print(reply.text)

review = client.chat(
    model="claude",
    function="code_review",
    desc="Please review this login handler for bugs and weak spots:\n\nasync function login(req,res){ const user = await db.find(req.body.email); if(user.password === req.body.password){ res.json({token: sign(user.id)}) } }",
)
print(review.text)

skills = client.get_skills()
print(skills["skills"][0]["name"])
```

Installation:

- `pip install requests`
- Copy `sdk/brainstorm.py` into your project

### JavaScript

Primary entrypoint:

```javascript
const { Brainstorm } = require('./brainstorm');

const client = new Brainstorm();

const ideas = await client.chat(
  "Give me seven practical launch ideas for a solo founder selling into local service businesses.",
  { model: "claude", function: "brainstorm" }
);
console.log(ideas.text);

const review = await client.chat("", {
  model: "claude",
  function: "code_review",
  desc: "Please review this Express middleware for auth bugs:\\n\\napp.use(async (req,res,next)=>{ if(req.headers.authorization===process.env.ADMIN_TOKEN){ req.user={role:'admin'}; } next(); })"
});
console.log(review.text);

const skills = await client.getSkills();
console.log(skills.skills.map((skill) => skill.name));
```

Works with Node.js 18+.

Installation:

- Copy `sdk/brainstorm.js` into your project

### Legacy SDK Compatibility

Old SDK files still work:

- `sdk/proxima.py`
- `sdk/proxima.js`

They now understand both the new `brainstorm` response metadata and the legacy `proxima` metadata.

## MCP

### MCP Config

Copy the exact JSON from the brAInstorm Settings panel when possible. A typical source checkout config looks like this:

```json
{
  "mcpServers": {
    "brainstorm": {
      "command": "node",
      "args": ["/absolute/path/to/brAInstorm/src/mcp-server-v3.js"],
      "cwd": "/absolute/path/to/brAInstorm"
    }
  }
}
```

### Typical MCP Paths

| Install Type | Example MCP Server Path | Example `cwd` |
|--------------|-------------------------|---------------|
| Source checkout on macOS | `/Users/you/Dev/brAInstorm/src/mcp-server-v3.js` | `/Users/you/Dev/brAInstorm` |
| Source checkout on Windows | `C:/path/to/brAInstorm/src/mcp-server-v3.js` | `C:/path/to/brAInstorm` |
| Packaged macOS app | `/Applications/brAInstorm.app/Contents/Resources/runtime/src/mcp-server-v3.js` | `/Applications/brAInstorm.app/Contents/Resources/runtime` |
| Packaged Windows app | `C:/Program Files/brAInstorm/resources/runtime/src/mcp-server-v3.js` | `C:/Program Files/brAInstorm/resources/runtime` |

### Compatible Apps

- Cursor
- VS Code with an MCP extension
- Claude Desktop
- Windsurf
- Gemini CLI

### Tool Highlights

**Search and Research**

- `deep_search`
- `pro_search`
- `news_search`
- `academic_search`
- `reddit_search`
- `youtube_search`
- `image_search`
- `math_search`

**Provider Tools**

- `ask_chatgpt`
- `ask_claude`
- `ask_gemini`
- `ask_googleai`
- `ask_deepseek`
- `ask_grok`
- `ask_zai`
- `ask_copilot`
- `ask_metaai`
- `ask_qwen`
- `ask_all_ais`
- `compare_ais`
- `smart_query`
- `init_provider`
- `provider_status`
- `navigate_provider`
- `debug_provider_dom`
- `execute_provider_script`

**Skills**

- `list_skills`
- `run_skill`

**Code and Analysis**

- `generate_code`
- `review_code`
- `debug_code`
- `optimize_code`
- `verify_code`
- `analyze_file`
- `review_code_file`
- `analyze_document`
- `analyze_image_url`

**Window and Session**

- `show_window`
- `hide_window`
- `toggle_window`
- `set_headless_mode`
- `new_conversation`
- `clear_cache`
- `router_stats`
- `get_typing_status`

## Project Structure

```text
brAInstorm/
├── assets/
│   ├── brainstorm-icon.webp
│   └── brainstorm-icon.png
├── electron/
│   ├── main-v2.cjs
│   ├── rest-api.cjs
│   ├── browser-manager.cjs
│   ├── provider-runtime.cjs
│   ├── provider-senders/
│   │   └── googleai.cjs
│   └── index-v2.html
├── sdk/
│   ├── brainstorm.py
│   ├── brainstorm.js
│   ├── proxima.py
│   └── proxima.js
├── skills/
│   ├── brainstorm.md
│   ├── code_review.md
│   ├── convo_history_summarize.md
│   ├── get_ui_reference.md
│   ├── github_search.md
│   └── security_audit.md
├── src/
│   ├── mcp-server-v3.js
│   ├── provider-catalog.cjs
│   ├── provider-automation.cjs
│   └── skill-prompts.cjs
└── package.json
```

## Compatibility Notes

- brAInstorm is the new external brand.
- Legacy `proxima` response metadata is still returned.
- Legacy `proxima://...` MCP resource URIs still work.
- Legacy SDK filenames still work.
- Legacy `PROXIMA_SKILLS_DIR` and `PROXIMA_REST_PORT` are still accepted.

## Troubleshooting

### Windows Firewall prompt

Click "Allow". brAInstorm only accepts local connections on `localhost:3210` and `localhost:19222`.

### Provider shows "Not logged in"

Click the provider tab and log in inside the embedded browser.

### MCP says a provider is disabled

Enable that provider in brAInstorm Settings first. Direct provider tools only work when the provider is enabled.

### API not responding

1. Make sure the brAInstorm app is running.
2. Visit `http://localhost:3210` in a browser.
3. Check that at least one provider is enabled and logged in.

### MCP tools are missing in Cursor or VS Code

1. Ensure brAInstorm is running.
2. Recopy the MCP JSON from Settings if you are using a packaged install.
3. Verify the MCP server path and `cwd`.
4. Restart the MCP client app.

### A new skill is not showing up

1. Make sure the file ends with `.md`.
2. Put it inside `skills/` or your `BRAINSTORM_SKILLS_DIR`.
3. Call `GET /v1/skills` or the MCP `list_skills` tool.
4. Check the startup logs for the discovered skill list.

### File-based MCP tools are not attaching files

Enable **File Attachments** in brAInstorm Settings and use absolute paths for `files` or `filePath`.

## License

This software is for **personal, non-commercial use only**.
See [LICENSE](LICENSE) for details.

## Contributing
This project is made for the community. Any contributions are welcome.

I put time into evolving it as I needed the tools and I'm sure you will need more features - well 
add them and let's evolve this together. 

Original idea came from [Zen4-bit](https://github.com/Zen4-bit). He didn't want to built out the 
modular provider architecture so we forked and reworked it. But let's not keep reforking - lets 
work on this together!

Current models and features by [MindFlowGo](https://github.com/mindflowgo/)

Contributors will be tracked in [CONTRIBUTORS.md](CONTRIBUTORS.md).


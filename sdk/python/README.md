# 🚀 Proxima SDK for Python

**Free, local AI gateway** — Chat with ChatGPT, Claude, Gemini, Perplexity through a single API. No API keys needed.

```bash
pip install proxima-sdk
```

## Quick Start

```python
from proxima import Proxima

# Automatically discovers the gateway port via rest-port.json (defaults to localhost:3210)
ai = Proxima()

# 💬 Chat with default model
response = ai.chat("What is machine learning?")
print(response)

# 🎯 Choose a specific provider or discovered model
response = ai.chat("Explain quantum computing", model="claude")

# 🧠 Control reasoning depth for thinking models
response = ai.chat(
    "Analyze this mathematical proof",
    model="gemini",
    thinking_level="high"  # 'default', 'low', 'medium', 'high'
)

# 📋 Discover available models for your active account
available_models = ai.models()
```

## Features

### 🔍 Web Search (Free!)
```python
# AI-powered search via Perplexity
results = ai.search("Latest AI news 2026")

# Free DuckDuckGo search (no AI, direct results)
results = ai.ddg_search("Python tutorials")
for r in results["proxima"]["results"]:
    print(f"{r['title']} → {r['url']}")
```

### 🌐 Web Scraper
```python
# Any URL → clean markdown
content = ai.scrape("https://docs.python.org/3/tutorial/")
print(content)  # Clean, readable markdown
```

### 💻 Code Generation
```python
# Generate code
code = ai.code("Binary search in Python")

# Review code
review = ai.code(my_code, action="review")

# Debug code
fix = ai.code(buggy_code, action="debug")
```

### 🤖 Multi-Agent Crew (role-based pipeline)
```python
# Default crew: Researcher → Writer → Reviewer
result = ai.crew("Write a blog post about AI in healthcare")

# Custom agents
result = ai.crew("Build a startup landing page", agents=[
    {"role": "Researcher", "model": "perplexity", "instruction": "Research competitor websites"},
    {"role": "Copywriter", "model": "claude", "instruction": "Write compelling headlines and copy"},
    {"role": "Developer", "model": "chatgpt", "instruction": "Generate responsive HTML/CSS"}
])
```

### ⚔️ Battle Mode (Compare AIs)
```python
result = ai.battle("What is the best programming language?")
# Gets answers from ALL available AIs simultaneously
```

### 🌍 Translate
```python
result = ai.translate("Hello, how are you?", to="Hindi")
result = ai.translate("Bonjour le monde", to="Japanese")
```

### 🛡️ Security Audit
```python
result = ai.security_audit("""
app.get("/user", (req, res) => {
    db.query("SELECT * FROM users WHERE id=" + req.params.id)
})
""")
```

## API Key Authentication

```python
# If Proxima has API key enabled:
ai = Proxima(api_key="sk-your-key-proxima")

# Custom server URL:
ai = Proxima(base_url="http://192.168.1.100:3210/v1")
```

## Async Client

```python
from proxima import AsyncProxima
import asyncio

async def main():
    async with AsyncProxima(api_key="sk-xxx") as ai:
        response = await ai.chat("Hello!")
        results = await ai.scrape("https://example.com")
        print(response)

asyncio.run(main())
```

```bash
# Install async support
pip install proxima-sdk[async]
```

## Available Models

Proxima supports both core provider aliases and dynamically discovered account models:

| Provider | Core Aliases | Discovered Sub-Engines (Examples) |
|---|---|---|
| ChatGPT | `chatgpt`, `gpt`, `openai` | Discovered from account (`chatgpt:gpt-5-6-mini`, etc.) |
| Claude | `claude`, `anthropic`, `sonnet` | Active session models |
| Gemini | `gemini`, `google`, `bard` | `gemini:argon`, `gemini:flash`, `gemini:pro`, `gemini:latest` |
| Perplexity | `perplexity`, `pplx`, `sonar` | Active session search models |
| Auto | `auto` | Dynamically routes to the best responsive model |

Call `ai.models()` at runtime to inspect the exact live models and capability tags (`Fast`, `Reasoning`, `Pro`) available for your account.

## Available Functions

| Function | Description |
|---|---|
| `chat()` | Normal AI conversation (supports `thinking_level` and `reasoning_effort`) |
| `models()` | List dynamically discovered and available models |
| `search()` | AI-powered web search |
| `ddg_search()` | Free DuckDuckGo search |
| `scrape()` | URL to markdown |
| `code()` | Generate/review/debug code |
| `translate()` | Translate text |
| `brainstorm()` | Generate ideas |
| `analyze()` | Analyze content/URLs |
| `crew()` | Multi-agent pipeline |
| `battle()` | Compare multiple AIs |
| `security_audit()` | Code security scan |

## Requirements

- Python 3.8+
- Proxima AI Gateway running locally (or on network)

## License

MIT — [github.com/zen4-bit/proxima](https://github.com/zen4-bit/proxima)

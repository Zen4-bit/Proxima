# 🚀 Proxima SDK for Python

**Free, local AI gateway** — Chat with ChatGPT, Claude, Gemini, Perplexity through a single API. No API keys needed.

```bash
pip install proxima-sdk
```

## Quick Start

```python
from proxima import Proxima

ai = Proxima()  # Connects to localhost:3210

# 💬 Chat with any AI
response = ai.chat("What is machine learning?")
print(response)

# 🎯 Choose your model
response = ai.chat("Explain quantum computing", model="claude")
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

| Model | Aliases |
|-------|---------|
| ChatGPT | `chatgpt`, `gpt`, `gpt-4`, `openai` |
| Claude | `claude`, `anthropic`, `sonnet` |
| Gemini | `gemini`, `google`, `bard` |
| Perplexity | `perplexity`, `pplx`, `sonar` |
| Auto | `auto` (picks best available) |

## Available Functions

| Function | Description |
|----------|-------------|
| `chat()` | Normal AI conversation |
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

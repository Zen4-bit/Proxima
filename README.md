<div align="center">

# Proxima

### Multi-AI MCP Server

Connect ChatGPT, Claude, Gemini & Perplexity to your AI coding tools via MCP

[Getting Started](#getting-started) · [MCP Tools](#available-mcp-tools) · [Configuration](#mcp-configuration) · [Providers](#supported-providers)

---

</div>

## Overview

Proxima is a local MCP (Model Context Protocol) server that connects multiple AI providers to your coding environment. Instead of paying for API keys, use your existing AI accounts directly.

> **Model Context Protocol (MCP)** is an open standard that connects AI assistants with external tools and data sources. Learn more at [modelcontextprotocol.io](https://modelcontextprotocol.io)

### Why Proxima?

| Feature | Description |
|---------|-------------|
| **Multi-AI Support** | ChatGPT, Claude, Gemini, Perplexity in one place |
| **No API Keys** | Use your existing account logins |
| **Local Server** | Runs on localhost, your data stays private |
| **45+ Tools** | Search, code, research, and more |

---

## Getting Started

### Installation

<table>
<tr>
<td width="50%">

**Download Installer**

Download the latest release and run the installer.

[Download for Windows →](../../releases)

</td>
<td width="50%">

**Run from Source**

```bash
git clone https://github.com/user/proxima
cd proxima
npm install
npm start
```

</td>
</tr>
</table>

### Quick Setup

1. **Open Proxima** and login to your AI providers
2. **Copy MCP config** from Settings
3. **Paste** into your AI coding app's MCP configuration
4. **Start using** the MCP tools

---

## Supported Providers

<table>
<tr>
<td align="center" width="25%">
<br>
<strong>Perplexity</strong>
<br>
Web search & research
<br><br>
</td>
<td align="center" width="25%">
<br>
<strong>ChatGPT</strong>
<br>
OpenAI's GPT models
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
</tr>
</table>

---

## MCP Configuration

Add this to your AI coding app's MCP configuration:

```json
{
  "mcpServers": {
    "proxima": {
      "command": "node",
      "args": ["C:/path/to/proxima/src/mcp-server-v3.js"]
    }
  }
}
```

> **Tip:** Copy the exact path from Proxima's Settings panel

### Compatible Apps

Works with any MCP-compatible client:
- Cursor
- VS Code (with MCP extension)
- Claude Desktop
- Windsurf
- And more...

---

## Available MCP Tools

### Search Tools

| Tool | Description |
|------|-------------|
| `deep_search` | Comprehensive web search |
| `pro_search` | Advanced research query |
| `youtube_search` | Find YouTube videos |
| `reddit_search` | Search Reddit discussions |
| `news_search` | Latest news articles |
| `academic_search` | Scholarly papers & research |

### Code Tools

| Tool | Description |
|------|-------------|
| `verify_code` | Check code best practices |
| `explain_code` | Get code explanations |
| `generate_code` | Generate code snippets |
| `debug_code` | Find and fix bugs |
| `optimize_code` | Performance improvements |
| `review_code` | Code review feedback |

### Multi-AI Tools

| Tool | Description |
|------|-------------|
| `ask_chatgpt` | Query ChatGPT |
| `ask_claude` | Query Claude |
| `ask_gemini` | Query Gemini |
| `ask_all_ais` | Query all providers at once |
| `compare_ais` | Compare responses from multiple AIs |
| `smart_query` | Automatic provider selection with fallback |

---

## Project Structure

```
proxima/
├── electron/
│   ├── main-v2.cjs          # Electron main process
│   ├── browser-manager.cjs   # Browser view management
│   └── index-v2.html         # Application UI
├── src/
│   └── mcp-server-v3.js      # MCP server implementation
├── images/                    # Provider logos
└── package.json
```

---

## Troubleshooting

<details>
<summary><strong>Windows Firewall prompt appears</strong></summary>

Proxima runs a local server on `localhost:19222` for MCP communication. Click "Allow" when prompted - the server only accepts local connections.

</details>

<details>
<summary><strong>Provider shows "Not logged in"</strong></summary>

Click the provider tab and complete the login process in the embedded browser. Your session will be saved.

</details>

<details>
<summary><strong>MCP tools not working</strong></summary>

1. Ensure Proxima is running
2. Verify the path in your MCP config is correct
3. Restart your AI coding app

</details>

---

## License

This software is for **personal, non-commercial use only**.  
Commercial and enterprise use is not permitted.  
See [LICENSE](LICENSE) for details.

---

<div align="center">

Made for AI-powered development

</div>

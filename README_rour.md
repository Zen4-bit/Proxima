<div align="center">

<img src="assets/proxima-icon.png" alt="Proxima" width="72"/>

# Proxima

**4 AI providers. 1 local server. No API keys.**

ChatGPT, Claude, Gemini aur Perplexity ko apne coding tools ke andar istemal karein — apne existing accounts ke zariye.

<br>

[![Version](https://img.shields.io/badge/version-4.1.0-blue)](https://github.com/Zen4-bit/Proxima/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/Zen4-bit/Proxima#Install)

[![License](https://img.shields.io/badge/license-Non--Commercial-red)](LICENSE)
[![Website](https://img.shields.io/badge/Website-proximamcp.in-blue)](https://www.proximamcp.in)
[![Stars](https://img.shields.io/github/stars/Zen4-bit/Proxima?style=social)](https://github.com/Zen4-bit/Proxima/stargazers)
[![Sponsors](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/Zen4-bit/Sponsors)

<br>

[Getting Started](#getting-started) · [CLI](#cli-tool) · [REST API](#rest-api) · [WebSocket](#websocket) · [SDKs](#sdks) · [MCP Tools](#mcp-tools)

<br>

**Languages:** [English](README.md) · [Русский](README_ru.md)

</div>

<br>

---

## Demo

**App Demo · CLI · Webhook Live Chat & Battle · Application Overview**

<table cellspacing="0" cellpadding="0">
<tr>
<td width="50%">

https://github.com/user-attachments/assets/5e75eb68-b1b5-43dc-979d-3bf6faa48fa0

</td>
<td width="50%">

https://github.com/user-attachments/assets/a8564fc9-b3b3-4a53-bc35-cfce72fe34da

</td>
</tr>
<tr>
<td width="50%">

https://github.com/user-attachments/assets/bb7fa455-d379-4e69-b530-f7c09d2faccf

</td>
<td width="50%">

https://github.com/user-attachments/assets/d4121fdb-f97e-4d35-846c-5ec7c5249a85

</td>
</tr>
</table>

---

## Overview

Proxima ek local AI gateway hai jo multiple AI providers ko aapke development environment se connect karta hai. Ye har provider ke saath browser level par aapke active login sessions ke zariye baat karta hai — bilkul waise hi jaise aap browser mein chat karte hain.

<br>

<table>
<tr>
<td>🌐 <strong>One Endpoint</strong></td>
<td>Sab kuch <code>/v1/chat/completions</code> ke zariye — koi alag URL nahi</td>
</tr>
<tr>
<td>🤖 <strong>4 AI Providers</strong></td>
<td>ChatGPT, Claude, Gemini, Perplexity — koi bhi model, koi bhi kaam</td>
</tr>
<tr>
<td>⚡ <strong>Provider Engines</strong></td>
<td>Native browser-level communication — 3–10x zyada fast aur reliable</td>
</tr>
<tr>
<td>🖥️ <strong>CLI Tool</strong></td>
<td><code>proxima ask</code>, <code>proxima fix</code>, <code>proxima debate</code> — seedha aapke terminal se</td>
</tr>
<tr>
<td>🔌 <strong>WebSocket</strong></td>
<td>Real-time streaming <code>ws://localhost:3210/ws</code> par</td>
</tr>
<tr>
<td>🧰 <strong>45+ MCP Tools</strong></td>
<td>Search, code, translate, analyze, debate, audit — sab MCP ke zariye</td>
</tr>
<tr>
<td>📡 <strong>REST API</strong></td>
<td>OpenAI-compatible API <code>localhost:3210</code> par</td>
</tr>
<tr>
<td>📦 <strong>SDKs</strong></td>
<td>Python aur JavaScript — bas ek function ka kaam</td>
</tr>
<tr>
<td>🧠 <strong>Smart Router</strong></td>
<td>Aapke sawal ke liye khud best AI chunta hai</td>
</tr>
<tr>
<td>🔑 <strong>No API Keys</strong></td>
<td>Aapke purane browser sessions use karta hai — dekhein <a href="#security--privacy">ye kaise kaam karta hai</a></td>
</tr>
<tr>
<td>🔒 <strong>Local & Private</strong></td>
<td><code>127.0.0.1</code> par chalta hai, data sirf un providers ko jata hai jinmein aap login hain</td>
</tr>
</table>

<br>

---

## What's New in v4.1.0

<table>
<tr>
<td width="40"><strong>🔥</strong></td>
<td><strong>Provider Engine System</strong><br>Proxima ab native browser-level communication use karta hai — koi DOM scraping nahi. Responses 3–10x fast hain aur SSE streaming ka support hai.</td>
</tr>
<tr>
<td><strong>⚡</strong></td>
<td><strong>CLI Tool</strong><br>Terminal mein <code>proxima ask</code>, <code>proxima fix</code>, <code>proxima debate</code> chalayein. Build errors ko direct pipe karein.</td>
</tr>
<tr>
<td><strong>🔌</strong></td>
<td><strong>WebSocket Server</strong><br><code>ws://localhost:3210/ws</code> par real-time streaming AI.</td>
</tr>
<tr>
<td><strong>🛠️</strong></td>
<td><strong>15 New MCP Tools</strong><br>Naye tools jaise <code>chain_query</code>, <code>solve</code>, <code>debate</code>, <code>security_audit</code>, <code>github_search</code> wagera shamil hain.</td>
</tr>
<tr>
<td><strong>📄</strong></td>
<td><strong>Interactive API Docs</strong><br>Live docs <code>/docs</code> par, jahan aap chat widget test kar sakte hain.</td>
</tr>
<tr>
<td><strong>🎯</strong></td>
<td><strong>Multi-Model Queries</strong><br><code>model: "all"</code> se ek sath saare providers se jawab lein.</td>
</tr>
<tr>
<td><strong>📤</strong></td>
<td><strong>Conversation Export</strong><br>Kisi bhi provider se apni puri chat history export karein.</td>
</tr>
</table>

<br>

---

## Getting Started

### Requirements
- [Node.js 18+](https://nodejs.org/)
- **Windows 10/11** — Installer available
- **macOS / Linux** — Source code se chala sakte hain

### Install
1. **Windows:** Latest release download aur install karein.
2. **Source:**
```bash
git clone https://github.com/Zen4-bit/Proxima.git
cd Proxima
npm install
npm start
```

### Connect to your editor
1. Proxima mein login karein.
2. **Settings → MCP Configuration** mein ja kar config copy karein.
3. Apne editor (Cursor/VS Code) ki MCP config file mein paste karein aur restart karein.

---

## Security & Privacy

- **Koi credentials save nahi hote:** Proxima aapke browser ke cookies use karta hai.
- **Local hai:** Sab kuch aapke machine par chalta hai, internet par kuch nahi jata.
- **Private:** Koi telemetry ya data tracking nahi hai.

---

## License

Proxima sirf **non-commercial** istemal ke liye hai. Poori details [LICENSE](LICENSE) file mein dekhein.

---

<div align="center">

**Proxima v4.1.0** — One API, All AI Models ⚡

Made by [Zen4-bit](https://github.com/Zen4-bit) · Every ⭐ matters 💕

</div>

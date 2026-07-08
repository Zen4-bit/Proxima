// Proxima — REST API Docs Page
//
// Renders the main gateway landing/docs HTML: live provider chips, stats,
// model list, the one-endpoint function table, and integration guides. Embeds
// the shared chat widget.
const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT, 10) || 3210;
const VERSION = '5.0.0';

const { getChatHTML, getChatJS } = require('./widget.cjs');

function getDocsPage(getEnabled, getFormattedStats) {
    // Defensive: a malformed providers/stats payload must never throw and 500
    // the whole docs page. Coerce to safe empty shapes up front.
    const _enabledRaw = getEnabled();
    const enabled = Array.isArray(_enabledRaw) ? _enabledRaw : [];
    const s = getFormattedStats() || {};

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxima API</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Inter',sans-serif;background:#08080d;color:#d4d4e0;min-height:100vh;line-height:1.6}
        .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(139,92,246,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,.025) 1px,transparent 1px);background-size:60px 60px}
        .wrap{max-width:920px;margin:0 auto;padding:36px 20px;position:relative;z-index:1}
        .head{text-align:center;margin-bottom:32px}
        .logo{font-size:42px;font-weight:700;background:linear-gradient(135deg,#a78bfa,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .sub{color:#666;font-size:14px;margin-top:2px}
        .chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:16px}
        .chip{display:flex;align-items:center;gap:5px;padding:4px 11px;border-radius:16px;font-size:11px;font-weight:500;background:rgba(139,92,246,.06);border:1px solid rgba(139,92,246,.12)}
        .chip.on .d{background:#22c55e;box-shadow:0 0 6px #22c55e}.chip.off .d{background:#ef4444}
        .d{width:6px;height:6px;border-radius:50%}
        .line{height:1px;background:linear-gradient(90deg,transparent,rgba(139,92,246,.3),transparent);margin:24px 0}
        .sec{margin-bottom:24px}
        .st{font-size:16px;font-weight:600;color:#a78bfa;margin-bottom:10px}
        .card{background:rgba(16,16,24,.85);border:1px solid rgba(139,92,246,.1);border-radius:8px;padding:14px 16px;margin-bottom:5px;transition:border-color .2s}
        .card:hover{border-color:rgba(139,92,246,.3)}
        .row{display:flex;align-items:center;gap:8px}
        .m{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;min-width:36px;text-align:center}
        .m.g{background:rgba(34,197,94,.1);color:#22c55e}.m.p{background:rgba(59,130,246,.1);color:#3b82f6}
        .ep{font-family:'JetBrains Mono',monospace;font-size:12px;color:#c4b5fd}.ds{color:#555;font-size:11px;margin-left:auto}
        .sg{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
        .sc{background:rgba(16,16,24,.85);border:1px solid rgba(139,92,246,.1);border-radius:8px;padding:12px 14px}
        .sl{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
        .sv{font-size:22px;font-weight:700;color:#c4b5fd;margin-top:2px}
        .ss{color:#444;font-size:10px;margin-top:1px}
        .ex{background:rgba(6,6,12,.9);border:1px solid rgba(139,92,246,.12);border-radius:8px;padding:14px;margin-top:5px}
        .ex h4{color:#a78bfa;font-size:10px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}
        pre{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5;color:#a5b4fc;white-space:pre-wrap}
        .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.15);margin-left:8px}
        .foot{text-align:center;margin-top:36px;color:#333;font-size:11px}
        .ar{color:#444;font-size:10px;margin-top:6px}
        .highlight{background:rgba(139,92,246,.08);border:1px solid rgba(139,92,246,.2);border-radius:8px;padding:16px;margin:12px 0}
        .highlight h3{color:#a78bfa;font-size:14px;margin-bottom:6px}
        .highlight p{color:#888;font-size:12px}
        .model-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px;margin-top:8px}
        .model-item{font-family:'JetBrains Mono',monospace;font-size:11px;color:#a5b4fc;padding:4px 8px;background:rgba(139,92,246,.04);border-radius:4px}
        .nav{display:flex;justify-content:center;gap:4px;margin-bottom:24px}
        .nav a{padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:all .2s;border:1px solid transparent}
        .nav a.active{background:rgba(139,92,246,.15);color:#a78bfa;border-color:rgba(139,92,246,.3)}
        .nav a:not(.active){color:#666;background:rgba(16,16,24,.5);border-color:rgba(255,255,255,.05)}
        .nav a:not(.active):hover{color:#a78bfa;border-color:rgba(139,92,246,.2);background:rgba(139,92,246,.05)}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="nav"><a href="/" class="active">⚡ REST API</a><a href="/cli">🖥️ CLI</a><a href="/ws">🔌 WebSocket</a><a href="/api-key">🔑 API Key</a></div>
        <div class="head">
            <div class="logo">⚡ Proxima API</div>
            <p class="sub">Unified AI Gateway · Port ${REST_PORT} · v${VERSION}</p>
            <div class="chips" id="provider-chips">
                ${enabled.map(p =>
        `<div class="chip on"><div class="d"></div>${p[0].toUpperCase() + p.slice(1)}</div>`
    ).join('')}
            </div>
        </div>

        ${getChatHTML('#a78bfa')}
        <div class="line"></div>

        <div class="highlight">
            <h3>🎯 ONE Endpoint — Everything</h3>
            <p>Same URL for chat, search, translate, code, analyze. Use <code>"function"</code> field to change behavior.</p>
            <pre style="margin-top:8px">
POST /v1/chat/completions

// Chat
{"model": "claude", "message": "Hello"}

// Search — add "function": "search"
{"model": "perplexity", "message": "AI news", "function": "search"}

// Translate — add "function": "translate" + "to"
{"model": "gemini", "message": "Hello", "function": "translate", "to": "Hindi"}

// Code — add "function": "code"
{"model": "claude", "message": "Sort algo", "function": "code"}

// Multimodal / Image Upload — add "filePath" for Gemini visual routing (specifically routed via Gemini)
{"model": "gemini", "message": "Describe this image", "filePath": "D:\\path\\to\\image.png"}</pre>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📊 Live Stats</div>
            <div class="sg">
                <div class="sc"><div class="sl">Requests</div><div class="sv">${s.totalRequests}</div><div class="ss">${s.totalErrors} errors</div></div>
                <div class="sc"><div class="sl">Uptime</div><div class="sv">${s.uptime}</div></div>
                ${Object.entries(s.providers || {}).map(([n, d]) => `<div class="sc"><div class="sl">${n[0].toUpperCase() + n.slice(1)}</div><div class="sv">${d.avgTime}</div><div class="ss">${d.calls} calls · ${d.minTime}–${d.maxTime}</div></div>`).join('')}
            </div>
            <div class="ar">Auto-refreshes every 10s</div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🤖 Models</div>
            <div class="model-grid" id="model-grid-dynamic">
                ${enabled.map(p => `<div class="model-item">${p}</div>`).join('')}
                <div class="model-item">auto → best available</div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">⚡ Functions (same endpoint, different body)</div>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#22c55e;font-weight:600">chat</td><td style="padding:8px">No function field needed</td><td style="padding:8px;color:#888">Default</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#3b82f6;font-weight:600">search</td><td style="padding:8px">"function": "search"</td><td style="padding:8px;color:#888">Web search + AI</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#f97316;font-weight:600">translate</td><td style="padding:8px">"function": "translate", "to": "Hindi"</td><td style="padding:8px;color:#888">Translate text</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#a855f7;font-weight:600">brainstorm</td><td style="padding:8px">"function": "brainstorm"</td><td style="padding:8px;color:#888">Generate ideas</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#ef4444;font-weight:600">code</td><td style="padding:8px">"function": "code", "action": "generate|review|debug|explain"</td><td style="padding:8px;color:#888">Code tools</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#06b6d4;font-weight:600">analyze</td><td style="padding:8px">"function": "analyze", "url": "..."</td><td style="padding:8px;color:#888">Analyze URL/content</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#eab308;font-weight:600">security_audit</td><td style="padding:8px">"function": "security_audit", "code": "..."</td><td style="padding:8px;color:#888">Security vulnerability scan</td></tr>
            <tr><td style="padding:8px;color:#ec4899;font-weight:600">debate</td><td style="padding:8px">"function": "debate"</td><td style="padding:8px;color:#888">Multi-perspective debate</td></tr>
            </table>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📖 Examples — ALL use same URL</div>
            <div class="ex">
                <h4>Chat</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "claude", "message": "What is AI?"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Search (same URL, add function)</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -d '{"model": "perplexity", "message": "AI news 2026", "function": "search"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Translate (same URL, add function + to)</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -d '{"model": "gemini", "message": "Hello world", "function": "translate", "to": "Hindi"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Code Generate (same URL, add function + action)</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -d '{"model": "claude", "message": "Sort algorithm", "function": "code", "action": "generate", "language": "Python"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Multimodal Image Upload (Gemini visual routing)</h4>
                <pre>curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "gemini", "message": "Describe this screenshot", "filePath": "D:\\\\path\\\\to\\\\screenshot.png"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4>Any Model — Same Pattern</h4>
                <pre>// Search with ChatGPT
{"model": "chatgpt", "message": "AI trends", "function": "search"}

// Code with Gemini
{"model": "gemini", "message": "REST API", "function": "code"}

// Chat with Perplexity
{"model": "perplexity", "message": "Explain quantum computing"}

// Auto pick — for anything
{"model": "auto", "message": "Hello"}</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#f59e0b">🔑 API Key — Authentication</div>
            <div class="highlight" style="background:rgba(245,158,11,.06);border-color:rgba(245,158,11,.15)">
                <h3 style="color:#f59e0b">What is the API Key?</h3>
                <p>API key secures your Proxima server. Without it, anyone on your network can use your AI providers. Once you generate a key from Settings → API Key, every API request must include it.</p>
            </div>
            <div class="ex">
                <h4 style="color:#f59e0b">Step 1 — Generate Key</h4>
                <pre>Open Proxima App → Settings → REST API section
Click "Generate Key" button
Your key looks like: <span style="color:#fbbf24;font-weight:600">sk-a1b2c3d4e5f6-proxima</span>
Copy and save it securely!</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4 style="color:#f59e0b">Step 2 — Use in Requests</h4>
                <pre>Add this header to every request:

<span style="color:#fbbf24">Authorization: Bearer sk-a1b2c3d4e5f6-proxima</span>

# cURL example
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-a1b2c3d4e5f6-proxima"</span> \\
  -d '{"model": "auto", "message": "Hello"}'</pre>
            </div>
            <div class="ex" style="margin-top:6px">
                <h4 style="color:#f59e0b">No Key? No Problem</h4>
                <pre>If you haven't generated a key yet, API is <span style="color:#22c55e">open access</span>.
You can use it without any Authorization header.
Generate a key only when you need security.</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#ec4899">🔗 Integration Guides — Connect Anywhere</div>

            <div class="highlight" style="background:rgba(236,72,153,.06);border-color:rgba(236,72,153,.15)">
                <h3 style="color:#ec4899">Universal Settings (for any OpenAI-compatible app)</h3>
                <pre style="margin-top:6px">
Base URL:   <span style="color:#ec4899;font-weight:600">http://localhost:${REST_PORT}/v1</span>
API Key:    <span style="color:#fbbf24;font-weight:600">sk-XXXX-proxima</span> (from Settings)
Model:      <span style="color:#22c55e">auto</span>  (or: claude, chatgpt, gemini, perplexity)</pre>
                <p style="margin-top:8px">Works with: OpenClaw, Nanobot, Continue.dev, Cursor, LibreChat, Open WebUI, LobeChat, ChatBox, and any app that supports custom OpenAI endpoints.</p>
            </div>

            <div class="ex" style="margin-top:10px">
                <h4 style="color:#22c55e">🐈 Nanobot (Terminal AI Agent)</h4>
                <pre><span style="color:#888"># Step 1: Install</span>
pip install nanobot-ai

<span style="color:#888"># Step 2: Config — save as ~/.nanobot/config.json</span>
{
  "providers": {
    "custom": {
      <span style="color:#fbbf24">"apiKey": "sk-XXXX-proxima"</span>,
      <span style="color:#ec4899">"apiBase": "http://localhost:${REST_PORT}/v1"</span>
    }
  },
  "agents": {
    "defaults": {
      "provider": "custom",
      <span style="color:#22c55e">"model": "auto"</span>
    }
  }
}

<span style="color:#888"># Step 3: Use</span>
nanobot agent                          <span style="color:#888"># Interactive chat</span>
nanobot agent -m "Explain AI"          <span style="color:#888"># One-shot question</span>
nanobot agent -m "Create hello.py"     <span style="color:#888"># Create files</span></pre>
            </div>

            <div class="ex" style="margin-top:6px">
                <h4 style="color:#a78bfa">🦞 OpenClaw / Any OpenAI Client</h4>
                <pre><span style="color:#888"># In the app settings, enter:</span>

API Base URL:  <span style="color:#ec4899">http://localhost:${REST_PORT}/v1</span>
API Key:       <span style="color:#fbbf24">sk-XXXX-proxima</span>
Model:         <span style="color:#22c55e">auto</span>

<span style="color:#888"># That's it! The app will talk to Proxima,
# Proxima routes to Claude/ChatGPT/Gemini/Perplexity.</span></pre>
            </div>

            <div class="ex" style="margin-top:6px">
                <h4 style="color:#3b82f6">🐍 Python (OpenAI SDK)</h4>
                <pre>import openai

client = openai.OpenAI(
    <span style="color:#ec4899">base_url="http://localhost:${REST_PORT}/v1"</span>,
    <span style="color:#fbbf24">api_key="sk-XXXX-proxima"</span>
)

response = client.chat.completions.create(
    <span style="color:#22c55e">model="auto"</span>,  <span style="color:#888"># or: claude, chatgpt, gemini</span>
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)</pre>
            </div>

            <div class="ex" style="margin-top:6px">
                <h4 style="color:#06b6d4">📦 JavaScript / Node.js</h4>
                <pre>const response = await fetch("<span style="color:#ec4899">http://localhost:${REST_PORT}/v1/chat/completions</span>", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        <span style="color:#fbbf24">"Authorization": "Bearer sk-XXXX-proxima"</span>
    },
    body: JSON.stringify({
        <span style="color:#22c55e">model: "auto"</span>,
        message: "Hello from JavaScript!"
    })
});
const data = await response.json();
console.log(data.choices[0].message.content);</pre>
            </div>

            <div class="ex" style="margin-top:6px">
                <h4 style="color:#f97316">🌊 cURL (Terminal)</h4>
                <pre><span style="color:#888"># Simple chat</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-XXXX-proxima"</span> \\
  -d '{"model": "auto", "message": "Hello!"}'

<span style="color:#888"># Streaming (SSE) — for real-time responses</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-XXXX-proxima"</span> \\
  -d '{"model": "claude", "message": "Hello!", <span style="color:#22c55e">"stream": true</span>}'

<span style="color:#888"># OpenAI format (messages array)</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-XXXX-proxima"</span> \\
  -d '{"model": "chatgpt", "messages": [{"role": "user", "content": "Hello!"}]}'</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#ef4444">❓ Troubleshooting</div>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#ef4444;font-weight:600">401 Error</td><td style="padding:8px">Missing or wrong API key. Add <code style="color:#fbbf24">Authorization: Bearer sk-xxx-proxima</code> header</td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#f97316;font-weight:600">404 Model</td><td style="padding:8px">That provider is disabled. Enable it in Proxima Settings, or use <code style="color:#22c55e">model: "auto"</code></td></tr>
            <tr style="border-bottom:1px solid rgba(255,255,255,.06)"><td style="padding:8px;color:#3b82f6;font-weight:600">Connection refused</td><td style="padding:8px">Proxima not running or REST API toggle is OFF. Start Proxima and enable REST API</td></tr>
            <tr><td style="padding:8px;color:#a78bfa;font-weight:600">Slow response</td><td style="padding:8px">Normal — Proxima uses browser sessions, not direct API. First request takes 5-15s</td></tr>
            </table>
        </div>

        <div class="foot">Proxima API v${VERSION} — Zen4-bit ⚡<br><span style="font-size:10px;color:#444">OpenAI-compatible · Free AI Gateway · No API keys to buy</span></div>
    </div>
    ${getChatJS()}
</body>
</html>`;
}

module.exports = { getDocsPage };


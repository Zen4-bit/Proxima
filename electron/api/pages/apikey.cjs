// Proxima — API Key & Integration Guide Page
//
// Renders the HTML docs page explaining API-key generation and how to connect
// OpenAI-compatible clients to the local gateway. Reflects current key status.
const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT) || 3210;
const VERSION = '5.0.0';

function getAPIKeyPage(loadApiKey) {
    const keyData = loadApiKey();
    const keyStatus = keyData ? `<span style="color:#f59e0b;font-weight:600">🔒 SECURED</span> — Key active since ${new Date(keyData.createdAt).toLocaleDateString()}` : `<span style="color:#22c55e;font-weight:600">🔓 OPEN ACCESS</span> — No key generated yet`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxima — API Key & Integration Guide</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Inter',sans-serif;background:#08080d;color:#d4d4e0;min-height:100vh;line-height:1.6}
        .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(245,158,11,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(245,158,11,.02) 1px,transparent 1px);background-size:60px 60px}
        .wrap{max-width:920px;margin:0 auto;padding:36px 20px;position:relative;z-index:1}
        .head{text-align:center;margin-bottom:32px}
        .logo{font-size:42px;font-weight:700;background:linear-gradient(135deg,#f59e0b,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .sub{color:#666;font-size:14px;margin-top:2px}
        .line{height:1px;background:linear-gradient(90deg,transparent,rgba(245,158,11,.3),transparent);margin:28px 0}
        .sec{margin-bottom:28px}
        .st{font-size:18px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}
        .card{background:rgba(16,16,24,.85);border:1px solid rgba(245,158,11,.1);border-radius:10px;padding:16px 18px;margin-bottom:8px;transition:border-color .2s}
        .card:hover{border-color:rgba(245,158,11,.3)}
        .highlight{background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.15);border-radius:10px;padding:18px;margin:12px 0}
        .highlight h3{font-size:15px;margin-bottom:8px}
        .highlight p{color:#999;font-size:13px;line-height:1.7}
        .ex{background:rgba(6,6,12,.9);border:1px solid rgba(245,158,11,.1);border-radius:10px;padding:16px;margin-top:8px}
        .ex h4{font-size:11px;margin-bottom:8px;text-transform:uppercase;letter-spacing:.6px;font-weight:700}
        pre{font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.6;color:#a5b4fc;white-space:pre-wrap}
        .foot{text-align:center;margin-top:36px;color:#333;font-size:11px}
        .nav{display:flex;justify-content:center;gap:4px;margin-bottom:24px;flex-wrap:wrap}
        .nav a{padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:all .2s;border:1px solid transparent}
        .nav a.active{background:rgba(245,158,11,.15);color:#f59e0b;border-color:rgba(245,158,11,.3)}
        .nav a:not(.active){color:#666;background:rgba(16,16,24,.5);border-color:rgba(255,255,255,.05)}
        .nav a:not(.active):hover{color:#f59e0b;border-color:rgba(245,158,11,.2);background:rgba(245,158,11,.05)}
        .status-bar{text-align:center;padding:12px 20px;background:rgba(16,16,24,.9);border:1px solid rgba(245,158,11,.1);border-radius:10px;font-size:13px;margin-bottom:24px}
        .step-num{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-weight:700;font-size:13px;margin-right:8px;flex-shrink:0}
        .step{display:flex;align-items:flex-start;padding:14px 16px;background:rgba(16,16,24,.85);border:1px solid rgba(255,255,255,.04);border-radius:10px;margin-bottom:6px}
        .step-text h4{font-size:14px;color:#e0e0e0;margin-bottom:2px}
        .step-text p{font-size:12px;color:#777}
        .badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;margin-left:8px}
        table{width:100%;border-collapse:collapse;font-size:13px}
        td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.04)}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="nav"><a href="/">⚡ REST API</a><a href="/cli">🖥️ CLI</a><a href="/ws">🔌 WebSocket</a><a href="/api-key" class="active">🔑 API Key</a></div>
        <div class="head">
            <div class="logo">🔑 API Key Guide</div>
            <p class="sub">Secure your Proxima API · Connect with any OpenAI-compatible app</p>
        </div>

        <div class="status-bar">Current Status: ${keyStatus}</div>

        <div class="sec">
            <div class="st" style="color:#f59e0b">🤔 What is an API Key?</div>
            <div class="highlight">
                <h3 style="color:#f59e0b">Simple Explanation</h3>
                <p>API Key is like a <strong style="color:#fbbf24">password for your Proxima server</strong>. When you generate one, only requests that include this password can use your AI providers (ChatGPT, Claude, Gemini, Perplexity).</p>
                <p style="margin-top:8px"><strong style="color:#22c55e">Without a key:</strong> Anyone on your network can use your AI — fine for personal use.<br>
                <strong style="color:#f59e0b">With a key:</strong> Only YOU (or apps you configure) can use it — required for sharing or security.</p>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#22c55e">📝 How to Generate a Key</div>
            <div class="step">
                <span class="step-num" style="background:rgba(34,197,94,.15);color:#22c55e">1</span>
                <div class="step-text"><h4>Open Proxima App</h4><p>Launch Proxima on your computer</p></div>
            </div>
            <div class="step">
                <span class="step-num" style="background:rgba(59,130,246,.15);color:#3b82f6">2</span>
                <div class="step-text"><h4>Go to Settings</h4><p>Click the ⚙️ Settings tab at the top right</p></div>
            </div>
            <div class="step">
                <span class="step-num" style="background:rgba(168,85,247,.15);color:#a78bfa">3</span>
                <div class="step-text"><h4>Enable REST API</h4><p>Turn ON the "Enable REST API" toggle</p></div>
            </div>
            <div class="step">
                <span class="step-num" style="background:rgba(245,158,11,.15);color:#f59e0b">4</span>
                <div class="step-text"><h4>Click "Generate Key"</h4><p>Your key will look like: <code style="color:#fbbf24;background:rgba(245,158,11,.1);padding:2px 8px;border-radius:4px">sk-a1b2c3d4e5f6-proxima</code></p></div>
            </div>
            <div class="step">
                <span class="step-num" style="background:rgba(236,72,153,.15);color:#ec4899">5</span>
                <div class="step-text"><h4>Copy & Save</h4><p>Click "Copy" and paste it wherever you need. You can always view it again in Settings.</p></div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#ec4899">⚙️ Universal Connection Settings</div>
            <div class="highlight" style="background:rgba(236,72,153,.04);border-color:rgba(236,72,153,.15)">
                <h3 style="color:#ec4899">Use these in ANY OpenAI-compatible app</h3>
                <pre style="margin-top:8px;font-size:14px;line-height:2">
Base URL:   <span style="color:#ec4899;font-weight:700">http://localhost:${REST_PORT}/v1</span>
API Key:    <span style="color:#fbbf24;font-weight:700">sk-XXXX-proxima</span> <span style="color:#666">(your generated key)</span>
Model:      <span style="color:#22c55e;font-weight:700">auto</span> <span style="color:#666">(or: claude, chatgpt, gemini, perplexity, gemini:3.5-flash, gemini:3.1-pro, gemini:3.1-flash-lite, gemini:auto)</span></pre>
                <p style="margin-top:10px"><strong style="color:#ddd">Works with:</strong> OpenClaw, Nanobot, Continue.dev, Cursor, LibreChat, Open WebUI, LobeChat, ChatBox, BetterChatGPT, and any OpenAI-compatible app.</p>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#a78bfa">🔗 Integration Guides</div>

            <div class="ex" style="border-color:rgba(34,197,94,.15)">
                <h4 style="color:#22c55e">🐈 Nanobot — Terminal AI Agent (Recommended)</h4>
                <pre>
<span style="color:#888">// What is it?</span>
<span style="color:#ccc">Nanobot is a terminal-based AI coding assistant like Claude Code.</span>
<span style="color:#ccc">It can read files, write code, run commands — all from your terminal.</span>
<span style="color:#ccc">With Proxima, it works completely FREE.</span>

<span style="color:#22c55e;font-weight:700">━━━ STEP 1: Install ━━━</span>
pip install nanobot-ai

<span style="color:#22c55e;font-weight:700">━━━ STEP 2: Create config file ━━━</span>
<span style="color:#888">// Save this as:  ~/.nanobot/config.json</span>
<span style="color:#888">// Windows path:  C:\\Users\\YourName\\.nanobot\\config.json</span>
{
  "providers": {
    "custom": {
      <span style="color:#fbbf24">"apiKey": "sk-XXXX-proxima"</span>,      <span style="color:#888">← your key here</span>
      <span style="color:#ec4899">"apiBase": "http://localhost:${REST_PORT}/v1"</span>
    }
  },
  "agents": {
    "defaults": {
      "provider": "custom",
      <span style="color:#22c55e">"model": "auto"</span>                   <span style="color:#888">← auto picks best available AI</span>
    }
  }
}

<span style="color:#22c55e;font-weight:700">━━━ STEP 3: Use! ━━━</span>
nanobot agent                          <span style="color:#888"># Interactive chat mode</span>
nanobot agent -m "Explain AI"          <span style="color:#888"># Quick question</span>
nanobot agent -m "Create a React app"  <span style="color:#888"># Create files</span>
nanobot agent -m "Fix the bug in app.js" <span style="color:#888"># Fix code</span></pre>
            </div>

            <div class="ex" style="margin-top:10px;border-color:rgba(168,85,247,.15)">
                <h4 style="color:#a78bfa">🦞 OpenClaw — AI Coding IDE</h4>
                <pre>
<span style="color:#888">// What is it?</span>
<span style="color:#ccc">OpenClaw is a VS Code-like AI coding tool.</span>
<span style="color:#ccc">Just enter these 3 values in its Settings:</span>

<span style="color:#a78bfa;font-weight:700">━━━ In OpenClaw Settings ━━━</span>

API Base URL:  <span style="color:#ec4899;font-weight:600">http://localhost:${REST_PORT}/v1</span>
API Key:       <span style="color:#fbbf24;font-weight:600">sk-XXXX-proxima</span>
Model:         <span style="color:#22c55e;font-weight:600">auto</span>

<span style="color:#888">// That's it! OpenClaw will now use Proxima as its AI backend.</span>
<span style="color:#888">// Proxima routes to Claude/ChatGPT/Gemini/Perplexity automatically.</span></pre>
            </div>

            <div class="ex" style="margin-top:10px;border-color:rgba(59,130,246,.15)">
                <h4 style="color:#3b82f6">🐍 Python — OpenAI SDK</h4>
                <pre>
<span style="color:#888"># pip install openai</span>
import openai

client = openai.OpenAI(
    <span style="color:#ec4899">base_url="http://localhost:${REST_PORT}/v1"</span>,
    <span style="color:#fbbf24">api_key="sk-XXXX-proxima"</span>           <span style="color:#888"># your key</span>
)

<span style="color:#888"># Simple chat</span>
response = client.chat.completions.create(
    <span style="color:#22c55e">model="auto"</span>,                        <span style="color:#888"># or: claude, chatgpt, gemini</span>
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

<span style="color:#888"># With streaming</span>
stream = client.chat.completions.create(
    model="claude", messages=[{"role": "user", "content": "Hello!"}],
    <span style="color:#22c55e">stream=True</span>
)
for chunk in stream:
    print(chunk.choices[0].delta.content, end="")</pre>
            </div>

            <div class="ex" style="margin-top:10px;border-color:rgba(6,182,212,.15)">
                <h4 style="color:#06b6d4">📦 JavaScript / Node.js</h4>
                <pre>
<span style="color:#888">// Using fetch (works in browser and Node.js)</span>
const response = await fetch("<span style="color:#ec4899">http://localhost:${REST_PORT}/v1/chat/completions</span>", {
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
console.log(data.choices[0].message.content);

<span style="color:#888">// Using OpenAI npm package</span>
<span style="color:#888">// npm install openai</span>
import OpenAI from "openai";
const client = new OpenAI({
    <span style="color:#ec4899">baseURL: "http://localhost:${REST_PORT}/v1"</span>,
    <span style="color:#fbbf24">apiKey: "sk-XXXX-proxima"</span>
});
const chat = await client.chat.completions.create({
    model: "auto", messages: [{ role: "user", content: "Hello!" }]
});
console.log(chat.choices[0].message.content);</pre>
            </div>

            <div class="ex" style="margin-top:10px;border-color:rgba(249,115,22,.15)">
                <h4 style="color:#f97316">🌊 cURL — Terminal Commands</h4>
                <pre>
<span style="color:#888"># Basic chat</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-XXXX-proxima"</span> \\
  -d '{"model": "auto", "message": "Hello!"}'

<span style="color:#888"># Chat with specific provider</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-XXXX-proxima"</span> \\
  -d '{"model": "claude", "message": "Write a Python function"}'

<span style="color:#888"># Streaming response (SSE)</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-XXXX-proxima"</span> \\
  -d '{"model": "chatgpt", "message": "Hello!", <span style="color:#22c55e">"stream": true</span>}'

<span style="color:#888"># OpenAI messages format</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  <span style="color:#fbbf24">-H "Authorization: Bearer sk-XXXX-proxima"</span> \\
  -d '{"model": "gemini", "messages": [{"role": "user", "content": "Hello!"}]}'

<span style="color:#888"># Without API key (if no key generated)</span>
curl http://localhost:${REST_PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "auto", "message": "Hello!"}'</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#06b6d4">🤖 Available Models</div>
            <table>
                <tr><td style="color:#22c55e;font-weight:600">auto</td><td>Auto-picks the best available AI. <strong style="color:#22c55e">Recommended for beginners.</strong></td></tr>
                <tr><td style="color:#a78bfa;font-weight:600">claude</td><td>Anthropic Claude — best for coding & analysis</td></tr>
                <tr><td style="color:#22c55e;font-weight:600">chatgpt</td><td>OpenAI ChatGPT — great all-rounder</td></tr>
                <tr><td style="color:#3b82f6;font-weight:600">gemini</td><td>Google Gemini — strong for reasoning (supports: <code>gemini:3.5-flash</code>, <code>gemini:3.1-pro</code>, <code>gemini:3.1-flash-lite</code>, <code>gemini:auto</code>)</td></tr>
                <tr><td style="color:#f97316;font-weight:600">perplexity</td><td>Perplexity — best for web search & research</td></tr>
            </table>
            <p style="color:#555;font-size:11px;margin-top:8px">Note: Only enabled providers in Proxima Settings will work. If a provider is disabled, use "auto" to pick from available ones.</p>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st" style="color:#ef4444">❓ Troubleshooting</div>
            <table>
                <tr><td style="color:#ef4444;font-weight:600;white-space:nowrap">401 Unauthorized</td><td>API key missing or wrong. Add <code style="color:#fbbf24;background:rgba(245,158,11,.1);padding:1px 6px;border-radius:3px">Authorization: Bearer sk-xxx-proxima</code> header</td></tr>
                <tr><td style="color:#f97316;font-weight:600;white-space:nowrap">404 Model not found</td><td>That AI provider is disabled in Proxima. Enable it in Settings, or use <code style="color:#22c55e">model: "auto"</code></td></tr>
                <tr><td style="color:#3b82f6;font-weight:600;white-space:nowrap">Connection refused</td><td>Proxima is not running, or REST API toggle is OFF. Open Proxima app → Settings → Enable REST API</td></tr>
                <tr><td style="color:#a78bfa;font-weight:600;white-space:nowrap">Slow response (5-15s)</td><td>Normal! Proxima uses browser sessions (not paid API). First request is slower, subsequent ones are faster.</td></tr>
                <tr><td style="color:#ec4899;font-weight:600;white-space:nowrap">Empty response</td><td>Provider might not be logged in. Open Proxima → click the provider tab → login with your account</td></tr>
            </table>
        </div>

        <div class="foot">Proxima API v${VERSION} — Zen4-bit ⚡<br>
        <span style="font-size:10px;color:#444">Free AI Gateway · OpenAI-compatible · No API keys to buy</span><br>
        <span style="font-size:10px;color:#333;margin-top:4px;display:inline-block">📖 <a href="/" style="color:#a78bfa;text-decoration:none">API Docs</a> · <a href="/cli" style="color:#06b6d4;text-decoration:none">CLI Docs</a> · <a href="/ws" style="color:#22c55e;text-decoration:none">WebSocket Docs</a></span>
        </div>
    </div>
</body>
</html>`;
}


module.exports = { getAPIKeyPage };


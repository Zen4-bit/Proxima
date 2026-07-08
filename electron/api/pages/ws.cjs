// Proxima — WebSocket Docs Page
//
// Renders the HTML page documenting the /ws real-time API (actions, message
// format, client examples) and embeds the shared in-page chat widget.
const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT) || 3210;
const VERSION = '5.0.0';
const { getChatHTML, getChatJS } = require('./widget.cjs');

function getWSDocsPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxima WebSocket</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Inter',sans-serif;background:#08080d;color:#d4d4e0;min-height:100vh;line-height:1.6}
        .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(34,197,94,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(34,197,94,.02) 1px,transparent 1px);background-size:60px 60px}
        .wrap{max-width:920px;margin:0 auto;padding:36px 20px;position:relative;z-index:1}
        .head{text-align:center;margin-bottom:32px}
        .logo{font-size:42px;font-weight:700;background:linear-gradient(135deg,#22c55e,#06b6d4);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .sub{color:#666;font-size:14px;margin-top:2px}
        .line{height:1px;background:linear-gradient(90deg,transparent,rgba(34,197,94,.3),transparent);margin:24px 0}
        .sec{margin-bottom:24px}
        .st{font-size:16px;font-weight:600;color:#22c55e;margin-bottom:10px}
        .highlight{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);border-radius:8px;padding:16px;margin:12px 0}
        .highlight h3{color:#22c55e;font-size:14px;margin-bottom:6px}
        .highlight p{color:#888;font-size:12px}
        .ex{background:rgba(6,6,12,.9);border:1px solid rgba(34,197,94,.12);border-radius:8px;padding:14px;margin-top:5px}
        .ex h4{color:#22c55e;font-size:10px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}
        pre{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5;color:#a5b4fc;white-space:pre-wrap}
        .foot{text-align:center;margin-top:36px;color:#333;font-size:11px}
        .cmd-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
        .cmd{padding:10px 14px;background:rgba(16,16,24,.85);border:1px solid rgba(34,197,94,.08);border-radius:8px;transition:border-color .2s}
        .cmd:hover{border-color:rgba(34,197,94,.25)}
        .cmd-name{font-family:'JetBrains Mono',monospace;font-size:12px;color:#22c55e;font-weight:600}
        .cmd-desc{font-size:11px;color:#666;margin-top:2px}
        .tag{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;margin-left:4px}
        .tag-live{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.15)}
        .nav{display:flex;justify-content:center;gap:4px;margin-bottom:24px}
        .nav a{padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:all .2s;border:1px solid transparent}
        .nav a.active{background:rgba(34,197,94,.15);color:#22c55e;border-color:rgba(34,197,94,.3)}
        .nav a:not(.active){color:#666;background:rgba(16,16,24,.5);border-color:rgba(255,255,255,.05)}
        .nav a:not(.active):hover{color:#22c55e;border-color:rgba(34,197,94,.2);background:rgba(34,197,94,.05)}
        @media(max-width:640px){.cmd-grid{grid-template-columns:1fr}}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="nav"><a href="/">⚡ REST API</a><a href="/cli">🖥️ CLI</a><a href="/ws" class="active">🔌 WebSocket</a><a href="/api-key">🔑 API Key</a></div>
        <div class="head">
            <div class="logo">🔌 Proxima WebSocket</div>
            <p class="sub">Real-time AI communication · ws://localhost:${REST_PORT}/ws</p>
        </div>

        ${getChatHTML('#22c55e')}
        <div class="line"></div>

        <div class="highlight">
            <h3>⚡ Connect</h3>
            <p>Persistent connection — send multiple messages without reconnecting.</p>
            <pre style="margin-top:10px">
// JavaScript
const ws = new WebSocket("ws://localhost:${REST_PORT}/ws");

ws.onopen = () => console.log("Connected!");
ws.onmessage = (e) => console.log(JSON.parse(e.data));

// Send a message
ws.send(JSON.stringify({
    action: "ask",
    model: "claude",
    message: "What is AI?"
}));</pre>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📋 Available Actions</div>
            <div class="cmd-grid">
                <div class="cmd"><div class="cmd-name">ask <span class="tag tag-live">LIVE</span></div><div class="cmd-desc">Chat with any AI provider</div></div>
                <div class="cmd"><div class="cmd-name">search</div><div class="cmd-desc">Web search via Perplexity</div></div>
                <div class="cmd"><div class="cmd-name">code</div><div class="cmd-desc">Generate / review / explain code</div></div>
                <div class="cmd"><div class="cmd-name">translate</div><div class="cmd-desc">Translate text</div></div>
                <div class="cmd"><div class="cmd-name">brainstorm</div><div class="cmd-desc">Creative ideas</div></div>
                <div class="cmd"><div class="cmd-name">debate</div><div class="cmd-desc">Multi-provider debate</div></div>
                <div class="cmd"><div class="cmd-name">audit</div><div class="cmd-desc">Security vulnerability scan</div></div>
                <div class="cmd"><div class="cmd-name">ping</div><div class="cmd-desc">Connection health check</div></div>
                <div class="cmd"><div class="cmd-name">stats</div><div class="cmd-desc">Server statistics</div></div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📨 Message Format</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>→ Send (Client to Server)</h4>
                    <pre>{
  "action": "ask",
  "model": "claude", // or chatgpt, perplexity, gemini (gemini:3.5-flash, gemini:3.1-pro, gemini:3.1-flash-lite, gemini:auto)
  "message": "What is AI?",
  "filePath": "D:\\\\path\\\\to\\\\file.png", // optional local path for Gemini visual routing
  "id": "optional-request-id"
}</pre>
                </div>
                <div class="ex">
                    <h4>← Receive (Server to Client)</h4>
                    <pre>// Status update
{"type":"status","id":"req_1","status":"processing"}

// Response
{"type":"response","id":"req_1",
 "content":"AI is...",
 "model":"claude",
 "responseTimeMs":5420}

// Error
{"type":"error","id":"req_1",
 "error":"Provider unavailable"}</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📝 All Actions — Examples</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>💬 Ask / Chat</h4>
                    <pre>// Ask specific provider
{"action":"ask","model":"claude",
 "message":"Write a haiku"}
 
// Auto-pick best
{"action":"ask",
 "message":"Hello world"}

// Image / Multimodal routing
{"action":"ask","model":"gemini",
  "message":"Describe this image",
  "filePath":"D:\\\\path\\\\to\\\\image.png"}</pre>
                </div>
                <div class="ex">
                    <h4>🔍 Search</h4>
                    <pre>{"action":"search",
 "query":"Latest AI news 2026"}</pre>
                </div>
                <div class="ex">
                    <h4>💻 Code</h4>
                    <pre>// Generate
{"action":"code",
 "description":"Sort algorithm",
 "language":"Python"}

// Review
{"action":"code","subaction":"review",
 "description":"def fib(n):..."}</pre>
                </div>
                <div class="ex">
                    <h4>🌐 Translate</h4>
                    <pre>{"action":"translate",
 "text":"Hello world",
 "to":"Hindi"}</pre>
                </div>
                <div class="ex">
                    <h4>🧠 Brainstorm</h4>
                    <pre>{"action":"brainstorm",
 "topic":"AI startup ideas"}</pre>
                </div>
                <div class="ex">
                    <h4>⚔️ Debate</h4>
                    <pre>{"action":"debate",
 "topic":"Is AI dangerous?"}</pre>
                </div>
                <div class="ex">
                    <h4>🛡️ Security Audit</h4>
                    <pre>{"action":"audit",
 "code":"app.get('/user',
  (req,res)=>db.query(
  'SELECT * WHERE id='+req.id))"}</pre>
                </div>
                <div class="ex">
                    <h4>❤️ Ping / Stats</h4>
                    <pre>{"action":"ping"}
// → {"type":"pong"}

{"action":"stats"}
// → {"type":"stats","data":{...}}</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🔧 Client Examples</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>JavaScript (Browser / Node.js)</h4>
                    <pre>const ws = new WebSocket("ws://localhost:${REST_PORT}/ws");

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'response') {
    console.log(msg.content);
  }
};

ws.onopen = () => {
  ws.send(JSON.stringify({
    action: "ask",
    model: "claude",
    message: "Explain AI"
  }));
};</pre>
                </div>
                <div class="ex">
                    <h4>Python</h4>
                    <pre>import websocket, json

ws = websocket.create_connection(
  "ws://localhost:${REST_PORT}/ws"
)

# Send
ws.send(json.dumps({
  "action": "ask",
  "model": "claude",
  "message": "What is AI?"
}))

# Receive
result = json.loads(ws.recv())  # status
result = json.loads(ws.recv())  # response
print(result["content"])</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📡 Event Types</div>
            <div class="cmd-grid">
                <div class="cmd"><div class="cmd-name">connected</div><div class="cmd-desc">Initial connection — returns clientId</div></div>
                <div class="cmd"><div class="cmd-name">status</div><div class="cmd-desc">Processing status update (processing, searching, etc.)</div></div>
                <div class="cmd"><div class="cmd-name">response</div><div class="cmd-desc">AI response with content and timing</div></div>
                <div class="cmd"><div class="cmd-name">error</div><div class="cmd-desc">Error with message</div></div>
                <div class="cmd"><div class="cmd-name">pong</div><div class="cmd-desc">Reply to ping</div></div>
                <div class="cmd"><div class="cmd-name">stats</div><div class="cmd-desc">Server statistics data</div></div>
            </div>
        </div>

        <div class="foot">Proxima WebSocket v${VERSION} — Zen4-bit ⚡</div>
    </div>
    ${getChatJS()}
</body>
</html>`;
}

module.exports = { getWSDocsPage };


// Proxima — CLI Docs Page
//
// Renders the HTML page documenting the `proxima` terminal client (commands,
// piping, file context, flags) and embeds the shared in-page chat widget.
const REST_PORT = parseInt(process.env.PROXIMA_REST_PORT) || 3210;
const VERSION = '5.0.0';
const { getChatHTML, getChatJS } = require('./widget.cjs');

function getCLIDocsPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxima CLI</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:'Inter',sans-serif;background:#08080d;color:#d4d4e0;min-height:100vh;line-height:1.6}
        .grid-bg{position:fixed;inset:0;background-image:linear-gradient(rgba(6,182,212,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(6,182,212,.02) 1px,transparent 1px);background-size:60px 60px}
        .wrap{max-width:920px;margin:0 auto;padding:36px 20px;position:relative;z-index:1}
        .head{text-align:center;margin-bottom:32px}
        .logo{font-size:42px;font-weight:700;background:linear-gradient(135deg,#06b6d4,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .sub{color:#666;font-size:14px;margin-top:2px}
        .back{display:inline-block;margin-top:12px;color:#a78bfa;text-decoration:none;font-size:12px;padding:4px 12px;border:1px solid rgba(139,92,246,.2);border-radius:16px;transition:all .2s}
        .back:hover{border-color:rgba(139,92,246,.5);background:rgba(139,92,246,.05)}
        .line{height:1px;background:linear-gradient(90deg,transparent,rgba(6,182,212,.3),transparent);margin:24px 0}
        .sec{margin-bottom:24px}
        .st{font-size:16px;font-weight:600;color:#06b6d4;margin-bottom:10px}
        .card{background:rgba(16,16,24,.85);border:1px solid rgba(6,182,212,.1);border-radius:8px;padding:14px 16px;margin-bottom:5px;transition:border-color .2s}
        .card:hover{border-color:rgba(6,182,212,.3)}
        .highlight{background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.15);border-radius:8px;padding:16px;margin:12px 0}
        .highlight h3{color:#06b6d4;font-size:14px;margin-bottom:6px}
        .highlight p{color:#888;font-size:12px}
        .ex{background:rgba(6,6,12,.9);border:1px solid rgba(6,182,212,.12);border-radius:8px;padding:14px;margin-top:5px}
        .ex h4{color:#06b6d4;font-size:10px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px}
        pre{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.5;color:#a5b4fc;white-space:pre-wrap}
        .foot{text-align:center;margin-top:36px;color:#333;font-size:11px}
        .cmd-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
        .cmd{padding:10px 14px;background:rgba(16,16,24,.85);border:1px solid rgba(6,182,212,.08);border-radius:8px;transition:border-color .2s}
        .cmd:hover{border-color:rgba(6,182,212,.25)}
        .cmd-name{font-family:'JetBrains Mono',monospace;font-size:12px;color:#06b6d4;font-weight:600}
        .cmd-desc{font-size:11px;color:#666;margin-top:2px}
        .tag{display:inline-block;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:600;margin-left:4px}
        .tag-new{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.15)}
        .tag-ctx{background:rgba(249,115,22,.08);color:#f97316;border:1px solid rgba(249,115,22,.12)}
        .nav{display:flex;justify-content:center;gap:4px;margin-bottom:24px}
        .nav a{padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;transition:all .2s;border:1px solid transparent}
        .nav a.active{background:rgba(6,182,212,.15);color:#06b6d4;border-color:rgba(6,182,212,.3)}
        .nav a:not(.active){color:#666;background:rgba(16,16,24,.5);border-color:rgba(255,255,255,.05)}
        .nav a:not(.active):hover{color:#06b6d4;border-color:rgba(6,182,212,.2);background:rgba(6,182,212,.05)}
        @media(max-width:640px){.cmd-grid{grid-template-columns:1fr}}
    </style>
</head>
<body>
    <div class="grid-bg"></div>
    <div class="wrap">
        <div class="nav"><a href="/">⚡ REST API</a><a href="/cli" class="active">🖥️ CLI</a><a href="/ws">🔌 WebSocket</a><a href="/api-key">🔑 API Key</a></div>
        <div class="head">
            <div class="logo">🖥️ Proxima CLI</div>
            <p class="sub">Talk to AI from your terminal · v${VERSION}</p>
        </div>

        ${getChatHTML('#06b6d4')}
        <div class="line"></div>

        <div class="highlight">
            <h3>⚡ Quick Start</h3>
            <p>Install and start using AI from your terminal in seconds.</p>
            <pre style="margin-top:10px">
# Option 1: Run directly
node cli/proxima-cli.cjs ask claude "What is AI?"

# Option 2: npm script
npm run cli -- ask claude "Hello"

# Option 3: Register globally (use from any folder on this PC)
npm link
proxima ask claude "Hello"</pre>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">📋 All Commands</div>
            <div class="cmd-grid">
                <div class="cmd"><div class="cmd-name">ask <span style="color:#666">[model]</span> "msg"</div><div class="cmd-desc">Chat with any AI provider</div></div>
                <div class="cmd"><div class="cmd-name">compare "question"</div><div class="cmd-desc">Ask all providers, compare side-by-side</div></div>
                <div class="cmd"><div class="cmd-name">search "query"</div><div class="cmd-desc">Web search via Perplexity</div></div>
                <div class="cmd"><div class="cmd-name">brainstorm "topic"</div><div class="cmd-desc">Generate creative ideas</div></div>
                <div class="cmd"><div class="cmd-name">translate "text" --to Lang</div><div class="cmd-desc">Translate to any language</div></div>
                <div class="cmd"><div class="cmd-name">code "description"</div><div class="cmd-desc">Generate / review / explain code</div></div>
                <div class="cmd"><div class="cmd-name">debate "topic"</div><div class="cmd-desc">Multi-AI debate on any topic</div></div>
                <div class="cmd"><div class="cmd-name">audit "code"</div><div class="cmd-desc">Security vulnerability scan</div></div>
                <div class="cmd"><div class="cmd-name">analyze "url"</div><div class="cmd-desc">Analyze URL or content</div></div>
                <div class="cmd"><div class="cmd-name">fix "error" <span class="tag tag-new">NEW</span></div><div class="cmd-desc">Fix errors with AI help</div></div>
                <div class="cmd"><div class="cmd-name">models</div><div class="cmd-desc">List all providers (ON/OFF)</div></div>
                <div class="cmd"><div class="cmd-name">status</div><div class="cmd-desc">Server health check</div></div>
                <div class="cmd"><div class="cmd-name">stats</div><div class="cmd-desc">Provider response times</div></div>
                <div class="cmd"><div class="cmd-name">new</div><div class="cmd-desc">Reset all conversations</div></div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🤖 Provider Control</div>
            <div class="ex">
                <h4>Choose Your AI</h4>
                <pre>
# Specific provider
proxima ask claude "Explain quantum computing"
proxima ask chatgpt "Write a poem about AI"
proxima ask gemini "Summarize this topic"
proxima ask perplexity "Latest news on AI"

# Auto-pick best available
proxima ask "Hello"
proxima ask auto "Hello"

# All providers at once
proxima ask all "What is consciousness?"
proxima compare "Is water wet?"</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">🔧 Context-Aware Features <span class="tag tag-ctx">SMART</span></div>
            <p style="color:#888;font-size:12px;margin-bottom:10px">Pipe command output, errors, or file content directly to AI for instant help.</p>

            <div class="cmd-grid">
                <div class="ex">
                    <h4>📥 Pipe Error Output</h4>
                    <pre># Build error → AI fixes it
npm run build 2>&1 | proxima fix

# Python error → AI fix
python app.py 2>&1 | proxima fix

# Any command output
docker logs app | proxima ask "any errors?"</pre>
                </div>
                <div class="ex">
                    <h4>📄 File as Context</h4>
                    <pre># Explain a file
proxima ask "explain this" --file src/app.js

# Review a file
proxima ask "review for bugs" --file server.py

# Fix error with source file
proxima fix "TypeError" --file src/utils.js

# Multimodal / Binary files (automatic visual routing)
proxima ask gemini "describe this trend screenshot" --file explore.png</pre>
                </div>
                <div class="ex">
                    <h4>🔀 Pipe + Question</h4>
                    <pre># Log analysis
cat error.log | proxima ask "what went wrong?"

# Git changes → code review
git diff | proxima code review

# Config check
cat nginx.conf | proxima ask "any issues?"</pre>
                </div>
                <div class="ex">
                    <h4>⚡ Auto-Fix Mode</h4>
                    <pre># Just pipe anything — auto detects
npm test 2>&1 | proxima fix
cargo build 2>&1 | proxima fix
go build . 2>&1 | proxima fix

# Even without a command name:
some-command 2>&1 | proxima</pre>
                </div>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">💻 Code Tools</div>
            <div class="ex">
                <h4>Generate, Review, Explain, Debug</h4>
                <pre>
# Generate code
proxima code "REST API with auth" --lang Python
proxima code "sort algorithm" --lang JavaScript

# Review code
proxima code review "def fib(n): return fib(n-1)+fib(n-2)"
cat app.js | proxima code review

# Explain code
proxima code explain "async/await patterns"
cat complex.py | proxima code explain

# Debug
proxima code debug "function fails on empty array"</pre>
            </div>
        </div>

        <div class="line"></div>

        <div class="sec">
            <div class="st">⚙️ Options & Environment</div>
            <div class="cmd-grid">
                <div class="ex">
                    <h4>Flags</h4>
                    <pre>--model, -m    Specify AI model (supports: gemini:3.5-flash, gemini:3.1-pro, gemini:3.1-flash-lite, gemini:auto)
--to           Target language (translate)
--from         Source language (translate)
--lang, -l     Programming language (code)
--file         Send file as context (text files appended; binary/multimodal files uploaded natively)
--q            Question for analyze
--json         Raw JSON output</pre>
                </div>
                <div class="ex">
                    <h4>Environment Variables</h4>
                    <pre># Custom port
set PROXIMA_PORT=4000
proxima ask claude "Hello"

# Custom host
set PROXIMA_HOST=192.168.1.100
proxima status

# Default: 127.0.0.1:${REST_PORT}</pre>
                </div>
            </div>
        </div>

        <div class="foot">Proxima CLI v${VERSION} — Zen4-bit ⚡</div>
    </div>
    ${getChatJS()}
</body>
</html>`;
}


module.exports = { getCLIDocsPage };


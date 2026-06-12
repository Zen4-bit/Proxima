# Proxima — Setup, Architecture, Fix Log

## What it is
Electron app that automates ChatGPT/Claude/Gemini/Perplexity web UIs via embedded BrowserViews. Exposes them through an MCP stdio server so Claude (or any MCP client) can ask any provider questions, generate images via DALL-E, etc.

## Install paths
- **Source**: `C:\Tools\Proxima\` (main-v2.cjs, mcp-server-v3.js, etc.)
- **Packed app**: `C:\Tools\Proxima\dist\win-unpacked\Proxima.exe`
- **Packed ASAR**: `C:\Tools\Proxima\dist\win-unpacked\resources\app.asar`
- **Extracted ASAR (editable)**: `C:\Tools\Proxima\dist\win-unpacked\resources\app-extracted\`
- **ASAR backup**: `C:\Tools\Proxima\dist\win-unpacked\resources\app.asar.bak`
- **Debug log**: `C:\Users\Jakob\proxima-debug.log` (via `dlog()` in main-v2.cjs)
- **Image save dir**: `C:\Users\Jakob\Pictures\Proxima\` (auto-created)
- **MCP config**: `C:\Users\Jakob\.claude\.mcp.json` → spawns `node C:\Tools\Proxima\src\mcp-server-v3.js`
- **Enabled providers**: `C:\Tools\Proxima\src\enabled-providers.json` → currently `perplexity, chatgpt, gemini`

## Key files
| File | Purpose |
|------|---------|
| `electron/main-v2.cjs` | Main Electron process. Browser automation, DOM extraction, IPC server on port 19222. |
| `src/mcp-server-v3.js` | MCP stdio server. Bridges Claude ↔ Electron IPC. ESM. |
| `electron/browser-manager.cjs` | BrowserView management per provider. |
| `electron/rest-api.cjs` | Optional REST endpoint. |

## Architecture (v4.1.0 — API-first)
1. Claude calls MCP tool (e.g. `generate_image`)
2. `mcp-server-v3.js` opens TCP socket to localhost:19222, sends JSON request
3. `main-v2.cjs` (IPC server) routes request → calls `sendMessage` → `getResponseWithTypingStatus`
4. **API path (primary)**: `sendMessage` calls `providerAPI.sendViaAPI()` → injects `chatgpt-engine.js` into BrowserView → sends via `/backend-api/conversation` SSE → captures full response text → caches in `_apiResponseCache`
5. **`getResponseWithTypingStatus`**: checks `_apiResponseCache` first, returns immediately (no DOM scraping needed). Calls `postProcessImages()` on API response before returning.
6. **DOM fallback** (if API fails): polls assistant DOM elements for up to 100s, also calls `postProcessImages()` on result
7. `postProcessImages()`: parses `![alt](url)` → downloads via `electronNet.request` with session cookies → saves to `~/Pictures/Proxima/img_TIMESTAMP.ext` → returns Markdown with local file path

## New in v4.1.0
- `electron/providers/chatgpt-engine.js` — runs inside ChatGPT BrowserView, uses direct API calls (SSE), implements SHA3-512 POW solver for `sentinel/chat-requirements`
- `electron/providers/claude-engine.js`, `gemini-engine.js`, `perplexity-engine.js` — same pattern
- `electron/provider-api.cjs` — injects engines, exposes `sendViaAPI()`
- `electron/ws-server.cjs` — optional WebSocket server
- `cli/proxima-cli.cjs` — standalone CLI

## Critical workflow: editing main-v2.cjs
**Source edits don't affect running app until repacked!** App runs from ASAR.

```powershell
# 1. Edit C:\Tools\Proxima\electron\main-v2.cjs
# 2. Copy to extracted ASAR dir
Copy-Item "C:\Tools\Proxima\electron\main-v2.cjs" `
          "C:\Tools\Proxima\dist\win-unpacked\resources\app-extracted\electron\main-v2.cjs" -Force
# 3. Repack ASAR
cd "C:\Tools\Proxima\dist\win-unpacked\resources"
npx @electron/asar pack app-extracted app.asar
# 4. Restart Proxima
Get-Process proxima -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 1.5
Start-Process "C:\Tools\Proxima\dist\win-unpacked\Proxima.exe"
```

## Fix log (2026-05-25)

### `generate_image` returned "No response captured"
**Root cause**: ChatGPT's new reasoning UI ("Thought for Xs") renders DALL-E image responses WITHOUT `[data-message-author-role="assistant"]` wrapper. Standard DOM query returned 0 messages.

**Fix** in `main-v2.cjs` ChatGPT DOM extraction block (~line 1708):
- Added `dalleImgs` filter for known CDN domains (`oaidalleapiprodscus`, `openai`, `blob:`, `files.oaiusercontent`)
- Added `bigImgs` broader fallback: any HTTP img with `naturalWidth > 200`, excluding `avatar`/`logo`
- ChatGPT signed URLs use `chatgpt.com/backend-api/estuary/content?id=...&sig=...` — caught by `bigImgs`

### Image URL not directly accessible
**Problem**: Signed ChatGPT URLs require session cookies. External MCP clients can't access them.

**Fix**: Added `postProcessImages()` in main-v2.cjs that:
- Parses `![alt](url)` from response text
- Downloads each URL via `electron.net.request` with `useSessionCookies: true` (auto-attaches ChatGPT cookies)
- Saves to `~/Pictures/Proxima/img_TIMESTAMP.ext` (extension from Content-Type)
- Returns text with `![alt](file:///C:/Users/Jakob/Pictures/Proxima/img_...png)` + original URL kept as reference

### Other earlier fixes (still active)
- `analyze_image_url` used `require()` in ESM → fixed via top-level imports of `https`, `http`, `os` in mcp-server-v3.js
- IPC socket close didn't reject pending requests → added rejection loop
- `getEnabledProviders()` read disk every call → 30s TTL cache
- 800ms sleep between `sendMessage` and `getResponseWithTyping` (race fix)
- IPC timeout 120s → 300s (image gen)
- Response desync (off-by-one): `__proxima_captured_response` retained previous response → clear buffer in `sendMessage` BEFORE sending
- ChatGPT fingerprint captured AFTER sendMessage → captured "Denke nach…" thinking bubble. Fixed: capture BEFORE send in sendMessage handler
- Added thinking-indicator blocklist (`THINKING_PATTERNS`)
- ChatGPT `MAX_POLLS` 40 → 200 (100s timeout)
- `img` tag support in `domToMarkdown()`

## Verified working
- `ask_chatgpt("text")` → returns text correctly
- `generate_image({prompt})` → returns Markdown with local file path + original URL
- Image saved to `C:\Users\Jakob\Pictures\Proxima\`

## Known remaining quirks
- **v4.1 API path**: ChatGPT engine POW solver may fail if ChatGPT changes challenge format → falls back to DOM
- Image gen response from SSE stream may not include inline image URL for all ChatGPT versions — if so, falls back to DOM `bigImgs` scraping
- `chatgpt-engine.js` doesn't handle WebSocket redirect (returns error "WebSocket mode not supported") — rare

## Critical: `ws` module for dev build
v4.1 `ws-server.cjs` requires `ws` npm package. `app.asar.unpacked\node_modules` ships without it from the original ASAR. After manual repack, must copy manually:
```powershell
Copy-Item "C:\Tools\Proxima\node_modules\ws" `
  "C:\Tools\Proxima\dist\win-unpacked\resources\app-extracted\node_modules\ws" -Recurse -Force
```
Then repack ASAR. Without this, Proxima starts but never binds port 19222 (silent crash: `rest-api.cjs` → `ws-server.cjs` → `require('ws')` → fail).

## Merge notes (2026-05-25 — v3.0.0 → v4.1.0)
- Pulled upstream, stashed our changes, applied conflicts manually
- **Kept from our work**: `electronNet` import, `downloadImageWithSession()`, `postProcessImages()`, `dlog()`, `IMAGE_SAVE_DIR`, `chatgptOldImageUrls` fingerprint, `bigImgs` fallback, Perplexity stability fix (was in upstream)
- **Dropped from our work** (superseded by v4.1): network interceptor poll loop in `getProviderResponse` (now handled by API-first path), global fingerprint vars (now use `responseState`)
- All mcp-server-v3.js fixes already in upstream v4.1

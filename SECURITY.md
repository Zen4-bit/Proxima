# Security Policy

Thanks for helping keep Proxima and its users safe.

## Supported versions

Security fixes are provided for the latest released major version.

| Version | Supported |
|---------|-----------|
| 5.0.x   | ✅ |
| 4.1.x   | ⚠️ Critical fixes only |
| < 4.1   | ❌ |

## Threat model (read this first)

Proxima is a **local-first desktop app**. It runs on `127.0.0.1`, talks to AI
providers through your own logged-in browser sessions or your own API keys
(BYOK), and — in the agent — can execute code and control the machine it runs
on. Because of that, a few things are **by design and not vulnerabilities**:

- The MCP/IPC TCP channel (`19222`) is gated by a dynamic, cryptographically generated token stored in `ipc-token.json`. The REST/WebSocket (`3210`) and FastAPI (`8500`) servers bind strictly to localhost, enforce loopback-only CORS origin verification, and can be configured with static API keys. All local interfaces exist within the same trust boundary as your terminal.
- The Proxima Agent executes code and shell commands on the host by design
  (guarded by the safety gate and permission modes).
- Using a provider through your session is equivalent to using it in your
  browser; Proxima does not bypass any provider authentication.

We **are** very interested in reports such as:

- SSRF / request-forgery bypasses in `web_scrape` or the Python web fetcher
  (e.g. reaching private/loopback/metadata addresses).
- Prompt-injection that defeats the content scanner and reaches system prompts.
- BYOK **API-key disclosure** (keys leaking to logs, disk in plaintext where it
  shouldn't, network, or across providers).
- Safety-gate / permission bypass that lets unattended agent code run a
  dangerous operation without approval.
- Command/JS injection via crafted messages, filenames, cookies, or tool args.
- A localhost service unexpectedly reachable off-host, or CORS/origin gaps.
- Path traversal in file/conversation/skill storage.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Use **GitHub's private vulnerability reporting**:

1. Go to the repository's **Security** tab →
   **Report a vulnerability** (GitHub Security Advisories):
   `https://github.com/Zen4-bit/Proxima/security/advisories/new`
2. Include:
   - Affected version (`5.0.0`, etc.) and OS.
   - Component (Electron runtime host / BYOK / MCP / Python agent / SDK / CLI).
   - A clear description and **minimal steps to reproduce** (or a PoC).
   - Impact and any suggested fix.

If you cannot use GitHub Security Advisories, contact the maintainer privately
via their GitHub profile: [@Zen4-bit](https://github.com/Zen4-bit).

## Response timeline

We aim to:

| Stage | Target |
|-------|--------|
| Acknowledge your report | within **72 hours** |
| Initial assessment / triage | within **7 days** |
| Fix or mitigation for confirmed issues | typically **30–90 days**, severity-dependent |
| Public disclosure | coordinated, **after** a fix ships |

We will keep you updated through the advisory and credit you in the release
notes (unless you prefer to stay anonymous).

## Disclosure policy

Please give us reasonable time to release a fix before any public disclosure.
We follow coordinated disclosure and will publish a GitHub Security Advisory
once a patched release is available.

## Good-faith safe harbor

We will not pursue or support action against researchers who:

- act in good faith and avoid privacy violations, data destruction, and service
  disruption, and
- only test against **their own** local installation (never other users' machines
  or third-party provider accounts), and
- report promptly and give us time to remediate.

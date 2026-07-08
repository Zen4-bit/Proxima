# Building & Deploying Proxima (Windows / macOS / Linux)

This document covers how Proxima is packaged for each OS, how the bundled
Python agent is provisioned on end-user machines, and the security defaults
that apply to production builds.

## 1. Build commands

```bash
npm install            # install Node deps (run on each target OS for native modules)

npm run build:win      # Windows  → NSIS installer (.exe) [x64]
npm run build:mac      # macOS    → DMG [x64 + arm64]
npm run build:linux    # Linux    → AppImage + .deb [x64]
npm run build:all      # all three (only on a host that can target them)
```

> **Important:** electron-builder cannot cross-compile everything from one OS.
> Build Windows on Windows, macOS on macOS (required for signing/notarization),
> and Linux on Linux (or in CI with a matrix of runners).

## 2. What gets bundled

`package.json > build.extraResources` ships:

- `src/tools/py`, `src/prompts`, `data` — runtime assets.
- `proxima-agent/` — the full Python agent **source**, with the dev `.venv`,
  `__pycache__`, `*.egg-info`, and tests **excluded** via filter.

The dev virtualenv is intentionally **never** bundled — a venv hardcodes
absolute interpreter paths and is not relocatable across machines or OSes.

## 3. First-run Python provisioning

The Python agent (CLI, Web UI, computer-use tools) needs a real Python
environment on the user's machine. On first launch, `electron/python-env.cjs`:

1. Locates the bundled `proxima-agent` source.
2. Picks a **base interpreter** — preferring a **bundled standalone Python**
   (`resources/python`, if shipped — see §3a) so **no system Python is needed**;
   otherwise a system Python ≥ 3.10 (`py -3` / `python3` / version-specific).
3. Creates a **managed venv** under the per-user data dir
   (`userData/py-env`) — a writable location, never Program Files.
4. Installs the agent into that venv — **offline-first**: if a bundled
   wheelhouse (`resources/wheels`) is present, it installs with
   `pip --no-index --find-links` (no internet); otherwise it installs from PyPI
   with retries. If the offline set is incomplete it transparently falls back
   to online so the user is never stuck.
5. Caches the resulting interpreter for fast subsequent launches.

This runs in the background and reports progress to the UI via the
`python-env-progress` / `env-status` IPC channels. If no Python is available
(no bundle and no system Python), the app shows a non-blocking banner with
install guidance and a **Retry setup** button (no silent failures).

The REST API / agent Web UI launcher (`electron/api/rest-api.cjs`) resolves the
interpreter through this manager, preferring the managed venv, then a dev
`.venv` (local development only), then the bundled/system Python.

## 3a. Optional offline bundle (advanced)

`python-env.cjs` provisions the agent with pip: if a prebuilt wheelhouse is
bundled at `resources/wheels`, it installs strictly offline (`pip --no-index`);
otherwise it installs the agent and its dependencies from PyPI on first run
(needs internet once, then reuses the cached venv).

`package.json > build.extraResources` copies `build/offline/python` and
`build/offline/wheels` into the app as `resources/python` and `resources/wheels`
when present. These folders are git-ignored (large + platform-specific) and only
placeholders are committed, so a build with no offline bundle still succeeds and
falls back to system Python + PyPI. Populating them (with a relocatable CPython
and a `pip wheel` wheelhouse for the target OS/arch) is left to the maintainer;
Proxima no longer ships a script that auto-downloads a Python interpreter.

## 3b. Run from source (macOS / Linux / Windows)

Install the prerequisites yourself, then run:

```bash
# Prerequisites: Node.js >= 18 and Python >= 3.10 on PATH
npm install       # installs Node deps (also runs automatically on `npm start`)
npm start         # launches Proxima; the agent venv is provisioned on first run
```

On first launch, `python-env.cjs` creates a managed venv from your system
Python and installs the agent (offline from the bundled wheelhouse if present,
otherwise from PyPI).

## 4. Native dependency detection

`electron/env-check.cjs` validates optional native tools at startup and surfaces
the result in the UI banner:

| Dependency        | Required | Feature                         | Notes |
|-------------------|----------|---------------------------------|-------|
| Python 3.10+      | Yes      | AI agent / Web UI / computer use | Provisioned automatically if present |
| Google Chrome     | Yes*     | Browser automation (CDP)         | *for browser-control features |
| Tesseract OCR     | No       | Screen text reading              | macOS has a native OCR fallback |
| xdotool + wmctrl  | No (Linux)| Desktop window control          | `apt install xdotool wmctrl` |

## 5. Security defaults (production)

- **Local API auth is enforced when a key is configured.** Once the user
  generates an API key, requests without a valid `Authorization: Bearer` token
  are rejected (`401`). With no key configured, only loopback access is allowed
  and the UI flags the "open" state.
- **CORS is locked to loopback origins.** The gateway can execute code and
  automate the desktop, so cross-origin browser requests from non-localhost
  sites are rejected (`403`). No wildcard `Access-Control-Allow-Origin`.
- **The server binds to `127.0.0.1` only.**
- **The agent defaults to SMART permission mode**, not full autonomy. Critical
  or destructive actions require explicit user approval. Users can opt into
  `FULL_AUTO` via the startup menu or `--perm auto`.

## 6. macOS signing & notarization (required for distribution)

The DMG build sets `hardenedRuntime: true` and uses
`build/entitlements.mac.plist`. To distribute outside a developer machine you
must sign and notarize:

1. Provide an Apple Developer ID certificate in the keychain.
2. Set `CSC_LINK` / `CSC_KEY_PASSWORD` (or use keychain) for signing.
3. Set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for
   notarization (electron-builder runs notarize automatically when present).

Unsigned builds will be blocked by Gatekeeper on other users' Macs.

## 7. Uninstall & data removal

**Windows (.exe / NSIS):** on uninstall the user is asked *"Also remove all
Proxima data and settings?"* (`build/installer.nsh` → `customUnInstall`,
wired via `nsis.include`):

- **Yes** → deletes the Electron userData (`%APPDATA%\Proxima`) — settings, the
  managed venv, the auto-downloaded Python runtime, local AI memory/embedding
  models, saved API keys, and the CLI shim — plus any `%LOCALAPPDATA%\Proxima`.
- **No** (and the silent/unattended default) → app is removed but data is kept
  for a future reinstall.

Files the agent created in the user's home `Proxima` workspace are **never**
deleted (that's the user's own content).

**macOS / Linux (source runs):** `bash scripts/uninstall.sh` mirrors this choice
(`--purge` to remove data non-interactively, `--keep-data` to keep it). It also
strips the CLI shim + PATH line. App data lives at
`~/Library/Application Support/Proxima` (macOS) / `~/.config/Proxima` (Linux).

## 8. Pre-release checklist

- [ ] `npm test` passes.
- [ ] Build each installer on its native OS.
- [ ] Smoke-test each installer on a **clean VM** (no dev tools installed):
      app launches, env banner appears, Python setup completes, a provider
      loads, and a chat round-trip works.
- [ ] macOS build is signed + notarized.
- [ ] API key generation + auth enforcement verified.

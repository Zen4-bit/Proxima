# Offline bundle (optional, populated at build time)

This folder lets Proxima ship a **fully self-contained** install so the end user
only runs the installer — no system Python, no internet needed at first run.

Two subfolders are consumed by `electron/python-env.cjs` and copied into the app
via `extraResources` (`package.json` → `build.extraResources` → `python` and
`wheels`):

- `python/` — a standalone, relocatable CPython (from
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone)).
  If present, the app uses it directly and needs **no system Python**.
- `wheels/` — every Python dependency as a prebuilt `.whl` for this OS+arch.
  If present, first-run install runs **offline** (`pip --no-index`).

Both are OPTIONAL. If empty/absent, the app transparently falls back to a system
Python + online PyPI (with retries), so existing builds keep working.

## How to populate (run on EACH target OS before building)

```
node scripts/prepare-offline-python.mjs
```

This downloads the matching standalone Python and builds the wheelhouse for the
current OS+arch. Then build as usual (`npm run build:win` / `build:mac` /
`build:linux`). Run it on the same OS/arch you are building for — wheels and the
Python runtime are platform-specific and cannot be cross-built.

> These folders are intentionally git-ignored except for this README and the
> `.gitkeep` placeholders, so the repo stays lean.

#!/usr/bin/env bash
# Proxima — Uninstall script for macOS and Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\033[36m[proxima]\033[0m %s\n' "$1"; }

OS="$(uname -s)"
if [ "$OS" = Darwin ]; then
  DATA="$HOME/Library/Application Support/Proxima"
else
  DATA="${XDG_CONFIG_HOME:-$HOME/.config}/Proxima"
fi

PURGE=ask
case "${1:-}" in
  --purge) PURGE=yes ;;
  --keep-data) PURGE=no ;;
esac

if [ "$PURGE" = ask ]; then
  printf 'Also remove ALL Proxima data (settings, Python runtime/venv, AI memory, saved keys)? [y/N] '
  read -r ans || ans=n
  case "$ans" in y|Y|yes|YES) PURGE=yes ;; *) PURGE=no ;; esac
fi

say "Removing source build artifacts (venv, offline bundle)…"
rm -rf "$ROOT/proxima-agent/.venv" "$ROOT/build/offline/python" "$ROOT/build/offline/wheels" 2>/dev/null || true
# rm -rf "$ROOT/node_modules" 2>/dev/null || true


rm -f "$DATA/bin/proxima" 2>/dev/null || true
[ -L /usr/local/bin/proxima ] && rm -f /usr/local/bin/proxima 2>/dev/null || true
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zprofile"; do
  [ -f "$rc" ] && sed -i.bak '/# Proxima CLI/d' "$rc" 2>/dev/null || true
done

if [ "$PURGE" = yes ]; then
  say "Removing Proxima data: $DATA"
  rm -rf "$DATA" 2>/dev/null || true
  say "Proxima data removed."
  say "Note: your agent-created files in ~/Proxima were kept (your content). Delete manually if desired."
else
  say "Kept Proxima data at: $DATA"
fi

say "Done."

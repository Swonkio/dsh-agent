#!/usr/bin/env bash
# Sync the plugin packages from their live directories into this repo.
#
# The packages are committed as real files so the repo is self-contained, but
# they are never edited here — this script re-copies them from where they
# actually run, so the shared copy cannot drift from the working one.
set -euo pipefail
SRC=/home/agent
KIT="$(cd "$(dirname "$0")" && pwd)"
PKGS=(dsh-tui dsh-memory dsh-web-readable dsh-web-searxng dsh-computer-use)

rm -rf "$KIT/packages"
mkdir -p "$KIT/packages"
for p in "${PKGS[@]}"; do
  mkdir -p "$KIT/packages/$p"
  # node_modules is excluded deliberately: it holds a symlink to the shared
  # @deepseek-ai scope, and shipping that points a stranger's install at paths
  # on this machine. Each package declares its own dependencies instead.
  for item in lib tools package.json README.md; do
    [ -e "$SRC/$p/$item" ] && cp -r "$SRC/$p/$item" "$KIT/packages/$p/" || true
  done
  find "$KIT/packages/$p" -name '*.bak-*' -delete 2>/dev/null || true
done
echo "synced $(find "$KIT/packages" -name '*.js' | wc -l) source files from ${#PKGS[@]} packages"

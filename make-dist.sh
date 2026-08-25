#!/usr/bin/env bash
# Build a distributable tarball of the kit from git — exactly what is
# committed, nothing else. The packages are edited in this repo (it is the
# source of truth), so there is nothing to sync from a live machine anymore.
# Run after committing; writes dsh-kit-<ref>.tar.gz next to the checkout.
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
REF=$(git -C "$KIT" rev-parse --short HEAD)
OUT="$KIT/../dsh-kit-$REF.tar.gz"
git -C "$KIT" archive --format=tar.gz --prefix="dsh-kit/" -o "$OUT" HEAD
echo "wrote $OUT"

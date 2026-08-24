#!/usr/bin/env sh
# dsh kit installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Swonkio/dsh-kit/main/bootstrap.sh | sh
#
# Runs under `sh` piped from curl, so it never reads stdin — stdin IS the
# script. Every choice is an environment variable instead:
#
#   DSH_HARNESS=/path   use an existing deepseek-harness instead of cloning
#   DSH_BUILD=1         clone AND build the harness if it is missing
#   DSH_REPO=owner/repo pull the kit from a different fork
#   DSH_REF=main        branch or tag to install
set -eu

REPO=${DSH_REPO:-Swonkio/dsh-kit}
REF=${DSH_REF:-main}
PREFIX=${DSH_PREFIX:-$HOME/.local/share/dsh-kit}

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }
need curl
need tar
need node
need git

# The harness needs a modern Node and so does this surface; checking here turns
# a confusing mid-install stack trace into one clear line.
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "node 22+ required, found $(node -v)"

say "dsh kit — installing from $REPO@$REF"

# ── the harness ─────────────────────────────────────────────────────────────
HARNESS=${DSH_HARNESS:-}
if [ -z "$HARNESS" ]; then
  for guess in "$HOME/deepseek-harness" "$PREFIX/deepseek-harness"; do
    [ -f "$guess/apps/cli/lib/bin.js" ] && HARNESS=$guess && break
  done
fi
if [ -z "$HARNESS" ]; then
  if [ "${DSH_BUILD:-0}" = "1" ]; then
    need pnpm
    say "cloning deepseek-harness (this is large, and the build takes a while)"
    mkdir -p "$PREFIX"
    [ -d "$PREFIX/deepseek-harness" ] || git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness "$PREFIX/deepseek-harness"
    ( cd "$PREFIX/deepseek-harness" && pnpm install && pnpm run build )
    HARNESS=$PREFIX/deepseek-harness
  else
    say ""
    say "No deepseek-harness found. It is a separate project (MIT) and must be"
    say "built once before this kit can run. Either:"
    say ""
    say "  DSH_BUILD=1 curl -fsSL https://raw.githubusercontent.com/$REPO/$REF/bootstrap.sh | sh"
    say ""
    say "to have this script clone and build it, or point at your own copy:"
    say ""
    say "  DSH_HARNESS=/path/to/deepseek-harness curl -fsSL ... | sh"
    exit 1
  fi
fi
say "harness: $HARNESS"

# ── the kit ─────────────────────────────────────────────────────────────────
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "downloading kit"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar xz -C "$TMP"
KIT=$(find "$TMP" -maxdepth 2 -name install.sh -print -quit)
[ -n "$KIT" ] || die "could not find install.sh in the downloaded archive"
KIT=$(dirname "$KIT")

mkdir -p "$PREFIX"
rm -rf "$PREFIX/kit"
cp -r "$KIT" "$PREFIX/kit"
DSH_HARNESS="$HARNESS" sh "$PREFIX/kit/install.sh"

say ""
say "Installed to $PREFIX/kit"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "NOTE: add ~/.local/bin to PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

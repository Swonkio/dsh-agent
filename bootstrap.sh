#!/usr/bin/env sh
# dsh kit installer — plug and play.
#
#   curl -fsSL https://raw.githubusercontent.com/Swonkio/dsh-agent/main/bootstrap.sh | sh
#
# Runs under `sh` piped from curl, so it never reads stdin — stdin IS the
# script. Every choice is an environment variable instead:
#
#   DSH_HARNESS=/path   use this deepseek-harness checkout (skip detection)
#   DSH_REPO=owner/repo pull the kit from a different fork
#   DSH_REF=main        branch or tag to install
#
# With no DSH_HARNESS, the script DETECTS an existing harness in the usual
# places and, when there is none, says "Downloading Deepseek-Harness", clones
# https://github.com/deepseek-ai/deepseek-harness itself, applies the kit's
# harness patches, and builds it — a large, one-time download; later installs
# reuse the checkout. A checkout that exists but was never built gets built,
# not re-cloned.
set -eu

REPO=${DSH_REPO:-Swonkio/dsh-agent}
REF=${DSH_REF:-main}
PREFIX=${DSH_PREFIX:-$HOME/.local/share/dsh-agent}

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

# ── the kit (downloaded first: it carries the harness patches) ──────────────
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

# ── the harness ─────────────────────────────────────────────────────────────

# Build (and patch) a harness checkout in place. Local harness patches ride
# in the kit: harness/*.patch, applied BEFORE the build so the built output
# carries them. Kept in step with the twin function in install.sh.
build_harness() {
  h=$1
  for patch in "$PREFIX/kit"/harness/*.patch; do
    [ -e "$patch" ] || continue
    if ( cd "$h" && git apply --check "$patch" 2>/dev/null ); then
      ( cd "$h" && git apply "$patch" )
      say "applied harness patch: $(basename "$patch")"
    fi
  done
  # The harness builds with pnpm. It ships with Node as corepack, so a
  # machine without it can still get there without manual steps.
  command -v pnpm >/dev/null 2>&1 || {
    say "enabling pnpm"
    corepack enable pnpm >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 \
      || die "pnpm is required to build the harness; install it with: npm install -g pnpm"
  }
  ( cd "$h" && pnpm install && pnpm run build ) \
    || die "harness build failed — see the output above, fix what it names, and re-run this installer"
}

# Plug and play: an explicit path wins, then a BUILT checkout in the usual
# places, then a cloned-but-unbuilt one (build, do not re-clone), else
# download it now.
HARNESS=${DSH_HARNESS:-}
if [ -z "$HARNESS" ]; then
  for guess in "$HOME/deepseek-harness" "$PREFIX/deepseek-harness" "$PWD/../deepseek-harness"; do
    [ -f "$guess/apps/cli/lib/bin.js" ] && HARNESS=$guess && break
  done
fi
if [ -z "$HARNESS" ]; then
  for guess in "$HOME/deepseek-harness" "$PREFIX/deepseek-harness" "$PWD/../deepseek-harness"; do
    if [ -f "$guess/package.json" ] && [ -d "$guess/packages/llm" ]; then
      say "found an unbuilt deepseek-harness at $guess — building it (this takes a while)"
      build_harness "$guess"
      HARNESS=$guess
      break
    fi
  done
fi
if [ -z "$HARNESS" ]; then
  HARNESS="$PREFIX/deepseek-harness"
  say ""
  say "Downloading Deepseek-Harness"
  say "  https://github.com/deepseek-ai/deepseek-harness"
  say "a large one-time clone; the build takes a while. Later installs reuse it."
  [ -d "$HARNESS" ] || git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness "$HARNESS"
  build_harness "$HARNESS"
fi
say "harness: $HARNESS"

DSH_HARNESS="$HARNESS" sh "$PREFIX/kit/install.sh"

say ""
say "Installed to $PREFIX/kit"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "NOTE: add ~/.local/bin to PATH:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

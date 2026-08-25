#!/usr/bin/env sh
# Install the dsh-agent kit against an existing deepseek-harness checkout.
# POSIX sh, not bash: the bootstrap runs this with `sh`, which is dash on
# Debian and Ubuntu, and dash has no `pipefail`.
set -eu

HARNESS=${DSH_HARNESS:-}
KIT="$(cd "$(dirname "$0")" && pwd)"
PREFIX=${DSH_PREFIX:-$HOME/.local/share/dsh-agent}

# ── the harness: detect, else download and build (plug and play) ────────────
# Twin of the logic in bootstrap.sh (that copy must stay curl-standalone).
build_harness() {
  h=$1
  for patch in "$KIT"/harness/*.patch; do
    [ -e "$patch" ] || continue
    if ( cd "$h" && git apply --check "$patch" 2>/dev/null ); then
      ( cd "$h" && git apply "$patch" )
      echo "applied harness patch: $(basename "$patch")"
    fi
  done
  command -v pnpm >/dev/null 2>&1 || {
    echo "enabling pnpm"
    corepack enable pnpm >/dev/null 2>&1 || npm install -g pnpm >/dev/null 2>&1 \
      || { echo "error: pnpm is required to build the harness; install it with: npm install -g pnpm" >&2; exit 1; }
  }
  ( cd "$h" && pnpm install && pnpm run build ) \
    || { echo "error: harness build failed — see the output above, fix what it names, and re-run" >&2; exit 1; }
}

if [ -z "$HARNESS" ]; then
  for guess in "$HOME/deepseek-harness" "$PREFIX/deepseek-harness" "$PWD/../deepseek-harness"; do
    [ -f "$guess/apps/cli/lib/bin.js" ] && HARNESS=$guess && break
  done
fi
if [ -z "$HARNESS" ]; then
  for guess in "$HOME/deepseek-harness" "$PREFIX/deepseek-harness" "$PWD/../deepseek-harness"; do
    if [ -f "$guess/package.json" ] && [ -d "$guess/packages/llm" ]; then
      echo "found an unbuilt deepseek-harness at $guess — building it (this takes a while)"
      build_harness "$guess"
      HARNESS=$guess
      break
    fi
  done
fi
if [ -z "$HARNESS" ]; then
  HARNESS="$PREFIX/deepseek-harness"
  echo ""
  echo "Downloading Deepseek-Harness"
  echo "  https://github.com/deepseek-ai/deepseek-harness"
  echo "a large one-time clone; the build takes a while. Later installs reuse it."
  [ -d "$HARNESS" ] || git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness "$HARNESS"
  build_harness "$HARNESS"
fi
echo "harness: $HARNESS"

# ── local harness patches (best-effort) ─────────────────────────────────────
# Patches ride in the kit's harness/ dir. On a fresh DSH_BUILD install the
# bootstrap applied them BEFORE the build. For an existing harness we apply
# to the source here — but the built output only picks them up after a
# rebuild, so say so. Already-patched (marker present) or diverged sources
# are skipped quietly: the terminal surface itself does not need the patch.
for patch in "$KIT"/harness/*.patch; do
  [ -e "$patch" ] || continue
  if grep -q randomUuid "$HARNESS/packages/llm/llm/src/message.ts" 2>/dev/null; then
    : # already patched (or upstream fixed it)
  elif ( cd "$HARNESS" && git apply --check "$patch" 2>/dev/null ); then
    ( cd "$HARNESS" && git apply "$patch" )
    echo "applied harness patch $(basename "$patch") — rebuild to activate: (cd $HARNESS && pnpm run build)"
  else
    echo "NOTE: harness patch $(basename "$patch") did not apply (diverged source?) — web UI over plain-HTTP LAN stays affected; the terminal surface is fine."
  fi
done


SCOPE="$HOME/.dsh/profiles/node_modules"
mkdir -p "$SCOPE/@deepseek-ai" "$HOME/.dsh/profiles/agent"

# Out-of-tree plugins are resolved by name from the profile's flat node_modules.
for p in "$KIT"/packages/*; do
  name=$(basename "$p")
  ln -sfn "$p" "$SCOPE/$name"
  # Packages with their own dependencies install them locally. NEVER link the
  # shared @deepseek-ai scope into a package that runs npm: npm follows the
  # symlink and deletes packages it considers extraneous, which breaks the
  # harness install. Nothing here imports @deepseek-ai at runtime.
  if [ -f "$p/package.json" ] && grep -q '"dependencies"' "$p/package.json"; then
    ( cd "$p" && npm install --silent --omit=dev >/dev/null 2>&1 ) || \
      echo "  ! npm install failed for $name — run it by hand in $p"
  fi
  echo "  linked $name"
done

# web-fetch-http ships with the harness but the base bundle never mounts it.
FETCH="$HARNESS/packages/web/web-fetch-http"
[ -d "$FETCH" ] && ln -sfn "$FETCH" "$SCOPE/@deepseek-ai/dsh-web-fetch-http" && echo "  linked dsh-web-fetch-http"

# The agent profile: root files (bundle declaration + empty patch root)
# first — a profile dir with only a patch file does not load — then the
# commented patch template the user edits.
mkdir -p "$HOME/.dsh/profiles/agent"
for root in package.json cordis.yml; do
  [ -e "$HOME/.dsh/profiles/agent/$root" ] || cp "$KIT/profile/$root" "$HOME/.dsh/profiles/agent/"
done
PROFILE="$HOME/.dsh/profiles/agent/cordis.patch.yml"
if [ -e "$PROFILE" ]; then
  echo "kept existing $PROFILE (template is at $KIT/profile/cordis.patch.yml)"
else
  cp "$KIT/profile/cordis.patch.yml" "$PROFILE"
  echo "wrote $PROFILE — EDIT IT before first run"
fi

# The sandboxed review profile the self-learning loop spawns its one-shot
# reviews in: same node_modules scope, no shell/fs/net/subagents (see
# profile/review/cordis.patch.yml for the rationale). Learning is opt-in in
# the agent profile; this just makes it available from the start.
mkdir -p "$HOME/.dsh/profiles/review"
REVIEW="$HOME/.dsh/profiles/review/cordis.patch.yml"
if [ ! -e "$REVIEW" ]; then
  cp "$KIT/profile/review/package.json" "$HOME/.dsh/profiles/review/"
  cp "$KIT/profile/review/cordis.yml" "$HOME/.dsh/profiles/review/"
  cp "$KIT/profile/review/cordis.patch.yml" "$REVIEW"
  echo "wrote $REVIEW (sandboxed review profile)"
fi

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/dsh-agent" <<LAUNCH
#!/bin/sh
exec node "$HARNESS/apps/cli/lib/bin.js" --profile agent "\$@"
LAUNCH
chmod +x "$HOME/.local/bin/dsh-agent"

echo
echo "Installed. Next:"
echo "  1. point ~/.dsh/settings.yaml at your model endpoint (see README)"
echo "  2. edit $PROFILE"
echo "  3. run: dsh-agent   (ensure ~/.local/bin is on PATH)"

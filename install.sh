#!/usr/bin/env bash
# Install the dsh kit against an existing deepseek-harness checkout.
set -euo pipefail

HARNESS=${DSH_HARNESS:-}
if [ -z "$HARNESS" ]; then
  for guess in "$HOME/deepseek-harness" "$PWD/../deepseek-harness"; do
    [ -f "$guess/apps/cli/lib/bin.js" ] && HARNESS=$guess && break
  done
fi
if [ -z "$HARNESS" ] || [ ! -f "$HARNESS/apps/cli/lib/bin.js" ]; then
  echo "Could not find a built deepseek-harness."
  echo "Clone and build it, then re-run with:  DSH_HARNESS=/path/to/deepseek-harness ./install.sh"
  exit 1
fi
echo "harness: $HARNESS"

KIT="$(cd "$(dirname "$0")" && pwd)"
SCOPE="$HOME/.dsh/profiles/node_modules"
mkdir -p "$SCOPE/@deepseek-ai" "$HOME/.dsh/profiles/tui"

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

PROFILE="$HOME/.dsh/profiles/tui/cordis.patch.yml"
if [ -e "$PROFILE" ]; then
  echo "kept existing $PROFILE (template is at $KIT/profile/cordis.patch.yml)"
else
  cp "$KIT/profile/cordis.patch.yml" "$PROFILE"
  echo "wrote $PROFILE — EDIT IT before first run"
fi

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/dsh-tui" <<LAUNCH
#!/bin/sh
exec node "$HARNESS/apps/cli/lib/bin.js" --profile tui "\$@"
LAUNCH
chmod +x "$HOME/.local/bin/dsh-tui"

echo
echo "Installed. Next:"
echo "  1. point ~/.dsh/settings.yaml at your model endpoint (see README)"
echo "  2. edit $PROFILE"
echo "  3. run: dsh-tui   (ensure ~/.local/bin is on PATH)"

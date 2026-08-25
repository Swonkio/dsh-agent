#!/bin/sh
# Nightly snapshot of the agent's durable state: memory, soul, skills, cron
# jobs, profiles, settings. Secrets (env.sh, credential store) are gitignored;
# session logs stay in their own tree. Runs from the user crontab; safe to
# run by hand at any time — an unchanged tree commits nothing.
#
# It also writes git bundles (single-file restorable repo copies) of this
# repository and the dsh-kit checkout into $BACKUP_DIR (default ~/.dsh/backups,
# keeping the last 7). Point BACKUP_DIR at a mounted USB drive or another
# machine's sync folder for real off-card copies.
set -eu
cd "$HOME/.dsh"
if [ ! -d .git ]; then
  echo "$HOME/.dsh is not a git repository; run: git init" >&2
  exit 1
fi
git add -A
if git diff --cached --quiet; then
  echo "snapshot: nothing changed"
else
  git commit -q -m "snapshot $(date +%Y-%m-%dT%H:%M:%S%z)"
  echo "snapshot: committed"
fi

BACKUP_DIR="${BACKUP_DIR:-$HOME/.dsh/backups}"
mkdir -p "$BACKUP_DIR"
for repo in "$HOME/.dsh" "$HOME/dsh-kit"; do
  name=$(basename "$repo")
  stamp=$(date +%Y%m%d)
  git -C "$repo" bundle create "$BACKUP_DIR/${name}-${stamp}.bundle" --all 2>/dev/null \
    && echo "bundle: ${name}-${stamp}.bundle"
done
ls -1t "$BACKUP_DIR"/*.bundle 2>/dev/null | tail -n +15 | xargs -r rm --
echo "snapshot: done"

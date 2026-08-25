# dsh-agent — restore guide

This archive holds everything built on the source machine: the dsh-kit plugin tree
(at its `dsh-agent-local` commit) and the `$DSH_HOME` state the system runs on.
Secrets are NOT included (API keys, bot token, credentials live outside git by
design) — bring your own.

## What is in here

```
dsh-kit/    the plugin tree: dsh-agent (terminal surface), dsh-memory (memory,
            skills, security scan, background review), dsh-cron (scheduling),
            dsh-soul (SOUL.md), dsh-telegram (gateway, vision, voice),
            dsh-agent-tools (the agent's own tool factory)
dsh-home/   profiles (agent + cron), settings.yaml, SOUL.md, memory/, skills/,
            tools/, cron jobs + snapshot script — the snapshot repo itself
```

## Prerequisites on the target machine

- Node 22.19+
- A built deepseek-harness checkout (`pnpm install && pnpm run build`),
  default path `~/deepseek-harness`
- `GLM_API_KEY` exported in `~/.bashrc` (z.ai coding plan)
- Optional: openai-whisper for Telegram voice notes (any later time)

## Restore steps

> **Install into `~/.dsh-agent`, not `~/.dsh`.** `~/.dsh` is the state
> directory of the *interactive* dsh — its own profiles, its `settings.yaml`
> with your providers, its sessions and memory. Copying this archive over it
> replaces all of that. The two installs share a machine but not a memory, a
> soul, or a profile set, so dsh-agent carries its own `$DSH_HOME` and the
> launcher in step 4 pins it.

```sh
# 1. trees
mkdir -p ~/dsh-kit && tar -x < dsh-kit.tar -C ~/dsh-kit       # or unpack dirs
mkdir -p ~/.dsh-agent && cp -r dsh-home/. ~/.dsh-agent/

# 2. kit-wide peer resolution (harness closure symlinks; versions must match
#    the installed harness — relink to whatever the closure has)
mkdir -p ~/dsh-kit/node_modules/@deepseek-ai
for p in dsh-agent dsh-cmdline dsh-home-paths dsh-llm dsh-session dsh-tools; do
  ln -sfn ~/.dsh-agent/profiles/node_modules/@deepseek-ai/$p ~/dsh-kit/node_modules/@deepseek-ai/$p
done
ln -sfn ~/.dsh-agent/profiles/node_modules/commander ~/dsh-kit/node_modules/commander
ln -sfn ~/.dsh-agent/profiles/node_modules/diff ~/dsh-kit/node_modules/diff

# 3. out-of-tree plugin links into the harness's flat fallback.
#    Link EVERY package rather than an enumerated list: the profile bundles
#    name `dsh-agent` itself, and any hand-written list goes stale the moment
#    a package is added (which is exactly how this step broke once).
mkdir -p ~/.dsh-agent/profiles/node_modules
for p in $(ls ~/dsh-kit/packages); do
  ln -sfn ~/dsh-kit/packages/$p ~/.dsh-agent/profiles/node_modules/$p
done
ln -sfn ~/deepseek-harness/packages/session-query/tool-session-query \
        ~/.dsh-agent/profiles/node_modules/@deepseek-ai/dsh-tool-session-query
ln -sfn ~/deepseek-harness/packages/web/web-fetch-http \
        ~/.dsh-agent/profiles/node_modules/@deepseek-ai/dsh-web-fetch-http

# 3b. external npm deps. Most kit packages depend only on the harness closure
#     and their in-repo siblings, which the links above resolve. The exception
#     is dsh-web-readable, which pulls @mozilla/readability, linkedom and
#     turndown from npm. Install them, or the agent will refuse to boot with
#     "Cannot find package '@mozilla/readability'" — a single plugin's missing
#     dependency fails the whole plugin tree, so this is not optional if the
#     agent profile keeps the readable fetcher.
( cd ~/dsh-kit/packages/dsh-web-readable && npm install --no-audit --no-fund )
#     Offline alternative: drop the readable fetcher and keep plain http fetch —
#     in dsh-home/profiles/agent/cordis.patch.yml set `web.fetchProvider: http`
#     and remove the web-fetch-readable insert; no external deps are then needed.

# 4. launchers — the launcher is what pins the separate state directory
printf '#!/bin/sh\nexec env DSH_HOME="${DSH_HOME:-$HOME/.dsh-agent}" DSH_HARNESS_BIN="${DSH_HARNESS_BIN:-$HOME/deepseek-harness/apps/cli/lib/bin.js}" node "$HOME/dsh-kit/packages/dsh-agent-ui/bin/dsh-agent.mjs" "$@"\n' > ~/.local/bin/dsh-agent
ln -sf ~/dsh-kit/packages/dsh-cron/bin/dsh-cron.mjs ~/.local/bin/dsh-cron
ln -sf ~/dsh-kit/packages/dsh-telegram/bin/dsh-telegram.mjs ~/.local/bin/dsh-telegram
chmod +x ~/.local/bin/dsh-agent ~/.local/bin/dsh-cron ~/.local/bin/dsh-telegram

# 5. cron environment (crontab never sources ~/.bashrc)
mkdir -p ~/.dsh-agent/cron
grep '^export GLM_API_KEY=' ~/.bashrc > ~/.dsh-agent/cron/env.sh && chmod 600 ~/.dsh-agent/cron/env.sh

# 6. crontab — OPTIONAL, and it starts autonomous work on this machine.
#    The first line wakes a scheduler every minute which can fire agent turns
#    that spend tokens and write to memory unattended. Add it only when you
#    actually want scheduled jobs running; everything else works without it.
(crontab -l 2>/dev/null
 echo '* * * * * . $HOME/.dsh-agent/cron/env.sh && flock -n $HOME/.dsh-agent/cron/lock $HOME/.local/bin/dsh-cron >> $HOME/.dsh-agent/cron/runner.log 2>&1'
 echo '17 3 * * * $HOME/.dsh-agent/cron/snapshot.sh >> $HOME/.dsh-agent/cron/snapshot.log 2>&1'
) | crontab -

# 7. snapshot repo identity
git -C ~/.dsh-agent init 2>/dev/null; git -C ~/.dsh-agent config user.name  >/dev/null || git -C ~/.dsh-agent config user.name  dsh-agent
git -C ~/.dsh-agent config user.email >/dev/null || git -C ~/.dsh-agent config user.email dsh-agent@localhost
```

Verify: `dsh-agent --dump-config` composes; `dsh-agent-ui status` shows the HUD; `node dsh-kit/tools/test-all.mjs` passes; `dsh-agent` opens (first run
shows the setup page — Telegram pairing is per-machine, the token is NOT in
this archive); unit suites with `node tools/test.mjs` inside each
`dsh-kit/packages/*`.

## Notes carried from the source machine

- The kit diverges from upstream Swonkio/dsh-kit (rename + all new packages);
  keep merging upstream into `main`, keep local work on `dsh-agent-local`.
- The LOCAL model is the default (`settings.yaml` → `agent-default-model`:
  `local` / `qwen3.8-27b-uncensored`), including the background review and
  scheduled jobs, so the learning loop costs nothing and sends nothing off the
  machine. Hosted providers stay available via `/model`. ASR/TTS/search are NOT
  on the z.ai coding plan — voice transcribes locally with whisper.
- The background review runs in the sandboxed `review` profile (no shell, no
  fetch, no file writes, no subagents, no tool creation). Verify with
  `DSH_HOME=~/.dsh-agent node dsh-kit/tools/test-review-sandbox.mjs`.
- Never `git clean` in the kit; the bundle dir `~/.dsh-agent/backups` holds nightly
  restorable bundles on the source machine.

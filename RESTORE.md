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

```sh
# 1. trees
mkdir -p ~/dsh-kit && tar -x < dsh-kit.tar -C ~/dsh-kit       # or unpack dirs
mkdir -p ~/.dsh && cp -r dsh-home/. ~/.dsh/

# 2. kit-wide peer resolution (harness closure symlinks; versions must match
#    the installed harness — relink to whatever the closure has)
mkdir -p ~/dsh-kit/node_modules/@deepseek-ai
for p in dsh-agent dsh-cmdline dsh-home-paths dsh-llm dsh-session dsh-tools; do
  ln -sfn ~/.dsh/profiles/node_modules/@deepseek-ai/$p ~/dsh-kit/node_modules/@deepseek-ai/$p
done
ln -sfn ~/.dsh/profiles/node_modules/commander ~/dsh-kit/node_modules/commander
ln -sfn ~/.dsh/profiles/node_modules/diff ~/dsh-kit/node_modules/diff

# 3. out-of-tree plugin links into the harness's flat fallback
for p in dsh-memory dsh-cron dsh-soul dsh-telegram dsh-agent-tools; do
  ln -sfn ~/dsh-kit/packages/$p ~/.dsh/profiles/node_modules/$p
done
ln -sfn ~/deepseek-harness/packages/session-query/tool-session-query \
        ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tool-session-query
ln -sfn ~/deepseek-harness/packages/web/web-fetch-http \
        ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-fetch-http

# 4. launchers
printf '#!/bin/sh\nexec node "$HOME/deepseek-harness/apps/cli/lib/bin.js" --profile agent "$@"\n' > ~/.local/bin/dsh-agent
ln -sf ~/dsh-kit/packages/dsh-cron/bin/dsh-cron.mjs ~/.local/bin/dsh-cron
ln -sf ~/dsh-kit/packages/dsh-telegram/bin/dsh-telegram.mjs ~/.local/bin/dsh-telegram
chmod +x ~/.local/bin/dsh-agent ~/.local/bin/dsh-cron ~/.local/bin/dsh-telegram

# 5. cron environment (crontab never sources ~/.bashrc)
mkdir -p ~/.dsh/cron
grep '^export GLM_API_KEY=' ~/.bashrc > ~/.dsh/cron/env.sh && chmod 600 ~/.dsh/cron/env.sh

# 6. crontab (scheduler every minute, snapshot nightly)
(crontab -l 2>/dev/null
 echo '* * * * * . $HOME/.dsh/cron/env.sh && flock -n $HOME/.dsh/cron/lock $HOME/.local/bin/dsh-cron >> $HOME/.dsh/cron/runner.log 2>&1'
 echo '17 3 * * * $HOME/.dsh/cron/snapshot.sh >> $HOME/.dsh/cron/snapshot.log 2>&1'
) | crontab -

# 7. snapshot repo identity
git -C ~/.dsh init 2>/dev/null; git -C ~/.dsh config user.name  >/dev/null || git -C ~/.dsh config user.name  dsh-agent
git -C ~/.dsh config user.email >/dev/null || git -C ~/.dsh config user.email dsh-agent@localhost
```

Verify: `dsh-agent --dump-config` composes; `dsh-agent` opens (first run
shows the setup page — Telegram pairing is per-machine, the token is NOT in
this archive); unit suites with `node tools/test.mjs` inside each
`dsh-kit/packages/*`.

## Notes carried from the source machine

- The kit diverges from upstream Swonkio/dsh-kit (rename + all new packages);
  keep merging upstream into `main`, keep local work on `dsh-agent-local`.
- The local model (settings.yaml `local` provider) is opt-in via `/model`; hosted glm-5.3 is
  the default. Vision is `glm-4.6v` (there is no 5v; used only for images,
  5.3 stays the task model). ASR/TTS/search are NOT on the coding plan —
  voice transcribes locally with whisper.
- Never `git clean` in the kit; the bundle dir `~/.dsh/backups` holds nightly
  restorable bundles on the source machine.

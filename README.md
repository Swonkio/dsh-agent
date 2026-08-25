# dsh-agent

A **local-first, self-improving agent kit** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a terminal coding agent plus seventeen Cordis plugins that give it durable memory, guardrails against runaway loops, and a learning loop that turns its own failures, your corrections, and its repeated procedures into better future behavior — all on your own model endpoint, by default on your own machine.

**This is not a standalone program.** The kit is a Cordis plugin bundle: it needs the harness to host it and an OpenAI-compatible model endpoint to talk to. The kit is the part that is mine to share; the harness and the model are separate downloads.

## The idea: a closed learning loop

Most agents start every session from zero. This kit keeps what a session learns and puts it back where the next session will see it:

```
        ┌──────────────────────────── the turn ────────────────────────────┐
        │                                                                  │
  user asks ──► agent acts ──► loop-guard caps runaway turns              │
        │         │              grounding nudges unverified conclusions  │
        │         │              and missing plans                        │
        │         ▼                                                         │
        │   turn ends ──► outcome? ──► detached review (sandboxed, local) │
        │                                   │                              │
        │                                   ├─ failure ────► "Lesson: …" memory
        │                                   ├─ correction ► "Lesson/Preference: …"
        │                                   ├─ procedure ──► a named skill
        │                                   └─ routine ────► durable facts + user model
        │                                                                  │
        │   next prompt: "Relevant past mistakes" section re-scored        │
        │   against the LATEST exchange, above the memory index            │
        │                                                                  │
        └── curation: skills that fail get flagged, lessons that are read
            but not followed get rewritten, contradictions get caught ◄──┘
```

Two design rules run through all of it:

- **Nothing leaves the machine unless you say so.** The interactive default, every review pass, every scheduled job can run on a local endpoint (`llama.cpp`, llama-swap, vLLM, ollama). Hosted providers are opt-in picks, not defaults.
- **Agent-written memory is plain files you can read and correct.** A durable wrong "lesson" is worse than no memory at all, so everything learned lands in reviewable markdown, is security-scanned on the way in, and has its contradictions and staleness tracked after.

## What's in it

| package | what it does |
|---|---|
| **the surface** | |
| `dsh-agent` | the terminal agent: Claude-Code-style TUI over the harness's base roster — first-run setup wizard, transcript, composer, editor, model dial, backend instrumentation (`/think`, `/backend`, `/cache`), scrollback. Ships the `agent` profile's surface bundle (persona, ask-user, Code Mode runtime, runner) |
| `dsh-agent-ui` | zero-dependency terminal UI toolkit the surface draws from: true-color theme, canvas, HUD, status lines, boot animation primitives |
| `dsh-agent-tools` | the agent mints its own tools: validated command-template definitions in `$DSH_HOME/tools` register as real schema-carrying tools at boot (`tool_create`/`tool_forget`), with quoting-escaped parameters, a key-scrubbed child environment, and security scanning — definitions are data, never model-authored code |
| **memory & learning** | |
| `dsh-memory` | the memory plugin and the whole learning loop (details below): `remember` project memory (QWEN.md), the `memory_save`/`memory_search`/`memory_edit`/`memory_forget` user store injected into every prompt, `skill_create` procedural memory, plus five detached review kinds, proactive lesson recall, review coalescing + idle drain, lesson-efficacy telemetry, and idle session digests |
| `dsh-epistemics` | truth maintenance behind memory: contradiction detection, provenance and confirmation counts, evidence-scaled staleness, and the refuse-first security scan every memory/skill/digest passes on the way in |
| `dsh-soul` | `SOUL.md` — the personality file, injected right after the persona |
| `dsh-user-model` | `USER.md` — a self-revising model of *who you are*, injected every session and kept current by the background review |
| **guardrails** | |
| `dsh-loop-guard` | the circuit breaker: caps runaway multi-step turns (soft nudge → hard turn-end), truncates a single response whose reasoning repeats itself or runs away, queues one focused recovery follow-up, and hands control back to you after a bounded number of auto-recoveries |
| `dsh-grounding` | behavior nudges that attack the *causes* of loops: **verify-before-conclude** (a stated root cause with no tool check behind it gets one rate-limited "go look" nudge) and **plan-on-multistep** (several tool calls in with no `todo_write` gets one "write a quick plan" nudge) |
| **self-observation** | |
| `dsh-prompt-audit` | the `/prompt` command: the assembled system prompt, section by section, with byte counts (sections, dynamic contexts, tool schemas). Zero model tokens |
| `dsh-curator` | outcome-aware curation: tracks whether a skill actually *helped* the turn that loaded it, flags failing skills for revision (not retirement), archives the idle ones — recoverably, never deletes — and lists stale memories, unresolved contradictions, and lessons that are read but not followed. Also annotates skills in the prompt with their track record (✓/⚠), so proven skills get preferred *before* the failure, and provides the `/loop` dashboard |
| `dsh-learning-eval` | the eval harness that measures whether any of this helps: runs a task set with memory on and off and reports the lift, with controls that keep the number honest |
| **integrations** | |
| `dsh-cron` | durable scheduled agentic tasks: a `cronjob` tool, a `/cron` command, and a crontab-driven runner that fires prompts through a one-shot profile |
| `dsh-telegram` | a Telegram gateway: long-poll the Bot API, run each message through a one-shot agent turn with per-chat session continuity, drain an outbox cron jobs can deliver to |
| `dsh-computer-use` | drive a VirtualBox VM's screen, keyboard and mouse; OCR-based `find` (optional, off by default) |
| **web** | |
| `dsh-web-readable` | article extraction before markdown conversion — cuts a typical page from ~21k tokens to ~4k, headings/lists/links intact |
| `dsh-web-searxng` | web search through a self-hosted SearXNG instance: free, keyless, local |

Plus `profile/` — the `agent` profile template and the sandboxed `review` profile the learning loop spawns into (see below), and `.github/workflows/ci.yml` — the unit suites run on every push.

**Compaction is not amnesia.** When auto-compaction fires at 80% of the window, a digest of the session is forced *before* the history is replaced, and a recap section injects this session's digest plus the most recent others into every prompt — so what compaction summarises away is still known.

**The learned state is durable.** `dsh-snapshot` keeps `$DSH_HOME` under git — memory, skills, SOUL/USER, profiles, settings — with a refuse-first ignore list (credentials, session logs, caches, and the machine-specific plugin symlinks never commit). It auto-commits when you go idle, exposes `/snapshot`, and can write a restorable single-file bundle.

## The learning loop in `dsh-memory`

All opt-in from the profile config; all of it can run on the local endpoint.

**Five review kinds, one sandbox.** After a turn ends, the plugin may spawn a *detached one-shot review* — a separate `dsh --profile review` process, never blocking your turn:

| trigger | review does |
|---|---|
| a completed turn (routine) | saves durable facts, revises the user model |
| a failed / interrupted / thrashing / loop-guard-broken turn | a **post-mortem** that extracts one "Lesson: …" memory |
| your correction ("no, do X instead") | a **correction review** — the highest-signal feedback there is — saving a Lesson or Preference |
| a completed multi-tool procedure (≥5 calls incl. a mutating one) | **skill synthesis**: may distill it into a named, reusable skill |
| idle with 3+ exchanges | a **digest**: one paragraph per session under `sessions/.digests/` |

The review profile is the sandbox: no shell, no file mutation, no network, no subagents, no tool minting, no interaction. What remains is exactly the vocabulary of learning — write a memory, write a skill, search past sessions. The one file write it can make is `digest_save`, scoped to `sessions/.digests/` and security-scanned like memory. Unattended reviews read untrusted text; they must not be able to act on it.

**They never fight your turn for the GPU.** Reviews share one queue: a second review within `coalesceWindowMs` (default 2 min) of a spawn *queues*, and the queue drains as **one combined model call** once you've been idle for `idleAfterMs` (default 5 min). With smart dispatch (on by default), a queued review first asks llama-swap's control plane whether the slot is actually generating — an idle slot takes the review immediately, a busy one defers. On a single-slot backend, a queued-behind-your-turn review is invisible; a competing one is a stall.

**Recall that follows the task.** Every prompt assembly re-scores the `Lesson: …` lines against the *latest* user+assistant exchange — not the opening request — and surfaces the top few in a dedicated section above the memory index. As the task drifts mid-session, the recalled mistakes drift with it.

**Lessons are held accountable.** Every surfaced lesson is logged; a failure soon after with that lesson on record is a miss. `curate report` lists lessons that were *read but not followed* — advice the agent keeps receiving and keeps ignoring — for rewrite or retirement.

## Prerequisites

1. **Node 22.19+ or 24+**
2. **A built deepseek-harness checkout** (MIT). Clone it and follow its own build steps: `pnpm install && pnpm run build`.
3. **An OpenAI-compatible endpoint.** Anything that speaks `/v1/chat/completions` — llama.cpp's `llama-server`, llama-swap, vLLM, ollama, or a hosted API.

## Install

One line, if you already have a built harness:

```sh
DSH_HARNESS=/path/to/deepseek-harness \
  curl -fsSL https://raw.githubusercontent.com/Swonkio/dsh-agent/main/bootstrap.sh | sh
```

Or let it clone and build the harness for you (large download, slow build, needs `pnpm`):

```sh
DSH_BUILD=1 curl -fsSL https://raw.githubusercontent.com/Swonkio/dsh-agent/main/bootstrap.sh | sh
```

The bootstrap never reads stdin — piped to `sh`, stdin *is* the script — so every option is an environment variable: `DSH_HARNESS` (use an existing harness), `DSH_BUILD` (clone+build if missing), `DSH_REPO`/`DSH_REF` (different fork or branch), `DSH_PREFIX` (install location).

From a clone instead:

```sh
git clone https://github.com/Swonkio/dsh-agent && cd dsh-agent
DSH_HARNESS=/path/to/deepseek-harness ./install.sh
```

`install.sh` links every kit package into `~/.dsh/profiles/node_modules/`, writes the `agent` profile patch and the sandboxed `review` profile, and drops a `dsh-agent` launcher into `~/.local/bin`. `DSH_HOME` relocates the whole data dir if you don't want `~/.dsh`.

## Configure

**1. Providers — no keys in files, ever.** Copy [`settings.example.yaml`](settings.example.yaml) to `~/.dsh/settings.yaml`:

```sh
cp settings.example.yaml ~/.dsh/settings.yaml
```

It configures three providers side by side — a local server, OpenRouter, and z.ai's GLM coding plan — all reachable from `/model` at runtime. **No key is ever written into that file**: `apiKeyEnv` names an environment variable and the harness reads the value from your environment, so export them from your shell profile instead. Keeping a local model as `agent-default-model` means nothing leaves your machine unless you pick a hosted model deliberately.

**A working sample state** lives in [`examples/dsh-home/`](examples/dsh-home) — a seed `MEMORY.md`, `SOUL.md`/`USER.md` scaffolds, sample cron jobs, and a filled-in `settings.yaml` — copy it into your `DSH_HOME` if you want a head start rather than an empty data dir.

**2. The profile patch.** Edit `~/.dsh/profiles/agent/cordis.patch.yml` (the installer wrote a fully commented template). It sizes compaction and tool-result pruning for a big local context window, wires the web fetch/search providers, and mounts the kit's plugins with their knobs:

- `dsh-memory` — the learning loop: `backgroundReview`, `learnFromFailures`, `learnFromCorrections`, `synthesizeSkills`, `digestSessions`, plus the lesson-recall (`lessonsTopK`, `lessonsMinScore`) and dispatch (`coalesceWindowMs`, `idleAfterMs`, `lessonEfficacy`) settings. **Point the review route at your local provider** (`reviewProvider: local`) to keep learning on-machine.
- `dsh-loop-guard` — `softStep`/`hardStep` (per-turn step caps), `repeatThreshold` (reasoning-loop detector), `maxRecoveries`.
- `dsh-grounding` — `verifyEvery`, `minEvidence`, `planStep`, `planMinTools`.
- `dsh-prompt-audit` — `/prompt`, threshold `warnAtBytes`.
- optional: `dsh-computer-use` (commented out — needs VirtualBox with VRDE/VNC).

Config changes activate on the next launch; there is no hot reload of plugin code.

**3. Run it:**

```sh
dsh-agent
```

## What you get at runtime

**Commands:** `/memory` (audit the memory index, zero tokens) · `/prompt` (audit the assembled system prompt, zero tokens) · `/loop` (the learning-loop dashboard: lessons, reviews, skill outcomes, guard breaks) · `/snapshot` (commit the learned state) · `/cron` (scheduled tasks) · `/model`, `/think`, `/backend`, `/cache` (from the surface).

**Tools the agent gains:** `remember` (project memory) · `memory_save`/`memory_search`/`memory_edit`/`memory_forget` (user memory) · `skill_create` (procedural memory) · `curate` (curation report and skill lifecycle) · `cronjob` (scheduled tasks) · `tool_create`/`tool_forget` (the agent tool factory) · `computer_use` (optional) — plus the harness's own bash/read/write/edit/glob/grep/todo/web/skills set.

## Providers

| provider | base URL | key |
|---|---|---|
| local | `http://127.0.0.1:8080/v1` | usually none |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| z.ai coding plan | `https://api.z.ai/api/coding/paas/v4` | `GLM_API_KEY` |

**z.ai: mind the base URL.** The coding plan is a subscription served from `/api/coding/paas/v4`. The standard pay-as-you-go path `/api/paas/v4` takes the same key and the same model ids but answers `error 1113 "Insufficient balance or no resource package"` unless you hold PAYG credit. Both paths serve `/models` successfully, so the model list looks healthy while completions fail — **if a valid key returns a balance error, suspect the URL before the subscription.**

**GLM models are reasoning models.** A small `maxTokens` can be spent entirely on deliberation and come back with empty content and non-zero `reasoning_tokens`. That is not a failure; give them room.

**OpenRouter ids change.** Read them from the catalogue rather than guessing — plausible-looking ids often do not exist:

```sh
curl -s https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" | jq -r '.data[].id'
```

## Security & privacy stance

- **No secrets in any file the kit writes or ships.** Credentials are referenced by environment-variable name (`apiKeyEnv`) and read from your environment at run time; the Telegram bot token lives in a `0600` config under `$DSH_HOME`; nothing in this repository contains a key, token, or password.
- **Memory is an injection surface with a long lifetime**, so every memory, skill, and digest passes a refuse-first scan (instruction-override, credential-exfiltration, backdoor, and invisible/bidi-Unicode patterns) before it is stored — it will be replayed into every future system prompt.
- **Unattended reviews run in a sandbox** that cannot execute, mutate files, fetch, spawn, or ask: a prompt injection that reaches one can, at worst, write a wrong memory — which the epistemics layer flags and the curator can retire.
- **Agent-authored tools are data, not code**: definitions in `$DSH_HOME/tools` are quoting-escaped, key-scrubbed, and security-scanned before they register as tools.
- **Nothing is ever deleted by curation** — archived, recoverably — and a pinned entry outranks every heuristic.

## Testing

Every package carries its own suite; run them all from a bare checkout:

```sh
node tools/test-all.mjs
```

`tools/` also holds the live-verification harnesses used during development (`live-test-*.mjs`, run against a scratch `DSH_HOME`) and `test-review-sandbox.mjs`, which composes the review profile and fails if anything executable reappears in it.

## Notes worth knowing

**Context window must match your server.** `contextWindow` is what the compaction threshold is a percentage *of*. Setting it higher than the server's real `-c` means compaction fires after the server has already truncated.

**The single-slot rule.** If your backend serves one request at a time, a second concurrent request does not run alongside your turn — it queues *ahead* of it. That is why `session-title-llm` is disabled in the template, why subagent/workflow tools are a poor fit on such a backend, and why this kit's reviews coalesce and drain at idle instead of spawning freely.

**Reasoning effort.** `/think off|low|medium|high` sets it per message. This only does something if your chat template reads `<|think_*|>` markers from message text — llama.cpp ignores the wire `reasoning_effort` field, so a server-side pin is otherwise the only control.

**`/backend` and the draft dial** read llama-swap's control plane on `:8080`. On any other backend they simply show nothing.

## Credits

Built on [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © DeepSeek).

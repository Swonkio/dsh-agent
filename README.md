# dsh-agent

A **persistent, self-hosted AI agent** built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It runs against any OpenAI-compatible model endpoint — a **local** llama.cpp / llama-swap / vLLM / ollama server by default, with hosted providers reachable at runtime — and adds durable memory, self-learning, scheduled jobs, a Telegram gateway, a persona, and the ability to write its own tools.

It is **not a Raspberry Pi project** — it was first built on one, but everything here runs on any Linux (or macOS) host with Node and a model endpoint. The default model is **local**, so nothing leaves the machine unless you choose a hosted model.

> This is a plugin bundle for DeepSeek Harness, not a standalone program: the harness hosts it, and a model endpoint answers it. Both are separate installs — see **Setup**.

---

## What it is

`dsh-agent` composes the harness base bundle plus one terminal-surface bundle, then a stack of plugins:

| package | what it adds |
|---|---|
| **dsh-agent** | the interactive terminal surface — transcript, composer, live HUD, ASCII animations, `/model` switching |
| **dsh-memory** | durable cross-session memory (`memory_save`/`_search`/`_edit`/`_forget`), a QWEN.md project-memory tool, full-text recall of past *conversations*, and opt-in **background self-review** that saves lessons after a turn |
| **dsh-cron** | schedule agent turns (`cronjob` tool + a per-minute scheduler run from crontab); jobs can post results to Telegram |
| **dsh-soul** | a `SOUL.md` persona injected into every session — who the *agent* is |
| **dsh-epistemics** | truth maintenance for memory: catches a new fact that **contradicts** one already on file (polarity, antonym, quantity), and records provenance — how you knew, when, and how many times it has been confirmed |
| **dsh-curator** | **outcome-aware** curation: records whether the turn that loaded a skill actually succeeded, then flags failing skills for revision, retires unused ones (archive, never delete), and reports stale or contradictory memories |
| **dsh-learning-eval** | an A/B harness that measures whether the loop actually helps — same tasks with memory on and off, deterministic scoring, and a control that refuses to credit memory for answers the model already knew |
| **dsh-user-model** | a self-revising `USER.md` — who the *user* is: expertise, preferences, working style, environment, projects. Injected into every session and **maintained by the background review**, so the agent starts each conversation already knowing you |
| **dsh-telegram** | a Telegram gateway — chat with the agent, send images (vision) and voice notes (local transcription) |
| **dsh-agent-tools** | the agent's own **tool factory**: `tool_create`/`tool_forget` register new schema-carrying tools from data definitions in `~/.dsh/tools`, security-scanned, never model-authored code |
| **dsh-web-readable** | article extraction before markdown — a page that would cost ~21k tokens of chrome comes back ~4k, content intact |
| **dsh-web-searxng** | web search through a self-hosted SearXNG (optional) |
| **dsh-computer-use** | drive a VirtualBox VM: keys, clicks, scroll, drag, OCR-based `find` (optional) |

Two run surfaces:

- **`dsh-agent`** — the interactive terminal.
- **`dsh-cron`** — the scheduler, run once a minute from your crontab; it fires any jobs that are due. Job *management* is done inside the agent with the `cronjob` tool, not the CLI.
- **`dsh-telegram`** — the gateway daemon (optional).

---

## Layout

```
dsh-kit/                 the plugin tree (this is what installs)
  packages/              the plugins above
  settings.example.yaml  provider config template (no keys)
  profile/               the agent profile patch template
  install.sh, bootstrap.sh
dsh-home/                a ready-to-use $DSH_HOME
  settings.yaml          three providers, local model as default
  profiles/agent/        the agent profile (bundles + cordis.patch.yml)
  profiles/cron/         the scheduler profile (no self-review — no recursion)
  SOUL.md                the persona
  memory/                MEMORY.md index + topic notes
  cron/                  jobs.json + the nightly snapshot script
RESTORE.md               step-by-step restore onto a new machine
```

---

## Models & providers

Configured in `dsh-home/settings.yaml`. **Keys are never stored in the file** — `apiKeyEnv` names an environment variable and the harness reads the value from your shell.

| provider | base URL | key | default? |
|---|---|---|---|
| **local** | `http://127.0.0.1:8080/v1` | `LOCAL_API_KEY` (any value; llama.cpp ignores it) | ✅ **yes** |
| openrouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | reachable via `/model` |
| z.ai coding plan | `https://api.z.ai/api/coding/paas/v4` | `GLM_API_KEY` | reachable via `/model` |

The **local model is the default** for interactive turns, background self-review, and new cron jobs. Switch to a hosted model at any time with `/model`, or per cron job with the `cronjob` tool's provider/model arguments.

**Notes learned the hard way** (all in the config comments):

- **`contextWindow` must equal the server's real `-c`.** It is what the compaction threshold is a percentage of; set it too high and the server truncates before the agent ever compacts.
- **z.ai coding plan is `/api/coding/paas/v4`**, not the pay-as-you-go `/api/paas/v4` — the latter answers `error 1113 "Insufficient balance"` with the same key. Both serve `/models`, so the list looks fine while completions fail.
- **GLM are reasoning models**: a small `maxTokens` can be spent entirely on deliberation and return empty content with non-zero `reasoning_tokens`.

---

## Setup

**Prerequisites**

1. **Node 22.19+ or 24+**
2. **A built deepseek-harness checkout** (MIT) — `git clone` it, `pnpm install && pnpm run build`.
3. **An OpenAI-compatible model endpoint.** For the local default, run e.g. `llama-server -m your-model.gguf -c 131072 --host 127.0.0.1 --port 8080` (any context size — just match it in settings).

**Install**

```sh
# from a clone of this repo
DSH_HARNESS=/path/to/deepseek-harness ./dsh-kit/install.sh   # links the plugins
cp -r dsh-home/. ~/.dsh/                                     # install the $DSH_HOME state
```

`RESTORE.md` has the full symlink recipe (peer resolution, launchers, crontab). Then:

```sh
export LOCAL_API_KEY=local        # any value; llama.cpp ignores it
# (optional) export OPENROUTER_API_KEY=...  GLM_API_KEY=...
dsh-agent                         # first run shows the setup page
```

**Run anywhere but the source machine:** set `DSH_HOME` to use a different state directory — the whole thing is relocatable, and the test suite for this kit runs each package under an isolated `$DSH_HOME`.

---

## Self-learning

After a turn completes, `dsh-memory` can fire a **detached background review** (throttled to one per few minutes) that reads the exchange and saves durable lessons to memory on its own — no extra model call per message. It runs under the `cron` profile, where self-review is off, so it never recurses. The review model is configurable (`reviewProvider`/`reviewModel`); here it runs on the **local** model, so self-learning costs nothing and leaks nothing.

The review does two things with what it reads:

- **Durable lessons** → `memory_save` / `skill_create` / `tool_create` (facts, procedures, and command-shaped tools worth keeping).
- **A deepening model of *you*** → it reads the current `USER.md` with `user_model`, folds in anything new the exchange revealed about your expertise, preferences, working style, environment, or projects, and **revises it in place** (dialectic, not append-only — a new observation corrects an old belief). That model is injected into every future session, so the agent behaves like a colleague on day two rather than day one.

This is the same shape as [Nous Research's Hermes Agent](https://github.com/nousresearch/hermes-agent) 'closed learning loop' — agent-curated memory, periodic nudges, FTS5 cross-session recall, autonomous skill creation, and a deepening user model — built here on a local model so the whole loop stays on your machine.

## Scheduling

`cron/jobs.json` ships two example jobs (a Bitcoin-price line and a portable host-health check), both routed at the local model. The scheduler is a crontab line that runs `dsh-cron` every minute; it fires due jobs and optionally posts to Telegram. Manage jobs from inside the agent with the `cronjob` tool.

## Snapshots

`cron/snapshot.sh` commits the agent's durable state (memory, soul, profiles, cron jobs) to a git repo at `$DSH_HOME` nightly and writes restorable git bundles to `~/.dsh/backups`. Secrets (`env.sh`, the credential store, `telegram/`, `sessions/`) are gitignored and never enter history.

---

## Security & privacy

- **No secret ever enters this repo.** API keys are environment-variable *names*; the Telegram bot token lives in a gitignored `~/.dsh/telegram/config.json` (mode 0600); the harness credential store and session logs are gitignored.
- **Local by default.** With the default config, no prompt leaves the machine. Hosted providers are opt-in per `/model` selection or per cron job.
- **The tool factory runs data, not code.** `tool_create` definitions are quoting-escaped, run with a key-scrubbed child environment, and security-scanned; the model never writes executable code that runs unsandboxed.

## Credits

Built on [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © DeepSeek), extending [Swonkio/dsh-kit](https://github.com/Swonkio/dsh-kit). Article extraction uses Mozilla Readability; terminal traces use Braille cells; the boot sequence is a caustic light field rendered as ASCII.


## The learning loop, in detail

Four properties this kit holds that are worth stating plainly, because each one
was a deliberate choice rather than an accident of implementation.

### 1. The review is sandboxed

The background review runs **unattended**, and its input is the last exchange —
which may contain web pages, file contents or command output carrying injected
instructions. So it runs in its own `review` profile that withholds shell, file
mutation, network, subagents, scheduling and tool creation. What it keeps is the
vocabulary of learning: `memory_save`, `user_model`, `skill_create`,
`session_search`.

An injection that reaches the review can at worst write a wrong memory — which
the next section catches — instead of running a command.

Capability is cut at the **tool** layer, not the service layer: the services
underneath (shell, approval, goals) stay enabled, because other plugins depend
on them — the tree refuses to load without them — and disabling `approval`
would remove the permission gate rather than tighten it. What the model can
call is decided by what is registered, so that is the layer to cut.

Measured against a stub endpoint that records the request, the review profile
sends **13 tools** where the agent profile sends **43**:

```
memory_save  memory_edit  memory_forget  memory_search  remember
user_model   skill        skill_create
session_search  session_trace  session_event_read/search/trace
```

No shell, no editor, no fetch, no subagent, no `tool_create`, no scheduling.
`dsh-kit/tools/test-review-sandbox.mjs` composes the profile and fails if any
tool-registering plugin reappears; it is checked against a deliberate breach so
the check itself is known to detect one.

### 2. A contradiction is caught on the way in

The store already refused near-duplicates. The failure it could not see was the
opposite one: a fact similar in **subject** but opposite in **claim**. "the node
runs jito-solana" and "the node runs stock agave" are only ~60% similar, so both
survived, and every later session was handed both.

`dsh-epistemics` scores that on the write path — free and deterministic, no
model call — on three signals: **polarity** (one side negated), **antonym**
(enabled/disabled, works/broken) and **quantity** (same subject, different port
or quant or size), gated by whether the two lines share a distinctive term at
all. It reports rather than blocks, so a false positive costs one sentence and a
true positive prevents a permanent wrong belief.

Provenance (`recorded`, `confirmed`, `confirmations`, `confidence`) lives in the
topic file's frontmatter, never in the index — the index is injected into every
prompt and would pay for those bytes on every turn forever.

### 3. Curation is driven by outcomes, not by counts

The easy signals are recency and use count, and they measure **attention, not
value**: a skill invoked constantly that leaves the turn failing half the time is
actively harmful, and a use count rewards it for being harmful more often.

`dsh-curator` records, for every skill the agent loads, whether the turn that
loaded it then succeeded. That changes what the right action is:

- a skill that is merely **unused** is archived — quietly, recoverably;
- a skill that is used and **fails** is *flagged for revision*, not retired,
  because it is being reached for, so the intent is live and only the content is
  wrong.

Those are opposite responses, and a count-based policy cannot tell the two cases
apart. Two invariants hold throughout: nothing is ever deleted (archive is a
move), and a pinned entry is untouchable.

### 4. The loop is measured

`dsh-learning-eval` runs a task set twice — once with memory seeded, once
without — and reports the lift.

The control arm is the whole design. Measuring the treatment alone tells you the
agent answered correctly, not that *memory* is why. And when a control already
scores full marks, the model knew the answer anyway: that task cannot detect
whether the loop works, so the harness names it and **excludes it from the
headline** rather than averaging a meaningless zero into the mean.

Scoring is deterministic substring matching, not an LLM judge, so a change in
the number comes from the agent rather than from a judge drifting. Any forbidden
term is an automatic zero — stating the stale version of a fact is not a
partially-correct answer.

```
node dsh-kit/packages/dsh-learning-eval/tools/eval.mjs --repeats 3 --out report.md
```

Each arm gets a throwaway `$DSH_HOME`, so the eval can never read or write your
real memory.

## Running the tests

```
node dsh-kit/tools/test-all.mjs
```

Works from a bare clone. It links in-repo sibling packages itself (a dependency
that lives in the same repo should not need a manual step) and reports suites
that need the harness peers as **skipped** rather than failed — a missing
install is a setup state, not a broken test, and conflating the two hides real
failures. In a full install all suites run:

```
346 assertions passed · 0 suite(s) failed · 0 skipped
```

The review sandbox has its own check, since it is a security boundary rather
than a behaviour:

```
DSH_HOME=~/.dsh-agent node dsh-kit/tools/test-review-sandbox.mjs
```

It composes the `review` profile for real and fails if anything that can
execute, write, fetch or delegate has reappeared.

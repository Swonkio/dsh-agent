# dsh-agent

An interactive terminal surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a Claude Code-style CLI built the way `dsh` expects a client to be built: as a profile bundle over `@deepseek-ai/dsh-base`, with no Host, HTTP server, API gateway, or browser runtime.

```sh
dsh-agent                      # open a session in the current directory
dsh-agent "fix the flaky test" # open with a first prompt
dsh-agent -c                   # continue this directory's last session
dsh-agent -r                   # pick a session to resume
dsh-agent -p "what is this?"   # one-shot, no UI (like --profile headless)
```

## Why it exists

The base bundle already composes a single-session, process-wide agent plane: tools, sandbox and approval policy, skills, subagents, plan mode, compaction, todos, goals, background jobs. The web bundle's own patch says as much — it disables those rows "for the TUI, which is single-session and composes its agent process-wide" — but this checkout ships no TUI bundle. This package is that missing surface.

Nothing here reimplements harness behavior. The surface fills exactly the seams a dsh client is supposed to fill:

| Seam | What this package provides |
|---|---|
| `ctx.cmdlineArgs` | a commander program publishing the `agentStartup` service |
| `session/event` | the renderer: assistant prose, reasoning, tool cards, diffs, todos, notices |
| `ctx.tools` presenters | `presentCall`/`presentResult` render intents mapped to terminal cards |
| `approval/request` | an interactive answerer (allow once / allow this tool / reject) |
| `ctx.userQuestions` | a terminal provider for `ask_user_question`, including plan review |
| `ctx.commands` | a slash-command adapter, so `/compact`, `/plan`, `/goal`, `/feedback` work |
| `ctx.agents` | one live Agent created or resumed in process, with `installModelSelection` |

## Layout

```
cordis.patch.yml   the bundle patch: persona, tool-ask-user, code-runtime, the two rows below
lib/startup.js     the cmdline provider (flags, --help), publishes `agentStartup`
lib/index.js       the runner: agent lifecycle, input loop, approvals, questions, commands
lib/render.js      the session feed as terminal output
lib/term.js        colors, the transient status line, the line editor, menus
lib/anim.js        the live primitives: scope, trace, gauges, shimmer, scanner, rotor
lib/braille.js     a 2x4-pixel-per-cell canvas, for traces that are lines not bars
lib/boot.js        the cold-start sequence: caustics, etching the wordmark
lib/light.js       the light model — one caustic field, shared by everything lit
lib/field.js       the wave equation, as a plucked string
lib/backend.js     llama-swap/llama.cpp introspection: draft efficiency, KV slots
tools/pty-drive.mjs  drives the surface on a real pty for testing
tools/transcript.mjs renders a pty capture the way a terminal would show it
```

## Install

The package is a profile bundle. A profile directory names it in `dsh.profile.bundles`, and the module must resolve from that directory:

```sh
mkdir -p ~/.dsh/profiles/agent/node_modules
ln -s /path/to/dsh-agent ~/.dsh/profiles/agent/node_modules/dsh-agent
cat > ~/.dsh/profiles/agent/package.json <<'JSON'
{
  "name": "dsh-profile-agent",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-agent"] } }
}
JSON
```

`dsh-agent/node_modules` is a symlink to `$DSH_HOME/profiles/node_modules`, the launcher-maintained flat fallback, so this package resolves `@deepseek-ai/*` and `commander` from the same installation the rest of the tree uses — one cordis instance, no duplicate services.

## This install

- Profile: `~/.dsh/profiles/agent` (bundles `@deepseek-ai/dsh-base` + `dsh-agent`), with `dsh-agent` symlinked into its `node_modules`.
- Launchers: `~/.local/bin/dsh` and `~/.local/bin/dsh-agent` (the latter is `dsh-agent`).
- The profile's own patch layer disables `session-title-llm`: this box serves one model at a time through llama-swap, so a second titling request would queue ahead of the turn being waited on. The heuristic titler still names sessions from the first prompt.
- `bubblewrap` is installed, and `/etc/apparmor.d/bwrap` grants it the unprivileged user namespaces Ubuntu 24.04 denies by default (`kernel.apparmor_restrict_unprivileged_userns=1`). Without that profile every `bash` call under `workspace-write` was denied and the agent had to ask to escalate. Delete the file and reload apparmor to revert.
- Prompt history lives in `~/.dsh/agent-history`.
- The profile layer also sets `compaction-basic.thresholdRatio: 0.9`, so automatic compaction fires at 90% of the routed model's context window instead of the shipped 80%. Auto-compaction itself is a base-composition feature (`auto` defaults to true), not something this surface implements — it just moves the trigger and renders the `compaction/*` events as notices.

## Keys

The composer is a real editor: `lib/keys.js` owns stdin for the process and decodes it, and `lib/editor.js` draws and repaints its own block. Nothing is created or destroyed per submission, which is what keeps a fast paste intact.

| Key | Effect |
|---|---|
| `enter` | send |
| `ctrl+j` / `alt+enter` | newline |
| paste | a multi-line paste arrives as one prompt, via bracketed paste — it never submits on the first newline |
| `tab` | complete a `/command` or an `@path` |
| `ctrl+o` | reopen the last tool result in full |
| `esc` | clear the prompt, or interrupt a running turn |
| `ctrl+a` `ctrl+e` `ctrl+u` `ctrl+k` `ctrl+w` | line start, line end, kill back, kill forward, kill word |
| `up` / `down` | history, or move between lines of a multi-line prompt |
| typing during a turn | queued as the next prompt (`agent.followup`), shown on the status line |
| `ctrl+c` twice when idle, `ctrl+d` | exit |
| digits, `j`/`k`, arrows | move in a menu |

## Commands

`/help` lists both halves: the surface's own commands (`/model`, `/status`, `/tools`, `/export`, `/jobs`, `/clear`, `/resume`, `/thinking`, `/think`, `/backend`, `/cache`, `/verbose`, `/exit`) and everything the composition registered on `ctx.commands` (`/compact`, `/plan`, `/goal`, `/feedback`, `/permission`, …). Unknown slash lines go to the registry and report its error rather than reaching the model.

### Local-model commands

These three exist because a local backend exposes things a hosted API does not.

`/think off|low|medium|high` sets reasoning effort **for the next message only**. llama.cpp ignores the wire `reasoning_effort` field entirely — verified by sending `xhigh` and `none` to an entry pinned at `low` and getting `low` behaviour both times — so effort is otherwise fixed per llama-swap entry and changing it means editing YAML and reloading the model. The Sharp chat template instead scans every system and user message for literal `<|think_off|>` / `<|think_low|>` / `<|think_medium|>` / `<|think_xhigh|>` markers, so this command prepends one and disarms itself. Measured end to end: `off` yields 0 reasoning characters, `xhigh` yields ~127 on the same prompt, both answering correctly. The armed level shows in the composer hint, since the marker is otherwise invisible.

`/backend` reports what the OpenAI route cannot carry: speculative-decode efficiency, decode and prefill throughput, and totals served since the model loaded. The drafting figure is `tokens_predicted_total / n_decode_total` — llama.cpp counts one decode step per forward pass but counts every token the MTP draft head got accepted, so their ratio is how many tokens each pass actually yielded. 1.0 means drafting contributes nothing; the ceiling is `--spec-draft-n-max` plus one.

`/cache save|restore [name]` saves or restores the backend KV slot through `--slot-save-path`. Deliberately manual: measured at ~100 KB per cached token on this deployment, so a 25k-token conversation is ~2.5 GB and a full 229k context is ~23 GB. An automatic per-turn save would write far more than it ever saves. Restoring a prefix that no longer matches costs an ordinary prefill, so the failure mode is lost time, never a wrong answer.

`/export [path]` writes the transcript as markdown (the harness's own exporter is a browser-only feature). `/jobs` lists what this session left running through `ctx.jobs` — the background `bash` work the model started.

## Look

The animations are **monochrome ASCII**. Their form comes from character density, and colour competes with that reading rather than adding to it — so the art spends nothing on hue and everything on ink coverage. What colour remains in the surface is semantic: the context gauge still turns amber and red at the compaction thresholds, because that reading changes what happens next.

Only the *crests* take colour. Below a high threshold the art is pure grey; above it the tone blends toward a pale cyan-white in proportion to how far past the floor it sits (`heat()`). Real caustics are not uniformly white — the lines where light concentrates read cooler and brighter than the wash around them — and confining the tint to those keeps the art **lit** rather than **coloured**, which is what the grey discipline was protecting.

Density alone is coarse, though: a usable ramp has about a dozen steps, which is not enough for a smooth gradient. Every glyph is therefore also **shaded across the greys** (`mono()` — a true grey at truecolor, the 24-step grey rail 232-255 at 256 colours, bold-vs-normal below that). Character shape carries the structure; brightness carries the gradient. The two together give far more tonal range than either alone.

The ramp itself is short by design — `` .`:;+*oOX#@`` — because ramps with dozens of glyphs look smooth in a proportional preview and turn to noise in a monospace cell, where neighbouring characters differ by less than the eye resolves.

Startup is **caustics** — light refracting through a moving surface, computed per pixel and drawn one ASCII glyph per cell. Four wave terms are summed and measured by how close the result sits to *zero*, not by its height: light concentrates where the contributing waves cancel, and raising that to a power thins the cancellation lines into filaments. Reading the crests instead gives smooth blobs, which is what a water surface looks like from above rather than what its light does below.

The wordmark is **etched** rather than drawn: its cells are lifted up the same scale, lit by the same light, so the caustics keep playing across the letters. A gamma lift sits before the ramp lookup, because caustic intensity is dominated by near-zero values — most of a lit surface is shadow between filaments — and mapping it linearly spends almost the whole ramp on the dark end.

A character cell is about twice as tall as it is wide, so the vertical span is halved on top of the grid ratio; without that the filaments come out stretched down the screen.

A **vignette** falls off toward the frame's edges. Without it the field meets the terminal in a hard rectangle and reads as a texture pasted into the window; with it the frame has a centre, and the wordmark sits in the brightest part of it rather than merely the middle of it.

The wordmark the sequence leaves behind is **lit by the same field**, as is the line printed when the session closes. The caustics fading to nothing and a plain line appearing where they were would break the continuity the whole sequence just established; lighting it means the field settles into the line rather than ending before it.

`lib/theme.js` owns every color the surface emits: one warm accent, one muted gray, and semantic roles (`success`, `danger`, `warning`, `token`, `thought`, `line`) that call sites reach for instead of naming colors. Depth is detected once — truecolor when the terminal advertises it, xterm-256 otherwise, basic SGR below that, and nothing at all when output is piped or `NO_COLOR` is set — so each role degrades instead of disappearing.

The chrome is three panels sharing one width (`chromeWidth()`, the terminal minus a column, capped at 120): the welcome banner, the composer, and menu cards. The prompt caret **breathes while the composer is empty and settles the moment there is text** — a pulsing mark is an invitation when the surface is waiting for you, and a distraction once you are the one writing. It breathes up out of the greys into the same cyan-white the crests take.

The composer's **lower edge carries drifting light** — the same caustic field the session opened with, sampled at a slowly advancing phase. Between turns nothing else on screen moves, and a completely still surface reads as a program that has stopped rather than one that is waiting. It drifts at 220ms per step on purpose: the ambient clock repaints the same block typing does, so a fast one would compete with input and turn a keystroke burst into flicker. The top rule stays dark, because a lit edge *under* the text reads as the surface being lit from below rather than as a decorated frame around it.

A multi-line tool result gets a **lit margin** down its left edge. It does two jobs: it groups the block, so a long result reads as one object rather than loose lines under a mark, and it carries the same light into the transcript. Each block samples the field at its own phase, so margins vary across a session — how much one varies within itself depends where its phase falls, exactly as a real surface catches light unevenly.

Tool-kind colours are deliberately left alone. They say what sort of operation ran, and replacing them with light would trade information for decoration.

The composer is a rounded box with a placeholder when empty and a hint row beneath it carrying model, context occupancy, session tokens, and the two keys worth knowing. That hint row replaced the per-turn footer, so the transcript keeps only conversation. On submit the box is erased and replaced by a compact `› prompt` echo. A terminal narrower than 44 columns drops the box and keeps the bare prompt.

Menus — `/model`, `/resume`, approval, `ask_user_question` — render as bordered cards with numbered rows, so a decision reads as a decision rather than as more transcript. They repaint on their own clock as well as on input: a highlight sweeps the top rule and the chosen row's marker breathes. A menu is the one place the surface stops and waits for a person, so it is the one place a still card reads as a hang rather than a pause — but the motion stays in the border, since animating the labels would move the text the reader is choosing between.

The colony **dissolves** rather than cutting when the sequence ends. The block has to be erased before the session prints into it, and going straight from a dense network to bare terminal is the one moment that reads as a glitch rather than an ending. The fade runs on the rendered colour, not the exposure — scaling exposure only walks the palette down to its darkest stop, which is a deep blue rather than the terminal's own background.

### Thinking

Reasoning renders as **thought bubbles**, one per paragraph, with the trailing circles that distinguish a thought balloon from a speech one. They are sized to their own content rather than to the terminal: a thought is an aside, and a full-width panel would give the model's deliberation the same visual weight as its answer.

The tradeoff is real and worth stating. A bubble must be sized before it is drawn, so unlike prose the text cannot be streamed a line at a time — it is held until a paragraph closes, and nothing appears while one is still being written. Two things bound that. A blank line closes a paragraph, and so does a character cap, so a model that never breaks still produces bubbles at a readable rate instead of one wall at the end; the forced cut is taken at the last sentence end so a bubble never ends mid-clause. Throughout, the turn HUD shows a shimmering `Thinking`, so the pause is never silent.

Each bubble's outline is **lit**, sampling the light field at its own phase, so no two carry the same gradient and a transcript of them reads as separately lit objects rather than repeated stamps of one asset. The sample is fixed rather than animated: a bubble is durable transcript, and a rule that kept moving after the thought was finished would pull attention back to text the reader has already passed.

`/thinking` still toggles the whole thing off.

## Rendering

The status line under a running turn pulses through `✻`-family glyphs and reports elapsed time, live tok/s folded from the delta stream, tokens produced, and `esc to interrupt`; anything typed while it runs rides on its tail as the queued next prompt.

Assistant prose is **line-buffered**: a line is styled the moment it completes, which gives correct markdown (headings, lists, inline code, fences) in ordinary scrollback without a repainting full-screen UI. Reasoning streams dimmed under one `✻ Thinking…` header, and `--no-thinking` hides it.

Delegated work is visible: a subagent's tool calls appear as indented `⤷` lines under the delegating call, and the status line names the child's current tool. Its prose stays in its own transcript, where it belongs — the conclusion comes back as the delegating tool's result.

Tool calls render from the tool's own declared intent, never from its name: a terminal card shows `bash(cmd)` with its captured output and exit status, a diff card shows a unified hunk with line numbers and a washed background per side, search cards group matches by file, read cards summarize the window. The `⏺` mark takes its color from the call's declared kind — read blue, edit green, delete red, execute accent — and reasoning streams under a `✻` in its own hue. Results are bounded to 8 lines with a `… +N lines (ctrl+o)` tail; `ctrl+o` reopens the last one in full after the fact, and `--verbose` (or `/verbose`) raises the bound for everything.

## Tests

```sh
node tools/test.mjs            # unit: key decoding, editing, completion, rendering
node tools/test.mjs --pty      # adds end-to-end scenarios on a real pty
node tools/test.mjs --pty --model   # adds scenarios that call the model
```

The harness is pre-release and says its event shapes will change, so the suite pins the parts that would otherwise break silently: the payload shapes this surface reads (`user/message` IS the message, `assistant/message` wraps one), the presenter contract, and the input decoding. Run it after pulling the harness.

## Known limitations

- **Scrollback is append-only.** A pending tool card cannot be rewritten in place when its result lands, so a call and its result are two blocks rather than one card that fills in. `ctrl+o` appends a full result rather than expanding the original in place.
- **`@path` inserts a reference, not the file.** The model reads the path with its own tools; nothing is attached to the message.
- **No mouse, and no in-editor syntax highlighting.**
- **One agent per process.** `/clear` and `/resume` dispose the live agent and start another; there is no session multiplexing, and subagent work is visible only through its parent's tool results.
- **Approval grants are per tool name for the session.** "Allow every X call" is this surface's own memory, because the approval vocabulary has only `allowed-once`; it is not persisted and not scoped to arguments.
- **No image input.** Attachments exist in the harness but there is no terminal affordance for them here.

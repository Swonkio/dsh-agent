# dsh kit

A terminal surface and four plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**This is not a standalone program.** `dsh-tui` is a Cordis plugin bundle: it needs the harness to host it and a model endpoint to talk to. The kit is the part that is mine to share; the harness and the model are separate downloads.

## What's in it

| package | what it does | needs |
|---|---|---|
| `dsh-tui` | the terminal surface — transcript, composer, live HUD, ASCII animations | — |
| `dsh-web-readable` | article extraction before markdown conversion; cuts a typical page from ~21k tokens to ~4k | npm deps |
| `dsh-web-searxng` | web search through a self-hosted SearXNG | a SearXNG instance |
| `dsh-memory` | a `remember` tool that writes project notes to `QWEN.md` | — |
| `dsh-computer-use` | drives a VirtualBox VM: keys, clicks, scroll, drag, OCR-based `find` | VirtualBox, `tesseract-ocr` |

The last one is optional and machine-specific — the template config has it commented out.

## Prerequisites

1. **Node 22.19+ or 24+**
2. **A built deepseek-harness checkout** (MIT). Clone it and follow its own build steps; `pnpm install && pnpm run build`.
3. **An OpenAI-compatible endpoint.** Anything that speaks `/v1/chat/completions` works — llama.cpp's `llama-server`, llama-swap, vLLM, or a hosted API.

## Install

One line, if you already have a built harness:

```sh
DSH_HARNESS=/path/to/deepseek-harness \
  curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/bootstrap.sh | sh
```

Or let it clone and build the harness for you (large download, slow build, needs `pnpm`):

```sh
DSH_BUILD=1 curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/bootstrap.sh | sh
```

From a clone instead:

```sh
git clone https://github.com/OWNER/REPO && cd REPO
DSH_HARNESS=/path/to/deepseek-harness ./install.sh
```

The bootstrap never reads stdin — piped to `sh`, stdin *is* the script — so every option is an environment variable: `DSH_HARNESS`, `DSH_BUILD`, `DSH_REPO`, `DSH_REF`, `DSH_PREFIX`.

Then point the harness at your model. In `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    local:
      displayName: local
      api: openai-completions
      baseURL: http://127.0.0.1:8080/v1
      apiKeyEnv: LOCAL_API_KEY      # may be unset for a local server
      models:
        - id: your-model-id          # must match what your server reports
          name: Your Model
          contextWindow: 131072      # match your server's -c exactly
          maxTokens: 32768

agent-default-model:
  provider: local
  model: your-model-id
```

Edit `~/.dsh/profiles/tui/cordis.patch.yml` (the installer copies a template), then run `dsh-tui`.

## Notes worth knowing

**Context window must match your server.** `contextWindow` is what the compaction threshold is a percentage *of*. Setting it higher than the server's real `-c` means compaction fires after the server has already truncated.

**The single-slot rule.** If your backend serves one request at a time, a second concurrent request does not run alongside your turn — it queues *ahead* of it. That is why `session-title-llm` is disabled in the template, and why subagent/workflow tools are a poor fit on such a backend.

**Reasoning effort.** `/think off|low|medium|high` sets it per message. This only does something if your chat template reads `<|think_*|>` markers from message text — llama.cpp ignores the wire `reasoning_effort` field, so a server-side pin is otherwise the only control.

**`/backend` and the draft dial** read llama-swap's control plane on `:8080`. On any other backend they simply show nothing.

## Credits

Built on [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © DeepSeek). Article extraction uses Mozilla Readability; the terminal traces use Braille cells; the boot sequence is a caustic light simulation rendered as ASCII.

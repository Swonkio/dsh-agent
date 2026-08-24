# dsh kit

A terminal surface and four plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**This is not a standalone program.** `dsh-agent` is a Cordis plugin bundle: it needs the harness to host it and a model endpoint to talk to. The kit is the part that is mine to share; the harness and the model are separate downloads.

## What's in it

| package | what it does | needs |
|---|---|---|
| `dsh-agent` | the terminal surface — transcript, composer, live HUD, ASCII animations | — |
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
  curl -fsSL https://raw.githubusercontent.com/Swonkio/dsh-kit/main/bootstrap.sh | sh
```

Or let it clone and build the harness for you (large download, slow build, needs `pnpm`):

```sh
DSH_BUILD=1 curl -fsSL https://raw.githubusercontent.com/Swonkio/dsh-kit/main/bootstrap.sh | sh
```

From a clone instead:

```sh
git clone https://github.com/Swonkio/dsh-kit && cd dsh-kit
DSH_HARNESS=/path/to/deepseek-harness ./install.sh
```

The bootstrap never reads stdin — piped to `sh`, stdin *is* the script — so every option is an environment variable: `DSH_HARNESS`, `DSH_BUILD`, `DSH_REPO`, `DSH_REF`, `DSH_PREFIX`.

Then point the harness at your models. Copy [`settings.example.yaml`](settings.example.yaml) to `~/.dsh/settings.yaml` and edit it:

```sh
cp settings.example.yaml ~/.dsh/settings.yaml
```

It configures three providers side by side — a local server, OpenRouter, and z.ai's GLM coding plan — all reachable from `/model` at runtime. **No key is ever written into that file**: `apiKeyEnv` names an environment variable and the harness reads the value from your environment, so export them from your shell profile instead.

Keeping a local model as `agent-default-model` means nothing leaves your machine unless you pick a hosted model deliberately.

Edit `~/.dsh/profiles/agent/cordis.patch.yml` (the installer copies a template), then run `dsh-agent`.

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

## Notes worth knowing

**Context window must match your server.** `contextWindow` is what the compaction threshold is a percentage *of*. Setting it higher than the server's real `-c` means compaction fires after the server has already truncated.

**The single-slot rule.** If your backend serves one request at a time, a second concurrent request does not run alongside your turn — it queues *ahead* of it. That is why `session-title-llm` is disabled in the template, and why subagent/workflow tools are a poor fit on such a backend.

**Reasoning effort.** `/think off|low|medium|high` sets it per message. This only does something if your chat template reads `<|think_*|>` markers from message text — llama.cpp ignores the wire `reasoning_effort` field, so a server-side pin is otherwise the only control.

**`/backend` and the draft dial** read llama-swap's control plane on `:8080`. On any other backend they simply show nothing.

## Credits

Built on [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, © DeepSeek).

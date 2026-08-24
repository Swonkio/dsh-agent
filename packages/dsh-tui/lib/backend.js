/**
 * Introspection for the local llama-swap / llama.cpp backend.
 *
 * The OpenAI-compatible route dsh talks to reports nothing about how the model
 * is actually running: the per-request `timings` object is dropped by the
 * adapter, and cumulative counters live on the upstream llama-server rather
 * than on llama-swap's proxy port. This module reaches the upstream directly
 * so the surface can show what a LOCAL model makes observable and a hosted API
 * never would — speculative-decode efficiency, KV cache pressure, and the
 * actual prefill/decode split.
 *
 * Every call is best-effort: a remote provider, a stopped backend, or a build
 * without `--metrics` yields undefined rather than an error, because none of
 * this is load-bearing for a conversation.
 * @module dsh-tui/backend
 */

/** Where llama-swap's control plane listens, unless the environment moves it. */
const SWAP_URL = process.env.DSH_TUI_SWAP_URL ?? 'http://127.0.0.1:8080'

/** Introspection must never delay a turn; every request fails fast instead. */
const TIMEOUT_MS = 1500

/** Cached upstream base URL, and the model it was resolved for. */
let discovered

/**
 * Fetch JSON or text with a hard deadline, resolving undefined on any failure.
 * @param {string} url - the absolute URL to read.
 * @param {'json' | 'text'} as - how to decode a 2xx body.
 * @param {object} [init] - additional fetch options (method, body, headers).
 * @returns {Promise<any | undefined>} the decoded body, or undefined.
 */
async function attempt(url, as, init) {
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, signal: abort.signal })
    if (!response.ok) return undefined
    return as === 'json' ? await response.json() : await response.text()
  } catch {
    // A missing, slow, or non-local backend is the normal case on a remote
    // route; introspection is decoration and never surfaces its own failure.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve the upstream llama-server base URL for the currently loaded model.
 * llama-swap assigns the port per launch, so this is re-read whenever the
 * running model changes.
 * @returns {Promise<{ base: string, model: string } | undefined>} the upstream, or undefined.
 */
export async function upstream() {
  const running = await attempt(`${SWAP_URL}/running`, 'json')
  const entry = running?.running?.find(row => row.state === 'ready')
  if (entry === undefined) return undefined
  const port = /--port (\d+)/.exec(entry.cmd ?? '')?.[1]
  if (port === undefined) return undefined
  if (discovered?.model !== entry.model) discovered = { base: `http://127.0.0.1:${port}`, model: entry.model }
  return discovered
}

/**
 * Parse llama.cpp's Prometheus exposition into a plain numeric map.
 * @param {string} body - the raw /metrics text.
 * @returns {Record<string, number>} metric name (without the `llamacpp:` prefix) to value.
 */
function parseMetrics(body) {
  const out = {}
  for (const line of body.split('\n')) {
    const match = /^llamacpp:(\w+) ([\d.eE+-]+)$/.exec(line)
    if (match !== null) out[match[1]] = Number(match[2])
  }
  return out
}

/**
 * Read the backend's cumulative counters and derive the figures worth showing.
 *
 * `tokensPerStep` is the speculative-decode payoff: llama.cpp counts one
 * decode step per forward pass but counts every token the MTP draft head got
 * accepted, so their ratio is how many tokens each pass actually yielded.
 * 1.0 means drafting is contributing nothing; the ceiling is
 * `--spec-draft-n-max + 1`. It is cumulative for the life of the loaded model,
 * which is why it is reported as a backend property rather than a turn stat.
 * @returns {Promise<object | undefined>} derived backend figures, or undefined.
 */
export async function stats() {
  const up = await upstream()
  if (up === undefined) return undefined
  const body = await attempt(`${up.base}/metrics`, 'text')
  if (typeof body !== 'string') return undefined
  const m = parseMetrics(body)
  const steps = m.n_decode_total ?? 0
  const predicted = m.tokens_predicted_total ?? 0
  return {
    model: up.model,
    tokensPerStep: steps > 0 ? predicted / steps : undefined,
    decodePerSecond: m.predicted_tokens_seconds,
    prefillPerSecond: m.prompt_tokens_seconds,
    kvRatio: m.kv_cache_usage_ratio,
    predictedTotal: predicted,
    promptTotal: m.prompt_tokens_total ?? 0,
    busy: (m.requests_processing ?? 0) > 0,
  }
}

/**
 * Save or restore the backend's KV cache slot to `--slot-save-path`.
 *
 * Measured on this deployment at ~100 KB per cached token, so a full 229k
 * context is ~23 GB: this is deliberately manual rather than automatic on
 * every turn. Restoring only helps when the saved prefix still matches the
 * conversation; a mismatch costs a normal prefill, never a wrong answer.
 * @param {'save' | 'restore'} action - which slot operation to run.
 * @param {string} filename - the slot file, relative to the backend's save path.
 * @returns {Promise<object | undefined>} llama.cpp's result, or undefined when unavailable.
 */
export async function slot(action, filename) {
  const up = await upstream()
  if (up === undefined) return undefined
  return attempt(`${up.base}/slots/0?action=${action}`, 'json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename }),
  })
}

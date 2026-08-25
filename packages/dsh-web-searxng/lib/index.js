/**
 * dsh-web-searxng — a `WebSearchProvider` backed by a local SearXNG instance.
 *
 * SearXNG is a self-hosted metasearch front end: it forwards a query to real
 * engines (Google, DuckDuckGo, Brave, …) and returns merged results as JSON.
 * That makes it the fastest free option for an agent — no API key, no quota,
 * and the only hop the harness pays is to loopback; the rest is SearXNG's own
 * upstream fan-out, which it parallelizes.
 *
 * The provider owns retrieval and normalization only. `dsh-tool-web` owns the
 * model-facing tool, and `ctx.web` owns provider selection — so this plugin is
 * ~1 interface with 3 members, exactly as the seam intends.
 *
 * @module dsh-web-searxng
 */

/** Stable Cordis plugin name. */
export const name = 'web-search-searxng'

/** The seam this provider registers into. */
export const inject = ['web']

/** Default endpoint: the container published on loopback. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8888'

/** How long to wait on the metasearch before giving up. */
const DEFAULT_TIMEOUT_MS = 15000

/** Results requested when the caller does not say. */
const DEFAULT_MAX_RESULTS = 10

/** Trim a provider string to something a prompt can afford. */
function bounded(value, limit) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

/** Normalize one SearXNG result into the seam's `WebSearchSource`. */
function toSource(result) {
  const url = typeof result?.url === 'string' ? result.url.trim() : ''
  if (url === '') return undefined
  return {
    url,
    ...bounded(result.title, 300) === undefined ? {} : { title: bounded(result.title, 300) },
    ...bounded(result.content, 1200) === undefined ? {} : { snippet: bounded(result.content, 1200) },
    // SearXNG reports `publishedDate` as ISO-8601 when the engine supplied one.
    ...typeof result.publishedDate === 'string' && result.publishedDate !== ''
      ? { publishedAt: result.publishedDate }
      : {},
  }
}

/** A `WebSearchProvider` over one SearXNG endpoint. */
class SearxngSearchProvider {
  constructor(options) {
    this.id = 'searxng'
    this.options = options
  }

  /**
   * Cheap local usability check — no network, per the seam's contract. A
   * parseable base URL is all this provider needs; whether the instance is up
   * is discovered by executing, which is what the error taxonomy is for.
   */
  available() {
    try {
      const url = new URL(this.options.baseUrl)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  /**
   * Run one search.
   * @param request - `{ query, maxResults? }` from the seam.
   * @param signal - caller cancellation; composed with our own timeout.
   */
  async search(request, signal) {
    const query = typeof request?.query === 'string' ? request.query.trim() : ''
    if (query === '') return { sources: [], truncated: false }

    const url = new URL('/search', this.options.baseUrl)
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    if (this.options.language !== undefined) url.searchParams.set('language', this.options.language)
    if (this.options.engines !== undefined) url.searchParams.set('engines', this.options.engines)

    // The caller's signal and the provider's own deadline both have to abort
    // the same fetch; AbortSignal.any composes them without leaking a timer.
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const composed = signal === undefined ? timeout : AbortSignal.any([signal, timeout])

    const response = await fetch(url, {
      signal: composed,
      headers: { accept: 'application/json', 'user-agent': 'dsh-web-searxng' },
    })
    if (!response.ok) {
      throw new Error(`searxng returned HTTP ${response.status} (is the JSON format enabled in settings.yml?)`)
    }
    const body = await response.json()

    const limit = Math.max(1, request?.maxResults ?? this.options.maxResults)
    const all = Array.isArray(body?.results) ? body.results : []
    const sources = []
    for (const result of all) {
      const source = toSource(result)
      if (source !== undefined) sources.push(source)
      if (sources.length >= limit) break
    }

    // SearXNG's `answers` are direct answers (calculators, definitions,
    // infoboxes) — worth surfacing as the result's prose when present.
    const answers = Array.isArray(body?.answers)
      ? body.answers.map(answer => (typeof answer === 'string' ? answer : answer?.answer)).filter(Boolean)
      : []
    const content = bounded(answers.join('\n'), 2000)

    return {
      ...content === undefined ? {} : { content },
      sources,
      truncated: all.length > sources.length,
    }
  }
}

/**
 * Mount the provider.
 * @param ctx - plugin context carrying `ctx.web`.
 * @param config - `{ baseUrl?, timeoutMs?, maxResults?, language?, engines? }`.
 */
export function apply(ctx, config = {}) {
  const options = {
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResults: config.maxResults ?? DEFAULT_MAX_RESULTS,
    language: config.language,
    engines: config.engines,
  }
  ctx.web.registerSearchProvider(new SearxngSearchProvider(options))
}

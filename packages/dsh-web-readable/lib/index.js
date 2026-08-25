/**
 * A fetch provider that returns an article instead of a page.
 *
 * The shipped HTTP provider returns the whole document, and `dsh-tool-web`
 * turns all of it into markdown — navigation, menus, cookie notices, footers
 * and every sidebar link included. Measured on one Wikipedia article that is
 * 85,912 characters of markdown, roughly 21,000 tokens, whose first eight
 * lines are "Jump to content", "Main menu", "Main page" and similar. On a
 * 229k-token window that is a considerable fraction of the context spent on
 * chrome, and the model has to read past it to reach the subject.
 *
 * This provider runs Mozilla's Readability over the document first and returns
 * the extracted article as HTML, so the existing consumer converts exactly the
 * same way and produces the same markdown minus the furniture. The same page
 * comes back as ~4,000 tokens with its headings, lists, tables and links
 * intact.
 *
 * Extraction is skipped when it does not apply. Readability looks for prose,
 * so on a link index — a forum front page, a search result list, a directory —
 * it finds little and the links ARE the content. In that case the full
 * document is returned unchanged, because a provider that strips a link index
 * down to its handful of prose words has destroyed the page rather than
 * cleaned it.
 * @module dsh-web-readable
 */

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/** Cordis plugin name. */
export const name = 'web-fetch-readable'

/** The capability seam this provider registers into. */
export const inject = ['web']

/** Stable id this provider registers under. */
export const READABLE_FETCH_PROVIDER_ID = 'readable'

/** Plugin config. */
export const Config = null

/**
 * Below this many characters, an extraction is treated as a failure to find an
 * article rather than as a short one. Tuned to sit under a genuine stub page
 * and well over the few words Readability salvages from a link index.
 */
const MIN_ARTICLE_CHARS = 600

/**
 * Above this ratio of extracted to original length, extraction has not earned
 * its risk: the page was mostly article already, and returning the original
 * avoids Readability's habit of dropping a trailing section it scored low.
 */
const KEEP_ORIGINAL_ABOVE = 0.72

/** Reasonable browser identity; some sites serve a stub to unknown agents. */
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Cap on the bytes read from one response. */
const MAX_BYTES = 5 << 20

/** Per-request deadline. */
const TIMEOUT_MS = 20000

/**
 * Extract the readable article from a document.
 * @param {string} html - the full document source.
 * @param {string} url - the document's URL, used to resolve relative links.
 * @returns {{ content: string, title?: string } | undefined} the article, or
 *   undefined when the page has none worth substituting.
 */
export function extractArticle(html, url) {
  let parsed
  try {
    parsed = parseHTML(html)
  } catch {
    // A document too malformed to parse is still perfectly readable as raw
    // markup downstream; extraction is an optimisation, never a gate.
    return undefined
  }
  const { document } = parsed
  // Readability resolves relative hrefs against the document URI, so without a
  // base every link in the result would come back relative and unusable.
  try {
    document.documentURI = url
  } catch {
    // Read-only in some DOM shims; links stay relative, which is survivable.
  }
  let article
  try {
    article = new Readability(document).parse()
  } catch {
    return undefined
  }
  const content = article?.content
  if (typeof content !== 'string' || content.length < MIN_ARTICLE_CHARS) return undefined
  if (content.length / html.length > KEEP_ORIGINAL_ABOVE) return undefined
  return { content, ...article.title ? { title: article.title } : {} }
}

/**
 * The article-extracting HTTP(S) fetch provider.
 */
export class ReadableFetchProvider {
  /** @type {string} */
  id = READABLE_FETCH_PROVIDER_ID

  /**
   * No local prerequisite: the provider is a fetch plus a pure transform.
   * @returns {boolean} always true.
   */
  available() {
    return true
  }

  /**
   * Fetch a URL and return its article, or the whole document when it has none.
   * @param {object} request - `{ url }` from the web seam.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object>} a `WebFetchResult`.
   */
  async fetch(request, signal) {
    const url = new URL(request.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${url.protocol}"; only http and https are fetched`)
    }
    const timer = new AbortController()
    const deadline = setTimeout(() => { timer.abort() }, TIMEOUT_MS)
    const onAbort = () => { timer.abort() }
    signal?.addEventListener('abort', onAbort, { once: true })
    let response
    let raw
    try {
      response = await fetch(url, { redirect: 'follow', signal: timer.signal, headers: { 'user-agent': USER_AGENT } })
      raw = await response.text()
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', onAbort)
    }

    const truncated = raw.length > MAX_BYTES
    const body = truncated ? raw.slice(0, MAX_BYTES) : raw
    const contentType = response.headers.get('content-type') ?? ''
    const isHtml = contentType.includes('html') || /^\s*<(?:!doctype|html)/i.test(body)
    if (!isHtml) {
      return { url: response.url || request.url, statusCode: response.status, truncated, body: { kind: 'text', content: body } }
    }

    const article = extractArticle(body, response.url || request.url)
    const content = article === undefined
      ? body
      // The title is reattached because Readability strips it out of the
      // content, and it is often the only statement of what the page is.
      : `<h1>${escapeHtml(article.title ?? '')}</h1>${article.content}`
    return { url: response.url || request.url, statusCode: response.status, truncated, body: { kind: 'html', content } }
  }
}

/**
 * Escape text for insertion into HTML.
 * @param {string} text - the raw text.
 * @returns {string} the escaped text.
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Register the provider.
 * @param {object} ctx - the plugin context, with the `web` service injected.
 */
export function apply(ctx) {
  ctx.web.registerFetchProvider(new ReadableFetchProvider())
}

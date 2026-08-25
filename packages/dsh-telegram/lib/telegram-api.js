/**
 * The thinnest possible Telegram Bot API client: fetch + the four methods
 * the gateway needs. No dependency, no retry framework — Telegram is
 * eventually consistent and the poll loop's next iteration is the retry.
 *
 * Node's fetch resolves DNS verbatim (IPv6 first here), and this Pi's IPv6
 * egress is unreliable while IPv4 is solid — so IPv4 goes first process-wide
 * for this module, and every call carries a hard timeout: a flaky route must
 * fail in seconds with a network error, not hang a minute and masquerade as
 * a token problem.
 *
 * @module dsh-telegram/lib/telegram-api
 */

import dns from 'node:dns'

dns.setDefaultResultOrder('ipv4first')

/** Base for all Bot API calls. */
const apiBase = (token) => `https://api.telegram.org/bot${token}`

/** Every call gets a bounded lifetime; long-polls override with their own. */
const DEFAULT_TIMEOUT_MS = 30000

/**
 * Call one Bot API method.
 * @param {string} token - the bot token.
 * @param {string} method - Bot API method name.
 * @param {object} [payload] - JSON body.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<object>} the `result` field on success.
 * @throws {Error} with `.network === true` for transport failures, or
 *   Telegram's description when the API answers `ok: false`.
 */
export async function call(token, method, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let response
  try {
    response = await fetch(`${apiBase(token)}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const failure = new Error(`network: could not reach api.telegram.org (${error.cause?.code ?? error.cause?.message ?? error.message})`)
    failure.network = true
    throw failure
  }
  const body = await response.json().catch(() => ({ ok: false, description: `HTTP ${response.status}` }))
  if (body.ok !== true) throw new Error(`telegram ${method}: ${body.description ?? `HTTP ${response.status}`}`)
  return body.result
}

/** Long-poll for updates; `timeout` seconds is the server-side hold. */
export function getUpdates(token, { offset, timeoutSeconds }) {
  return call(token, 'getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message'] }, { timeoutMs: (timeoutSeconds + 10) * 1000 })
}

/** Resolve a file_id to its downloadable path. */
export async function getFile(token, fileId) {
  return await call(token, 'getFile', { file_id: fileId })
}

/** Download a Telegram file (photos, voice notes) as raw bytes. */
export async function downloadFile(token, filePath) {
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`telegram download ${filePath}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Send a text message, split to Telegram's 4096-char hard limit. */
export async function sendMessage(token, chatId, text) {
  const chunks = splitForTelegram(text)
  let last
  for (const chunk of chunks) {
    last = await call(token, 'sendMessage', { chat_id: chatId, text: chunk })
  }
  return last
}

/** Split long agent replies on paragraph/line boundaries under the limit. */
export function splitForTelegram(text, limit = 4096) {
  if (text.length <= limit) return [text]
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const at = cut > limit * 0.5 ? cut : limit
    chunks.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\s+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

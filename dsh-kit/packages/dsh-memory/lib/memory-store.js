/**
 * The user-level memory store: a MEMORY.md index plus one topic file per
 * entry, under `$DSH_HOME/memory/`.
 *
 * The index is the only part injected into every system prompt (capped by the
 * caller), so each line must carry a complete, self-contained fact — a bare
 * keyword that only makes sense next to its topic file helps nobody at prompt
 * time. Topic files hold the detail and are read on demand through the normal
 * fs tools, which is why they can afford a larger cap than the index.
 *
 * Everything here is plain files on purpose, same reasoning as QWEN.md in the
 * `remember` tool: memory an agent writes is only as good as the human's
 * ability to read and correct it.
 *
 * @module dsh-memory/lib/memory-store
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { findConflicts, parseFrontmatter, renderFrontmatter, recordProvenance } from 'dsh-epistemics'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Refuse to grow the index past what could ever be injected usefully. */
export const MAX_INDEX_BYTES = 8192
/** One topic's detail file may be larger than an index line, not unbounded. */
export const MAX_TOPIC_BYTES = 16384

/** Words that carry no distinguishing signal when comparing two facts. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'has', 'have', 'in', 'into', 'is', 'it', 'its', 'no', 'not', 'of', 'on', 'only', 'or', 'so',
  'that', 'the', 'there', 'this', 'to', 'via', 'was', 'with', 'you', 'your',
])

/**
 * Content words of a line, truncated to a 5-character stem.
 *
 * Stemming is what makes lexical comparison survive real paraphrase:
 * inject/injection/injecting all collapse to `injec`. Without it the same fact
 * written two ways scores low and slips through as a new entry.
 */
export function contentWords(line) {
  return new Set(
    line.toLowerCase().replace(/^[-*]\s*/, '').split(/[^a-z0-9]+/)
      .filter(word => word.length > 2 && !STOPWORDS.has(word))
      .map(word => word.slice(0, 5)),
  )
}

/**
 * How much two facts overlap, 0 to 1 — the overlap coefficient, shared words
 * over the SMALLER set. Dividing by the smaller set asks "is one of these
 * essentially contained in the other", which is the right question when a
 * model restates a fact with more explanation than the stored version.
 */
export function similarity(left, right) {
  const a = contentWords(left)
  const b = contentWords(right)
  // Very short facts carry too little signal for containment to mean anything.
  if (a.size < 4 || b.size < 4) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / Math.min(a.size, b.size)
}

/** Above this overlap a new fact counts as the same memory, not a new one. */
export const DUPLICATE_AT = 0.6

/**
 * The topic of an index line (`- Topic: summary`), or undefined for a
 * malformed line.
 */
function lineTopic(line) {
  const match = /^-\s*([^:]+):\s*(.*)$/.exec(line)
  return match === undefined ? undefined : { topic: match[1].trim(), summary: match[2] }
}

/**
 * Find the single index line a substring refers to. Hermes-style matching:
 * a short unique substring is enough; zero matches and ambiguous matches are
 * both errors, ambiguity listing the candidates so the next attempt can be
 * more specific without another tool call.
 */
export async function findLineBySubstring(home, match) {
  const needle = match.trim().toLowerCase()
  const lines = await indexLines(home)
  const hits = lines.filter(line => line.toLowerCase().includes(needle))
  if (hits.length === 0) throw new Error(`no memory matches "${match}"`)
  if (hits.length > 1) throw new Error(`"${match}" matches ${hits.length} memories; be more specific:\n${hits.join('\n')}`)
  return { line: hits[0], lines }
}

/** Render the index document from its lines. */
function renderIndex(lines) {
  return `# Memory index\n\nOne line per topic; detail in topics/<slug>.md. Maintained by memory_save.\n\n${lines.join('\n')}\n`
}

/** Stamp the write clock. */
async function stampWrite(home) {
  await writeFile(join(home, '.last-write'), `${new Date().toISOString()}\n`)
}

/**
 * Remove the memory a substring identifies, along with its topic file.
 * @returns {{ removed: string, topicPath: string | undefined }}
 */
export async function removeFact(home, match) {
  const { line, lines } = await findLineBySubstring(home, match)
  const parsed = lineTopic(line)
  await writeFile(join(home, 'MEMORY.md'), renderIndex(lines.filter(l => l !== line)))
  let topicPath
  if (parsed !== undefined) {
    topicPath = join(home, 'topics', `${slugify(parsed.topic)}.md`)
    await rm(topicPath, { force: true })
  }
  await stampWrite(home)
  return { removed: line, topicPath }
}

/**
 * Rewrite the memory a substring identifies: a new summary for its index
 * line and, optionally, a replacement topic body. The topic keeps its name
 * and position — this is a correction, not a move.
 * @returns {{ line: string, topicPath: string | undefined }}
 */
export async function editFact(home, match, { summary, body }) {
  const { line, lines } = await findLineBySubstring(home, match)
  const parsed = lineTopic(line)
  if (parsed === undefined) throw new Error(`that line has no "Topic: summary" shape to edit: ${line}`)
  if ((summary === undefined || summary.trim() === '') && body === undefined) {
    throw new Error('provide a new summary, a new body, or both')
  }
  const nextSummary = summary === undefined ? parsed.summary : summary.trim().replace(/\s+/g, ' ')
  const threat = scanMemoryText(`${nextSummary}\n${body ?? ''}`)
  if (threat !== undefined) {
    throw new Error(`memory entry rejected by security scan: ${threat}. Memory is replayed into every future system prompt — record the fact without instructions or obfuscation.`)
  }
  const nextLine = `- ${parsed.topic}: ${nextSummary}`
  const rendered = renderIndex(lines.map(l => (l === line ? nextLine : l)))
  if (Buffer.byteLength(rendered) > MAX_INDEX_BYTES) {
    throw new Error(await capacityError(home, rendered, nextLine))
  }
  let topicPath
  if (parsed !== undefined) {
    topicPath = join(home, 'topics', `${slugify(parsed.topic)}.md`)
    if (body !== undefined) {
      const detail = body.trim() === '' ? '' : `${body.trim()}\n`
      if (Buffer.byteLength(detail) > MAX_TOPIC_BYTES) throw new Error(`topic body exceeds ${MAX_TOPIC_BYTES} bytes`)
      if (detail === '') {
        await rm(topicPath, { force: true })
        topicPath = undefined
      } else {
        await mkdir(join(home, 'topics'), { recursive: true })
        await writeFile(topicPath, `# ${parsed.topic}\n\n${detail}`)
      }
    }
  }
  await writeFile(join(home, 'MEMORY.md'), rendered)
  await stampWrite(home)
  return { line: nextLine, topicPath }
}

/**
 * The capacity error Hermes made load-bearing: not a bare "too big", but the
 * current entries, the usage, and the consolidation instruction — everything
 * the model needs to make room in this same turn.
 */
export async function capacityError(home, nextRendered, attemptedLine) {
  const bytes = Buffer.byteLength(nextRendered)
  const entries = (await indexLines(home)).join('\n')
  return `Memory at ${bytes}/${MAX_INDEX_BYTES} bytes. Adding "${attemptedLine}" would exceed the limit. Consolidate now: use memory_edit to merge overlapping entries into shorter ones, or memory_forget stale or less important entries (current entries below), then retry — all in this turn.\n\n${entries}`
}

/**
 * One usage header line, Hermes-style, so both the prompt and /memory show
 * how much room is left before writes start failing.
 */
export async function usageHeader(home) {
  const bytes = Buffer.byteLength(await indexText(home))
  const percent = Math.round((bytes / MAX_INDEX_BYTES) * 100)
  return `[${percent}% — ${bytes}/${MAX_INDEX_BYTES} chars]`
}

/**
 * Content-based rejections for text that will be replayed into future system
 * prompts. Memory is an injection surface with a long lifetime: an entry
 * reading "ignore previous instructions" or pointing at the credential store
 * would ride every session until someone reads the file by hand, so the
 * patterns are heuristic but the stance is refuse-first.
 */
const THREAT_PATTERNS = [
  ['injection', /(ignore|disregard|forget|override|bypass)\s+(all\s+)?(previous|prior|above|earlier|system|developer|these)\s+(instruction|prompt|rule|message|direction)/i],
  ['prompt-override', /(you are now|act as|new instructions:|system:)/i],
  ['credential-exfiltration', /(send|post|upload|curl|wget|fetch|email|exfiltrate)[^\n]{0,60}(api[_ -]?key|token|secret|credential|password|\.env\b|id_rsa|\.ssh|authorized_keys)/i],
  ['environment-exfiltration', /\b(env|printenv|cat\s+~?\/\.(env|bashrc|profile)|history)\b[^\n]{0,80}\b(curl|wget|nc|netcat|ssh|scp|http)/i],
  ['backdoor', /(authorized_keys|\/etc\/sudoers|adduser[^\n]{0,30}sudo|crontab[^\n]{0,30}(curl|wget|http))/i],
]

/** Invisible and directional-override codepoints a fact has no honest use for. */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u

/**
 * Scan text destined for memory or skills; return a rejection reason or
 * undefined when the text passes.
 */
export function scanMemoryText(text) {
  if (INVISIBLE.test(text)) return 'invisible or bidi-override Unicode characters'
  for (const [name, pattern] of THREAT_PATTERNS) {
    if (pattern.test(text)) return `${name} pattern ("${pattern.source.slice(0, 60)}…")`
  }
  return undefined
}

/** Kebab-case slug for a topic title. */
function slugify(topic) {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Parse the index into its lines, or an empty list when absent. */
export async function indexLines(home) {
  let text = ''
  try {
    text = await readFile(join(home, 'MEMORY.md'), 'utf8')
  } catch {
    // No memories yet.
  }
  return text.split('\n').filter(line => line.startsWith('- '))
}

/** The raw index text, for prompt injection. */
export async function indexText(home) {
  try {
    return await readFile(join(home, 'MEMORY.md'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Synchronous index read. Prompt-section text functions run synchronously
 * during assembly, and re-reading a kilobyte-scale file there is cheaper than
 * any cache that could go stale after a `memory_save`.
 */
export function indexTextSync(home) {
  try {
    return readFileSync(join(home, 'MEMORY.md'), 'utf8')
  } catch {
    return ''
  }
}

/** Synchronous variant of {@link lastWriteMs}, for the same reason. */
export function lastWriteMsSync(home) {
  try {
    return statSync(join(home, '.last-write')).mtimeMs
  } catch {
    return 0
  }
}

/** mtime of the last successful write, in ms since the epoch; 0 when never. */
export async function lastWriteMs(home) {
  try {
    return (await stat(join(home, '.last-write'))).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Record one fact: a summary line in the index, detail in a topic file.
 *
 * Saving to a topic that already exists REPLACES its entry — a topic is one
 * canonical fact with optional detail, not an append log, so corrections
 * overwrite and the store never grows two versions of the same thing.
 *
 * @param {string} home - the memory directory (`$DSH_HOME/memory`).
 * @param {{ topic: string, summary: string, body?: string }} fact
 * @returns {{ indexPath: string, topicPath: string, status: 'recorded'|'updated'|'already known', bytes: number }}
 */
export async function saveFact(home, { topic, summary, body, confidence }) {
  const title = topic.trim().replace(/\s+/g, ' ')
  const line = `- ${title}: ${summary.trim().replace(/\s+/g, ' ')}`
  if (title === '' || summary.trim() === '') throw new Error('topic and summary must not be empty')
  const threat = scanMemoryText(`${title}\n${summary}\n${body ?? ''}`)
  if (threat !== undefined) {
    throw new Error(`memory entry rejected by security scan: ${threat}. Memory is replayed into every future system prompt — record the fact without instructions or obfuscation.`)
  }
  const slug = slugify(title)
  if (slug === '') throw new Error(`topic "${title}" has no usable characters for a filename`)

  const lines = await indexLines(home)
  const existing = lines.findIndex(entry => {
    const match = /^-\s*([^:]+):\s*(.*)$/.exec(entry)
    return match !== null && slugify(match[1]) === slug
  })
  // Dedup across topics, not just this one: the same fact under a new name is
  // still the same memory.
  if (existing === -1) {
    const dupe = lines.find(entry => similarity(entry, line) >= DUPLICATE_AT)
    if (dupe !== undefined) {
      return { indexPath: join(home, 'MEMORY.md'), topicPath: join(home, 'topics', `${slug}.md`), status: 'already known', bytes: Buffer.byteLength((await indexText(home))) }
    }
  }

  const updated = existing === -1
    ? [...lines, line]
    : lines.map((entry, index) => (index === existing ? line : entry))
  const rendered = `# Memory index\n\nOne line per topic; detail in topics/<slug>.md. Maintained by memory_save.\n\n${updated.join('\n')}\n`
  if (Buffer.byteLength(rendered) > MAX_INDEX_BYTES) {
    throw new Error(await capacityError(home, rendered, line))
  }

  const detail = body === undefined || body.trim() === '' ? '' : `${body.trim()}\n`
  if (Buffer.byteLength(detail) > MAX_TOPIC_BYTES) throw new Error(`topic body exceeds ${MAX_TOPIC_BYTES} bytes`)

  // Contradiction check, against every line EXCEPT the one being replaced —
  // rewriting a topic is how a fact gets corrected, so its own previous
  // wording must never count as a conflict with itself.
  const others = existing === -1 ? lines : lines.filter((_, index) => index !== existing)
  const conflicts = findConflicts(line, others)

  const topicPath = join(home, 'topics', `${slug}.md`)
  await mkdir(join(home, 'topics'), { recursive: true })

  // Provenance rides in the topic file's frontmatter, never in the index —
  // the index is injected into every prompt and pays for its bytes forever.
  let previousMeta = {}
  try {
    previousMeta = parseFrontmatter(await readFile(topicPath, 'utf8')).meta
  } catch { /* first time this topic is written */ }
  const meta = recordProvenance(previousMeta, { confidence })
  await writeFile(topicPath, renderFrontmatter(meta, `# ${title}\n\n${detail}`))

  await writeFile(join(home, 'MEMORY.md'), rendered)
  await writeFile(join(home, '.last-write'), `${new Date().toISOString()}\n`)
  return {
    indexPath: join(home, 'MEMORY.md'),
    topicPath,
    status: existing === -1 ? 'recorded' : 'updated',
    bytes: Buffer.byteLength(rendered),
    confirmations: meta.confirmations,
    ...(conflicts.length === 0 ? {} : { conflicts }),
  }
}

/**
 * Keyword search over the index lines and topic bodies.
 *
 * Substring plus stem-overlap scoring: at this corpus size (an index capped
 * in kilobytes) there is nothing for FTS to win, and stems keep "llama"
 * matching "llamaserver" the way a model asking about a memory actually
 * phrases it.
 * @returns {Promise<Array<{ topic: string, summary: string, path: string, score: number }>>}
 */
export async function search(home, query, limit = 10) {
  const needles = [...contentWords(query)]
  const raw = query.toLowerCase().trim()
  if (needles.length === 0 && raw === '') return []
  const results = []
  for (const line of await indexLines(home)) {
    const match = /^-\s*([^:]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const [, topic, summary] = match
    const slug = slugify(topic)
    let score = 0
    if (raw !== '' && line.toLowerCase().includes(raw)) score += 2
    const words = contentWords(line)
    for (const needle of needles) if (words.has(needle)) score += 1
    let detail = ''
    try {
      detail = await readFile(join(home, 'topics', `${slug}.md`), 'utf8')
      if (raw !== '' && detail.toLowerCase().includes(raw)) score += 1
      const detailWords = contentWords(detail.slice(0, 4096))
      for (const needle of needles) if (detailWords.has(needle)) score += 0.5
    } catch {
      // Index-only entry; nothing to add.
    }
    if (score > 0) results.push({ topic, summary, path: join(home, 'topics', `${slug}.md`), score })
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * Pick which index lines reach this prompt. Small indexes go in whole; past
 * `allUnder` lines the default model's window cannot afford the full index,
 * so lines score by stem overlap with the conversation's latest user message
 * and the top `topK` travel, backfilled by the most recent lines so recency
 * carries when the signal is weak.
 * @param {string[]} lines - the index's `- ` lines, in stored order.
 * @param {string | undefined} signalText - latest user message text, if any.
 * @param {{ allUnder?: number, topK?: number }} options
 * @returns {{ selected: string[], total: number, mode: 'all' | 'selected' }}
 */
export function selectMemoryLines(lines, signalText, { allUnder = 12, topK = 8 } = {}) {
  if (lines.length <= allUnder) return { selected: lines, total: lines.length, mode: 'all' }
  const chosen = new Map()
  const needles = [...contentWords(signalText ?? '')]
  if (needles.length > 0) {
    const scored = lines
      .map((line, index) => {
        const words = contentWords(line)
        let shared = 0
        for (const needle of needles) if (words.has(needle)) shared += 1
        return { index, line, score: shared / needles.length }
      })
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score)
    for (const entry of scored.slice(0, topK)) chosen.set(entry.index, entry.line)
  }
  for (let i = lines.length - 1; i >= 0 && chosen.size < topK; i--) {
    if (!chosen.has(i)) chosen.set(i, lines[i])
  }
  const selected = [...chosen.entries()].sort((left, right) => left[0] - right[0]).map(([, line]) => line)
  return { selected, total: lines.length, mode: 'selected' }
}

/**
 * Cut text to a byte budget on a line boundary, marking the cut. Used for
 * everything injected into a prompt, where the default model's window is only
 * 8192 tokens and every section must be bounded.
 */
export function truncateForPrompt(text, capBytes) {
  if (Buffer.byteLength(text) <= capBytes) return text
  const marker = '\n…(truncated; full text on disk)'
  // Slice by bytes (a mid-character slice would produce replacement runes),
  // then back up to a line or word boundary so the cut reads as deliberate.
  const room = Math.max(0, capBytes - Buffer.byteLength(marker))
  const cut = Buffer.from(text).subarray(0, room).toString('utf8')
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '))
  return `${(lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()}${marker}`
}

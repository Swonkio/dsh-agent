/**
 * dsh-memory — the `remember` tool, which maintains `QWEN.md`.
 *
 * The READ side already exists: `dsh-agent-instructions` walks the instruction
 * file candidates from the project root down to the working directory and
 * injects them into every session. This package only supplies the write half,
 * so the agent can record what it learned and stop rediscovering it.
 *
 * The file is plain markdown under the user's own project. That is deliberate:
 * memory an agent writes is only as good as the human's ability to read and
 * correct it, and a durable wrong "lesson" is worse than no memory at all.
 *
 * @module dsh-memory
 */

import { readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'tool-remember'

/** The registry this tool registers into. */
export const inject = ['tools']

/** Sections the file is organized into, in the order they are written. */
const SECTIONS = {
  environment: 'Environment facts',
  mistake: 'Mistakes to avoid',
  howto: 'How to do things here',
  preference: 'Preferences',
}

/** Refuse to grow the file past what the instruction loader will read. */
const MAX_BYTES = 60000

/** Walk up from `start` looking for a project root marker. */
async function projectRoot(start, markers) {
  let directory = resolve(start)
  for (;;) {
    for (const marker of markers) {
      try {
        await access(join(directory, marker))
        return directory
      } catch {
        // Not this level; keep walking.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return resolve(start)
    directory = parent
  }
}

/** Split an existing file into its section bodies, preserving unknown text. */
function parseSections(text) {
  const sections = new Map()
  let preamble = ''
  let current
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading !== null) {
      current = heading[1].trim()
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current === undefined) preamble += `${line}\n`
    else sections.get(current).push(line)
  }
  return { preamble, sections }
}

/** Reassemble the file from its parts, trimming runs of blank lines. */
function renderFile(preamble, sections) {
  const parts = [preamble.trim()]
  for (const title of [...Object.values(SECTIONS), ...[...sections.keys()].filter(k => !Object.values(SECTIONS).includes(k))]) {
    const body = sections.get(title)
    if (body === undefined) continue
    // A section is a bullet list; blank lines inside one are only ever an
    // artifact of round-tripping the file, never meaningful.
    const lines = body.map(line => line.trimEnd()).filter(line => line !== '')
    if (lines.length === 0) continue
    parts.push(`## ${title}`, lines.join('\n'))
  }
  return `${parts.filter(part => part !== '').join('\n\n')}\n`
}

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
 * inject/injection/injecting all collapse to `injec`, and
 * keyboard/keyboardputscancode both to `keybo`. Without it the same fact
 * written two ways scores ~0.3 and slips through as a new entry.
 */
function contentWords(line) {
  return new Set(
    line.toLowerCase().replace(/^[-*]\s*/, '').split(/[^a-z0-9]+/)
      .filter(word => word.length > 2 && !STOPWORDS.has(word))
      .map(word => word.slice(0, 5)),
  )
}

/**
 * How much two facts overlap, 0 to 1 — the overlap coefficient, shared words
 * over the SMALLER set.
 *
 * Jaccard (shared over union) was wrong here: a model restating a fact tends
 * to write a longer, more explanatory version, and the extra words inflate the
 * union and sink the score. Two statements of the identical VBoxManage fact
 * scored 0.35 under Jaccard and 0.55 under containment. Dividing by the
 * smaller set asks the right question — "is one of these essentially contained
 * in the other" — rather than "are these the same length and content".
 */
function similarity(left, right) {
  const a = contentWords(left)
  const b = contentWords(right)
  // Very short facts carry too little signal for containment to mean anything;
  // two three-word lines sharing two words are not necessarily the same fact.
  if (a.size < 4 || b.size < 4) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / Math.min(a.size, b.size)
}

const DUPLICATE_AT = 0.6

/**
 * Register the tool.
 * @param ctx - plugin context carrying `ctx.tools`.
 * @param config - `{ filename?, projectRootMarkers? }`.
 */
export function apply(ctx, config = {}) {
  const filename = config.filename ?? 'QWEN.md'
  const markers = config.projectRootMarkers ?? ['.git']

  ctx.tools.register(defineTool({
    name: 'remember',
    description:
      `Record a durable fact in ${filename}, the project memory file that is loaded into every future session here. `
      + 'Use it when you learn something that would otherwise have to be rediscovered: how this project is built or run, '
      + 'a mistake that wasted time and how to avoid it, an environment constraint, or a stated preference. '
      + 'Record only what you VERIFIED — a confidently wrong memory is worse than none, and it persists. '
      + 'Do not record transient state, secrets, or anything already obvious from the code.',
    parameters: {
      fact: {
        type: 'string',
        required: true,
        description: 'One specific, self-contained sentence. Include the WHY when it is not obvious. Bad: "be careful with the config". Good: "llama-swap --predict caps every request including compaction, which deadlocks long sessions".',
      },
      category: {
        type: 'string',
        required: true,
        enum: Object.keys(SECTIONS),
        description: 'environment: how this machine or project is set up. mistake: something that went wrong and how to avoid it. howto: a procedure worth repeating. preference: how the user wants things done.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          section: { type: 'string', required: true },
          status: { type: 'string', enum: ['recorded', 'already known'], required: true },
          bytes: { type: 'integer', required: true },
          existing: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'already known'
          ? `Already recorded in ${value.path}, as: "${value.existing}". Nothing added.`
          : `Recorded under "${value.section}" in ${value.path} (${value.bytes} bytes).`,
      }],
    },
    async execute(args) {
      const fact = args.fact.trim().replace(/\s+/g, ' ')
      if (fact === '') throw new Error('fact must not be empty')
      const section = SECTIONS[args.category]
      if (section === undefined) throw new Error(`unknown category "${args.category}"`)

      const root = await projectRoot(process.cwd(), markers)
      const path = join(root, filename)

      let existing = ''
      try {
        existing = await readFile(path, 'utf8')
      } catch {
        // First fact in this project; the file is created below.
      }

      const { preamble, sections } = parseSections(existing)
      const entry = `- ${fact}`
      // Compare against every section, not just the target one: the same fact
      // filed under a different category is still a duplicate.
      for (const [, body] of sections) {
        const match = body.find(line => line.trim() !== '' && similarity(line, entry) >= DUPLICATE_AT)
        if (match !== undefined) {
          return { path, section, status: 'already known', bytes: Buffer.byteLength(existing), existing: match.replace(/^-\s*/, '') }
        }
      }
      const target = sections.get(section) ?? []
      target.push(entry)
      sections.set(section, target)

      const header = preamble.trim() === ''
        ? `# Project memory\n\nMaintained by the agent via the \`remember\` tool, and read into every session here.\nEdit or delete anything that is wrong — it is a plain file.`
        : preamble
      const rendered = renderFile(header, sections)
      if (Buffer.byteLength(rendered) > MAX_BYTES) {
        throw new Error(`${filename} would exceed ${MAX_BYTES} bytes; prune it before recording more`)
      }
      await writeFile(path, rendered)
      return { path, section, status: 'recorded', bytes: Buffer.byteLength(rendered) }
    },
  }))
}

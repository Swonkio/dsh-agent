/**
 * dsh-memory — the memory plugin: two kinds of memory, both plain files.
 *
 * Project memory is `remember`, which maintains QWEN.md at the project root
 * (the read side already exists: `dsh-agent-instructions` injects it into
 * every session there).
 *
 * User memory is the `$DSH_HOME/memory/` store (`memory_save` /
 * `memory_search`): durable facts that follow the user across projects, with
 * the MEMORY.md index injected into every system prompt. Procedural memory is
 * `skill_create`, the write half of the skills system — the shipped loader
 * only reads, so this is how a repeated procedure becomes a named skill.
 *
 * Files stay plain markdown on purpose: memory an agent writes is only as
 * good as the human's ability to read and correct it, and a durable wrong
 * "lesson" is worse than no memory at all.
 *
 * @module dsh-memory
 */

import { readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  saveFact, search, indexTextSync, lastWriteMsSync, truncateForPrompt,
  selectMemoryLines, contentWords, similarity, DUPLICATE_AT,
  removeFact, editFact, indexText, MAX_INDEX_BYTES,
} from './memory-store.js'
import { writeSkill } from './skill-create.js'

/** Stable Cordis plugin name. */
export const name = 'tool-remember'

/** The registries this plugin writes into. */
export const inject = ['tools', 'systemPrompt', 'commands']

/** Sections the project memory file is organized into, in written order. */
const SECTIONS = {
  environment: 'Environment facts',
  mistake: 'Mistakes to avoid',
  howto: 'How to do things here',
  preference: 'Preferences',
}

/** Refuse to grow the project file past what the instruction loader reads. */
const MAX_BYTES = 60000

/**
 * Whether a completed turn warrants a background review: enabled, real
 * content on both sides, and outside the throttle window. The throttle
 * exists because a chatty evening is many turns of one conversation — one
 * review pass per few minutes captures it without one model call per message.
 */
export function reviewDecision({ enabled, lastUserText, lastAssistantText, lastReviewMs, now = Date.now(), throttleMs = 10 * 60 * 1000 }) {
  if (enabled !== true) return false
  if (lastUserText.trim() === '' || lastAssistantText.trim() === '') return false
  if (lastReviewMs > 0 && now - lastReviewMs < throttleMs) return false
  return true
}

/** The prompt the detached review session runs. */
export function reviewPrompt(userText, assistantText, capBytes = 4096) {
  const clip = text => (Buffer.byteLength(text) > capBytes ? `${text.slice(0, capBytes)}…` : text)
  return 'You are the self-improvement review for dsh-agent. Below is one exchange from the session that just ended. '
    + 'Identify DURABLE lessons only: verified facts about the user or their machines worth keeping across sessions, '
    + 'mistakes now understood, or procedures worth repeating. For each, call memory_save (one topic, one self-contained '
    + 'summary), skill_create for a procedure worth teaching, or tool_create for a command worth becoming a permanent '
    + 'typed tool. Do NOT save ephemeral state, secrets, or anything obvious from context. '
    + 'If there is nothing durable, reply exactly: nothing to keep\n\n'
    + `USER:\n${clip(userText)}\n\nASSISTANT:\n${clip(assistantText)}`
}

/**
 * Fire the detached review pass: a one-shot agent turn in its own session
/**
 * Fire the detached review pass: a one-shot agent turn in its own session
 * namespace (~/.dsh/reviews) on the task model. The review session itself
 * runs the cron profile, where backgroundReview is unset — no recursion.
 * Lives inside apply() to close over the resolved memory home.
 */
async function maybeReviewOf(home, userText, assistantText) {
  try {
    const { mkdir, writeFile, stat } = await import('node:fs/promises')
    const marker = join(home, '.last-review')
    let lastReviewMs = 0
    try {
      lastReviewMs = (await stat(marker)).mtimeMs
    } catch { /* never reviewed */ }
    if (!reviewDecision({ enabled: true, lastUserText: userText, lastAssistantText: assistantText, lastReviewMs })) return
    await mkdir(join(dshHomePath(), 'reviews'), { recursive: true })
    await writeFile(marker, `${new Date().toISOString()}\n`)
    const { spawn } = await import('node:child_process')
    const { dshBinPath, envFileExports } = await import('../../dsh-cron/lib/jobs.js')
    const env = { ...(await envFileExports()), ...process.env }
    const child = spawn(process.execPath, [
      dshBinPath(), '--profile', 'cron', '-p', reviewPrompt(userText, assistantText),
      '--provider', 'zai', '--model', 'glm-5.3',
    ], { cwd: join(dshHomePath(), 'reviews'), detached: true, stdio: 'ignore', env })
    child.unref()
  } catch (error) {
    // A review that cannot even spawn must never disturb the session that
    // triggered it; the throttle file simply was not written this time.
    console.error(`dsh-memory: background review skipped: ${error.message}`)
  }
}

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

/**
 * Register the tools and prompt sections.
 * @param {object} ctx - plugin context carrying `ctx.tools` and `ctx.systemPrompt`.
 * @param {object} config - `{ filename?, projectRootMarkers?, indexCapBytes?, nudgeAfterMs? }`.
 */
export function apply(ctx, config = {}) {
  const filename = config.filename ?? 'QWEN.md'
  const markers = config.projectRootMarkers ?? ['.git']
  const indexCapBytes = config.indexCapBytes ?? 4096
  const nudgeAfterMs = config.nudgeAfterMs ?? 6 * 60 * 60 * 1000
  const memoryHome = dshHomePath('memory')

  // The relevance signal for memory injection: the newest thing the human
  // said. AssembleContext carries no conversation, so the plugin watches the
  // session firehose itself; before the first message of a session this is
  // empty and injection falls back to the most recent lines.
  let lastUserText = ''
  let lastAssistantText = ''
  // The self-improvement trigger: a turn that loaded a skill and still
  // failed. A skill that steers wrong poisons every future session that
  // loads it, so the very next prompt carries a fix-it-now nudge (shown
  // once per incident, then cleared).
  let skillUsedThisTurn = false
  let skillFailedNudge = false
  ctx.on('session/event', (_session, event) => {
    if (event?.type === 'user/message') {
      const content = event.data?.content
      if (typeof content === 'string') lastUserText = content
      else if (Array.isArray(content)) lastUserText = content.filter(block => block?.type === 'text').map(block => block.text).join(' ')
      return
    }
    if (event?.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (Array.isArray(blocks)) lastAssistantText = blocks.filter(block => block?.type === 'text').map(block => block.text).join(' ')
      return
    }
    if (event?.type === 'tool/call' && event.data?.name === 'skill') {
      skillUsedThisTurn = true
      return
    }
    if (event?.type === 'turn/end') {
      if (skillUsedThisTurn && event.data?.reason?.kind === 'failed') skillFailedNudge = true
      skillUsedThisTurn = false
      if (event.data?.reason?.kind === 'completed' && config.backgroundReview === true) {
        void maybeReviewOf(memoryHome, lastUserText, lastAssistantText)
      }
    }
  })

  ctx.tools.register(defineTool({
    name: 'remember',
    description:
      `Record a durable fact in ${filename}, the project memory file that is loaded into every future session here. `
      + 'Use it when you learn something that would otherwise have to be rediscovered: how this project is built or run, '
      + 'a mistake that wasted time and how to avoid it, an environment constraint, or a stated preference. '
      + 'Record only what you VERIFIED — a confidently wrong memory is worse than none, and it persists. '
      + 'Do not record transient state, secrets, or anything already obvious from the code. '
      + 'For facts about the USER or their machine that hold across projects, prefer memory_save.',
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

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description:
      'Record a durable fact about the user, their machines, or their preferences in the user memory store, '
      + 'which is injected into every future session in every project. One call = one topic: a short title plus a '
      + 'summary that stands alone (it is the line the model reads at prompt time), with optional detail body. '
      + 'Saving to an existing topic REPLACES it — rewrite the whole fact, not a delta. '
      + 'Record only what you VERIFIED; a wrong durable memory is worse than none. '
      + 'Project-specific facts belong in remember (QWEN.md) instead.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Short stable title for the fact, e.g. "Pi model serving" or "Preferred review style".',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'One self-contained sentence carrying the whole fact. Bad: "uses the port from before". Good: "llama-server serves bonsai-27b on 127.0.0.1:8080 with 8192 context, started manually".',
      },
      body: {
        type: 'string',
        description: 'Optional detail (commands, caveats, history) kept in the topic file; read on demand, not injected.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          indexPath: { type: 'string', required: true },
          topicPath: { type: 'string', required: true },
          status: { type: 'string', enum: ['recorded', 'updated', 'already known'], required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'already known'
          ? 'Already in memory; nothing added.'
          : `${value.status === 'updated' ? 'Updated' : 'Recorded'} memory (${value.bytes} bytes index): ${value.topicPath}`,
      }],
    },
    async execute(args) {
      return saveFact(memoryHome, args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_edit',
    description:
      'Correct or tighten an existing memory: matched by a short UNIQUE substring of the current entry '
      + '(a few distinctive words suffice; zero or multiple matches return an error listing the candidates). '
      + 'Rewrites that entry\'s summary in the index and, when a body is given, replaces its topic detail '
      + '(empty body removes the detail file). Use this to consolidate near-duplicate memories into one tighter entry.',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: 'A substring unique to the one memory being edited, e.g. "bonsai 8080".',
      },
      summary: {
        type: 'string',
        description: 'The replacement summary line — self-contained, carries the whole fact.',
      },
      body: {
        type: 'string',
        description: 'Replacement topic detail (omit to keep the current detail; empty string removes it).',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'string', required: true },
          topicPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Memory rewritten: ${value.line}` }],
    },
    async execute(args) {
      return editFact(memoryHome, args.match, { summary: args.summary, body: args.body })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Remove a memory that is wrong or no longer worth its space, matched by a short UNIQUE substring '
      + '(zero or multiple matches return an error listing the candidates). Removes the index line and its topic file. '
      + 'Prefer memory_edit when the fact changed rather than died.',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: 'A substring unique to the one memory being removed.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'string', required: true },
          topicPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Removed: ${value.removed}` }],
    },
    async execute(args) {
      return removeFact(memoryHome, args.match)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search the user memory store before re-deriving something that past sessions may already have learned '
      + '(machines, endpoints, preferences, past decisions). Returns matching topics with their summaries and paths.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords of what you are looking for, e.g. "llama port context".' },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                topic: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                path: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No memories matched.'
          : value.results.map(hit => `- ${hit.topic}: ${hit.summary} (${hit.path})`).join('\n'),
      }],
    },
    async execute(args) {
      return { results: await search(memoryHome, args.query) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skill_create',
    description:
      'Capture a repeatable procedure as a named skill — procedural memory. When you notice yourself re-deriving '
      + 'the same steps (a deploy check, a debugging recipe, a file format), write it once as a skill and it becomes '
      + 'available in every future session immediately, no restart. Update with overwrite when the procedure improves. '
      + 'This is the write half of the skills system; everything you and the user can also read lives in the same files.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Kebab-case id, e.g. "verify-llama-server".',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One sentence: what this skill does. This is what future sessions see when deciding to use it.',
      },
      whenToUse: {
        type: 'string',
        description: 'Optional: the situations that call for this skill, phrased as a trigger.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The skill content as markdown: the steps, commands, and gotchas. Write it for a future session that knows nothing else.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing skill of the same name (default false: refuse instead).',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          status: { type: 'string', enum: ['created', 'replaced'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.status === 'replaced' ? 'Replaced' : 'Created'} skill at ${value.path}. It is live in every session from now on.`,
      }],
    },
    async execute(args) {
      return writeSkill(dshHomePath('skills'), args)
    },
  }))

  // ── system prompt sections ───────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'memory:index',
    order: 20,
    text: () => {
      const index = indexTextSync(memoryHome)
      if (index === '') return ''
      const bytes = Buffer.byteLength(index)
      const percent = Math.round((bytes / MAX_INDEX_BYTES) * 100)
      const lines = index.split('\n').filter(line => line.startsWith('- '))
      const { selected, total, mode } = selectMemoryLines(lines, lastUserText)
      const note = mode === 'selected' ? `\n(Showing ${selected.length} of ${total} memories by relevance to this conversation; memory_search reaches the rest.)` : ''
      const body = `${selected.join('\n')}${note}`
      return `# Memory [${percent}% — ${bytes}/${MAX_INDEX_BYTES} chars]\nPersistent memory from past sessions. Above ~80% consolidate with memory_edit/memory_forget before adding. Topic detail under memory/topics/ (memory_search finds it):\n\n${truncateForPrompt(body, indexCapBytes)}`
    },
  })

  ctx.systemPrompt.section({
    name: 'memory:instruction',
    order: 21,
    text: () => {
      let text = 'Durable facts about the user and their machines belong in memory: memory_save (one topic, one self-contained summary), memory_search before re-deriving what past sessions may have learned; memory_edit corrects or merges, memory_forget removes — when a save fails the capacity check, consolidate in the SAME turn using the entries the error lists. Record only verified facts.'
      const last = lastWriteMsSync(memoryHome)
      if (last > 0 && Date.now() - last > nudgeAfterMs) {
        text += `\nIt has been a while since memory was last written — if this session established something durable, save it.`
      }
      return text
    },
  })

  ctx.systemPrompt.section({
    name: 'skill:create-hint',
    order: 22,
    text: () => {
      let text = 'A procedure you have now done twice is worth capturing once: skill_create turns it into a named skill every future session can use — and when a skill proves wrong or incomplete mid-task, fix it immediately with skill_create (overwrite: true) rather than working around it; improved live, it is the loop teaching itself.'
      if (skillFailedNudge) {
        skillFailedNudge = false
        text += '\nThe previous turn loaded a skill and still failed. If the skill itself was wrong, stale, or incomplete, THIS is the moment to rewrite it with skill_create (overwrite: true) — otherwise every future session inherits the same failure.'
      }
      return text
    },
  })

  // A command, not a tool: the index is data the human may want to audit,
  // and auditing it should cost zero model tokens.
  ctx.commands.register({
    name: 'memory',
    description: 'show the persistent memory index (and where its files live)',
    handler: async () => {
      const index = indexTextSync(memoryHome)
      const lastWrite = lastWriteMsSync(memoryHome)
      const age = lastWrite === 0 ? 'never written' : `${Math.round((Date.now() - lastWrite) / 3600000)}h since last write`
      const bytes = Buffer.byteLength(index)
      const percent = Math.round((bytes / MAX_INDEX_BYTES) * 100)
      const usage = `[${percent}% — ${bytes}/${MAX_INDEX_BYTES} chars, ${age}]`
      if (index === '') {
        return { kind: 'success', text: `Memory store is empty (${age}).\nThe agent fills it with memory_save; files live under ${memoryHome}.` }
      }
      return {
        kind: 'success',
        text: `## Memory ${usage}\n\n${index.trim()}\n\n(Edit or delete lines in ${join(memoryHome, 'MEMORY.md')} — it is a plain file; topic detail under ${join(memoryHome, 'topics')})`,
      }
    },
  })
}

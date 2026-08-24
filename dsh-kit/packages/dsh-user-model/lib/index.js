/**
 * dsh-user-model — a self-revising model of the user, injected every session.
 *
 * SOUL.md is who the AGENT is; USER.md is who the USER is — and unlike the
 * soul, it is maintained by the agent rather than authored by the person. It
 * holds a picture built up across sessions: expertise, preferences, working
 * style, environment, current projects. It is injected into every session's
 * system prompt so a conversation starts with the agent already knowing who it
 * is talking to, the way a colleague does on day two rather than day one.
 *
 * It is REVISABLE, not append-only. The `user_model` tool reads and rewrites
 * the whole document, so a new observation that contradicts an earlier belief
 * corrects it in place. That dialectic — revise, don't accrete — is what keeps
 * the model true rather than merely large, and it is what the background
 * review needs to deepen the model instead of duplicating memory.
 *
 * The file is read once when the plugin starts (a fresh process per session),
 * so every new session picks up the latest model; a mid-session rewrite takes
 * effect next session. That matches how the model is meant to work — a
 * deepening picture ACROSS sessions, not a scratchpad within one.
 * @module dsh-user-model
 */

import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Stable Cordis plugin name. */
export const name = 'dsh-user-model'

/** Reads the system-prompt registry and the tool registry. */
export const inject = ['systemPrompt', 'tools']

/** Cut a model larger than the budget on a line boundary. */
const TRUNCATION_MARK = '\n…(USER.md truncated for the prompt — consolidate it)'

/**
 * Register the user-model section (when the file exists) and the `user_model`
 * tool (always).
 * @param {object} ctx - plugin context with `ctx.systemPrompt` and `ctx.tools`.
 * @param {object} config - `{ filename?: string, maxBytes?: number }`.
 */
export function apply(ctx, config = {}) {
  const filename = config.filename ?? 'USER.md'
  const maxBytes = config.maxBytes ?? 2048
  const path = join(dshHomePath(), filename)

  // Injected once at session start, like the soul: a stable picture for the
  // session's lifetime, refreshed next session.
  let model = ''
  try {
    model = readFileSync(path, 'utf8').trim()
  } catch { /* no model yet: nothing to inject, the tool can still create it */ }

  if (model !== '') {
    let text = model
    if (Buffer.byteLength(text) > maxBytes) {
      const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARK))
      const cut = Buffer.from(text).subarray(0, room).toString('utf8')
      const lastBreak = cut.lastIndexOf('\n')
      text = `${(lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()}${TRUNCATION_MARK}`
    }
    // Order 2: after the harness persona (0) and the soul (1), so identity
    // comes first and the picture of the user follows it.
    ctx.systemPrompt.section({
      name: 'user:model',
      order: 2,
      text: `# Your user\nWhat you have learned about the person you are working with, across sessions. Trust it, and keep it current with the user_model tool when you learn something new or find it wrong.\n\n${text}`,
    })
  }

  ctx.tools.register(defineTool({
    name: 'user_model',
    description:
      `Read or rewrite ${filename}, your evolving model of the user — injected into every future session. `
      + 'Use get to read the current model, then set to write a revised version. '
      + 'This is REVISION, not appending: fold a new observation in, correct anything now known to be wrong, '
      + 'and keep it concise and organised (expertise, preferences, working style, environment, current projects). '
      + 'Record only what you actually observed, never guesses, and never secrets. A confidently wrong model '
      + 'misleads every future session, so prefer to leave something out than to assert it unsupported.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['get', 'set'],
        description: 'get: return the current model. set: replace it with the revised markdown in `content`.',
      },
      content: {
        type: 'string',
        description: 'For set: the full revised model as markdown. Required when action is set.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'set'], required: true },
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'get'
          ? (value.bytes === 0 ? 'The user model is empty. Build it with user_model set.' : value.content)
          : `User model updated (${value.bytes} bytes). It loads into every future session.`,
      }],
    },
    async execute(args) {
      if (args.action === 'get') {
        let content = ''
        try { content = await readFile(path, 'utf8') } catch { /* absent = empty */ }
        return { action: 'get', path, bytes: Buffer.byteLength(content), content }
      }
      const content = (args.content ?? '').trim()
      if (content === '') throw new Error('set requires non-empty content')
      // The stored file may exceed the PROMPT budget (it is truncated on
      // injection), but an unbounded model is a smell; cap it generously and
      // ask for consolidation rather than silently dropping the tail.
      const hardCap = maxBytes * 4
      if (Buffer.byteLength(content) > hardCap) {
        throw new Error(`the user model would exceed ${hardCap} bytes; consolidate it before writing more`)
      }
      await writeFile(path, `${content}\n`)
      return { action: 'set', path, bytes: Buffer.byteLength(content) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'set' ? 'Update user model' : 'Read user model',
      kind: args.action === 'set' ? 'other' : 'read',
      locations: [{ path }],
    }),
  }))
}

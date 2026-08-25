/**
 * dsh-soul — the user's personality file for the agent.
 *
 * If `$DSH_HOME/SOUL.md` exists, it is injected as a system-prompt section
 * immediately after the persona (order 1): voice, values, standing style the
 * user wants across every session and every profile. If it does not exist,
 * nothing is registered and nothing is created — a personality is the user's
 * to write, not the machine's to seed.
 *
 * The file is read once when the plugin starts, not per prompt assembly: it
 * describes a person, not state, and a running session keeping one voice for
 * its whole lifetime matters more than picking up mid-session edits.
 *
 * @module dsh-soul
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Stable Cordis plugin name. */
export const name = 'dsh-soul'

/** Reads the system prompt registry. */
export const inject = ['systemPrompt']

/** Cut a soul larger than this on a line boundary; a persona is not a wiki. */
const TRUNCATION_MARK = '\n…(SOUL.md truncated — keep it shorter)'

/**
 * Register the soul section when the file exists.
 * @param {object} ctx - plugin context carrying `ctx.systemPrompt`.
 * @param {object} config - `{ maxBytes?: number }`, default 2048.
 */
export function apply(ctx, config = {}) {
  const maxBytes = config.maxBytes ?? 2048
  let soul = ''
  try {
    soul = readFileSync(join(dshHomePath(), 'SOUL.md'), 'utf8').trim()
  } catch {
    // No SOUL.md: the user has not written a personality, and that is fine.
    return
  }
  if (soul === '') return

  let text = soul
  if (Buffer.byteLength(text) > maxBytes) {
    const room = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARK))
    const cut = Buffer.from(text).subarray(0, room).toString('utf8')
    const lastBreak = cut.lastIndexOf('\n')
    text = `${(lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()}${TRUNCATION_MARK}`
  }

  ctx.systemPrompt.section({
    name: 'user:soul',
    order: 1,
    text: `# Soul\n${text}`,
  })
}

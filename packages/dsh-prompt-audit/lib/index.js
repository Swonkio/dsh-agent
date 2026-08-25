/**
 * dsh-prompt-audit — the /prompt command.
 *
 * The system prompt accretes: persona, memory index, lessons, skill catalog,
 * tool guidance, sandbox policy… Every one of them is a byte spent on EVERY
 * request, and when the window starts filling there is no way to see which
 * section is doing the filling. This plugin rides the real assembly waterfall
 * (it records each assembled prompt exactly as the model received it, scoped
 * layers included) and exposes it as a zero-token slash command.
 *
 * Nothing here calls a model or writes a file; worst case it renders an empty
 * snapshot ("no assembly observed yet").
 *
 * @module dsh-prompt-audit
 */

/** Render one captured assembly as the report the human reads. Pure. */
export function renderPromptReport(snapshot, now = Date.now()) {
  if (snapshot === undefined || snapshot === null) {
    return 'No prompt assembly observed yet — send a message first.'
  }
  const lines = []
  const sectionRows = snapshot.sections.map(section => ({ name: section.name, bytes: section.bytes }))
  const total = sectionRows.reduce((sum, row) => sum + row.bytes, 0)
  const contextRows = (snapshot.contexts ?? []).map(context => ({ name: context.name, bytes: context.bytes }))
  const contextTotal = contextRows.reduce((sum, row) => sum + row.bytes, 0)
  const toolBytes = snapshot.toolBytes ?? 0
  const ageSec = Math.round((now - snapshot.at) / 1000)

  lines.push(`## System prompt — ${fmt(total)} bytes across ${sectionRows.length} sections (assembled ${ageSec}s ago${snapshot.scope !== undefined ? `, scope ${snapshot.scope}` : ''})`, '')
  for (const row of [...sectionRows].sort((a, b) => b.bytes - a.bytes)) {
    lines.push(`- ${fmt(row.bytes).padStart(7)}  ${row.name}`)
  }
  if (contextRows.length > 0) {
    lines.push('', `## Dynamic contexts — ${fmt(contextTotal)} bytes across ${contextRows.length} (replayed as user-role snapshots)`, '')
    for (const row of contextRows.sort((a, b) => b.bytes - a.bytes)) {
      lines.push(`- ${fmt(row.bytes).padStart(7)}  ${row.name}`)
    }
  }
  lines.push('', `## Tools — ${snapshot.tools ?? 0} schemas, ~${fmt(toolBytes)} bytes of definitions`, '')
  const grand = total + contextTotal + toolBytes
  lines.push(`Prompt-side total: ~${fmt(grand)} bytes (≈${Math.round(grand / 4)} tokens at 4 bytes/token, before conversation history).`)
  if (snapshot.warnAt !== undefined && grand > snapshot.warnAt) {
    lines.push(``, `⚠️ Above the ${fmt(snapshot.warnAt)}-byte audit threshold — the biggest sections above are the ones to consolidate.`)
  }
  return lines.join('\n')
}

/** Bytes with a thousands separator; kept local and dependency-free. */
function fmt(bytes) {
  return String(Math.max(0, Math.round(bytes))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Stable Cordis plugin name. */
export const name = 'dsh-prompt-audit'

/** Registers one human command; listens to the assembly waterfall. */
export const inject = ['commands']

/** Policy defaults. */
export const DEFAULTS = { warnAtBytes: 40000 }

/**
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [config] - `{ warnAtBytes? }`.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  /** The most recent assembly per scope (and the latest overall). */
  let latest

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const result = await next()
    try {
      latest = {
        at: Date.now(),
        scope: context?.scope,
        sections: result.sections.map(section => ({ name: section.name, bytes: Buffer.byteLength(section.text) })),
        contexts: (result.contexts ?? []).map(context1 => ({ name: context1.name, bytes: Buffer.byteLength(context1.text) })),
        tools: result.tools?.length ?? 0,
        toolBytes: result.tools?.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)), 0) ?? 0,
        warnAt: cfg.warnAtBytes,
      }
    } catch {
      // Auditing must never be able to break assembly.
    }
    return result
  })

  ctx.commands.register({
    name: 'prompt',
    description: 'show the assembled system prompt, section by section, with byte counts',
    handler: async () => ({ kind: 'success', text: renderPromptReport(latest) }),
  })
}

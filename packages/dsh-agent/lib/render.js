/**
 * The session-feed renderer: it turns the durable event stream into terminal
 * output, using each tool's own `presentCall`/`presentResult` render intent
 * rather than special-casing tool names — the same contract the browser
 * surface consumes, projected onto a scrollback terminal.
 * @module dsh-agent/render
 */

import { structuredPatch } from 'diff'
import { bubble, ellipsize, screenWidth, width, wrap } from './term.js'
import { glyph, meter, mono, ui } from './theme.js'
import { caustic } from './light.js'

/** Gutter marks: a call, its result, and a continuation row. */
const CALL = glyph.call
const RESULT = glyph.result
const INDENT = '  '
const CONTINUE = '     '

/** Result lines shown before the tail is folded away, unless --verbose. */
const RESULT_LINES = 8
/** Verbose still bounds output, so one runaway command cannot flood the screen. */
const VERBOSE_LINES = 400

/** Per-kind color for a tool-call header. */
const KIND_COLOR = {
  read: ui.token,
  edit: ui.success,
  delete: ui.danger,
  move: ui.warning,
  search: ui.thought,
  execute: ui.accent,
  fetch: ui.token,
  other: ui.accentSoft,
}

/** Join a content-block list into plain text. */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.map(block => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'reasoning') return block.text
    if (block?.type === 'image') return '[image]'
    return ''
  }).join('')
}

/** Inline markdown → SGR: bold, italic, and inline code. */
function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, (_, code) => ui.accent(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => ui.bold(bold))
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, (_, lead, italic) => `${lead}${ui.italic(italic)}`)
}

/**
 * Style one completed line of assistant prose. Rendering is line-buffered:
 * a line is styled the moment it is complete, which keeps markdown correct
 * without a repainting full-screen UI.
 */
function markdownLine(line, state) {
  const fence = /^\s*```/.test(line)
  if (fence) {
    state.code = !state.code
    return ui.muted(line)
  }
  if (state.code) return ui.muted(line)
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading !== null) return ui.bold(ui.accent(heading[2]))
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
  if (bullet !== null) return `${bullet[1]}${ui.accent('•')} ${inlineMarkdown(bullet[2])}`
  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
  if (numbered !== null) return `${numbered[1]}${ui.token(`${numbered[2]}.`)} ${inlineMarkdown(numbered[3])}`
  const quote = /^\s*>\s?(.*)$/.exec(line)
  if (quote !== null) return ui.muted(`│ ${quote[1]}`)
  if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) return ui.muted('─'.repeat(Math.min(screenWidth(), 40)))
  return inlineMarkdown(line)
}

/**
 * Style a whole markdown block at once (a plan under review, a command's
 * output): the same per-line styling the streamed path uses, with one fence
 * state carried across the block.
 */
export function renderMarkdown(text, limit = screenWidth()) {
  const state = { code: false }
  return String(text).split('\n')
    .map(line => wrap(markdownLine(line, state), limit))
    .join('\n')
}

/** Bound a list of lines, appending a folded-tail note when it was cut. */
function bound(lines, limit) {
  if (lines.length <= limit) return { lines, hidden: 0 }
  return { lines: lines.slice(0, limit), hidden: lines.length - limit }
}

/** Render a `+`/`-` unified hunk set for one file change. */
function diffLines(file, limit) {
  const before = file.oldText ?? ''
  const after = file.newText ?? ''
  const patch = structuredPatch('a', 'b', before, after, '', '', { context: 2 })
  const out = []
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const raw of hunk.lines) {
      const body = raw.slice(1)
      if (raw.startsWith('+')) {
        out.push(`${ui.muted(String(newLine).padStart(5))} ${ui.addBg(ui.success(`+ ${body}`))}`)
        newLine += 1
      } else if (raw.startsWith('-')) {
        out.push(`${ui.muted(String(oldLine).padStart(5))} ${ui.removeBg(ui.danger(`- ${body}`))}`)
        oldLine += 1
      } else {
        out.push(`${ui.muted(String(newLine).padStart(5))} ${ui.muted(`  ${body}`)}`)
        oldLine += 1
        newLine += 1
      }
      if (out.length >= limit) return out
    }
  }
  return out
}

/** Compact one-line summary of a tool's raw arguments for a card header. */
function summarizeArgs(args) {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') return args
  if (typeof args !== 'object') return String(args)
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'object') continue
    parts.push(`${key}: ${String(value)}`)
    if (parts.length === 3) break
  }
  // A call whose arguments are all structured (ask_user_question's question
  // list) would otherwise render as empty parentheses.
  if (parts.length === 0) return JSON.stringify(args)
  return parts.join(', ')
}

/**
 * Characters of unbroken reasoning that force a bubble to close.
 *
 * Only reached when a model writes a long run with no paragraph break; the
 * usual boundary is a blank line. Sized so a forced bubble is still a readable
 * few lines rather than a wall.
 */
const REASONING_BUBBLE_MAX = 420


/** The renderer owns everything the surface prints while a turn runs. */
export class Renderer {
  /**
   * @param screen - the shared {@link Screen}.
   * @param options - `tools` registry, presenter `scope`, and display switches.
   */
  constructor(screen, options) {
    this.screen = screen
    this.options = options
    this.text = ''
    this.reasoning = ''
    this.markdown = { code: false }
    this.calls = new Map()
    this.results = []
    this.lastCall = undefined
    this.reasoningOpen = false
    this.textOpen = false
  }

  /** The bound on result lines for the current verbosity. */
  get resultLimit() {
    return this.options.verbose === true ? VERBOSE_LINES : RESULT_LINES
  }

  /** Route one durable session event to its renderer. */
  render(event) {
    switch (event.type) {
      case 'assistant/chunk': return this.chunk(event.data.chunk)
      case 'tool/call': return this.toolCall(event.data)
      case 'tool/result': return this.toolResult(event.data)
      case 'todo/write': return this.todos(event.data.todos)
      case 'turn/end': return this.turnEnd(event.data.reason)
      case 'llm/retry': return this.retry(event.data)
      case 'compaction/start': return this.notice(ui.muted('compacting the conversation…'))
      case 'compaction/end': return this.compactionEnd(event.data)
      case 'plan/mode': return this.notice(event.data.active === true
        ? ui.token('plan mode on — the agent will propose before it edits')
        : ui.token('plan mode off'))
      case 'permission/preset': return this.notice(ui.warning(`permissions: ${event.data.preset ?? 'changed'}`))
      case 'session/title': return this.title(event.data)
      default: return undefined
    }
  }

  /** Stream one provider chunk. */
  chunk(chunk) {
    if (chunk.type === 'text-delta') {
      this.flushReasoning()
      this.text += chunk.text
      this.drainText()
      return
    }
    if (chunk.type === 'reasoning-delta' && this.options.thinking !== false) {
      this.flushText()
      this.reasoning += chunk.text
      this.drainReasoning()
      return
    }
    if (chunk.type === 'block-end') {
      this.flushText()
      this.flushReasoning()
    }
  }

  /** Emit every complete line of buffered assistant prose. */
  drainText() {
    let at = this.text.indexOf('\n')
    while (at !== -1) {
      const line = this.text.slice(0, at)
      this.text = this.text.slice(at + 1)
      this.printProse(line)
      at = this.text.indexOf('\n')
    }
  }

  /** Print one complete prose line, opening the assistant block if needed. */
  printProse(line) {
    if (!this.textOpen) {
      this.screen.blank()
      this.textOpen = true
    }
    const styled = markdownLine(line, this.markdown)
    this.screen.line(width(styled) > screenWidth() ? wrap(styled, screenWidth()) : styled)
  }

  /** Flush a partial prose line at a boundary. */
  flushText() {
    if (this.text === '') return
    const rest = this.text
    this.text = ''
    this.printProse(rest)
  }

  /**
   * Emit buffered reasoning as thought bubbles, one per paragraph.
   *
   * A bubble has to be sized to its content, so unlike prose the text cannot
   * be streamed a line at a time — it is held until a paragraph closes. That
   * is a real cost: nothing appears while a paragraph is still being written.
   * It is bounded two ways. A blank line closes a paragraph, and so does
   * {@link REASONING_BUBBLE_MAX}, so a model that never breaks still produces
   * bubbles at a readable rate instead of one wall at the end. The turn HUD
   * shows a shimmering `Thinking` throughout, so the pause is never silent.
   */
  drainReasoning() {
    let at = this.reasoning.indexOf('\n\n')
    while (at !== -1) {
      const paragraph = this.reasoning.slice(0, at)
      this.reasoning = this.reasoning.slice(at + 2)
      this.printReasoning(paragraph)
      at = this.reasoning.indexOf('\n\n')
    }
    // An unbroken run has to be cut somewhere; the cut is taken at the last
    // sentence end before the cap so a bubble does not end mid-clause.
    if (this.reasoning.length > REASONING_BUBBLE_MAX) {
      const head = this.reasoning.slice(0, REASONING_BUBBLE_MAX)
      const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'))
      const cut = stop > REASONING_BUBBLE_MAX / 3 ? stop + 1 : REASONING_BUBBLE_MAX
      this.printReasoning(this.reasoning.slice(0, cut))
      this.reasoning = this.reasoning.slice(cut)
    }
  }

  /** Draw one paragraph of reasoning as a thought bubble. */
  printReasoning(paragraph) {
    if (paragraph.trim() === '') return
    // Every bubble gets its own gap, not just the first: adjacent balloons
    // read as one ragged block, and the tail circles are too light to separate
    // them on their own.
    this.screen.blank()
    this.reasoningOpen = true
    for (const line of bubble(paragraph, { color: ui.thought, edge: ui.thought })) {
      this.screen.line(line)
    }
  }

  /** Flush a partial reasoning paragraph at a boundary. */
  flushReasoning() {
    if (this.reasoning !== '') {
      const rest = this.reasoning
      this.reasoning = ''
      this.printReasoning(rest)
    }
    this.reasoningOpen = false
  }

  /** Close any open assistant block so the next section starts clean. */
  flush() {
    this.flushText()
    this.flushReasoning()
    this.textOpen = false
    this.markdown.code = false
  }

  /** Look up a tool definition through the presenter scope. */
  definition(name) {
    try {
      return this.options.tools?.get(name, this.options.scope())
    } catch {
      return undefined
    }
  }

  /** Render a requested tool call as a card header. */
  toolCall(data) {
    let args
    try {
      args = JSON.parse(data.arguments)
    } catch {
      args = undefined
    }
    this.calls.set(data.callId, { name: data.name, args })
    let view
    try {
      view = args === undefined ? undefined : this.definition(data.name)?.presentCall?.(args)
    } catch {
      view = undefined
    }
    this.flush()
    this.screen.blank()
    if (view?.card === 'terminal') {
      if (typeof view.description === 'string' && view.description !== '') {
        this.screen.line(ui.muted(wrap(view.description, screenWidth())))
      }
      this.screen.line(`${KIND_COLOR.execute(CALL)} ${ui.bold(data.name)}${ui.muted('(')}${ellipsize(this.relative(view.title), screenWidth() - width(data.name) - 6)}${ui.muted(')')}`)
      return
    }
    const kind = view?.card === 'diff' ? 'edit' : (view?.kind ?? 'other')
    const color = KIND_COLOR[kind] ?? KIND_COLOR.other
    // A presenter's title is already a sentence about this call ("Read
    // note.txt"), so it stands alone; only the unpresented fallback needs the
    // tool name plus a summary of its arguments.
    const header = view === undefined
      ? `${ui.bold(data.name)}${ui.muted('(')}${ellipsize(this.relative(summarizeArgs(args)), screenWidth() - width(data.name) - 6)}${ui.muted(')')}`
      : ui.bold(ellipsize(this.relative(view.title), screenWidth() - 4))
    this.screen.line(`${color(CALL)} ${header}`)
    this.lastCall = view?.title === undefined ? data.name : this.relative(view.title)
  }

  /** Render a settled tool call under its header. */
  toolResult(data) {
    const block = data.message?.content?.[0]
    const callId = data.message?.source?.callId
    const call = callId === undefined ? undefined : this.calls.get(callId)
    const isError = block?.isError === true
    let view
    try {
      view = call === undefined
        ? undefined
        : this.definition(call.name)?.presentResult?.(call.args, {
          content: block?.content ?? [],
          isError,
          ...data.meta === undefined ? {} : { meta: data.meta },
        })
    } catch {
      view = undefined
    }
    if (isError) {
      const text = this.relative(blocksToText(block?.content).trim())
      const wrapped = wrap(text === '' ? 'failed' : text, screenWidth() - width(CONTINUE)).split('\n')
      this.printResult(wrapped, { color: ui.danger })
      return
    }
    switch (view?.card) {
      case 'terminal': return this.terminalResult(view)
      case 'diff': return this.printDiffs(view.diffs, true)
      case 'search': return this.searchResult(view)
      case 'read': return this.readResult(view)
      default: return this.genericResult(view, block)
    }
  }

  /**
   * Print a result body under the gutter mark, bounded to the current
   * verbosity. The unbounded text is retained so ctrl+o can reopen it after
   * the fact — scrollback cannot be rewritten, but it can be appended to.
   * @param lines - the lines to show, already formatted.
   * @param options - `color` for the body, `full` when the retained text
   * differs from what is shown (a read card shows a summary, retains the file).
   */
  printResult(lines, { color = ui.muted, full = lines, label } = {}) {
    this.retain(label, full)
    if (lines.length === 0) {
      this.screen.line(`${INDENT}${ui.muted(`${RESULT}  (no output)`)}`)
      return
    }
    const { lines: shown, hidden } = bound(lines, this.resultLimit)
    // A multi-line result gets a lit margin down its left edge. It does two
    // things at once: it groups the block, so a long result reads as one
    // object rather than as loose lines under a mark, and it carries the same
    // light as the rest of the surface into the transcript. Each block samples
    // the field at its own phase, so the margins vary down a session.
    const spine = shown.length > 1 || hidden > 0 ? litSpine(shown.length + (hidden > 0 ? 1 : 0)) : undefined
    shown.forEach((line, index) => {
      const prefix = index === 0
        ? `${INDENT}${ui.muted(RESULT)}  `
        : spine === undefined ? CONTINUE : `${INDENT}${spine[index]}  `
      this.screen.line(`${prefix}${color === undefined ? line : color(line)}`)
    })
    if (hidden > 0) {
      const tail = spine === undefined ? CONTINUE : `${INDENT}${spine[shown.length]}  `
      this.screen.line(`${tail}${ui.muted(`… +${hidden} lines (ctrl+o)`)}`)
    }
  }

  /** Keep the last few complete result bodies for {@link expandLast}. */
  retain(label, lines) {
    if (lines.length === 0) return
    this.results.push({ label: label ?? this.lastCall ?? 'result', lines })
    if (this.results.length > 5) this.results.shift()
  }

  /** Print the most recent result in full, however long it was. */
  expandLast() {
    const last = this.results[this.results.length - 1]
    this.screen.blank()
    if (last === undefined) {
      this.screen.line(ui.muted('  nothing to expand yet'))
      return
    }
    this.screen.line(ui.bold(`${last.label} — ${last.lines.length} line${last.lines.length === 1 ? '' : 's'}`))
    for (const line of last.lines.slice(0, 5000)) this.screen.line(`${INDENT}${line}`)
    if (last.lines.length > 5000) this.screen.line(ui.muted(`${INDENT}… +${last.lines.length - 5000} lines`))
  }

  /** Terminal card: the captured output plus an exit-status note. */
  terminalResult(view) {
    const raw = (view.output ?? '').replace(/\s+$/, '')
    const lines = raw === '' ? [] : raw.split('\n').map(line => this.relative(line))
    const status = view.exitCode !== undefined && view.exitCode !== 0
      ? ui.danger(`exit ${view.exitCode}`)
      : view.signal !== undefined ? ui.danger(`killed by ${view.signal}`) : undefined
    this.printResult(lines.map(line => ellipsize(line, screenWidth() - 6)), { full: lines })
    if (status !== undefined) this.screen.line(`${CONTINUE}${status}`)
  }

  /** Search card: matches grouped by file, or a flat path list. */
  searchResult(view) {
    const lines = []
    if (view.shape === 'matches') {
      for (const file of view.files) {
        lines.push(ui.token(this.relative(file.path)))
        for (const match of file.matches) {
          lines.push(`${ui.muted(String(match.lineNumber).padStart(5))} ${ellipsize(match.line.trim(), screenWidth() - 12)}`)
        }
      }
    } else {
      for (const path of view.paths) lines.push(ui.token(this.relative(path)))
    }
    this.printResult(lines, { color: undefined })
    const total = `${view.total} ${view.shape === 'matches' ? 'matches' : 'paths'}${view.truncated === true ? ' (capped by the tool)' : ''}`
    this.screen.line(`${CONTINUE}${ui.muted(total)}`)
  }

  /** Read card: a line-count summary rather than a second copy of the file. */
  readResult(view) {
    const shown = view.lines.length
    const summary = `read ${shown} line${shown === 1 ? '' : 's'} of ${this.relative(view.path)}`
      + (view.totalLines > shown ? ui.muted(` (${view.totalLines} total)`) : '')
    const body = view.lines.map(line => `${ui.muted(String(line.number).padStart(5))} ${line.text}`)
    // The card stays a one-line summary — the file is not news to the user —
    // while the window itself is what ctrl+o and --verbose open.
    this.printResult([summary], { color: undefined, full: body, label: this.relative(view.path) })
    if (this.options.verbose !== true) return
    const { lines, hidden } = bound(body, VERBOSE_LINES)
    for (const line of lines) this.screen.line(`${CONTINUE}${line}`)
    if (hidden > 0) this.screen.line(`${CONTINUE}${ui.muted(`… +${hidden} lines`)}`)
  }

  /** Generic card: the tool's reformatted content, or its raw result text. */
  genericResult(view, block) {
    if (typeof view?.title === 'string' && view.title !== '' && view.content === undefined) {
      this.printResult([this.relative(view.title)], { color: undefined })
      return
    }
    const text = this.relative(blocksToText(view?.content ?? block?.content).replace(/\s+$/, ''))
    const lines = text === '' ? [] : text.split('\n')
    this.printResult(lines.map(line => ellipsize(line, screenWidth() - 6)), { full: lines })
  }

  /** Print one or more file diffs under the current card. */
  printDiffs(diffs, asResult = false) {
    if (!Array.isArray(diffs)) return
    for (const file of diffs) {
      const header = ui.token(this.relative(file.path))
      const lines = diffLines(file, this.resultLimit * 4)
      if (asResult) {
        this.printResult([header, ...lines], { color: undefined, label: this.relative(file.path) })
        continue
      }
      this.screen.line(`${INDENT}${ui.muted(RESULT)}  ${header}`)
      for (const line of lines) this.screen.line(`${CONTINUE}${line}`)
    }
  }

  /** The todo list, in the tool's own order. */
  todos(todos) {
    this.flush()
    this.screen.blank()
    this.screen.line(`${ui.accent(CALL)} ${ui.bold('Todos')}`)
    const done = todos.filter(todo => todo.status === 'completed').length
    todos.forEach((todo, index) => {
      const mark = todo.status === 'completed'
        ? ui.success(glyph.done)
        : todo.status === 'in_progress' ? ui.accent(glyph.active) : ui.muted(glyph.pending)
      const text = todo.status === 'completed'
        ? ui.muted(ui.strike(todo.content))
        : todo.status === 'in_progress' ? ui.bold(todo.content) : ui.muted(todo.content)
      const prefix = index === 0 ? `${INDENT}${ui.muted(RESULT)}  ` : CONTINUE
      this.screen.line(`${prefix}${mark} ${ellipsize(text, screenWidth() - 10)}`)
    })
    if (todos.length > 1) {
      this.screen.line(`${CONTINUE}${meter(Math.round((done / todos.length) * 100), 8)} ${ui.muted(`${done}/${todos.length}`)}`)
    }
  }

  /** Print one line under the current card, in the result gutter. */
  under(text) {
    this.screen.line(`${INDENT}${ui.muted(RESULT)}  ${text}`)
  }

  /**
   * One line of progress from a delegated child agent. Only its tool calls
   * surface: the child's prose and reasoning belong to its own transcript, and
   * its conclusion reaches the parent as the delegating tool's result.
   */
  child(event) {
    if (event.type !== 'tool/call') return
    let title
    try {
      const args = JSON.parse(event.data.arguments)
      title = this.definition(event.data.name)?.presentCall?.(args)?.title
    } catch {
      title = undefined
    }
    this.flush()
    this.screen.line(ui.muted(`${INDENT}${glyph.child} ${ellipsize(this.relative(title ?? event.data.name), screenWidth() - 6)}`))
  }

  /** A short surface notice that is not part of the conversation. */
  notice(text) {
    this.flush()
    this.screen.blank()
    this.screen.line(`${ui.muted(glyph.info)} ${text}`)
  }

  /** Report the end of a turn when it was not an ordinary completion. */
  turnEnd(reason) {
    this.flush()
    // Call/result pairing is turn-local, so the table retires with the turn.
    this.calls.clear()
    if (reason === undefined || reason.kind === 'completed') return
    if (reason.kind === 'aborted') {
      this.notice(ui.warning('interrupted'))
      return
    }
    if (reason.kind === 'error') {
      this.notice(ui.danger(`${reason.error?.code ?? 'ERROR'}: ${reason.error?.message ?? 'the turn failed'}`))
      return
    }
    if (reason.kind === 'max-tokens') {
      this.notice(ui.warning('stopped at the output token cap'))
      return
    }
    if (reason.kind === 'blocked') this.notice(ui.warning('the turn was blocked before it ran'))
  }

  /** A scheduled provider retry. */
  retry(data) {
    const attempt = data.maxRetries === undefined ? `${data.retry}` : `${data.retry}/${data.maxRetries}`
    this.notice(ui.warning(`retrying ${data.provider} in ${Math.round((data.delayMs ?? 0) / 100) / 10}s (${attempt}): ${data.failure?.message ?? 'request failed'}`))
  }

  /** Compaction outcome. */
  compactionEnd(data) {
    if (data.error !== undefined) {
      this.notice(ui.danger(`compaction failed: ${data.error}`))
      return
    }
    this.notice(ui.muted('conversation compacted'))
  }

  /** The session title, once the titler resolves one. */
  title(data) {
    const title = typeof data === 'string' ? data : data?.title
    if (typeof title !== 'string' || title === '') return
    this.options.onTitle?.(title)
  }

  /** Shorten an absolute path against the session's working directory. */
  relative(text) {
    const cwd = this.options.cwd
    if (typeof text !== 'string') return String(text)
    if (typeof cwd !== 'string' || cwd === '') return text
    return text.split(`${cwd}/`).join('').split(cwd).join('.')
  }
}

/**
 * A lit vertical margin, one glyph per row.
 *
 * Sampled DOWN the light field rather than across it, so a margin picks up the
 * gradient of wherever it happens to fall. How much it varies within one block
 * depends on where that block's phase lands: some stretches of the field are
 * a smooth ramp and others are nearly level, exactly as a real surface catches
 * light unevenly. What is guaranteed is variation BETWEEN blocks, since each
 * takes its own phase — a session of results is lit, not stencilled.
 * @param {number} rows - how many rows the block occupies.
 * @returns {string[]} one rendered glyph per row, index 0 unused.
 */
function litSpine(rows) {
  const phase = (Date.now() % 100000) / 1100
  const out = []
  for (let row = 0; row < rows; row += 1) {
    const value = caustic(0, row / Math.max(6, rows) - 0.5, phase, 3, 1)
    out.push(mono(0.18 + value * 0.5)(glyph.vertical))
  }
  return out
}

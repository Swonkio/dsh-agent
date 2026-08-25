/**
 * The composer: a multi-line line editor over {@link keyboard}, with history,
 * completion, and bracketed-paste support.
 *
 * It draws its own block and repaints it in place, so a wrapped or multi-line
 * prompt behaves like an editor rather than a teletype. Nothing here creates or
 * destroys a stdin reader per submission — the keyboard owns stdin for the
 * process lifetime — which is what keeps a fast paste from losing everything
 * after its first newline.
 * @module dsh-agent/editor
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { keyboard } from './keys.js'
import { chromeWidth, ellipsize, litRule, width } from './term.js'
import { glyph, heat, ui } from './theme.js'

const ESC = String.fromCharCode(27)
const CSI = `${ESC}[`

/** How many suggestion rows the menu shows before folding the rest away. */
const SUGGESTION_ROWS = 8

/**
 * Milliseconds between ambient repaints of the composer.
 *
 * Slow on purpose: this repaints the same block typing does, so a fast clock
 * competes with input and turns a keystroke burst into flicker.
 */
const DRIFT_MS = 220

/** How many submissions the on-disk history keeps. */
const HISTORY_LIMIT = 500

/** Split `text` into code points paired with their display width. */
function cells(text) {
  const out = []
  for (const char of text) out.push({ char, w: width(char) })
  return out
}

/** Read the persisted prompt history, newest last. */
function loadHistory(path) {
  if (path === undefined) return []
  try {
    return readFileSync(path, 'utf8').split('\n').filter(line => line !== '').slice(-HISTORY_LIMIT)
  } catch {
    return []
  }
}

/** The longest string every candidate starts with. */
function commonPrefix(candidates) {
  if (candidates.length === 0) return ''
  let prefix = candidates[0]
  for (const candidate of candidates.slice(1)) {
    while (prefix !== '' && !candidate.startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}

/** A multi-line composer bound to one screen. */
export class Editor {
  /**
   * @param options - `screen`, optional `historyPath`, a `completions(token, line)`
   * source, and `onKey` for keys the surface wants to own (ctrl+o, …).
   */
  constructor({ screen, historyPath, completions = () => [], onKey, hint = () => '', placeholder = '' } = {}) {
    this.screen = screen
    this.historyPath = historyPath
    this.completions = completions
    this.onKey = onKey
    this.hint = hint
    /** Phase of the ambient light along the lower edge; advanced by startDrift. */
    this.drift = 0
    this.placeholder = placeholder
    this.history = loadHistory(historyPath)
    this.text = ''
    this.cursor = 0
    this.rows = 0
    this.cursorRow = 0
    this.suggestions = []
    this.suggestIndex = 0
  }

  /** Terminal columns available to the block. */
  get columns() {
    return chromeWidth()
  }

  /** Whether there is room to draw the composer as a box. */
  get boxed() {
    return keyboard.interactive && this.columns >= 44
  }

  /** Text columns inside the box (borders and their padding removed). */
  get inner() {
    return this.boxed ? this.columns - 4 : this.columns
  }

  /**
   * Read one submission.
   * @param prompt - the styled prompt for the first row.
   * @returns the text, `null` when the user interrupted (ctrl+c), or
   * `undefined` on end of input (ctrl+d on an empty line).
   */
  read(prompt) {
    this.prompt = prompt
    this.promptWidth = width(prompt)
    this.text = ''
    this.cursor = 0
    this.historyAt = this.history.length
    this.draft = ''
    this.rows = 0
    this.cursorRow = 0
    this.refreshSuggestions()
    if (!keyboard.interactive) return this.readPiped()
    return new Promise(resolve => {
      this.paint(true)
      this.startDrift()
      const done = value => {
        this.closed = true
        this.stopDrift()
        pop()
        this.finish(value)
        resolve(value)
      }
      this.closed = false
      const pop = keyboard.push(key => { this.handle(key, done) })
    })
  }

  /** Non-TTY input: whole lines from the stream, no editing. */
  readPiped() {
    return new Promise(resolve => {
      let buffer = ''
      const pop = keyboard.push(key => {
        if (key.name === 'return' || key.name === 'newline') {
          pop()
          resolve(buffer)
          return
        }
        buffer += key.name === 'paste' ? key.text : (key.sequence ?? '')
      })
    })
  }

  /**
   * Replace the live composer with a compact echo of what was sent, so the
   * transcript keeps the prompt without keeping the box, the hint row, and the
   * empty padding around them.
   */
  finish(submitted) {
    if (!keyboard.interactive) {
      this.screen.column = 0
      return
    }
    this.eraseBlock()
    this.rows = 0
    this.cursorRow = 0
    this.screen.column = 0
    this.screen.lastWasBlank = true
    if (typeof submitted !== 'string' || submitted.trim() === '') return
    submitted.split('\n').forEach((line, at) => {
      const lead = at === 0 ? ui.accent(`${this.prompt}`) : ' '.repeat(this.promptWidth)
      this.screen.line(`${lead}${line}`)
    })
  }

  // ── rendering ────────────────────────────────────────────────────────────

  /** Lay the current text out into terminal rows and locate the cursor. */
  layout() {
    const available = Math.max(8, this.inner - this.promptWidth)
    const rows = []
    let cursorRow = 0
    let cursorColumn = this.promptWidth
    let index = 0
    for (const line of this.text.split('\n')) {
      const chunks = []
      let chunk = ''
      let used = 0
      for (const cell of cells(line)) {
        if (used + cell.w > available) {
          chunks.push(chunk)
          chunk = ''
          used = 0
        }
        chunk += cell.char
        used += cell.w
      }
      chunks.push(chunk)
      for (const piece of chunks) {
        const start = index
        const end = index + [...piece].length
        if (this.cursor >= start && this.cursor <= end) {
          cursorRow = rows.length
          cursorColumn = this.promptWidth + width(piece.slice(0, this.cursor - start))
        }
        rows.push(piece)
        index = end
      }
      // The newline itself occupies one offset between logical lines.
      index += 1
    }
    return { rows, cursorRow, cursorColumn }
  }

  /**
   * Ask for a repaint after the current batch of keys. One data chunk can
   * carry many keys — fast typing, a driver, a terminal replaying input — and
   * painting per key would emit a screenful of redraws for one keystroke burst.
   */
  /**
   * Drift the light along the composer's lower edge while the surface waits.
   *
   * Between turns nothing else moves, and a completely still surface reads as
   * a program that has stopped rather than one that is waiting. This is the
   * same caustic field the session opened with, sampled at a slowly advancing
   * phase, so the light never actually goes out.
   *
   * Deliberately slow. It repaints the composer block, which is also what
   * typing does, so a fast ambient clock would compete with input for the
   * terminal and turn a keystroke burst into a flicker. At this rate the
   * repaint is invisible and the drift is still legible.
   */
  startDrift() {
    if (this.driftTimer !== undefined || !keyboard.interactive) return
    this.driftTimer = setInterval(() => {
      if (this.closed === true) return
      this.drift += 0.09
      this.schedulePaint()
    }, DRIFT_MS)
    this.driftTimer.unref?.()
  }

  /** Stop the ambient clock; the composer is no longer on screen. */
  stopDrift() {
    if (this.driftTimer === undefined) return
    clearInterval(this.driftTimer)
    this.driftTimer = undefined
  }

  schedulePaint() {
    if (this.paintQueued === true) return
    this.paintQueued = true
    queueMicrotask(() => {
      this.paintQueued = false
      if (this.closed !== true) this.paint()
    })
  }

  /** Repaint the whole block in place. */
  paint(first = false) {
    if (!keyboard.interactive) return
    const { rows, cursorRow, cursorColumn } = this.layout()
    const lines = this.boxed ? this.boxLines(rows) : this.bareLines(rows)
    let out = ''
    if (!first) {
      if (this.cursorRow > 0) out += `${CSI}${this.cursorRow}A`
      out += `\r${CSI}0J`
    }
    out += lines.join('\n')
    // The cursor lands inside the box: one row past the top border, and one
    // border plus one space into the line.
    const cursorLine = (this.boxed ? 1 : 0) + cursorRow
    const up = lines.length - 1 - cursorLine
    if (up > 0) out += `${CSI}${up}A`
    const column = (this.boxed ? 2 : 0) + cursorColumn
    out += `\r${column > 0 ? `${CSI}${column}C` : ''}`
    process.stdout.write(out)
    this.rows = lines.length
    this.cursorRow = cursorLine
  }

  /** The composer drawn as a rounded box with a hint row beneath it. */
  boxLines(rows) {
    const bar = glyph.horizontal.repeat(this.columns - 2)
    // The top rule is dark and the BOTTOM one carries the light, because a lit
    // edge under the text reads as the surface being lit from below rather
    // than as a decorated frame around it.
    const out = [ui.line(`${glyph.topLeft}${bar}${glyph.topRight}`)]
    rows.forEach((row, at) => {
      // The caret breathes while the composer is empty and settles the moment
      // there is text: a pulsing mark is an invitation when the surface is
      // waiting for you, and a distraction once you are the one writing.
      const idle = this.text === ''
      const lead = at === 0
        ? idle ? heat(0.5 + 0.45 * Math.abs(Math.sin(this.drift * 1.7)))(this.prompt) : ui.accent(this.prompt)
        : ' '.repeat(this.promptWidth)
      const body = at === 0 && this.text === '' && this.placeholder !== ''
        ? ui.muted(ellipsize(this.placeholder, this.inner - this.promptWidth))
        : row
      const pad = ' '.repeat(Math.max(0, this.inner - this.promptWidth - width(body)))
      out.push(`${ui.line(glyph.vertical)} ${lead}${body}${pad} ${ui.line(glyph.vertical)}`)
    })
    out.push(`${ui.line(glyph.bottomLeft)}${litRule(this.columns - 2, this.drift)}${ui.line(glyph.bottomRight)}`)
    if (this.suggesting) {
      out.push(...this.suggestionLines())
      return out
    }
    const hint = this.hint()
    out.push(hint === '' ? '' : `  ${ui.muted(ellipsize(hint, this.columns - 2))}`)
    return out
  }

  /** The live menu rows: what typing `/` or `@` is offering right now. */
  suggestionLines() {
    const shown = this.suggestions.slice(0, SUGGESTION_ROWS)
    const width_ = Math.max(...shown.map(item => width(item.value)))
    const rows = shown.map((item, at) => {
      const active = at === this.suggestIndex
      const marker = active ? ui.accent(glyph.prompt) : ' '
      const value = active ? ui.bold(item.value) : ui.text(item.value)
      const pad = ' '.repeat(Math.max(0, width_ - width(item.value)))
      const hint = item.hint === undefined ? '' : ui.muted(`  ${item.hint}`)
      return `  ${marker} ${ellipsize(`${value}${pad}${hint}`, this.columns - 4)}`
    })
    if (this.suggestions.length > SUGGESTION_ROWS) {
      rows.push(`    ${ui.muted(`… +${this.suggestions.length - SUGGESTION_ROWS} more`)}`)
    }
    return rows
  }

  /** The fallback for a terminal too narrow to box: prompt, text, nothing else. */
  bareLines(rows) {
    return rows.map((row, at) => `${at === 0 ? ui.accent(this.prompt) : ' '.repeat(this.promptWidth)}${row}`)
  }

  /** Erase the block so the surface can print above it, then repaint. */
  eraseBlock() {
    if (!keyboard.interactive) return
    let out = ''
    if (this.cursorRow > 0) out += `${CSI}${this.cursorRow}A`
    out += `\r${CSI}0J`
    process.stdout.write(out)
    this.screen.column = 0
  }

  /** Move the cursor to `row` of the current block. */
  moveToRow(row) {
    if (!keyboard.interactive) return
    const delta = row - this.cursorRow
    if (delta > 0) process.stdout.write(`${CSI}${delta}B`)
    if (delta < 0) process.stdout.write(`${CSI}${-delta}A`)
    this.cursorRow = row
  }

  /** Print `lines` above the block (a completion list, a note). */
  printAbove(lines) {
    if (!keyboard.interactive) return
    this.eraseBlock()
    for (const line of lines) process.stdout.write(`${line}\n`)
    this.paint(true)
  }

  // ── editing ──────────────────────────────────────────────────────────────

  /** Insert `text` at the cursor. */
  insert(text) {
    const chars = [...this.text]
    this.text = [...chars.slice(0, this.cursor), ...[...text]].join('') + chars.slice(this.cursor).join('')
    this.cursor += [...text].length
  }

  /** Remove the range `[from, to)` and place the cursor at `from`. */
  remove(from, to) {
    const chars = [...this.text]
    const start = Math.max(0, from)
    const end = Math.min(chars.length, to)
    if (start >= end) return
    this.text = [...chars.slice(0, start), ...chars.slice(end)].join('')
    this.cursor = start
  }

  /** Offset of the start of the word before the cursor. */
  wordLeft() {
    const chars = [...this.text]
    let at = this.cursor
    while (at > 0 && /\s/.test(chars[at - 1])) at -= 1
    while (at > 0 && !/\s/.test(chars[at - 1])) at -= 1
    return at
  }

  /** Offset of the end of the word after the cursor. */
  wordRight() {
    const chars = [...this.text]
    let at = this.cursor
    while (at < chars.length && /\s/.test(chars[at])) at += 1
    while (at < chars.length && !/\s/.test(chars[at])) at += 1
    return at
  }

  /** Offset of the start of the visual line the cursor sits on. */
  lineStart() {
    const before = [...this.text].slice(0, this.cursor).join('')
    const at = before.lastIndexOf('\n')
    return at === -1 ? 0 : at + 1
  }

  /** Offset of the end of the logical line the cursor sits on. */
  lineEnd() {
    const at = this.text.indexOf('\n', this.cursor)
    return at === -1 ? [...this.text].length : at
  }

  /** Replace the buffer (history navigation) and park the cursor at its end. */
  replaceAll(text) {
    this.text = text
    this.cursor = [...text].length
  }

  // ── key handling ─────────────────────────────────────────────────────────

  /** Apply one decoded key. */
  handle(key, done) {
    if (this.onKey?.(key, this) === true) {
      this.schedulePaint()
      return
    }
    switch (key.name) {
      case 'paste':
        // A pasted block is content, never a submission: strip the trailing
        // newline the copy usually carries and keep every interior one.
        this.insert(key.text.replace(/\r\n/g, '\n').replace(/\n+$/, ''))
        break
      case 'char':
        this.insert(key.sequence)
        break
      case 'return': {
        if (key.alt === true) {
          this.insert('\n')
          break
        }
        // With the menu open, enter takes the highlighted entry unless the
        // line already IS that entry — so `/he`+enter completes, and
        // `/help`+enter sends.
        const highlighted = this.suggestions[this.suggestIndex]?.value
        if (highlighted !== undefined && highlighted !== this.token().text) {
          this.applySuggestion(highlighted)
          break
        }
        done(this.submit())
        return
      }
      case 'newline':
        this.insert('\n')
        break
      case 'backspace':
        if (key.alt === true) this.remove(this.wordLeft(), this.cursor)
        else this.remove(this.cursor - 1, this.cursor)
        break
      case 'delete':
        this.remove(this.cursor, key.alt === true ? this.wordRight() : this.cursor + 1)
        break
      case 'left':
        this.cursor = key.ctrl === true || key.alt === true ? this.wordLeft() : Math.max(0, this.cursor - 1)
        break
      case 'right':
        this.cursor = key.ctrl === true || key.alt === true
          ? this.wordRight()
          : Math.min([...this.text].length, this.cursor + 1)
        break
      case 'home':
        this.cursor = this.lineStart()
        break
      case 'end':
        this.cursor = this.lineEnd()
        break
      case 'up':
        if (this.suggesting) this.moveSuggestion(-1)
        else this.vertical(-1)
        break
      case 'down':
        if (this.suggesting) this.moveSuggestion(1)
        else this.vertical(1)
        break
      case 'tab':
        this.complete()
        break
      case 'escape':
        // Esc dismisses the menu first; a second press clears the line.
        if (this.suggesting) this.suggestions = []
        else this.replaceAll('')
        break
      case 'a':
        if (key.ctrl === true) this.cursor = this.lineStart()
        break
      case 'e':
        if (key.ctrl === true) this.cursor = this.lineEnd()
        break
      case 'u':
        if (key.ctrl === true) this.remove(this.lineStart(), this.cursor)
        break
      case 'k':
        if (key.ctrl === true) this.remove(this.cursor, this.lineEnd())
        break
      case 'w':
        if (key.ctrl === true) this.remove(this.wordLeft(), this.cursor)
        break
      case 'l':
        if (key.ctrl === true) {
          process.stdout.write(`${CSI}2J${CSI}H`)
          this.paint(true)
          return
        }
        break
      case 'c':
        if (key.ctrl === true) {
          done(null)
          return
        }
        break
      case 'd':
        if (key.ctrl !== true) break
        if (this.text === '') {
          done(undefined)
          return
        }
        this.remove(this.cursor, this.cursor + 1)
        break
      default:
        break
    }
    if (key.name !== 'escape') this.refreshSuggestions()
    this.schedulePaint()
  }

  /** Move the highlight within the menu. */
  moveSuggestion(direction) {
    const count = this.suggestions.length
    this.suggestIndex = (this.suggestIndex + direction + count) % count
  }

  /** Commit the current text and record it in history. */
  submit() {
    const text = this.text
    if (text.trim() !== '') this.remember(text)
    return text
  }

  /** Up/down: move between visual rows, or step through history at the edges. */
  vertical(direction) {
    const { rows, cursorRow, cursorColumn } = this.layout()
    const target = cursorRow + direction
    if (target >= 0 && target < rows.length) {
      this.cursor = this.offsetAt(target, cursorColumn)
      return
    }
    if (direction < 0) {
      if (this.historyAt === this.history.length) this.draft = this.text
      if (this.historyAt === 0) return
      this.historyAt -= 1
      this.replaceAll(this.history[this.historyAt])
      return
    }
    if (this.historyAt >= this.history.length) return
    this.historyAt += 1
    this.replaceAll(this.historyAt === this.history.length ? this.draft : this.history[this.historyAt])
  }

  /** The text offset nearest `column` on visual `row`. */
  offsetAt(row, column) {
    const { rows } = this.layout()
    let offset = 0
    for (let at = 0; at < row; at += 1) {
      offset += [...rows[at]].length
      // A row that ended because of an explicit newline consumes that newline.
      if (this.text[offset] === '\n') offset += 1
    }
    const wanted = Math.max(0, column - this.promptWidth)
    let used = 0
    let inRow = 0
    for (const cell of cells(rows[row] ?? '')) {
      if (used + cell.w > wanted) break
      used += cell.w
      inRow += 1
    }
    return offset + inRow
  }

  /** The whitespace-delimited token the cursor sits at the end of. */
  token() {
    const before = [...this.text].slice(0, this.cursor).join('')
    return { before, text: /(\S*)$/.exec(before)?.[1] ?? '' }
  }

  /**
   * Recompute the suggestion menu for the current token. The menu is live —
   * typing `/` opens it and every keystroke filters it — because a command
   * list the user has to know to ask for is a list they do not know exists.
   */
  refreshSuggestions() {
    const { before, text } = this.token()
    const candidates = text === '' ? [] : this.completions(text, before)
    const normalized = candidates.map(candidate => (
      typeof candidate === 'string' ? { value: candidate } : candidate
    ))
    const changed = normalized.length !== this.suggestions.length
      || normalized.some((item, at) => item.value !== this.suggestions[at]?.value)
    this.suggestions = normalized
    if (changed) this.suggestIndex = 0
    if (this.suggestIndex >= this.suggestions.length) this.suggestIndex = 0
  }

  /** Whether the menu is showing anything worth selecting from. */
  get suggesting() {
    return this.suggestions.length > 0
  }

  /** Replace the current token with `value`, leaving room to keep typing. */
  applySuggestion(value) {
    const { text } = this.token()
    const start = this.cursor - [...text].length
    this.remove(start, this.cursor)
    // A path completion into a directory keeps going; a command is complete.
    this.insert(value.endsWith('/') ? value : `${value} `)
    this.refreshSuggestions()
  }

  /** Tab: take the highlighted suggestion, or extend to the common prefix. */
  complete() {
    if (!this.suggesting) return
    const { text } = this.token()
    const values = this.suggestions.map(item => item.value)
    const highlighted = values[this.suggestIndex]
    if (values.length === 1 || highlighted !== values[0] || commonPrefix(values) === text) {
      this.applySuggestion(highlighted)
      return
    }
    const shared = commonPrefix(values)
    if (shared.length > text.length) {
      const start = this.cursor - [...text].length
      this.remove(start, this.cursor)
      this.insert(shared)
      this.refreshSuggestions()
      return
    }
    this.applySuggestion(highlighted)
  }

  /** Append one submission to the in-memory and on-disk history. */
  remember(text) {
    const flat = text.replace(/\n/g, ' ')
    if (this.history[this.history.length - 1] !== flat) {
      this.history.push(flat)
      if (this.history.length > HISTORY_LIMIT) this.history.shift()
      if (this.historyPath !== undefined) {
        try {
          appendFileSync(this.historyPath, `${flat}\n`)
        } catch {
          // History is a convenience; a read-only home must not break the session.
        }
      }
    }
    this.historyAt = this.history.length
  }
}

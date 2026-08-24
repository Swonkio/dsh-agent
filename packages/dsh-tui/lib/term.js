/**
 * Terminal primitives for dsh-tui: colors, a transient status line that never
 * collides with streamed output, text measurement/wrapping, and the three
 * input modes the surface needs (a line editor, a menu, and a key watcher).
 *
 * Everything here is process-level presentation with no dsh dependency, so the
 * runner reads as protocol logic and this file as the screen.
 * @module dsh-tui/term
 */

import { keyboard } from './keys.js'
import { glyph, gradient, heat, mono, pane, pulseColor, ui } from './theme.js'
import { caustic } from './light.js'

/** Escape and Control Sequence Introducer, built rather than written literally. */
const ESC = String.fromCharCode(27)
const CSI = ESC + '['
const ANSI_PATTERN = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g')

/** Remove SGR sequences so widths measure what a reader sees. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_PATTERN, '')
}

/** Whether a code point occupies two terminal cells. */
function isWide(code) {
  return (code >= 0x1100 && code <= 0x115F)
    || (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE30 && code <= 0xFE6F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1FAFF)
}

/** Printable width of `text`, counting wide CJK/emoji cells as two columns. */
export function width(text) {
  let total = 0
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0)
    if (code === 0x200D || (code >= 0xFE00 && code <= 0xFE0F)) continue
    total += isWide(code) ? 2 : 1
  }
  return total
}

/** The usable text width of the terminal, bounded so wide windows stay readable. */
export function screenWidth(max = 140) {
  return Math.max(40, Math.min((process.stdout.columns || 80) - 2, max))
}

/**
 * The width of the surface's chrome — banner, composer, menu cards. Wider than
 * the prose measure so panels frame the terminal, but still bounded: a box
 * drawn across 200 columns reads as a wall, not as a frame.
 */
export function chromeWidth() {
  return Math.max(40, (process.stdout.columns || 80) - 1)
}

/**
 * Wrap `text` to `limit` columns, prefixing continuation lines with `indent`.
 * Existing newlines are preserved and styled words measure by printable width.
 */
export function wrap(text, limit, indent = '') {
  const out = []
  for (const paragraph of String(text).split('\n')) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`
      if (width(candidate) <= limit || line === '') {
        line = candidate
        continue
      }
      out.push(line)
      line = indent + word
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Truncate `text` to `limit` columns with a trailing ellipsis. */
export function ellipsize(text, limit) {
  if (width(text) <= limit) return text
  let out = ''
  for (const char of stripAnsi(text)) {
    if (width(out) + 1 >= limit) break
    out += char
  }
  return `${out}…`
}

/**
 * The screen: every write goes through here so the animated status line is
 * always erased before durable output lands and never interleaves with it.
 */
export class Screen {
  constructor(out = process.stdout) {
    this.out = out
    this.tty = out.isTTY === true
    this.column = 0
    this.status = undefined
    this.statusHeight = 1
    this.statusInterval = undefined
    this.frame = 0
    this.timer = undefined
    this.lastWasBlank = true
  }

  /** Write durable output, erasing any live status line first. */
  write(text) {
    if (text === '') return
    this.eraseStatus()
    this.out.write(text)
    const lastNewline = text.lastIndexOf('\n')
    this.column = lastNewline === -1 ? this.column + width(text) : width(text.slice(lastNewline + 1))
    this.lastWasBlank = false
  }

  /** Write `text` followed by a newline. */
  line(text = '') {
    this.write(`${text}\n`)
  }

  /** Ensure the cursor sits at the start of a fresh line. */
  atLineStart() {
    if (this.column !== 0) this.write('\n')
  }

  /** Leave exactly one blank line before the next block. */
  blank() {
    this.atLineStart()
    if (this.lastWasBlank) return
    this.out.write('\n')
    this.column = 0
    this.lastWasBlank = true
  }

  /**
   * Show an animated status region under the cursor. `render(frame)` is called
   * on each tick and returns either one line or an array of lines.
   *
   * A multi-line region is transient in the same sense the single line is: it
   * is erased before any durable write and repainted afterwards, so the
   * transcript above it never accumulates HUD frames. The painted height is
   * remembered rather than recomputed, because a render whose height changes
   * between paint and erase would otherwise leave orphaned rows behind.
   * @param {(frame: number) => string | string[]} render - the per-frame renderer.
   * @param {number} [fps] - repaints per second; higher rates suit motion-heavy HUDs.
   */
  showStatus(render, fps = 10) {
    this.status = render
    if (!this.tty) return
    const interval = Math.max(16, Math.round(1000 / fps))
    if (this.timer !== undefined && this.statusInterval !== interval) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.timer === undefined) {
      this.statusInterval = interval
      this.timer = setInterval(() => { this.paintStatus() }, interval)
      this.timer.unref?.()
    }
    this.paintStatus()
  }

  /** Repaint the status region in place. */
  paintStatus() {
    if (this.status === undefined || !this.tty || this.column !== 0) return
    this.frame += 1
    const limit = (process.stdout.columns || 80) - 1
    const rendered = this.status(this.frame)
    const lines = (Array.isArray(rendered) ? rendered : [rendered]).map(line => ellipsize(line, limit))
    this.eraseStatus()
    this.statusHeight = lines.length
    // Trailing rows are joined by \n; the cursor is then walked back to the
    // first row so the next paint overwrites the same region.
    this.out.write(lines.join('\n'))
    if (lines.length > 1) this.out.write(`${CSI}${lines.length - 1}A`)
    this.out.write('\r')
  }

  /** Erase the status region without forgetting it (a later paint restores it). */
  eraseStatus() {
    if (!this.tty || this.status === undefined) return
    const height = this.statusHeight ?? 1
    this.out.write(`\r${CSI}2K`)
    for (let row = 1; row < height; row += 1) {
      this.out.write(`${CSI}1B${CSI}2K`)
    }
    if (height > 1) this.out.write(`${CSI}${height - 1}A`)
    this.out.write('\r')
    this.statusHeight = 1
  }

  /** Stop and erase the status line. */
  hideStatus() {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.eraseStatus()
    this.status = undefined
  }
}

/** Braille spinner frames, in the order they animate. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * A single-choice menu, drawn as a bordered card so a decision reads as a
 * decision rather than as more transcript. Arrows or j/k move, enter selects,
 * a digit jumps straight to a row, and esc (or ctrl+c) cancels.
 * @returns the selected index, or undefined when cancelled.
 */
export async function select(screen, { title, items, initial = 0, footer }) {
  if (items.length === 0) return undefined
  screen.hideStatus()
  screen.blank()
  if (!keyboard.interactive) return initial
  let index = Math.min(Math.max(initial, 0), items.length - 1)
  const width_ = chromeWidth()
  const inner = width_ - 4
  const bar = glyph.horizontal.repeat(width_ - 2)
  let frame = 0
  /**
   * A highlight travelling along the card's top rule.
   *
   * A menu is the one place the surface stops and waits for a person, so it is
   * the one place a still card reads as a hang rather than as a pause. The
   * sweep is confined to the border: animating the labels themselves would
   * move the text a reader is trying to choose between.
   */
  const topRule = () => {
    const span = width_ - 2
    const head = frame % (span * 2) < span ? frame % (span * 2) : span * 2 - (frame % (span * 2)) - 1
    let out = ''
    for (let x = 0; x < span; x += 1) {
      const distance = Math.abs(x - head)
      out += distance === 0 ? ui.accent(glyph.horizontal)
        : distance <= 2 ? ui.accentSoft(glyph.horizontal)
          : ui.line(glyph.horizontal)
    }
    return `${ui.line(glyph.topLeft)}${out}${ui.line(glyph.topRight)}`
  }
  /** Compose the whole card for the current selection. */
  const compose = () => {
    const body = []
    if (title !== undefined) {
      for (const line of wrap(title, inner).split('\n')) body.push(line)
      body.push('')
    }
    items.forEach((item, at) => {
      const chosen = at === index
      // The chosen row's marker breathes rather than blinking: a hard on/off
      // pulls the eye away from the labels, which is exactly where it should
      // be while the user is choosing.
      const marker = chosen ? pulseColor(frame >> 1, glyph.prompt) : ' '
      const number = ui.muted(`${at + 1}.`)
      const label = chosen ? ui.bold(item.label) : ui.text(item.label)
      body.push(`${marker} ${number} ${ellipsize(label, inner - 5)}`)
      if (item.hint !== undefined) body.push(`    ${ui.muted(ellipsize(item.hint, inner - 5))}`)
    })
    if (footer !== undefined) {
      body.push('')
      body.push(ui.muted(footer))
    }
    return [
      pane(topRule()),
      ...body.map(line => pane(`${ui.line(glyph.vertical)} ${line}${' '.repeat(Math.max(0, inner - width(line)))} ${ui.line(glyph.vertical)}`)),
      pane(ui.line(`${glyph.bottomLeft}${bar}${glyph.bottomRight}`)),
    ]
  }
  let painted = 0
  const paint = () => {
    const lines = compose()
    let out = painted === 0 ? '' : `${CSI}${painted}A`
    out += lines.map(line => `\r${CSI}2K${line}`).join('\n') + '\n'
    process.stdout.write(out)
    painted = lines.length
  }
  paint()
  screen.column = 0
  screen.lastWasBlank = false
  // The card repaints on its own clock as well as on input, so the sweep runs
  // while the user is reading rather than only when they press a key.
  const ticker = setInterval(() => {
    frame += 1
    paint()
  }, 90)
  ticker.unref?.()
  return new Promise(resolve => {
    const done = value => {
      clearInterval(ticker)
      pop()
      resolve(value)
    }
    const pop = keyboard.push(key => {
      const char = key.name === 'char' ? key.sequence : ''
      if (key.name === 'up' || char === 'k' || (key.ctrl === true && key.name === 'p')) {
        index = (index - 1 + items.length) % items.length
        paint()
        return
      }
      if (key.name === 'down' || char === 'j' || key.name === 'tab' || (key.ctrl === true && key.name === 'n')) {
        index = (index + 1) % items.length
        paint()
        return
      }
      if (/^[1-9]$/.test(char)) {
        const at = Number(char) - 1
        if (at < items.length) {
          index = at
          paint()
          done(index)
        }
        return
      }
      if (key.name === 'return') {
        done(index)
        return
      }
      if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) done(undefined)
    })
  })
}

/**
 * Observe keys without consuming them for a reader: used to watch for an
 * interrupt (and collect type-ahead) while a turn streams.
 * @returns a controller that can stand down for a nested reader and resume.
 */
export function watchKeys(handler) {
  let pop = keyboard.push(handler)
  return {
    /** Stand down while a menu or the composer owns the keyboard. */
    pause() {
      pop?.()
      pop = undefined
    },
    /** Take the keyboard back. */
    resume() {
      pop?.()
      pop = keyboard.push(handler)
    },
    stop() {
      pop?.()
      pop = undefined
    },
  }
}

/** Render a boxed banner around `lines`. */
export function box(lines, { color = ui.line, full = false, title } = {}) {
  const inner = full
    ? chromeWidth() - 4
    : Math.min(chromeWidth() - 4, Math.max(...lines.map(line => width(line)), title === undefined ? 0 : width(title) + 6))
  const bar = glyph.horizontal.repeat(inner + 2)
  // A titled panel breaks its own top rule rather than spending a row on a
  // heading, so a labelled panel is the same height as an unlabelled one.
  const head = title === undefined
    ? color(`${glyph.topLeft}${bar}${glyph.topRight}`)
    : color(`${glyph.topLeft}${glyph.horizontal}${glyph.tee} `)
      + ui.bold(gradient(title))
      + color(` ${glyph.teeClose}${glyph.horizontal.repeat(Math.max(0, inner - width(title) - 3))}${glyph.topRight}`)
  const out = [pane(head)]
  for (const line of lines) {
    out.push(pane(`${color(glyph.vertical)} ${line}${' '.repeat(Math.max(0, inner - width(line)))} ${color(glyph.vertical)}`))
  }
  out.push(pane(color(`${glyph.bottomLeft}${bar}${glyph.bottomRight}`)))
  return out.join('\n')
}

/**
 * A thought bubble: rounded body plus the trailing circles that make it read
 * as a thought rather than as speech.
 *
 * Sized to its own content rather than to the terminal, because a thought is
 * an aside — a full-width panel would give the model's deliberation the same
 * visual weight as its answer. Long text still wraps, but the bubble never
 * grows past a readable measure.
 * @param {string} text - the thought; wrapped and trimmed.
 * @param {object} [options] - rendering options.
 * @param {number} [options.indent] - columns to inset the whole bubble.
 * @param {(text: string) => string} [options.color] - colouriser for the body text.
 * @param {(text: string) => string} [options.edge] - colouriser for the outline.
 * @returns {string[]} the bubble's lines, tail last.
 */
export function bubble(text, { indent = 2, color = ui.muted, edge = ui.line } = {}) {
  const measure = Math.max(24, Math.min(chromeWidth() - indent - 6, 72))
  const body = wrap(text.trim().replace(/\s*\n\s*/g, ' '), measure).split('\n')
  const inner = Math.max(...body.map(line => width(line)))
  const pad = ' '.repeat(indent)
  // Each bubble samples the light field at its own phase, so no two carry the
  // same gradient and a transcript of them reads as separately lit objects
  // rather than as repeated stamps of one asset.
  const phase = (Date.now() % 100000) / 900
  const rule = (left, right) => `${edge(left)}${litRule(inner + 2, phase)}${edge(right)}`
  const lines = [
    `${pad}${pane(rule(glyph.topLeft, glyph.topRight))}`,
    ...body.map(line => `${pad}${pane(`${edge(glyph.vertical)} ${color(line)}${' '.repeat(inner - width(line))} ${edge(glyph.vertical)}`)}`),
    `${pad}${pane(rule(glyph.bottomLeft, glyph.bottomRight))}`,
  ]
  // The tail descends toward the left margin, shrinking as it goes, which is
  // the convention that separates a thought balloon from a speech balloon.
  if (indent >= 2) {
    lines.push(`${' '.repeat(indent - 1)}${edge(glyph.bubbleLarge)}`)
    lines.push(`${' '.repeat(Math.max(0, indent - 2))}${edge(glyph.bubbleSmall)}`)
  }
  return lines
}

/**
 * A horizontal rule lit by the surface's caustic field.
 *
 * Gives an outline the varying brightness of glass catching light along its
 * length, instead of one flat border colour. Sampled at a fixed phase rather
 * than animated: a bubble is durable transcript, and a rule that kept moving
 * after the thought was finished would pull attention back to text the reader
 * has already passed.
 * @param {number} span - length in cells.
 * @param {number} phase - where in the light field to sample.
 * @returns {string} the lit rule.
 */
export function litRule(span, phase) {
  let out = ''
  for (let x = 0; x < span; x += 1) {
    // Sharpness 1: an outline wants a sheen along its length, not filaments.
    const value = caustic(x / Math.max(1, span) - 0.5, 0, phase, 3, 1)
    out += mono(0.26 + value * 0.5)(glyph.horizontal)
  }
  return out
}

/**
 * Text lit by the surface's light field, one sample per character.
 *
 * Used for the wordmark the cold-start sequence leaves behind. The caustics
 * fade to nothing and then a plain line appears where they were, which breaks
 * the continuity the whole sequence just established; lighting that line means
 * the field does not so much end as settle into it.
 * @param {string} text - the text to light.
 * @param {number} phase - where in the field to sample.
 * @returns {string} the lit text.
 */
export function litText(text, phase) {
  const span = Math.max(1, text.length)
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ' ') { out += ' '; continue }
    const value = caustic(i / span - 0.5, 0, phase, 4, 1)
    out += heat(0.46 + value * 0.5)(text[i])
  }
  return out
}

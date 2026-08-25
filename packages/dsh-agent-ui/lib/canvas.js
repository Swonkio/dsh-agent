/**
 * A braille sub-pixel canvas.
 *
 * Each terminal cell holds a 2x4 grid of braille dots, so an 80x20 screen
 * becomes a 160x80 plotting surface — enough to draw a constellation and the
 * beams between its stars as smooth curves rather than blocky characters. Each
 * lit dot also carries a colour, and cells resolve to the colour of their
 * brightest contributor at render time.
 *
 * @module dsh-agent-ui/canvas
 */

import { RESET } from './theme.js'

// Braille dot bit per (col,row) within a cell: cols 0..1, rows 0..3.
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

export class Canvas {
  /** @param {number} cols - character columns. @param {number} rows - character rows. */
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.width = cols * 2
    this.height = rows * 4
    this.bits = new Uint8Array(cols * rows)
    // Per-cell colour escape (strongest writer wins) and its priority.
    this.ink = new Array(cols * rows).fill('')
    this.pri = new Float32Array(cols * rows)
  }

  clear() {
    this.bits.fill(0)
    this.ink.fill('')
    this.pri.fill(0)
  }

  /** Light a sub-pixel at (x,y) with a colour escape and a priority 0..1. */
  plot(x, y, escape = '', priority = 1) {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    const cell = (py >> 2) * this.cols + (px >> 1)
    this.bits[cell] |= DOT[py & 3][px & 1]
    if (priority >= this.pri[cell]) {
      this.pri[cell] = priority
      this.ink[cell] = escape
    }
  }

  /** Draw a line between two sub-pixel points (Bresenham), fading along it. */
  line(x0, y0, x1, y1, escapeAt = () => '', priority = 0.4) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    const steps = Math.max(dx, -dy) || 1
    let done = 0
    for (;;) {
      this.plot(x0, y0, escapeAt(done / steps), priority)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
      done += 1
    }
  }

  /** Render to a string of `rows` lines (no trailing newline), coloured. */
  toString(depth = 3) {
    const out = []
    for (let r = 0; r < this.rows; r += 1) {
      let line = ''
      let openInk = ''
      for (let c = 0; c < this.cols; c += 1) {
        const cell = r * this.cols + c
        const bits = this.bits[cell]
        if (bits === 0) {
          if (openInk !== '') { line += RESET; openInk = '' }
          line += ' '
          continue
        }
        const glyph = String.fromCharCode(0x2800 + bits)
        const ink = depth === 0 ? '' : this.ink[cell]
        if (ink !== openInk) {
          if (openInk !== '') line += RESET
          line += ink
          openInk = ink
        }
        line += glyph
      }
      if (openInk !== '') line += RESET
      out.push(line)
    }
    return out.join('\n')
  }
}

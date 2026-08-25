/**
 * The cold-start sequence: caustics.
 *
 * Light refracting through a moving surface, computed per pixel rather than
 * drawn — the bright web is the interference of several phase-shifted wave
 * terms, sharpened by a power curve so the crests concentrate into filaments
 * the way real caustics do. It is the same construction used for water
 * caustics in shader work, evaluated here on a half-block grid.
 *
 * The motion is deliberately slow and the palette is a single cool light
 * source, because this is the surface's one full-screen moment and it should
 * read as something lit rather than something playing.
 *
 * Degrades rather than disappears: no TTY skips the sequence, and without
 * colour the half blocks fall back to a two-level glyph.
 * @module dsh-agent/boot
 */

import { chromeWidth } from './term.js'
import { ui, heat, ink } from './theme.js'
import { caustic, lift } from './light.js'

const CSI = `${String.fromCharCode(27)}[`

/** Frames in the sequence, and the delay between them. */
const FRAMES = 104
const FRAME_MS = 33

/** Frames spent fading the field out at the end. */
const FADE_FRAMES = 14

/** The text the light etches. */
const WORDMARK = 'dsh'

/** A 5-row block alphabet, doubled vertically to match the half-block grid. */
const LETTERS = {
  d: ['   ██', '   ██', ' ████', '██  ██', ' █████'],
  s: [' ████', '██   ', ' ███ ', '    ██', '████ '],
  h: ['██   ', '██   ', '█████', '██  ██', '██  ██'],
}

/**
 * Lay the wordmark out as a set of lit cell indices on the pixel grid.
 * @param {number} cols - grid width.
 * @param {number} rows - grid height (already doubled).
 * @returns {Set<number>} indices belonging to the wordmark.
 */
function wordmarkCells(cols, rows) {
  const glyphs = [...WORDMARK].map(ch => LETTERS[ch]).filter(Boolean)
  const spacing = 3
  const totalWidth = glyphs.reduce((sum, g) => sum + Math.max(...g.map(r => r.length)) + spacing, -spacing)
  const originX = Math.floor((cols - totalWidth) / 2)
  const originY = Math.floor((rows - glyphs[0].length * 2) / 2)
  const cells = new Set()
  let x = originX
  for (const glyph of glyphs) {
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === ' ') continue
        for (let sub = 0; sub < 2; sub += 1) {
          const cx = x + col
          const cy = originY + row * 2 + sub
          if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue
          cells.add(cx + cy * cols)
        }
      }
    }
    x += Math.max(...glyph.map(r => r.length)) + spacing
  }
  return cells
}

/**
 * Play the boot sequence, then leave a single wordmark line behind.
 * @param {object} screen - the shared Screen, whose cursor bookkeeping is restored at the end.
 * @param {string} [subtitle] - the durable line printed once the sequence ends.
 * @param {string[]} [facts] - short readouts revealed under the field.
 * @returns {Promise<void>} resolves when the block has been wiped.
 */
export async function boot(screen, subtitle, facts = []) {
  if (process.stdout.isTTY !== true) {
    if (subtitle !== undefined) screen.line(subtitle)
    return
  }
  const cols = Math.min(chromeWidth(), 96)
  // One ASCII glyph per cell, so the grid IS the text area. Half blocks would
  // give twice the vertical resolution, but they are not ASCII and the point
  // here is character art: the form has to come from the glyphs themselves.
  const gridRows = 14
  const rows = gridRows + 2
  const word = wordmarkCells(cols, gridRows)
  const phase = (Date.now() % 10000) / 1000

  process.stdout.write(`${CSI}?25l`)
  try {
    for (let at = 0; at < FRAMES + FADE_FRAMES; at += 1) {
      const time = phase + at * 0.028
      // The etching rises over the middle of the run and holds; the whole
      // field then dims together rather than the letters outliving the light.
      const etch = Math.min(1, Math.max(0, (at - 34) / 30))
      const fade = at < FRAMES ? 1 : 1 - (at - FRAMES + 1) / FADE_FRAMES

      const lines = []
      for (let y = 0; y < gridRows; y += 1) {
        let line = ''
        for (let x = 0; x < cols; x += 1) {
          line += shade(x, y, cols, gridRows, time, word, etch, fade)
        }
        lines.push(line)
      }

      const shown = at < 74 ? 0 : Math.ceil(facts.length * Math.min(1, (at - 74) / 20))
      const rail = facts.slice(0, shown).map(f => ui.muted(f)).join(ui.line(' · '))
      lines.push('')
      lines.push(`${' '.repeat(Math.max(0, Math.floor((cols - visible(rail)) / 2)))}${at < FRAMES ? rail : ''}`)

      const painted = lines.map(line => `${CSI}2K${line}`).join('\n')
      process.stdout.write(at === 0 ? painted : `${CSI}${rows - 1}A\r${painted}`)
      await new Promise(resolve => { setTimeout(resolve, FRAME_MS) })
    }
    process.stdout.write(`${CSI}${rows - 1}A\r${CSI}0J`)
  } finally {
    process.stdout.write(`${CSI}?25h`)
  }
  screen.column = 0
  screen.lastWasBlank = false
  if (subtitle !== undefined) screen.line(subtitle)
}

/**
 * Render one cell of the field as a shaded ASCII glyph.
 *
 * Density and brightness are driven by the same value on purpose. The ramp has
 * about a dozen steps, which is too coarse for a smooth caustic gradient on
 * its own; shading each glyph across the greys refines it without changing the
 * character, so structure reads from the glyph and gradient from the tone.
 *
 * The wordmark is lit by the same light rather than given ink of its own, so
 * the caustics keep playing across the letters and they read as etched into
 * the surface instead of stamped over it.
 * @param {number} x - cell column.
 * @param {number} y - cell row.
 * @param {number} cols - grid width.
 * @param {number} rows - grid height.
 * @param {number} time - animation phase.
 * @param {Set<number>} word - wordmark cell indices.
 * @param {number} etch - how far the etching has risen, 0 to 1.
 * @param {number} fade - global dim, 1 to 0.
 * @returns {string} one rendered cell.
 */
function shade(x, y, cols, rows, time, word, etch, fade) {
  // A character cell is about twice as tall as it is wide, so the vertical
  // span is halved on top of the grid ratio; without it the filaments come out
  // stretched down the screen.
  const light = caustic(x / cols - 0.5, (y / rows - 0.5) * (rows / cols) * 2, time)
  // A vignette: light falls off toward the frame's edges. Without it the field
  // meets the terminal in a hard rectangle and reads as a texture pasted into
  // the window; with it the frame has a centre, and the wordmark sits in the
  // brightest part of it rather than merely in the middle of it.
  const dx = (x / cols - 0.5) * 2
  const dy = (y / rows - 0.5) * 2
  const vignette = Math.max(0, 1 - (dx * dx * 0.55 + dy * dy * 0.42))
  const lit = lift(light) * (0.35 + 0.65 * vignette)
  const value = (word.has(x + y * cols) ? lit * (1 - etch * 0.4) + etch * 0.85 : lit * 0.8) * fade
  return heat(value)(ink(value))
}

/**
 * Visible width of a string that may carry SGR escapes.
 * @param {string} text - the string to measure.
 * @returns {number} its printed width in cells.
 */
function visible(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length
}

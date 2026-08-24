/**
 * Animation primitives for the live surface.
 *
 * These are drawn every frame while the agent works, so each one is a pure
 * function of (frame, data) with no internal timers: the runner owns the clock
 * and the repaint, and a paused or backgrounded surface simply stops calling.
 * Every primitive degrades to plain ASCII when the terminal cannot do better,
 * because the information they carry — speed, pressure, acceptance — must
 * survive a dumb terminal.
 * @module dsh-tui/anim
 */

import { ui, COLORED, heat, ink, mono } from './theme.js'
import { Braille } from './braille.js'
import { caustic, lift } from './light.js'

/** Phase velocity before any decode rate is known: visible drift, no implied speed. */
const IDLE_VELOCITY = 0.55

/**
 * Glyphs the light ribbon is drawn with, dimmest first.
 *
 * Horizontal rules rather than blocks: a one-row band of solid blocks reads as
 * a bar that happens to be shaded, where rules read as a lit line.
 */
const RIBBON = ['.', '-', '=', '#']

/** ASCII partials, for a fill edge that lands between cells. */
const PARTIAL = ['.', ':', '+', '*', '=']

/**
 * Clamp a value into a unit interval, mapping non-finite input to zero so a
 * missing measurement renders as an empty gauge rather than a crash.
 * @param {number | undefined} value - the raw ratio.
 * @returns {number} a finite ratio in [0, 1].
 */
function unit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}



/**
 * A segmented gauge that changes role colour as it fills.
 *
 * Used for context pressure, where the thresholds are not decorative: the
 * warning band starts where auto-compaction becomes likely within a turn or
 * two, so the colour change is the user's notice that a summarization pass is
 * coming.
 * @param {number} ratio - fill in [0, 1].
 * @param {number} width - how many cells to fill.
 * @returns {string} one rendered row.
 */
export function gauge(ratio, width) {
  const clamped = unit(ratio)
  // Any non-zero occupancy shows at least one cell. Rounding alone reports
  // everything under half a cell as empty, so a context holding thousands of
  // tokens draws identically to a fresh one.
  const exact = clamped * width
  const filled = exact > 0 ? Math.max(1, Math.round(exact)) : 0
  // Semantic colour survives here on purpose: this is the one meter whose
  // reading changes what happens next, and amber/red at the compaction
  // thresholds is information, not decoration.
  const tone = clamped >= 0.9 ? ui.danger : clamped >= 0.75 ? ui.warning : ui.success
  if (filled === 0) return ui.line('-'.repeat(width))
  // The leading cell is drawn as a partial block chosen by the fractional
  // remainder, so the level reads as a liquid surface sitting between two
  // cells rather than snapping a whole cell at a time.
  const remainder = exact - Math.floor(exact)
  const meniscus = remainder > 0.1 && filled < width ? PARTIAL[Math.min(PARTIAL.length - 1, Math.floor(remainder * PARTIAL.length))] : ''
  const solid = meniscus === '' ? filled : filled - 1
  return `${tone('#'.repeat(Math.max(0, solid)))}${meniscus === '' ? '' : tone(meniscus)}`
    + `${ui.line('-'.repeat(Math.max(0, width - Math.max(0, solid) - (meniscus === '' ? 0 : 1))))}`
}

/**
 * Sweep a highlight through text, one cell per frame.
 *
 * Applied to streaming reasoning: the text is already dim, and a moving bright
 * band reads as "still arriving" without the surface having to reserve a
 * separate spinner cell beside it.
 * @param {string} text - the text to sweep.
 * @param {number} frame - the repaint counter.
 * @returns {string} the text with one bright band.
 */
export function shimmer(text, frame) {
  if (!COLORED || text.length === 0) return ui.thought(text)
  const head = frame * 2 % (text.length + 24)
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const distance = Math.abs(i - head)
    out += distance < 3 ? ui.bold(ui.thought(text[i])) : ui.dim(ui.thought(text[i]))
  }
  return out
}

/**
 * The speculative-decode dial: how many tokens each forward pass yielded.
 *
 * Scaled against the configured draft ceiling rather than a fixed maximum, so
 * a full bar means drafting is doing everything it possibly can on this
 * deployment and a near-empty one means the draft head is being rejected.
 * @param {number | undefined} tokensPerStep - cumulative tokens per decode step.
 * @param {number} ceiling - `--spec-draft-n-max` plus one.
 * @param {number} width - how many cells to fill.
 * @returns {string} one rendered row.
 */
export function draftDial(tokensPerStep, ceiling, width) {
  if (tokensPerStep === undefined) return ui.line('-'.repeat(width))
  const ratio = unit((tokensPerStep - 1) / Math.max(1, ceiling - 1))
  const filled = Math.round(ratio * width)
  const tone = ratio >= 0.7 ? ui.success : ratio >= 0.35 ? ui.warning : ui.muted
  return `${tone('='.repeat(filled))}${ui.line('-'.repeat(Math.max(0, width - filled)))}`
}


/**
 * A rotating quadrant mark. Reads as a live process at a glance and costs one
 * cell, so it can sit inside a row that is otherwise full of numbers.
 * @param {number} frame - the repaint counter.
 * @returns {string} one glyph.
 */
export function rotor(frame) {
  // Quarter arcs, not filled halves: a thin lit segment travelling a ring
  // reads as a highlight moving over a curved surface, where a rotating solid
  // reads as a loading spinner. Stepped every other frame so it turns at a
  // pace that suits the rest of the surface.
  // The classic four-stroke ASCII spinner, brightened and dimmed as it turns
  // so it reads as something lit rather than something flipping between four
  // unrelated glyphs.
  const strokes = ['|', '/', '-', '\\']
  const at = (frame >> 1) % strokes.length
  return mono(0.55 + 0.4 * Math.abs(Math.sin(frame * 0.18)))(strokes[at])
}


/**
 * The token string as an oscilloscope trace.
 *
 * Braille gives four pixel rows per character row, so the wave is drawn as a
 * connected line rather than quantised into block heights — consecutive
 * samples are joined, which is what stops a fast-moving crest from reading as
 * a row of disconnected steps.
 *
 * The trace is centred on a midline: the string carries signed displacement,
 * and drawing it from a baseline would throw away every trough.
 * @param {object} string - the String1D to draw; its cell count should be twice `cells`.
 * @param {number} cells - width in character cells.
 * @param {number} gain - pixels of deflection per unit amplitude.
 * @returns {string} one rendered row.
 */
export function scope(string, cells, gain = 26) {
  const canvas = new Braille(cells, 1)
  const mid = (canvas.height - 1) / 2
  const at = x => mid - Math.max(-mid, Math.min(mid, string.now[Math.min(string.size - 1, x)] * gain))
  for (let x = 0; x < canvas.width; x += 1) {
    if (x === 0) canvas.plot(0, at(0))
    else canvas.line(x - 1, at(x - 1), x, at(x))
  }
  // Colour per cell by the larger of its two samples, so a crest tints the
  // cell it passes through even when only half of it is displaced.
  return canvas.row(0, cell => {
    const a = Math.abs(string.now[cell * 2] ?? 0)
    const b = Math.abs(string.now[cell * 2 + 1] ?? 0)
    return heat(0.34 + Math.min(0.62, Math.max(a, b) * 14))
  })
}

/**
 * A series as a filled Braille trace, newest at the right.
 * @param {number[]} samples - the series; shorter than the canvas pads on the left.
 * @param {number} cells - width in character cells.
 * @returns {string} one rendered row.
 */
export function trace(samples, cells) {
  const canvas = new Braille(cells, 1)
  const width = canvas.width
  const recent = samples.slice(-width)
  const peak = Math.max(...recent, 1)
  const offset = width - recent.length
  const heightOf = value => (canvas.height - 1) * (1 - unit(value / peak))
  for (let i = 0; i < recent.length; i += 1) {
    const x = offset + i
    if (i === 0) canvas.plot(x, heightOf(recent[0]))
    else canvas.line(x - 1, heightOf(recent[i - 1]), x, heightOf(recent[i]))
  }
  return mono(0.62)(canvas.row(0))
}

/**
 * A ribbon of the same caustic light that opens the session.
 *
 * Sampled along a single row of the field the cold-start sequence fills, so
 * the light playing under a working turn is literally the same illumination,
 * moving at the same rate. That continuity is the point: an unrelated
 * decoration in the same palette would read as a second effect rather than as
 * the surface still being lit.
 *
 * Drawn at a lower spatial frequency than the full field, because a row one
 * cell tall cannot resolve fine filaments — at boot density it degrades into
 * flicker.
 * @param {number} frame - the repaint counter.
 * @param {number} width - how many cells to fill.
 * @returns {string} one rendered row.
 */
export function ribbon(frame, width) {
  if (width <= 0) return ''
  const time = frame * 0.05
  let out = ''
  for (let x = 0; x < width; x += 1) {
    const value = lift(caustic(x / width - 0.5, 0, time, 6))
    // The floor keeps the rule visible between filaments. Without it the band
    // is mostly unlit, which reads as a broken line rather than a lit one:
    // caustic intensity spends most of its range near zero.
    out += heat(0.16 + value * 0.74)(RIBBON[Math.min(RIBBON.length - 1, Math.floor(value * RIBBON.length))])
  }
  return out
}

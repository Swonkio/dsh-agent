/**
 * Shared render primitives: the wordmark, meters, and a framed panel, all
 * depth-aware and width-aware. Pure string builders — no I/O, no cursor
 * control — so the HUD and the boot's final frame share one look and the
 * tests can assert on plain strings.
 *
 * @module dsh-agent-ui/render
 */

import { PALETTE, RESET, paint, heat } from './theme.js'

/** Visible width of a string, ignoring SGR escapes. */
export function visibleWidth(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length
}

/** Pad a string (that may contain escapes) to a visible width. */
export function padVisible(text, width) {
  const gap = width - visibleWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

/**
 * The dsh-agent wordmark: a compact "sigil" plus the name. The sigil is a
 * caduceus-adjacent double-helix bracket — a nod to Hermes lineage without
 * copying its ☤ — that reads as "a mind that keeps two strands: memory and
 * skill". Falls back cleanly when unicode or colour is unavailable.
 */
export function wordmark(depth, opts = {}) {
  const glyph = opts.ascii ? '<>' : '❯⟨⟩'
  const sigil = paint(glyph, PALETTE.gold, depth)
  const name = paint('dsh', PALETTE.gold, depth) + paint('·', PALETTE.amber, depth) + paint('agent', PALETTE.text, depth)
  return `${sigil} ${name}`
}

/**
 * A horizontal meter. `filled/total` of `width` cells, coloured by fraction on
 * the synaptic ramp when a heat bar is wanted, or a flat palette colour.
 */
export function meter(fraction, width, depth, opts = {}) {
  const f = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
  const on = Math.round(f * width)
  const full = opts.glyph ?? '█'
  const empty = opts.empty ?? '·'
  let bar = ''
  if (depth === 0) {
    bar = full.repeat(on) + empty.repeat(width - on)
  } else if (opts.ramp) {
    for (let i = 0; i < on; i += 1) bar += `${heat(width <= 1 ? f : i / (width - 1), depth)}${full}`
    bar += RESET + paint(empty.repeat(width - on), PALETTE.faint, depth)
  } else {
    const col = opts.color ?? (f > 0.85 ? PALETTE.warn : PALETTE.alive)
    bar = paint(full.repeat(on), col, depth) + paint(empty.repeat(width - on), PALETTE.faint, depth)
  }
  return bar
}

/** A tiny sparkline from values 0..1. */
export function spark(values, depth, col = PALETTE.amber) {
  const ticks = '▁▂▃▄▅▆▇█'
  const s = values.map(v => ticks[Math.min(7, Math.max(0, Math.round(v * 7)))]).join('')
  return paint(s, col, depth)
}

/**
 * A framed panel. `title` sits in the top rule; `rows` are pre-rendered
 * (escape-carrying) lines, padded to the inner width.
 */
export function panel(title, rows, width, depth) {
  const inner = Math.max(10, width - 2)
  const L = PALETTE.line
  const titleText = title === '' ? '' : ` ${paint(title, PALETTE.amber, depth)} `
  const titleW = visibleWidth(titleText)
  const dashes = Math.max(0, inner - titleW - 1)
  const top = paint('╭─', L, depth) + titleText + paint('─'.repeat(dashes) + '╮', L, depth)
  const bottom = paint('╰' + '─'.repeat(inner) + '╯', L, depth)
  const body = rows.map(row => {
    const bar = paint('│', L, depth)
    return `${bar} ${padVisible(row, inner - 2)} ${bar}`
  })
  return [top, ...body, bottom].join('\n')
}

/** Two-column key/value row for inside a panel. */
export function kv(key, value, innerWidth, depth) {
  const k = paint(key, PALETTE.muted, depth)
  const gap = Math.max(1, innerWidth - 2 - visibleWidth(k) - visibleWidth(value))
  return `${k}${' '.repeat(gap)}${value}`
}

/**
 * dsh-agent's palette and terminal-capability detection.
 *
 * The interactive dsh (dsh-tui) is ice-blue and glass — cool, still, a surface
 * you look THROUGH. dsh-agent is deliberately the opposite: warm amber and
 * gold, the colour of lamplight and old paper, with one living green. It is an
 * agent that REMEMBERS, so its identity is warmth and accumulation, not glass.
 * Seeing the two side by side, you should never mistake which one you launched.
 *
 * Every colour is defined three ways — 24-bit truecolor, the nearest xterm-256
 * index, and a bare SGR attribute — and the renderer picks the richest the
 * terminal actually advertises. NO_COLOR blanks all of it; a non-colour
 * terminal still gets legible text, never escape soup.
 *
 * @module dsh-agent-ui/theme
 */

/** Colour depth the current stream supports: 3 = truecolor, 2 = 256, 0 = none. */
export function colorDepth(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0
  if (env.DSH_AGENT_FORCE_COLOR === '3') return 3
  if (env.DSH_AGENT_NO_COLOR === '1') return 0
  if (stream && stream.isTTY === false && env.DSH_AGENT_FORCE_COLOR === undefined) return 0
  const term = (env.TERM ?? '').toLowerCase()
  if (term === 'dumb' || term === '') return 0
  const colorterm = (env.COLORTERM ?? '').toLowerCase()
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 3
  if (term.includes('256')) return 2
  return term.includes('color') ? 2 : 0
}

const ESC = '\x1b['

/**
 * A colour carrying all three encodings. `fg(depth)` / `bg(depth)` return the
 * escape for the given depth; depth 0 returns an empty string.
 */
export function color([r, g, b], xterm256, attr) {
  return {
    rgb: [r, g, b],
    fg(depth) {
      if (depth >= 3) return `${ESC}38;2;${r};${g};${b}m`
      if (depth === 2) return `${ESC}38;5;${xterm256}m`
      return attr ? `${ESC}${attr}m` : ''
    },
    bg(depth) {
      if (depth >= 3) return `${ESC}48;2;${r};${g};${b}m`
      if (depth === 2) return `${ESC}48;5;${xterm256}m`
      return ''
    },
  }
}

export const RESET = `${ESC}0m`

/** The dsh-agent palette. */
export const PALETTE = {
  // The signature: warm gold, the colour the wordmark and live nodes burn.
  gold: color([255, 196, 92], 214, 33),
  amber: color([214, 148, 58], 179, 33),
  ember: color([150, 92, 34], 130, 31),
  // The one living colour — a memory confirmed, a healthy skill, a heartbeat.
  alive: color([120, 214, 148], 114, 32),
  // A skill failing when used, a contradiction standing unresolved.
  warn: color([232, 132, 96], 209, 31),
  // Structure and quiet text.
  text: color([230, 222, 208], 253, 37),
  muted: color([150, 138, 120], 245, 90),
  faint: color([92, 84, 72], 240, 90),
  line: color([70, 62, 52], 238, 90),
}

/** The synaptic ramp: cold ember → warm gold, indexed 0..1 for node heat. */
const RAMP = [
  [58, 44, 34], [92, 60, 34], [140, 84, 40], [190, 120, 52],
  [230, 160, 70], [255, 196, 92], [255, 224, 150],
]

/** A gradient step 0..1 as an fg escape, for constellation heat and beams. */
export function heat(t, depth) {
  if (depth === 0) return ''
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  const scaled = clamped * (RAMP.length - 1)
  const low = Math.floor(scaled)
  const high = Math.min(RAMP.length - 1, low + 1)
  const f = scaled - low
  const mix = i => Math.round(RAMP[low][i] + (RAMP[high][i] - RAMP[low][i]) * f)
  return color([mix(0), mix(1), mix(2)], 214, 33).fg(depth)
}

/** Paint `text` in a palette colour, respecting depth; a no-op when depth 0. */
export function paint(text, col, depth) {
  if (depth === 0 || col === undefined) return text
  return `${col.fg(depth)}${text}${RESET}`
}

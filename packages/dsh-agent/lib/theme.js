/**
 * The palette. One warm accent, one muted gray, and semantic roles for the
 * rest — so the surface reads as a designed thing rather than as whatever
 * color each call site reached for.
 *
 * Depth is detected once: truecolor when the terminal advertises it, 256 when
 * it does not, and nothing at all when output is piped or NO_COLOR is set.
 * Every role degrades to a sensible basic color, so a dumb terminal still gets
 * meaning from color rather than a wall of escape codes.
 * @module dsh-agent/theme
 */

const ESC = String.fromCharCode(27)
const CSI = `${ESC}[`

/** How much color this terminal can take. */
function depth() {
  if (process.stdout.isTTY !== true) return 0
  if ((process.env.NO_COLOR ?? '') !== '') return 0
  const term = process.env.TERM ?? ''
  if (term === 'dumb') return 0
  const colorterm = process.env.COLORTERM ?? ''
  if (/truecolor|24bit/i.test(colorterm)) return 3
  if (/256|kitty|alacritty|wezterm|ghostty/i.test(`${term}${colorterm}`)) return 2
  return 1
}

const DEPTH = depth()

/**
 * One color in three depths: truecolor rgb, the nearest xterm-256 index, and
 * a basic SGR code for everything older.
 */
function color([r, g, b], index, basic) {
  if (DEPTH === 0) return text => String(text)
  const open = DEPTH === 3 ? `38;2;${r};${g};${b}` : DEPTH === 2 ? `38;5;${index}` : String(basic)
  return text => `${CSI}${open}m${text}${CSI}39m`
}

/** A background wash, used sparingly — diff rows and the odd badge. */
function background([r, g, b], index, basic) {
  if (DEPTH === 0) return text => String(text)
  const open = DEPTH === 3 ? `48;2;${r};${g};${b}` : DEPTH === 2 ? `48;5;${index}` : String(basic)
  return text => `${CSI}${open}m${text}${CSI}49m`
}

/** A bare SGR attribute (bold, dim, italic, strikethrough). */
function attribute(on, off) {
  if (DEPTH === 0) return text => String(text)
  return text => `${CSI}${on}m${text}${CSI}${off}m`
}

/**
 * Semantic roles. Reach for these, never for a raw color.
 *
 * The palette is glass: cool, desaturated, and low-contrast by design. Borders
 * sit barely above the background because a pane's edge should be inferred
 * rather than drawn, and the one accent is a pale ice blue that reads as lit
 * rather than painted. Nothing here is fully saturated — saturation is what
 * makes a terminal UI feel like a toolbar instead of a surface.
 */
export const ui = {
  /** The one accent: prompts, borders, the live spinner, tool marks. */
  accent: color([146, 205, 225], 152, 36),
  /** A quieter accent for supporting glyphs beside it. */
  accentSoft: color([94, 143, 166], 109, 36),
  /** Ordinary prose the user is meant to read. */
  text: color([214, 224, 231], 253, 37),
  /** Secondary information: hints, meta, folded tails. */
  muted: color([124, 140, 152], 245, 90),
  /** Structure: borders, gutters, rules. Deliberately close to the ground. */
  line: color([58, 72, 82], 238, 90),
  /** Something worked, or was added. */
  success: color([139, 201, 168], 115, 32),
  /** Something failed, or was removed. */
  danger: color([216, 138, 138], 174, 31),
  /** Something needs a decision. */
  warning: color([219, 190, 138], 180, 33),
  /** Paths, ids, and other machine tokens inside prose. */
  token: color([158, 190, 220], 110, 36),
  /** Reasoning, plans, and other model-internal text. */
  thought: color([158, 170, 200], 146, 35),
  /** Washes for diff rows. */
  addBg: background([26, 48, 40], 22, 42),
  removeBg: background([58, 32, 34], 52, 41),
  bold: attribute(1, 22),
  dim: attribute(2, 22),
  italic: attribute(3, 23),
  strike: attribute(9, 29),
  underline: attribute(4, 24),
}

/**
 * The frosted fill behind a pane.
 *
 * Glass reads as glass because a surface sits fractionally above its ground,
 * not because it has a border. This is that lift: a wash a few values lighter
 * than a dark terminal, applied across a panel's full width so its edges are
 * felt rather than outlined.
 *
 * Truecolor only. The 256-colour cube has no step this small — the nearest
 * index is either invisible or a slab — so lower depths get no fill and lean
 * on the border instead, which is why the border is still drawn at all.
 */
export const PANE = DEPTH === 3 ? `${CSI}48;2;22;28;34m` : ''

/** Closes {@link PANE}. Empty when no fill was opened. */
export const PANE_OFF = PANE === '' ? '' : `${CSI}49m`

/**
 * Wrap one line in the frosted pane fill.
 *
 * The fill is re-opened after every reset the content emits: a colouriser that
 * ends with `39m`/`49m` would otherwise punch a hole in the pane wherever
 * coloured text sits inside it.
 * @param {string} text - the line's content, which may carry its own colours.
 * @returns {string} the line, filled.
 */
export function pane(text) {
  if (PANE === '') return text
  return `${PANE}${text.replaceAll(`${CSI}49m`, PANE)}${PANE_OFF}`
}

/** The glyphs the surface draws with, in one place. */
export const glyph = {
  /** A tool call, and the mark the whole transcript is built around. */
  call: '⏺',
  /** The result hanging under a call. */
  result: '⎿',
  /** A delegated child's activity. */
  child: '⤷',
  /** The composer's prompt. */
  prompt: '›',
  /** Rounded box corners and edges. */
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  /** Todo states. */
  done: '✓',
  active: '▸',
  pending: '○',
  /** The brackets that break a panel's top rule around its title. */
  tee: '┤',
  teeClose: '├',
  /** The thought bubble's trailing circles, largest first. */
  bubbleLarge: '○',
  bubbleSmall: '∘',
  /** Notices. */
  info: '·',
  warn: '!',
  ask: '?',
}

/** The pulsing mark shown while the agent works. */
export const PULSE = ['✢', '✳', '∗', '✻', '✽', '✻', '∗', '✳']

/** The accent's two ends, for gradients and for the pulse's colour cycle. */
const GRADIENT_FROM = [146, 205, 225]
const GRADIENT_TO = [176, 190, 226]

/** Mix two rgb triples; `t` runs 0 → 1. */
function mix(from, to, t) {
  return from.map((channel, at) => Math.round(channel + (to[at] - channel) * t))
}

/** Wrap one already-rendered string in an rgb foreground. */
function paint([r, g, b], text) {
  if (DEPTH === 0) return text
  if (DEPTH === 3) return `${CSI}38;2;${r};${g};${b}m${text}${CSI}39m`
  // Without truecolor a gradient would band badly; the accent reads better.
  return `${CSI}38;5;209m${text}${CSI}39m`
}

/**
 * Spread a colour ramp across `text`, one step per visible character. Used for
 * the wordmark and the pulse — the places where a little motion or depth
 * earns its keep.
 */
export function gradient(text, from = GRADIENT_FROM, to = GRADIENT_TO, offset = 0) {
  if (DEPTH === 0) return String(text)
  const characters = [...String(text)]
  return characters
    .map((char, at) => {
      if (char === ' ') return char
      const t = characters.length === 1 ? 0 : ((at / (characters.length - 1)) + offset) % 1
      return paint(mix(from, to, t < 0 ? t + 1 : t), char)
    })
    .join('')
}

/** One step of the pulse's colour cycle, for the running-turn mark. */
export function pulseColor(frame, text) {
  const t = (Math.sin(frame / 4) + 1) / 2
  return paint(mix(GRADIENT_FROM, GRADIENT_TO, t), text)
}

/** A meter: filled and empty cells with a percentage, coloured by level. */
export function meter(percent, cells = 10) {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  const bar = '▰'.repeat(filled) + '▱'.repeat(cells - filled)
  const paintBar = percent >= 85 ? ui.danger : percent >= 70 ? ui.warning : ui.accentSoft
  return `${paintBar(bar)} ${ui.muted(`${percent}%`)}`
}

/** Whether color is available at all (tests and layout math ask). */
export const COLORED = DEPTH > 0

/**
 * The light palette, darkest first. It runs from the ground a pane sits on,
 * up through the accent, to a near-white highlight — the range of a single
 * cool light source rather than a hue wheel, so a field's shape reads as
 * illumination and not as a heat map.
 */
const WAVE_STOPS = [
  [16, 22, 30],
  [28, 54, 72],
  [46, 96, 118],
  [86, 150, 168],
  [146, 205, 225],
  [226, 240, 246],
]

/**
 * Interpolate the wave palette.
 *
 * Returns a plain colouriser rather than a colour so call sites stay uniform
 * with the semantic roles in {@link ui}; on a terminal without colour it is
 * the identity, and the field still reads through its glyph ramp alone.
 * @param {number} t - position in the palette, 0 (deepest trough) to 1 (brightest crest).
 * @returns {(text: string | number) => string} a colouriser for that point.
 */
export function waveColor(t) {
  if (DEPTH === 0) return text => String(text)
  const rgb = waveRGB(t)
  if (DEPTH === 3) return text => `${CSI}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${CSI}39m`
  // The 6x6x6 cube is coarse enough that neighbouring stops can collapse onto
  // one index; that is acceptable degradation, the glyph ramp still separates them.
  const cube = rgb.map(channel => Math.round(channel / 255 * 5))
  const index = 16 + 36 * cube[0] + 6 * cube[1] + cube[2]
  return text => `${CSI}38;5;${index}m${text}${CSI}39m`
}

/**
 * The wave palette as raw channels, for callers that composite colours
 * themselves rather than wrapping text.
 * @param {number} t - position in the palette, 0 to 1.
 * @returns {[number, number, number]} the interpolated rgb triple.
 */
export function waveRGB(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  const span = clamped * (WAVE_STOPS.length - 1)
  const low = Math.min(WAVE_STOPS.length - 1, Math.floor(span))
  const high = Math.min(WAVE_STOPS.length - 1, low + 1)
  const mix = span - low
  return WAVE_STOPS[low].map((channel, i) => Math.round(channel + (WAVE_STOPS[high][i] - channel) * mix))
}

/**
 * Composite two vertically stacked pixels into one character cell.
 *
 * A cell is drawn as an upper half block: the foreground paints the top pixel
 * and the background paints the bottom one. That doubles vertical resolution,
 * which matters because a terminal is wide and short — a simulation given only
 * as many rows as there are text lines has too little vertical room for
 * structure, and the pixels are twice as tall as they are wide so anything
 * isotropic comes out visibly stretched. Half blocks fix both at once.
 * @param {[number, number, number]} top - rgb of the upper pixel.
 * @param {[number, number, number]} bottom - rgb of the lower pixel.
 * @returns {string} one rendered cell.
 */
export function halfBlock(top, bottom) {
  if (DEPTH === 0) {
    // Without colour the two pixels can only be spent on one glyph each way.
    const lit = (top[0] + top[1] + top[2]) / 3 > 60
    const under = (bottom[0] + bottom[1] + bottom[2]) / 3 > 60
    return lit && under ? '█' : lit ? '▀' : under ? '▄' : ' '
  }
  if (DEPTH === 3) {
    return `${CSI}38;2;${top[0]};${top[1]};${top[2]}m${CSI}48;2;${bottom[0]};${bottom[1]};${bottom[2]}m▀${CSI}39m${CSI}49m`
  }
  const cube = rgb => 16 + 36 * Math.round(rgb[0] / 255 * 5) + 6 * Math.round(rgb[1] / 255 * 5) + Math.round(rgb[2] / 255 * 5)
  return `${CSI}38;5;${cube(top)}m${CSI}48;5;${cube(bottom)}m▀${CSI}39m${CSI}49m`
}

/**
 * Grayscale, for the ASCII art.
 *
 * The animations are monochrome by design: their form comes from character
 * density, and colour competes with that reading rather than adding to it. But
 * density alone is coarse — a ramp has maybe a dozen usable steps — so shading
 * each glyph across the greys doubles the tonal range without touching the
 * character choice. Character shape carries the structure; brightness carries
 * the gradient.
 *
 * Truecolor gets a true grey; 256 uses the 24-step grey rail (232-255), which
 * is finer than anything the colour cube offers on the diagonal.
 * @param {number} t - brightness, 0 (black) to 1 (white).
 * @returns {(text: string | number) => string} a colouriser for that level.
 */
export function mono(t) {
  if (DEPTH === 0) return text => String(text)
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  if (DEPTH === 3) {
    const v = Math.round(16 + clamped * 239)
    return text => `${CSI}38;2;${v};${v};${v}m${text}${CSI}39m`
  }
  if (DEPTH === 2) {
    const step = 232 + Math.round(clamped * 23)
    return text => `${CSI}38;5;${step}m${text}${CSI}39m`
  }
  // Basic terminals have only bold-vs-normal to spend on brightness.
  return clamped > 0.6 ? text => `${CSI}1m${text}${CSI}22m` : text => String(text)
}

/**
 * The ASCII density ramp, darkest first.
 *
 * Chosen so each step is a visible jump in ink coverage at terminal sizes:
 * ramps with dozens of glyphs look smooth in a proportional preview and turn
 * to noise in a monospace cell, because neighbouring characters differ by less
 * than the eye resolves at that scale.
 */
export const ASCII_RAMP = ' .`:;+*oOX#@'

/**
 * Pick the ramp glyph for a brightness.
 * @param {number} t - brightness, 0 to 1.
 * @returns {string} one character.
 */
export function ink(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  return ASCII_RAMP[Math.min(ASCII_RAMP.length - 1, Math.floor(clamped * ASCII_RAMP.length))]
}

/**
 * Where the greys stop and the highlight begins.
 *
 * Below this the art is pure monochrome; only the top of the range takes
 * colour. Keeping the threshold high is the whole point — a tint applied
 * across the range makes the art *coloured*, which is what the grey discipline
 * was avoiding, while a tint confined to the crests makes it *lit*.
 */
const HEAT_FLOOR = 0.72

/** The colour the brightest light carries: a pale cyan-white, as through water. */
const HEAT_TOP = [176, 232, 255]

/**
 * Grayscale with a cool highlight in the top of the range.
 *
 * Real caustics are not uniformly white: the crests where light concentrates
 * read cooler and brighter than the wash around them. This reproduces that
 * with one rule — below {@link HEAT_FLOOR} nothing changes, above it the grey
 * is blended toward {@link HEAT_TOP} in proportion to how far past the floor
 * it sits, so only genuine crests take colour and the structure still comes
 * from the character ramp.
 * @param {number} t - brightness, 0 (black) to 1 (white).
 * @returns {(text: string | number) => string} a colouriser for that level.
 */
export function heat(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  if (DEPTH === 0 || clamped < HEAT_FLOOR) return mono(clamped)
  const mix = (clamped - HEAT_FLOOR) / (1 - HEAT_FLOOR)
  const grey = 16 + clamped * 239
  const rgb = HEAT_TOP.map(channel => Math.round(grey + (channel - grey) * mix))
  if (DEPTH === 3) return text => `${CSI}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${CSI}39m`
  const cube = rgb.map(channel => Math.round(channel / 255 * 5))
  const index = 16 + 36 * cube[0] + 6 * cube[1] + cube[2]
  return text => `${CSI}38;5;${index}m${text}${CSI}39m`
}

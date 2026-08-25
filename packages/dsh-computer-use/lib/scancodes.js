/**
 * PS/2 set-1 scancodes, the alphabet VirtualBox's keyboard injection speaks.
 *
 * A press is the code; the matching release is the code with bit 0x80 set.
 * Extended keys (arrows, navigation) are prefixed 0xE0. Shifted characters are
 * expressed as a base key plus a shift wrap rather than a separate code.
 * @module dsh-computer-use/scancodes
 */

/** Unshifted keys, by the character or key name a caller writes. */
const BASE = {
  escape: 0x01, '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07,
  '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b, '-': 0x0c, '=': 0x0d, backspace: 0x0e,
  tab: 0x0f, q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17,
  o: 0x18, p: 0x19, '[': 0x1a, ']': 0x1b, enter: 0x1c, return: 0x1c, ctrl: 0x1d,
  a: 0x1e, s: 0x1f, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26,
  ';': 0x27, "'": 0x28, '`': 0x29, shift: 0x2a, '\\': 0x2b, z: 0x2c, x: 0x2d, c: 0x2e,
  v: 0x2f, b: 0x30, n: 0x31, m: 0x32, ',': 0x33, '.': 0x34, '/': 0x35, alt: 0x38,
  ' ': 0x39, space: 0x39, capslock: 0x3a,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40,
  f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
}

/** Characters reached by holding shift, mapped to the unshifted key. */
const SHIFTED = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', ':': ';', '"': "'",
  '~': '`', '|': '\\', '<': ',', '>': '.', '?': '/',
}

/** Keys behind the 0xE0 extended prefix. */
const EXTENDED = {
  up: 0x48, down: 0x50, left: 0x4b, right: 0x4d,
  home: 0x47, end: 0x4f, pageup: 0x49, pagedown: 0x51,
  insert: 0x52, delete: 0x53, win: 0x5b, meta: 0x5b,
}

/** Render a press+release pair for one base code. */
function tap(code) {
  return [code, code | 0x80]
}

/** Render a press+release pair for one extended code. */
function tapExtended(code) {
  return [0xe0, code, 0xe0, code | 0x80]
}

/**
 * Translate a key name or single character into scancodes.
 * @param key - `a`, `Enter`, `ctrl+alt+delete`, `F4`, `up` …
 * @returns the scancode sequence, or undefined when the key is unknown.
 */
export function keyToScancodes(key) {
  // A literal space is a key, not whitespace to be trimmed away. Splitting a
  // chord on '+' and trimming each part erases it, which silently dropped
  // every space out of typed text.
  if (key === ' ') return tap(BASE[' '])
  const parts = String(key).split('+').map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) return undefined

  // A chord: every part but the last is a modifier held across the final key.
  const target = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1).map(m => m.toLowerCase())

  const lower = target.toLowerCase()
  let core
  // Uppercase and shifted punctuation are tested BEFORE the plain lookup:
  // `A` lowercases to a key that exists, so checking BASE first would silently
  // type `a`.
  if (target.length === 1 && target >= 'A' && target <= 'Z') {
    core = [BASE.shift, ...tap(BASE[lower]), BASE.shift | 0x80]
  } else if (EXTENDED[lower] !== undefined) core = tapExtended(EXTENDED[lower])
  else if (BASE[lower] !== undefined) core = tap(BASE[lower])
  else if (SHIFTED[target] !== undefined) {
    const base = BASE[SHIFTED[target]]
    core = [BASE.shift, ...tap(base), BASE.shift | 0x80]
  } else if (BASE[target] !== undefined) core = tap(BASE[target])
  else return undefined

  if (modifiers.length === 0) return core
  const down = []
  const up = []
  for (const modifier of modifiers) {
    const code = BASE[modifier] ?? EXTENDED[modifier]
    if (code === undefined) return undefined
    if (EXTENDED[modifier] !== undefined) {
      down.push(0xe0, code)
      up.unshift(0xe0, code | 0x80)
    } else {
      down.push(code)
      up.unshift(code | 0x80)
    }
  }
  return [...down, ...core, ...up]
}

/**
 * Translate a literal string into scancodes, one character at a time.
 * @param text - the text to type.
 * @returns the scancode sequence; unknown characters are skipped.
 */
export function textToScancodes(text) {
  const out = []
  for (const char of String(text)) {
    if (char === '\n') {
      out.push(...tap(BASE.enter))
      continue
    }
    const codes = keyToScancodes(char)
    if (codes !== undefined) out.push(...codes)
  }
  return out
}

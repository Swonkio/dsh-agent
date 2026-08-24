/**
 * The keyboard: one owner of stdin for the whole process, decoding raw bytes
 * into key events and routing them to whichever reader is on top of the stack.
 *
 * Owning stdin once is what makes fast input safe. The previous readline-based
 * prompt built and tore down an interface per submission, and everything the
 * terminal had already buffered behind the first newline — the rest of a
 * pasted block — was discarded with it. Here nothing pauses and nothing is
 * rebuilt: bytes arriving mid-swap land on whoever holds the stack.
 *
 * Bracketed paste is enabled while a reader is active, so a pasted block
 * arrives as one `paste` key rather than as text with submit-shaped newlines
 * in it.
 * @module dsh-tui/keys
 */

const ESC = String.fromCharCode(27)
const CSI = `${ESC}[`

/** Turn bracketed paste on and off around the readers that want whole blocks. */
const PASTE_ON = `${CSI}?2004h`
const PASTE_OFF = `${CSI}?2004l`
const PASTE_START = `${CSI}200~`
const PASTE_END = `${CSI}201~`

/** Exact sequences that name a key, longest match first. */
const SEQUENCES = [
  [`${CSI}1;5C`, { name: 'right', ctrl: true }],
  [`${CSI}1;5D`, { name: 'left', ctrl: true }],
  [`${CSI}1;3C`, { name: 'right', alt: true }],
  [`${CSI}1;3D`, { name: 'left', alt: true }],
  [`${CSI}A`, { name: 'up' }],
  [`${CSI}B`, { name: 'down' }],
  [`${CSI}C`, { name: 'right' }],
  [`${CSI}D`, { name: 'left' }],
  [`${CSI}H`, { name: 'home' }],
  [`${CSI}F`, { name: 'end' }],
  [`${CSI}1~`, { name: 'home' }],
  [`${CSI}7~`, { name: 'home' }],
  [`${CSI}4~`, { name: 'end' }],
  [`${CSI}8~`, { name: 'end' }],
  [`${CSI}3~`, { name: 'delete' }],
  [`${CSI}5~`, { name: 'pageup' }],
  [`${CSI}6~`, { name: 'pagedown' }],
  [`${CSI}Z`, { name: 'tab', shift: true }],
  [`${ESC}${String.fromCharCode(13)}`, { name: 'return', alt: true }],
  [`${ESC}${String.fromCharCode(10)}`, { name: 'return', alt: true }],
  [`${ESC}${String.fromCharCode(127)}`, { name: 'backspace', alt: true }],
  [`${ESC}b`, { name: 'left', alt: true }],
  [`${ESC}f`, { name: 'right', alt: true }],
  [`${ESC}d`, { name: 'delete', alt: true }],
]

/** Control bytes that name a key on their own. */
const CONTROLS = new Map([
  [String.fromCharCode(13), { name: 'return' }],
  [String.fromCharCode(10), { name: 'newline' }],
  [String.fromCharCode(9), { name: 'tab' }],
  [String.fromCharCode(127), { name: 'backspace' }],
  [String.fromCharCode(8), { name: 'backspace' }],
  [String.fromCharCode(1), { name: 'a', ctrl: true }],
  [String.fromCharCode(2), { name: 'b', ctrl: true }],
  [String.fromCharCode(3), { name: 'c', ctrl: true }],
  [String.fromCharCode(4), { name: 'd', ctrl: true }],
  [String.fromCharCode(5), { name: 'e', ctrl: true }],
  [String.fromCharCode(6), { name: 'f', ctrl: true }],
  [String.fromCharCode(11), { name: 'k', ctrl: true }],
  [String.fromCharCode(12), { name: 'l', ctrl: true }],
  [String.fromCharCode(14), { name: 'n', ctrl: true }],
  [String.fromCharCode(15), { name: 'o', ctrl: true }],
  [String.fromCharCode(16), { name: 'p', ctrl: true }],
  [String.fromCharCode(18), { name: 'r', ctrl: true }],
  [String.fromCharCode(21), { name: 'u', ctrl: true }],
  [String.fromCharCode(23), { name: 'w', ctrl: true }],
  [String.fromCharCode(26), { name: 'z', ctrl: true }],
])

/** Whether `text` is the beginning of a longer escape sequence still arriving. */
function isPartial(text) {
  if (text === ESC || text === `${ESC}[`) return true
  if (!text.startsWith(CSI)) return false
  // A CSI sequence runs until its final byte in the @-~ range.
  return !/[@-~]/.test(text.slice(CSI.length))
}

/**
 * Decode one chunk into key events.
 * @param input - the pending input text.
 * @param state - carries the in-progress paste across chunks.
 * @param force - emit a held partial sequence instead of waiting for its rest.
 * A lone Escape byte is indistinguishable from the start of a longer sequence
 * until either more bytes arrive or enough time passes, so the keyboard forces
 * the decision on a timer.
 * @returns the decoded keys plus any incomplete tail to keep.
 */
export function decode(input, state = {}, force = false) {
  const keys = []
  let rest = input
  while (rest !== '') {
    if (state.paste !== undefined) {
      const end = rest.indexOf(PASTE_END)
      if (end === -1) {
        // The terminal may split a large paste across many chunks.
        state.paste += rest
        return { keys, rest: '', state }
      }
      state.paste += rest.slice(0, end)
      keys.push({ name: 'paste', text: state.paste })
      state.paste = undefined
      rest = rest.slice(end + PASTE_END.length)
      continue
    }
    if (rest.startsWith(PASTE_START)) {
      state.paste = ''
      rest = rest.slice(PASTE_START.length)
      continue
    }
    if (!force && (PASTE_START.startsWith(rest) || PASTE_END.startsWith(rest))) return { keys, rest, state }
    const match = SEQUENCES.find(([sequence]) => rest.startsWith(sequence))
    if (match !== undefined) {
      keys.push({ ...match[1], sequence: match[0] })
      rest = rest.slice(match[0].length)
      continue
    }
    if (!force && isPartial(rest)) return { keys, rest, state }
    const char = String.fromCodePoint(rest.codePointAt(0))
    rest = rest.slice(char.length)
    if (char === ESC) {
      keys.push({ name: 'escape', sequence: char })
      continue
    }
    const control = CONTROLS.get(char)
    keys.push(control === undefined ? { name: 'char', sequence: char } : { ...control, sequence: char })
  }
  return { keys, rest: '', state }
}

/** Single owner of stdin: raw mode, bracketed paste, and a reader stack. */
export class Keyboard {
  constructor(input = process.stdin, out = process.stdout) {
    this.input = input
    this.out = out
    this.readers = []
    this.pending = ''
    this.state = {}
    this.attached = false
  }

  /** Whether this process can read keys at all. */
  get interactive() {
    return this.input.isTTY === true
  }

  /** Begin owning stdin. Idempotent. */
  attach() {
    if (this.attached) return
    this.attached = true
    this.input.setEncoding('utf8')
    if (this.interactive) {
      this.input.setRawMode(true)
      this.out.write(PASTE_ON)
    }
    this.onData = chunk => { this.consume(chunk) }
    this.input.on('data', this.onData)
    this.input.resume()
    // Raw mode and bracketed paste are terminal-wide state: restore them even
    // when the process leaves through a path that never reaches detach().
    if (this.restoreOnExit === undefined) {
      this.restoreOnExit = () => { this.detach() }
      process.once('exit', this.restoreOnExit)
    }
  }

  /** Release stdin and restore the terminal's own modes. */
  detach() {
    if (!this.attached) return
    this.attached = false
    this.input.off('data', this.onData)
    if (this.interactive) {
      this.out.write(PASTE_OFF)
      this.input.setRawMode(false)
    }
    this.input.pause()
  }

  /** Decode a chunk and hand its keys to the active reader. */
  consume(chunk, force = false) {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.pending += chunk
    const { keys, rest, state } = decode(this.pending, this.state, force)
    this.pending = rest
    this.state = state
    this.deliver(keys)
    // A held tail is either a sequence still arriving or a bare Escape. Give
    // the rest of it one frame to show up, then take the input as it stands.
    if (this.pending !== '' && state.paste === undefined) {
      this.flushTimer = setTimeout(() => { this.consume('', true) }, 60)
      this.flushTimer.unref?.()
    }
  }

  /** Hand decoded keys to whichever reader is on top as each one lands. */
  deliver(keys) {
    for (const key of keys) {
      const reader = this.readers[this.readers.length - 1]
      if (reader === undefined) continue
      // A reader that finishes mid-batch hands the rest to whoever it uncovers,
      // so keys typed across a mode change are never dropped.
      reader(key)
    }
  }

  /** Push a reader onto the stack; the returned disposer pops exactly it. */
  push(reader) {
    this.attach()
    this.readers.push(reader)
    return () => {
      const at = this.readers.lastIndexOf(reader)
      if (at !== -1) this.readers.splice(at, 1)
    }
  }
}

/** The process-wide keyboard. */
export const keyboard = new Keyboard()

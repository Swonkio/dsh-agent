/**
 * The dsh-tui regression suite.
 *
 * Unit checks run in-process against the input, editor, completion, and
 * rendering layers — the parts that break silently when the harness moves
 * under us. `--pty` adds end-to-end scenarios driven through a real pty; the
 * ones that need a model are skipped unless `--model` is passed, so the fast
 * suite stays fast.
 *
 * Usage: node tools/test.mjs [--pty] [--model]
 * @module dsh-tui/tools/test
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ESC = String.fromCharCode(27)
const CR = String.fromCharCode(13)
const LF = String.fromCharCode(10)

const { decode } = await import(join(ROOT, 'lib/keys.js'))
const { Editor } = await import(join(ROOT, 'lib/editor.js'))
const { Renderer } = await import(join(ROOT, 'lib/render.js'))
const { Screen, stripAnsi } = await import(join(ROOT, 'lib/term.js'))
const { completePath } = await import(join(ROOT, 'lib/index.js'))

let passed = 0
const failures = []

/** Assert `actual` deep-equals `expected`. */
function is(name, actual, expected) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left === right) {
    passed += 1
    return
  }
  failures.push(`${name}\n    expected ${right}\n    actual   ${left}`)
}

/** Assert a condition holds. */
function ok(name, condition, detail = '') {
  if (condition === true) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === '' ? '' : `\n    ${detail}`}`)
}

// ── keys ─────────────────────────────────────────────────────────────────────

const names = input => decode(input, {}).keys.map(key => key.name)

is('decode: plain text is chars', names('hi'), ['char', 'char'])
is('decode: enter submits, ctrl+j is a newline', names(CR + LF), ['return', 'newline'])
is('decode: arrows', names(`${ESC}[A${ESC}[B${ESC}[C${ESC}[D`), ['up', 'down', 'right', 'left'])
is('decode: word motion', names(`${ESC}[1;5D${ESC}b`), ['left', 'left'])
is('decode: ctrl keys', names(String.fromCharCode(3) + String.fromCharCode(15)), ['c', 'o'])
is(
  'decode: a bracketed paste is one key',
  decode(`${ESC}[200~a${LF}b${ESC}[201~`, {}).keys,
  [{ name: 'paste', text: `a${LF}b` }],
)
{
  const state = {}
  const first = decode(`${ESC}[200~part1`, state)
  const second = decode(`part2${ESC}[201~`, state)
  is('decode: a paste split across chunks reassembles', [first.keys, second.keys.map(k => k.text)], [[], ['part1part2']])
}
is('decode: an incomplete escape is held', decode(`${ESC}[`, {}).rest, `${ESC}[`)
is('decode: a lone escape waits for the rest of its sequence', decode(ESC, {}).keys, [])
is('decode: a forced flush turns that lone escape into a key', decode(ESC, {}, true).keys.map(k => k.name), ['escape'])
is('decode: text after a held escape survives', decode(`${ESC}[Ax`, {}).keys.map(k => k.name), ['up', 'char'])

// ── editor ───────────────────────────────────────────────────────────────────

/** An editor bound to a throwaway screen, with input already "read". */
function editor(options = {}) {
  const instance = new Editor({ screen: new Screen(), ...options })
  instance.prompt = '> '
  instance.promptWidth = 2
  instance.text = ''
  instance.cursor = 0
  instance.historyAt = instance.history.length
  instance.draft = ''
  return instance
}

/**
 * Feed decoded keys into an editor; returns the submitted value if any. The
 * force flag mirrors the keyboard's escape-flush timer, so a trailing Escape
 * reaches the editor the way it does at a terminal.
 */
function type(instance, input) {
  let submitted
  for (const key of decode(input, {}, true).keys) instance.handle(key, value => { submitted = value })
  return submitted
}

{
  const it = editor()
  type(it, 'hello')
  is('editor: typing inserts', it.text, 'hello')
  type(it, `${ESC}[D${ESC}[D`)
  type(it, 'X')
  is('editor: insert at the cursor', it.text, 'helXlo')
}
{
  const it = editor()
  const submitted = type(it, `one${LF}two${CR}`)
  is('editor: ctrl+j makes a newline, enter submits both lines', submitted, `one${LF}two`)
}
{
  const it = editor()
  type(it, `${ESC}[200~first${LF}second${LF}${ESC}[201~`)
  is('editor: a paste lands whole and does not submit', it.text, `first${LF}second`)
  ok('editor: a pasted block leaves the cursor at its end', it.cursor === it.text.length)
}
{
  const it = editor()
  type(it, 'alpha beta')
  type(it, String.fromCharCode(23))
  is('editor: ctrl+w kills the last word', it.text, 'alpha ')
  type(it, String.fromCharCode(21))
  is('editor: ctrl+u kills to the line start', it.text, '')
}
{
  const it = editor()
  type(it, `abc${ESC}[H`)
  is('editor: home moves to the line start', it.cursor, 0)
  type(it, `${ESC}[F`)
  is('editor: end moves to the line end', it.cursor, 3)
}
{
  const it = editor()
  it.history = ['older', 'newer']
  it.historyAt = 2
  type(it, `${ESC}[A`)
  is('editor: up walks back through history', it.text, 'newer')
  type(it, `${ESC}[A`)
  is('editor: up again reaches the older entry', it.text, 'older')
  type(it, `${ESC}[B${ESC}[B`)
  is('editor: down returns to the draft', it.text, '')
}
{
  const it = editor({ completions: token => ['/status', '/stop'].filter(c => c.startsWith(token)) })
  type(it, '/sta')
  it.complete()
  is('editor: a unique completion is applied', it.text, '/status ')
}
{
  const it = editor({ completions: token => ['/status', '/stop'].filter(c => c.startsWith(token)) })
  type(it, '/s')
  is('editor: typing a slash opens the menu', it.suggestions.map(s => s.value), ['/status', '/stop'])
  it.complete()
  is('editor: tab extends to the common prefix first', it.text, '/st')
  it.complete()
  is('editor: tab again takes the highlighted entry', it.text, '/status ')
  is('editor: accepting closes the menu', it.suggesting, false)
}
{
  const it = editor({ completions: token => ['/status', '/stop'].filter(c => c.startsWith(token)) })
  type(it, '/s')
  type(it, `${ESC}[B`)
  is('editor: down moves the highlight, not history', it.suggestIndex, 1)
  const submitted = type(it, CR)
  is('editor: enter takes the highlighted entry instead of sending', submitted, undefined)
  is('editor: … and applies it', it.text, '/stop ')
}
{
  const it = editor({ completions: token => ['/status'].filter(c => c.startsWith(token)) })
  type(it, '/status ')
  const submitted = type(it, CR)
  is('editor: a completed command sends on enter', submitted, '/status ')
}
{
  const it = editor({ completions: () => ['/status'] })
  type(it, '/s')
  type(it, ESC)
  is('editor: escape dismisses the menu before clearing the line', [it.suggesting, it.text], [false, '/s'])
}
{
  const it = editor({ completions: token => [{ value: '/help', hint: 'list commands' }].filter(c => c.value.startsWith(token)) })
  type(it, '/h')
  is('editor: descriptions ride along with the menu', it.suggestions[0].hint, 'list commands')
}
{
  const it = editor()
  const submitted = type(it, `draft${String.fromCharCode(3)}`)
  is('editor: ctrl+c cancels the line', submitted, null)
}
{
  const it = editor()
  const submitted = type(it, String.fromCharCode(4))
  is('editor: ctrl+d on an empty line ends input', submitted, undefined)
}
{
  const it = editor()
  type(it, `keep${ESC}`)
  is('editor: escape clears the prompt', it.text, '')
}

{
  const it = editor()
  let paints = 0
  it.paint = () => { paints += 1 }
  type(it, 'abc')
  await new Promise(resolve => { queueMicrotask(resolve) })
  is('editor: one chunk of keys repaints once', paints, 1)
}

// ── generation rate ──────────────────────────────────────────────────────────

{
  // The rate folds intervals BETWEEN deltas and skips pauses, so a tool call or
  // a prefill stall inside a turn cannot drag the reading down and pin it there.
  const { Tui } = await import(join(ROOT, 'lib/index.js'))
  const { String1D } = await import(join(ROOT, 'lib/field.js'))
  const meter = Object.create(Tui.prototype)
  meter.stream = { tokens: 0, last: 0, interval: undefined, samples: 0 }
  meter.turnTokens = 0
  // countDelta also plucks the token string; this test only exercises the rate
  // meter, but the collaborator has to exist for the method to run.
  meter.string = new String1D(18)
  let clock = 1_000_000
  const original = Date.now
  Date.now = () => clock
  const tick = ms => { clock += ms; meter.countDelta() }
  for (let at = 0; at < 20; at += 1) tick(16)      // ~60 tok/s
  const fast = meter.rate()
  tick(3000)                                       // a tool call, then more tokens
  for (let at = 0; at < 20; at += 1) tick(16)
  const afterPause = meter.rate()
  for (let at = 0; at < 40; at += 1) tick(100)     // genuinely slow generation
  const slow = meter.rate()
  Date.now = original
  is('rate: reports the streaming speed', fast, '63 tok/s')
  is('rate: a pause between bursts does not change it', afterPause, '63 tok/s')
  is('rate: real slowdown is reported', slow, '10 tok/s')
}

// ── completion ───────────────────────────────────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-test-'))
  writeFileSync(join(dir, 'notes.md'), 'x')
  writeFileSync(join(dir, 'other.txt'), 'x')
  const here = process.cwd()
  process.chdir(dir)
  is('complete: @ prefix matches one file', completePath('not'), ['notes.md'])
  is('complete: @ with no prefix lists the directory', completePath('').sort(), ['notes.md', 'other.txt'])
  process.chdir(here)
}

// ── rendering ────────────────────────────────────────────────────────────────

/** A screen that captures its output instead of writing to a terminal. */
function capture() {
  const chunks = []
  const screen = new Screen({ isTTY: false, write: chunk => chunks.push(chunk) })
  return { screen, text: () => stripAnsi(chunks.join('')) }
}

/** A renderer over a captured screen with no tool registry. */
function renderer(options = {}) {
  const { screen, text } = capture()
  return { renderer: new Renderer(screen, { tools: undefined, scope: () => undefined, cwd: '/w', ...options }), text }
}

{
  const { renderer: r, text } = renderer()
  r.render({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: `# Title${LF}body **bold**${LF}` } } })
  r.flush()
  ok('render: markdown headings and prose reach the screen', text().includes('Title') && text().includes('body bold'), text())
}
{
  const { renderer: r, text } = renderer()
  r.render({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' } })
  ok('render: an unpresented call names the tool and its arguments', /bash\(command: ls -la\)/.test(text()), text())
}
{
  const { renderer: r, text } = renderer()
  r.render({ type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"/w/a.txt"}' } })
  r.render({
    type: 'tool/result',
    data: {
      message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: `line1${LF}line2` }] }] },
    },
  })
  ok('render: a result body appears under its call', text().includes('line1') && text().includes('line2'), text())
}
{
  const { renderer: r, text } = renderer()
  const long = Array.from({ length: 40 }, (_, at) => `line ${at}`).join(LF)
  r.render({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  r.render({
    type: 'tool/result',
    data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: long }] }] } },
  })
  ok('render: a long result is folded with a ctrl+o hint', /\+\d+ lines \(ctrl\+o\)/.test(text()), text())
  r.expandLast()
  ok('render: ctrl+o reopens every retained line', text().includes('line 39'), 'line 39 missing after expandLast')
}
{
  const { renderer: r, text } = renderer()
  r.render({ type: 'todo/write', data: { todos: [{ content: 'done thing', status: 'completed' }, { content: 'next thing', status: 'in_progress' }] } })
  ok('render: todos show their state', text().includes('done thing') && text().includes('next thing'), text())
}
{
  const { renderer: r, text } = renderer()
  r.render({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'BOOM', message: 'it broke' } } } })
  ok('render: a failed turn reports its error', text().includes('BOOM') && text().includes('it broke'), text())
}
{
  const { renderer: r, text } = renderer()
  r.child({ type: 'tool/call', data: { callId: 'x', name: 'grep', arguments: '{}' } })
  ok('render: child activity is one indented line', text().includes('grep'), text())
}
{
  const { renderer: r, text } = renderer()
  r.render({ type: 'tool/call', data: { callId: 'c1', name: 'write', arguments: '{}' } })
  r.render({
    type: 'tool/result',
    data: {
      message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'refused: /w/secret' }] }] },
    },
  })
  ok('render: an error result is shown and relativized', /refused: secret/.test(text()), text())
}

// ── pty scenarios ────────────────────────────────────────────────────────────

if (process.argv.includes('--pty')) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-tui-pty-'))
  writeFileSync(join(workspace, 'note.txt'), 'hello from the test workspace\n')
  /** Run one scripted pty scenario and return its capture. */
  const drive = steps => {
    const script = join(workspace, 'script.json')
    writeFileSync(script, JSON.stringify(steps))
    return execFileSync(process.execPath, [join(ROOT, 'tools/pty-drive.mjs'), script, workspace], {
      encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
  {
    const out = drive([
      { expect: 'terminal session', timeout: 90_000 },
      { delay: 600, send: `${ESC}[200~pasted one${LF}pasted two${LF}${ESC}[201~` },
      { delay: 800, send: ESC },
      { delay: 300, send: `/status${CR}` },
      { expect: 'auto-allowed', timeout: 30_000 },
      { delay: 300, send: `/jobs${CR}` },
      { expect: 'background jobs', timeout: 20_000 },
      { delay: 300, send: `/exit${CR}` },
    ])
    ok('pty: a paste never starts a turn', !out.includes('esc to interrupt'), 'a turn began during the paste scenario')
    ok('pty: /status reports the session', out.includes('auto-allowed'), out.slice(-400))
    ok('pty: /jobs answers', out.includes('background jobs'), out.slice(-400))
    ok('pty: the session exits cleanly', out.includes('exited with 0'), out.slice(-200))
  }
  if (process.argv.includes('--model')) {
    const out = drive([
      { expect: 'terminal session', timeout: 90_000 },
      { delay: 600, send: `read note.txt and reply with its contents only${CR}` },
      { expect: 'ctx', timeout: 600_000 },
      { delay: 400, send: `/export transcript.md${CR}` },
      { expect: 'exported to', timeout: 20_000 },
      { delay: 400, send: `/exit${CR}` },
    ])
    ok('pty: a real turn runs a tool and answers', /test workspace/.test(out), out.slice(-600))
    ok('pty: /export writes the transcript', out.includes('exported to'), out.slice(-300))
  }
}

// ── report ───────────────────────────────────────────────────────────────────

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
for (const failure of failures) process.stdout.write(`\n  FAIL ${failure}\n`)
process.exit(failures.length === 0 ? 0 : 1)

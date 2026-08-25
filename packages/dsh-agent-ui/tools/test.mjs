/**
 * Unit checks for dsh-agent-ui: colour-depth detection and NO_COLOR, the
 * memory→graph build and its deterministic layout, the braille canvas, the
 * frame composer's monotonic reveal, the status aggregator over a temp home,
 * and the HUD/render primitives.
 *
 * Usage: node tools/test.mjs
 * @module dsh-agent-ui/tools/test
 */

import { colorDepth, PALETTE, paint, heat } from '../lib/theme.js'
import { buildGraph, layout, terms, labelOf } from '../lib/graph.js'
import { Canvas } from '../lib/canvas.js'
import { frame } from '../lib/boot.js'
import { gatherStatus, ago } from '../lib/status.js'
import { renderHud } from '../lib/hud.js'
import { visibleWidth, padVisible, meter, panel, wordmark } from '../lib/render.js'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const failures = []
const ok = (name, cond, detail = '') => { cond === true ? (passed += 1) : failures.push(`${name}${detail ? ' — ' + detail : ''}`) }
const noEsc = s => s.replace(/\x1b\[[0-9;]*m/g, '')

// ── colour depth ────────────────────────────────────────────────────────────
ok('NO_COLOR forces mono', colorDepth({ NO_COLOR: '1' }, { isTTY: true }) === 0)
ok('COLORTERM=truecolor → 3', colorDepth({ COLORTERM: 'truecolor', TERM: 'xterm' }, { isTTY: true }) === 3)
ok('xterm-256color → 2', colorDepth({ TERM: 'xterm-256color' }, { isTTY: true }) === 2)
ok('TERM=dumb → 0', colorDepth({ TERM: 'dumb' }, { isTTY: true }) === 0)
ok('non-TTY defaults to mono', colorDepth({ TERM: 'xterm-256color' }, { isTTY: false }) === 0)
ok('force overrides non-TTY', colorDepth({ TERM: 'xterm', DSH_AGENT_FORCE_COLOR: '3' }, { isTTY: false }) === 3)
ok('paint is a no-op at depth 0', paint('x', PALETTE.gold, 0) === 'x')
ok('paint wraps at depth 3', paint('x', PALETTE.gold, 3).includes('38;2;'))
ok('heat is empty at depth 0', heat(0.5, 0) === '')
ok('heat clamps out-of-range', heat(2, 3) === heat(1, 3) && heat(-1, 3) === heat(0, 3))

// ── graph ───────────────────────────────────────────────────────────────────
ok('terms keeps distinctive tokens', terms('runs envoy-proxy behind loadbalancer').has('envoy-proxy'))
ok('terms drops stopwords and shorts', !terms('the api is up').has('the') && !terms('the api is up').has('up'))
ok('labelOf takes the topic', labelOf('- Model serving: on port 8080') === 'Model serving')
ok('labelOf truncates to 22', labelOf('- ' + 'x'.repeat(40) + ': y').length === 22)
{
  const lines = [
    '- Gateway: the api gateway runs envoy-proxy',
    '- Gateway binary: envoy-proxy is the gateway not nginx',
    '- Cooling: the prune job stops the disk filling',
  ]
  const g = buildGraph(lines)
  ok('a node per memory', g.nodes.length === 3)
  ok('shared distinctive term links two nodes', g.edges.some(e =>
    (g.nodes[e.a].label.startsWith('Gateway') && g.nodes[e.b].label.startsWith('Gateway'))))
  ok('unrelated memory is unlinked', g.nodes.find(n => n.label === 'Cooling').degree === 0)
  ok('the more-connected node is hotter', g.nodes[0].heat >= g.nodes[2].heat)
  ok('blank lines are dropped', buildGraph(['- a: x', '', '- ', '- b: y']).nodes.length === 2)
  ok('empty memory yields an empty graph', buildGraph([]).nodes.length === 0)
}

// ── layout ──────────────────────────────────────────────────────────────────
{
  const g = buildGraph(['- a: alpha beta', '- b: beta gamma', '- c: delta'])
  const p1 = layout(g.nodes, { rotate: 0.6 })
  const p2 = layout(g.nodes, { rotate: 0.6 })
  ok('layout is deterministic', JSON.stringify(p1.map(n => [n.x, n.y])) === JSON.stringify(p2.map(n => [n.x, n.y])))
  ok('all nodes land on the unit canvas', p1.every(n => n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1))
  ok('layout of nothing is nothing', layout([]).length === 0)
}

// ── canvas ──────────────────────────────────────────────────────────────────
{
  const c = new Canvas(10, 5)
  ok('canvas subpixel size is 2x4 per cell', c.width === 20 && c.height === 20)
  ok('empty canvas renders blank', noEsc(c.toString(3)).trim() === '')
  c.plot(0, 0, '', 1)
  ok('a plotted dot appears', noEsc(c.toString(3)).includes('⠁'))
  c.clear()
  ok('clear empties it', noEsc(c.toString(3)).trim() === '')
  c.plot(1000, 1000, '', 1) // out of bounds is a no-op, not a throw
  ok('out-of-bounds plot is ignored', noEsc(c.toString(3)).trim() === '')
  c.line(0, 0, 18, 18, () => '', 0.5)
  ok('a diagonal line lights multiple cells', noEsc(c.toString(3)).replace(/\s/g, '').length >= 3)
  ok('mono render carries no escapes', c.toString(0) === noEsc(c.toString(0)))
}

// ── frame composer ──────────────────────────────────────────────────────────
{
  const g = buildGraph(Array.from({ length: 8 }, (_, i) => `- topic${i}: shared word item${i}`))
  const placed = layout(g.nodes, { rotate: 0.6 })
  const lit = p => noEsc(frame(g, placed, { cols: 40, rows: 10, depth: 3, p })).replace(/\s/g, '').length
  ok('nothing lit at p=0-ish is less than fully lit', lit(0.05) <= lit(1))
  ok('more is lit over time (monotone-ish)', lit(0.3) <= lit(0.7) + 2 && lit(0.7) <= lit(1) + 2)
  ok('final frame carries the wordmark', noEsc(frame(g, placed, { cols: 40, rows: 10, depth: 3, p: 1 })).includes('dsh'))
  ok('frame is deterministic at fixed p', frame(g, placed, { cols: 40, rows: 10, depth: 3, p: 0.5 }) === frame(g, placed, { cols: 40, rows: 10, depth: 3, p: 0.5 }))
  ok('empty-memory frame still renders rows', frame(buildGraph([]), [], { cols: 40, rows: 6, depth: 3, p: 1 }).split('\n').length === 6)
}

// ── ago ─────────────────────────────────────────────────────────────────────
ok('ago: seconds', ago(Date.now() - 5000).endsWith('s ago'))
ok('ago: minutes', ago(Date.now() - 5 * 60000).endsWith('m ago'))
ok('ago: hours', ago(Date.now() - 5 * 3600000).endsWith('h ago'))
ok('ago: days', ago(Date.now() - 5 * 86400000).endsWith('d ago'))
ok('ago: unparseable → null', ago('nonsense') === null)

// ── status aggregation over a real temp home ────────────────────────────────
{
  const home = await mkdtemp(join(tmpdir(), 'dsh-ui-'))
  await mkdir(join(home, 'memory', 'topics'), { recursive: true })
  await writeFile(join(home, 'memory', 'MEMORY.md'),
    '# Memory index\n\n- Alpha: envoy-proxy on the gateway\n- Beta: the gateway runs envoy-proxy\n- Gamma: unrelated prune job\n')
  await writeFile(join(home, 'memory', 'topics', 'alpha.md'), '# a\n')
  await writeFile(join(home, 'USER.md'), '## Expertise\nlocal LLMs\n')
  await writeFile(join(home, 'SOUL.md'), 'be terse\n')

  const report = await gatherStatus(home, { indexCapBytes: 8192 })
  ok('counts memory entries', report.memory.entries === 3)
  ok('counts topic files', report.memory.topics === 1)
  ok('computes index fullness', report.memory.fullness > 0 && report.memory.fullness < 1)
  ok('detects the user model', report.userModel.present === true)
  ok('detects the soul', report.soul.present === true)
  ok('carries the memory lines for the boot', report.memoryLines.length === 3)

  // With the curator/epistemics deps injected, skills + contradictions light up.
  const deps = {
    loadUsage: async () => ({ s1: { uses: 10, wins: 3, losses: 7, lastUsed: new Date().toISOString(), state: 'active' } }),
    curationPlan: (input) => ({ counts: { skills: Object.keys(input.skills).length, flagged: 1, stale: 0, archive: 0 }, actions: [] }),
    scanMemory: async () => ({ conflicts: [{ a: '- Alpha', b: '- Beta', signal: 'antonym', score: 0.7 }], staleMemories: [] }),
  }
  const rich = await gatherStatus(home, { ...deps, indexCapBytes: 8192 })
  ok('skills flagged from outcomes', rich.skills.flagged === 1)
  ok('contradictions from the scan', rich.contradictions.length === 1)

  // An empty home is valid, not an error.
  const empty = await gatherStatus(join(home, 'nope'))
  ok('missing home yields zeroed report', empty.memory.entries === 0 && empty.soul.present === false)
}

// ── render primitives + HUD ──────────────────────────────────────────────────
ok('visibleWidth ignores escapes', visibleWidth(paint('hello', PALETTE.gold, 3)) === 5)
ok('padVisible pads to width', visibleWidth(padVisible('hi', 10)) === 10)
ok('meter fills proportionally (mono)', meter(0.5, 10, 0).startsWith('█████'))
ok('meter clamps over 1', noEsc(meter(2, 8, 0)).replace(/·/g, '').length === 8)
ok('wordmark contains the name', noEsc(wordmark(3)).includes('dsh') && noEsc(wordmark(3)).includes('agent'))
ok('panel frames its title', noEsc(panel('mem', ['row'], 40, 3)).includes('mem'))
{
  const report = {
    memory: { entries: 5, topics: 2, indexBytes: 400, indexCap: 8192, fullness: 0.05, lastWrite: '2m ago' },
    skills: { total: 3, active: 2, stale: 0, flagged: 1, archived: 0 },
    contradictions: [], review: { lastRun: '1h ago' }, curation: { lastRun: null },
    userModel: { present: true, lastUpdate: '3m ago' }, soul: { present: true },
  }
  const hud = renderHud(report, { depth: 0, width: 80 })
  ok('HUD names all sections', ['memory', 'skills', 'integrity', 'learning loop'].every(s => hud.includes(s)))
  ok('HUD surfaces a failing skill', hud.includes('failing when used'))
  ok('HUD mono has no escapes', hud === noEsc(hud))
  const clean = renderHud({ ...report, skills: { total: 0, active: 0, stale: 0, flagged: 0, archived: 0 } }, { depth: 3, width: 80 })
  ok('HUD handles no skills', noEsc(clean).includes('no learned skills yet'))
}

// ── launcher chrome decision (safety-critical) ──────────────────────────────
import { wantsChrome } from '../lib/launch.js'
ok('chrome for a bare interactive session', wantsChrome([], { stdoutTTY: true, stdinTTY: true }) === true)
ok('no chrome for -p', wantsChrome(['-p', 'hi'], { stdoutTTY: true, stdinTTY: true }) === false)
ok('no chrome for --json', wantsChrome(['--json'], { stdoutTTY: true, stdinTTY: true }) === false)
ok('no chrome for --dump-config', wantsChrome(['--dump-config'], { stdoutTTY: true, stdinTTY: true }) === false)
ok('no chrome when stdout is piped', wantsChrome([], { stdoutTTY: false, stdinTTY: true }) === false)
ok('no chrome when stdin is piped', wantsChrome([], { stdoutTTY: true, stdinTTY: false }) === false)
ok('chrome survives benign flags', wantsChrome(['--model', 'x'], { stdoutTTY: true, stdinTTY: true }) === true)

if (failures.length === 0) console.log(`${passed} passed, 0 failed`)
else { console.log(`${passed} passed, ${failures.length} failed`); for (const f of failures) console.log('  ✗', f); process.exit(1) }

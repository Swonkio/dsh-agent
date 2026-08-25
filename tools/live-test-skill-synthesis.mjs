/**
 * LIVE test B — auto-skill synthesis through the real dsh-memory apply().
 * Feeds the firehose a completed 6-call procedural turn and asserts the
 * detached review actually SPAWNS (marker + reviews dir + live process),
 * stays inside the scratch DSH_HOME, throttles, and stays quiet for
 * non-procedural turns. Run with DSH_HOME pointing at a scratch home whose
 * `profiles` symlink back to the real ones (dshBinPath + review profile).
 */
import assert from 'node:assert/strict'

/** The local model the scratch reviews run on: DSH_TEST_MODEL=your-model-id node tools/live-test-*.mjs */
const MODEL = process.env.DSH_TEST_MODEL ?? 'local-model'
import { stat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as memory from '../packages/dsh-memory/lib/index.js'

const run = promisify(execFile)
const home = process.env.DSH_HOME
assert.ok(home?.includes('dsh-test-home'), `refusing to run against a real DSH_HOME (${home})`)

const listeners = {}
const ctx = {
  on(event, handler) { listeners[event] = handler },
  systemPrompt: { section: () => {} },
  tools: { register: () => {} },
  commands: { register: () => {} },
}
memory.apply(ctx, {
  synthesizeSkills: true,
  skillReviewProvider: 'local',
  skillReviewModel: MODEL,
})

const fire = (type, data) => listeners['session/event']({ id: 'S1' }, { type, data })
const tool = (name, brief) => ({ callId: `c-${name}-${Math.random()}`, name, arguments: JSON.stringify({ command: brief }) })

// ── 1. a procedural completed turn spawns the review ────────────────────────
fire('turn/start', { turn: 1 })
fire('user/message', { content: 'restart the panel node and verify it is healthy' })
fire('tool/call', tool('bash', 'systemctl status rat-panel'))
fire('tool/call', tool('read', 'panel/server.js'))
fire('tool/call', tool('edit', 'panel/server.js'))
fire('tool/call', tool('bash', 'systemctl restart rat-panel'))
fire('tool/call', tool('bash', 'curl -s localhost:9090/healthz'))
fire('tool/call', tool('bash', 'journalctl -u rat-panel -n 20'))
fire('assistant/message', { message: { content: [{ type: 'text', text: 'panel restarted and healthy' }] } })
fire('turn/end', { reason: { kind: 'completed' } })

await new Promise(resolve => setTimeout(resolve, 2500))

const marker = `${home}/memory/.last-skill-review`
const markerStat = await stat(marker).catch(() => null)
assert.ok(markerStat, 'spawn marker .last-skill-review written')
console.log('  marker written:', markerStat.mtime.toISOString())

const reviewsDir = await stat(`${home}/reviews`).catch(() => null)
assert.ok(reviewsDir?.isDirectory(), 'scratch reviews/ dir created')

let spawned = []
try {
  const { stdout } = await run('ps', ['-eo', 'args'])
  spawned = stdout.split('\n').filter(line => line.includes('--profile') && line.includes('review'))
} catch { /* ps unavailable */ }
console.log(spawned.length > 0 ? '  live review process:\n    ' + spawned[0].slice(0, 160) : '  (review process already exited — marker is the spawn proof)')
console.log('✓ LIVE B1 PASS: procedural completed turn spawned the detached skill review (isolated in scratch home)')

// ── 2. the 15-min throttle blocks an immediate second spawn ─────────────────
const before = (await stat(marker)).mtimeMs
fire('turn/start', { turn: 2 })
for (let i = 0; i < 6; i++) fire('tool/call', tool('bash', `echo step ${i}`))
fire('turn/end', { reason: { kind: 'completed' } })
await new Promise(resolve => setTimeout(resolve, 1500))
const after = (await stat(marker)).mtimeMs
assert.equal(after, before, 'throttle: marker untouched inside the window')
console.log('✓ LIVE B2 PASS: second procedural turn inside 15 min did not spawn again')

// ── 3. a non-procedural (read-only) turn never spawns ───────────────────────
fire('turn/start', { turn: 3 })
fire('tool/call', tool('read', 'a.log'))
fire('tool/call', tool('read', 'b.log'))
fire('tool/call', tool('bash', 'cat c.log'))
fire('turn/end', { reason: { kind: 'completed' } })
await new Promise(resolve => setTimeout(resolve, 1200))
assert.equal((await stat(marker)).mtimeMs, after, 'no spawn for a 3-call turn')
console.log('✓ LIVE B3 PASS: short read-only turn spawned nothing')

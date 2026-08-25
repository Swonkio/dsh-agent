/**
 * LIVE test — the new review loop end to end, in a scratch DSH_HOME:
 *   1. a user correction spawns the correction review
 *   2. a second review inside the coalesce window QUEUES (marker untouched)
 *   3. the idle drain later runs the queue as ONE combined call
 *   4. lesson hits are logged when the lessons section renders
 *   5. the digest review runs when idle with ≥3 exchanges
 * Windows are shrunk: coalesceWindowMs 8s, idleAfterMs 2s, drain cooldown 2s,
 * so the whole sequence completes in well under a minute.
 */
import assert from 'node:assert/strict'

/** The local model the scratch reviews run on: DSH_TEST_MODEL=your-model-id node tools/live-test-*.mjs */
const MODEL = process.env.DSH_TEST_MODEL ?? 'local-model'
import { stat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as memory from '../packages/dsh-memory/lib/index.js'

const home = process.env.DSH_HOME
assert.ok(home?.includes('dsh-test-home'), `refusing a real DSH_HOME (${home})`)

// Self-contained lesson corpus so assertions cannot drift from setup.
const LESSONS = [
  '- Lesson: vbox-log-first: When diagnosing the VirtualBox VM crash, read the vbox-install log with one command before stating the root cause',
  '- Lesson: npm-symlink-destruction: When npm install runs inside a symlinked kit package it deletes harness packages it calls extraneous',
]
await mkdir(join(home, 'memory'), { recursive: true })
await writeFile(join(home, 'memory', 'MEMORY.md'), `# Memory index\n\n${LESSONS.join('\n')}\n`)

const sections = {}
const listeners = {}
const ctx = {
  on(event, handler) { listeners[event] = handler },
  effect: () => {},
  systemPrompt: { section: s => { sections[s.name] = s } },
  tools: { register: () => {} },
  commands: { register: () => {} },
}
// smartDispatch is OFF: this suite asserts the QUEUE discipline (coalesce
// window → queue → idle drain). The queue-jump-on-idle-slot behavior is
// covered separately by the probeBackendIdle unit checks and a live probe.
memory.apply(ctx, {
  backgroundReview: true, reviewProvider: 'local', reviewModel: MODEL,
  learnFromCorrections: true, correctionReviewProvider: 'local', correctionReviewModel: MODEL,
  coalesceWindowMs: 8000, idleAfterMs: 2000, idleDrainCooldownMs: 2000, smartDispatch: false,
  lessonEfficacy: true, lessonsTopK: 2, lessonsMinScore: 0.2,
  digestSessions: true, digestReviewProvider: 'local', digestReviewModel: MODEL,
  synthesizeSkills: true, skillReviewProvider: 'local', skillReviewModel: MODEL,
})

const session = { id: 'live-test-session' }
const fire = (type, data) => listeners['session/event'](session, { type, data })

// ── 4. lesson hits are logged when the section renders ─────────────────────
fire('user/message', { content: 'the vbox vm crashes during install, find the root cause', source: { kind: 'user' } })
fire('assistant/message', { message: { content: [{ type: 'text', text: 'checking virtualbox setup' }] } })
const lessonText = sections['memory:lessons'].text()
assert.match(lessonText, /vbox-log-first/, 'lesson surfaced')
const hits = (await stat(`${home}/memory/.lesson-hits.jsonl`)).isFile()
assert.ok(hits, '.lesson-hits.jsonl written by the section render')
console.log('✓ 4. lesson hits logged at render time')

// ── 1. a correction spawns the correction review ───────────────────────────
fire('assistant/message', { message: { content: [{ type: 'text', text: 'Use the Q8 model for the 256k context window.' }] } })
fire('user/message', { content: 'No, use the Q6 model — Q8 OOMs on GPU2 at first decode', source: { kind: 'user' } })
await new Promise(r => setTimeout(r, 2000))
const correctionMarker = (await stat(`${home}/memory/.last-correction-review`).catch(() => null))
assert.ok(correctionMarker, 'correction review spawned (marker written)')
console.log('✓ 1. correction review spawned')

// ── 2. a second review inside the window queues ────────────────────────────
fire('turn/start', { turn: 1 })
for (let i = 0; i < 6; i++) {
  fire('tool/call', { callId: `c${i}`, name: 'bash', arguments: JSON.stringify({ command: `echo step ${i}` }) })
}
fire('turn/end', { reason: { kind: 'completed' } })
await new Promise(r => setTimeout(r, 2000))
const skillMarker = await stat(`${home}/memory/.last-skill-review`).catch(() => null)
assert.ok(skillMarker === null, 'skill review QUEUED, not spawned (inside coalesce window)')
console.log('✓ 2. second review queued inside the coalesce window')

// ── 3 + 5. idle drain runs the queue (and the digest) ───────────────────────
// 3 exchanges for the digest trigger.
for (let turn = 2; turn <= 4; turn++) {
  fire('turn/start', { turn })
  fire('user/message', { content: `question ${turn} about the panel restart`, source: { kind: 'user' } })
  fire('assistant/message', { message: { content: [{ type: 'text', text: `answer ${turn}: restarted and healthy` }] } })
  fire('turn/end', { reason: { kind: 'completed' } })
}
console.log('  waiting for the idle drain (30s tick, tiny windows)...')
const deadline = Date.now() + 75_000
let drainedSkill = false
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 5000))
  drainedSkill = (await stat(`${home}/memory/.last-skill-review`).catch(() => null)) !== null
  if (drainedSkill) break
}
assert.ok(drainedSkill, 'queued skill review ran via the idle drain')
console.log('✓ 3. idle drain ran the queued review')

const deadline2 = Date.now() + 75_000
let digestMarker = false
while (Date.now() < deadline2) {
  await new Promise(r => setTimeout(r, 5000))
  digestMarker = (await stat(`${home}/memory/.last-digest-review`).catch(() => null)) !== null
  if (digestMarker) break
}
assert.ok(digestMarker, 'digest review ran when idle with 3+ exchanges')
console.log('✓ 5. digest review dispatched')
console.log('\nLIVE review-loop PASS (digest file lands once the local model finishes; check sessions/.digests/)')

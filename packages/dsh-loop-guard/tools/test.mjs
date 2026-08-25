/**
 * dsh-loop-guard self-test. Pure-logic checks plus a faithful replay of the
 * harness stream contract: it feeds `guardStream` a fake source and asserts the
 * emitted tail is a VALID stream (blocks balanced, exactly one terminal finish)
 * exactly as `packages/llm/llm/src/invariant.ts::validateStream` requires.
 *
 * Run: node tools/test.mjs
 */
import assert from 'node:assert/strict'
import { RepetitionCounter, segmentKey, stepVerdict } from '../lib/detect.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

console.log('detect: segmentKey')
ok('collapses paraphrase-with-suffix to one key', () => {
  const a = segmentKey('So the root cause is that the VBoxSVC crashes during the unattended install', 6, 8)
  const b = segmentKey('So the root cause is that the VBoxSVC crashes', 6, 8)
  assert.equal(a, b)
  assert.equal(a, 'so the root cause is that the vboxsvc')
})
ok('rejects too-short segments', () => {
  assert.equal(segmentKey('Let me check.', 6, 8), null)
  assert.equal(segmentKey('ok', 6, 8), null)
})

console.log('detect: RepetitionCounter')
ok('trips on the Nth recurrence, not before', () => {
  const c = new RepetitionCounter({ repeatThreshold: 3, minWords: 4, prefixWords: 6 })
  const line = 'the vboxsvc service crashes during the install.\n'
  assert.equal(c.push(line), null)
  assert.equal(c.push(line), null)
  const hit = c.push(line)
  assert.ok(hit)
  assert.equal(hit.count, 3)
})
ok('buffers partial segments across deltas', () => {
  const c = new RepetitionCounter({ repeatThreshold: 2, minWords: 4, prefixWords: 6 })
  // Same sentence delivered a few characters at a time, twice.
  for (const piece of ['the same ', 'exact reasoning ', 'appears here.\n']) assert.equal(c.push(piece), null)
  let hit = null
  for (const piece of ['the same ', 'exact reasoning ', 'appears here.\n']) hit = c.push(piece) ?? hit
  assert.ok(hit)
})
ok('does not trip on genuinely varied reasoning', () => {
  const c = new RepetitionCounter({ repeatThreshold: 3, minWords: 4, prefixWords: 6 })
  let hit = null
  for (const line of [
    'first I will inspect the vboxdrv permissions carefully.\n',
    'next the kernel module list should be checked against lsmod.\n',
    'then the agent user group membership matters for access.\n',
    'finally the unattended install log will show the real error.\n',
  ]) hit = c.push(line) ?? hit
  assert.equal(hit, null)
})

console.log('detect: stepVerdict')
ok('nudges on the soft cadence and breaks past the hard line', () => {
  const cfg = { softStep: 25, nudgeEvery: 10, hardStep: 60 }
  assert.equal(stepVerdict(10, cfg), null)
  assert.equal(stepVerdict(25, cfg), 'nudge')
  assert.equal(stepVerdict(30, cfg), null)
  assert.equal(stepVerdict(35, cfg), 'nudge')
  assert.equal(stepVerdict(60, cfg), null)
  assert.equal(stepVerdict(61, cfg), 'break')
})

// ── stream contract replay ───────────────────────────────────────────────────
// Re-implements validateStream's rules so we prove guardStream emits a stream
// the real harness would accept.
function validate(chunks) {
  const open = new Map()
  let finished = false
  let usageSeen = false
  for (const chunk of chunks) {
    assert.ok(!finished, `chunk ${chunk.type} after terminal finish`)
    switch (chunk.type) {
      case 'block-start':
        assert.ok(!open.has(chunk.index), `repeated block-start ${chunk.index}`)
        open.set(chunk.index, chunk.blockType); break
      case 'text-delta': case 'reasoning-delta': {
        const kind = chunk.type === 'text-delta' ? 'text' : 'reasoning'
        assert.equal(open.get(chunk.index), kind, `delta ${kind} on non-open block ${chunk.index}`); break
      }
      case 'tool-call-delta':
        assert.equal(open.get(chunk.index), 'tool-call'); break
      case 'block-end': {
        const kind = open.get(chunk.index)
        assert.ok(kind !== undefined, `block-end ${chunk.index} with no open block`)
        assert.equal(chunk.block.type, kind, `block-end ${chunk.index} closes ${chunk.block.type}, expected ${kind}`)
        open.delete(chunk.index); break
      }
      case 'usage':
        assert.ok(!usageSeen, 'usage twice'); usageSeen = true; break
      case 'finish':
        assert.ok(open.size === 0 || chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted',
          `finished with ${open.size} open blocks`)
        finished = true; break
      default:
        throw new Error(`unknown chunk ${chunk.type}`)
    }
  }
  assert.ok(finished, 'stream ended without a terminal finish')
  return chunks
}

async function collect(gen) {
  const out = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

// Minimal stand-ins so we can import the real guardStream via a tiny shim.
// guardStream is not exported (internal), so exercise it through apply()'s
// llm/stream wrapper using a fake ctx that captures the listener.
import * as plugin from '../lib/index.js'

function fakeCtx() {
  const listeners = {}
  const followups = []
  return {
    on(event, handler) { listeners[event] = handler },
    agents: { get: () => ({ followup: (m) => followups.push(m) }) },
    _listeners: listeners,
    _followups: followups,
  }
}

// A fake agent-loop request must be recognised by isAgentLoopRequest; that set
// is populated by markAgentLoopRequest. Import it to mark our request object.
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'

async function runStream(sourceChunks, config = {}) {
  const ctx = fakeCtx()
  plugin.apply(ctx, config)
  const request = markAgentLoopRequest({ sessionId: 'S1', messages: [] })
  const wrapped = ctx._listeners['llm/stream'](request, async function* () {
    for (const chunk of sourceChunks) yield chunk
  })
  const emitted = await collect(wrapped)
  return { emitted, followups: ctx._followups }
}

console.log('stream: reasoning-loop truncation')
{
  const loopLine = 'So the root cause is that the VBoxSVC crashes during the install. '
  const source = [{ type: 'block-start', index: 0, blockType: 'reasoning' }]
  for (let i = 0; i < 40; i++) source.push({ type: 'reasoning-delta', index: 0, text: loopLine })
  source.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'x' } })
  source.push({ type: 'finish', reason: { kind: 'stop' } })

  const { emitted, followups } = await runStream(source, { repeatThreshold: 5, minWords: 5, prefixWords: 7 })
  validate(emitted)
  assert.ok(emitted.some(c => c.type === 'finish' && c.reason.kind === 'stop'), 'has a stop finish')
  // It cut early: far fewer than the 40 deltas made it through before the synthetic tail.
  const deltas = emitted.filter(c => c.type === 'reasoning-delta').length
  assert.ok(deltas < 40, `expected an early cut, saw ${deltas} deltas`)
  assert.equal(followups.length, 1, 'queued exactly one recovery follow-up')
  console.log(`    (cut after ${deltas} deltas, emitted valid tail, 1 follow-up)`)
  passed++
}

console.log('stream: healthy stream passes through untouched')
{
  const source = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'a careful, non-repeating chain of thought about the problem.\n' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '...' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{"command":"ls"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const { emitted, followups } = await runStream(source)
  validate(emitted)
  assert.deepEqual(emitted, source, 'healthy stream is passed through verbatim')
  assert.equal(followups.length, 0, 'no follow-up for a healthy stream')
  passed++
  console.log('    (passed through verbatim, no follow-up)')
}

console.log('stream: never cuts mid tool-call')
{
  const source = [{ type: 'block-start', index: 0, blockType: 'tool-call' }]
  // A huge tool-call argument stream must NOT be truncated even past maxChars.
  for (let i = 0; i < 50; i++) source.push({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'write', argumentsDelta: 'x'.repeat(1000) })
  source.push({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'write', arguments: 'x' } })
  source.push({ type: 'finish', reason: { kind: 'stop' } })
  const { emitted } = await runStream(source, { maxChars: 1000 })
  validate(emitted)
  assert.deepEqual(emitted, source, 'tool-call stream never truncated')
  passed++
  console.log('    (tool-call stream left intact)')
}

console.log(`\n${passed} checks passed`)

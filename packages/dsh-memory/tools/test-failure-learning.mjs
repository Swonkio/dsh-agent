/**
 * dsh-memory failure-learning self-test. Pure-logic checks for the failure
 * trigger, evidence formatting, prompt, and throttle. Run: node tools/test-failure-learning.mjs
 */
import assert from 'node:assert/strict'
import {
  isLearnableFailure, formatEvidence, failurePrompt, failureReviewDecision,
} from '../lib/index.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

console.log('isLearnableFailure')
ok('a loop-guard break always learns', () => {
  assert.equal(isLearnableFailure({ reason: 'completed', loopBreak: true }), true)
  assert.equal(isLearnableFailure({ reason: 'blocked', loopBreak: true }), true)
})
ok('explicit failed/error/blocked always learn', () => {
  assert.equal(isLearnableFailure({ reason: 'failed' }), true)
  assert.equal(isLearnableFailure({ reason: 'error' }), true)
  assert.equal(isLearnableFailure({ reason: 'blocked' }), true)
})
ok('a clean user-abort is NOT a lesson', () => {
  assert.equal(isLearnableFailure({ reason: 'aborted', toolErrors: 0, stepCount: 3 }), false)
})
ok('a user-abort of a thrashing turn IS a lesson', () => {
  assert.equal(isLearnableFailure({ reason: 'aborted', toolErrors: 0, stepCount: 60 }), true)
  assert.equal(isLearnableFailure({ reason: 'aborted', toolErrors: 5, stepCount: 4 }), true)
})
ok('a clean completed turn is NOT a lesson', () => {
  assert.equal(isLearnableFailure({ reason: 'completed', toolErrors: 0, stepCount: 5 }), false)
})
ok('a completed turn that struggled with many tool errors IS a lesson', () => {
  assert.equal(isLearnableFailure({ reason: 'completed', toolErrors: 4, stepCount: 10 }), true)
})
ok('thresholds are configurable', () => {
  assert.equal(isLearnableFailure({ reason: 'completed', toolErrors: 2 }, { minErrors: 2 }), true)
})

console.log('formatEvidence')
ok('renders outcome, steps, loop reason, and clipped errors', () => {
  const text = formatEvidence({
    reason: 'blocked',
    stepCount: 61,
    loopBreak: 'it reached 61 steps in one turn without finishing',
    toolErrors: [
      { name: 'bash', message: 'VBoxManage: error: Failed to open /dev/vboxdrv\n\n  more noise   here' },
      { name: 'read_image', message: 'screenshot timed out' },
    ],
  })
  assert.match(text, /Outcome: blocked/)
  assert.match(text, /Steps taken in the turn: 61/)
  assert.match(text, /Loop-guard interrupted/)
  assert.match(text, /bash: VBoxManage: error/)
  assert.ok(!text.includes('\n\n  more noise'), 'whitespace in errors is collapsed')
})
ok('caps total size', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ name: 'bash', message: 'x'.repeat(100) + i }))
  const text = formatEvidence({ reason: 'failed', stepCount: 1, toolErrors: many }, 1200)
  // Soft cap: capBytes worth of slice plus a 3-byte "…" marker (same contract as the shipped clip()).
  assert.ok(Buffer.byteLength(text) <= 1200 + 4, `evidence should be capped, got ${Buffer.byteLength(text)}`)
})

console.log('failurePrompt')
ok('targets memory_save with a "When X, do Y" lesson and the nothing-to-keep escape', () => {
  const p = failurePrompt('set up the VM', formatEvidence({ reason: 'blocked', stepCount: 61, loopBreak: 'looped', toolErrors: [] }))
  assert.match(p, /memory_save/)
  assert.match(p, /When X, do Y instead/)
  assert.match(p, /nothing to keep/)
  assert.match(p, /USER REQUEST:\nset up the VM/)
  assert.match(p, /WHAT WENT WRONG:/)
})

console.log('failureReviewDecision (throttle)')
ok('fires when enabled and outside the window; throttles inside it', () => {
  const now = 1_000_000_000
  assert.equal(failureReviewDecision({ enabled: true, lastReviewMs: 0, now }), true)
  assert.equal(failureReviewDecision({ enabled: true, lastReviewMs: now - 60_000, now }), false)
  assert.equal(failureReviewDecision({ enabled: true, lastReviewMs: now - 4 * 60_000, now }), true)
  assert.equal(failureReviewDecision({ enabled: false, lastReviewMs: 0, now }), false)
})

console.log(`\n${passed} checks passed`)

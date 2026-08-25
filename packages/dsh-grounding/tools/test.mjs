/**
 * dsh-grounding self-test. Pure-logic checks for the two detectors, plus a
 * replay of the full arm→nudge flow through apply() with a fake context:
 * firehose events in, injected pre-step messages out.
 *
 * Run: node tools/test.mjs   (from ~/.dsh-agent/profiles for harness imports)
 */
import assert from 'node:assert/strict'
import { hasConclusion, shouldPlan } from '../lib/detect.js'
import * as plugin from '../lib/index.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

console.log('detect: hasConclusion')
ok('matches cause/confirmation phrases', () => {
  assert.equal(hasConclusion('The root cause is that VBoxSVC crashes on startup.'), true)
  assert.equal(hasConclusion('the problem is the missing kernel module'), true)
  assert.equal(hasConclusion('This is because the port was already bound.'), true)
  assert.equal(hasConclusion("That's why the panel dropped every client."), true)
  assert.equal(hasConclusion("It's definitely the watchdog killing it."), true)
  assert.equal(hasConclusion('I confirmed that the file exists.'), true)
  assert.equal(hasConclusion('The culprit is the EISDIR handler.'), true)
})
ok('does not match narration or questions', () => {
  assert.equal(hasConclusion('Let me check the log before saying anything.'), false)
  assert.equal(hasConclusion('I will read /var/log/vbox-install.log next.'), false)
  assert.equal(hasConclusion('What could cause the crash?'), false)
  assert.equal(hasConclusion('that is why it reconnects'), false, 'long-form "that is why" is outside the pattern')
  assert.equal(hasConclusion(''), false)
  assert.equal(hasConclusion(undefined), false)
})

console.log('detect: shouldPlan')
ok('fires at planStep with enough tools and no todo', () => {
  assert.equal(shouldPlan({ step: 5, toolCallsThisTurn: 3, sawTodo: false, plannedNudged: false }), true)
  assert.equal(shouldPlan({ step: 7, toolCallsThisTurn: 9, sawTodo: false, plannedNudged: false }), true, 'still eligible past planStep')
})
ok('stays quiet before the bar, after a todo, or after a nudge', () => {
  assert.equal(shouldPlan({ step: 4, toolCallsThisTurn: 3, sawTodo: false, plannedNudged: false }), false)
  assert.equal(shouldPlan({ step: 5, toolCallsThisTurn: 2, sawTodo: false, plannedNudged: false }), false)
  assert.equal(shouldPlan({ step: 5, toolCallsThisTurn: 6, sawTodo: true, plannedNudged: false }), false)
  assert.equal(shouldPlan({ step: 5, toolCallsThisTurn: 6, sawTodo: false, plannedNudged: true }), false)
})
ok('config overrides apply', () => {
  assert.equal(shouldPlan({ step: 3, toolCallsThisTurn: 4, sawTodo: false, plannedNudged: false }, { planStep: 3, planMinTools: 4 }), true)
})

// ── apply() replay: firehose in, nudged pre-step out ──────────────────────────
function fakeCtx() {
  const listeners = {}
  return {
    on(event, handler) { listeners[event] = handler },
    _listeners: listeners,
  }
}

function driver(config = {}) {
  const ctx = fakeCtx()
  plugin.apply(ctx, config)
  const session = { id: 'S1' }
  const agent = { id: 'S1' }
  const firehose = event => ctx._listeners['session/event'](session, event)
  const preStep = step => ctx._listeners['agent/pre-step'](
    { agent, step },
    async () => ({ kind: 'enter', messages: [] }),
  )
  return { firehose, preStep }
}

const text = t => ({ data: { message: { content: [{ type: 'text', text: t }] } } })
const call = name => ({ data: { callId: `c-${name}-${Math.random()}`, name, arguments: '{}' } })
const injected = decision => decision.messages.map(m => m.content[0].text)

console.log('apply: verify-before-conclude')
await okAsync('an unevidenced conclusion arms a nudge at the next step', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  d.firehose({ type: 'assistant/message', ...text('The root cause is that VBoxSVC crashes.') })
  const decision = await d.preStep(2)
  const msgs = injected(decision)
  assert.equal(msgs.length, 1)
  assert.match(msgs[0], /\[grounding\]/)
  assert.match(msgs[0], /verify/i)
})
await okAsync('a conclusion AFTER a tool call this stretch is evidence — no nudge', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  d.firehose({ type: 'tool/call', ...call('read') })
  d.firehose({ type: 'assistant/message', ...text('The root cause is that VBoxSVC crashes — I just read it in the log.') })
  const decision = await d.preStep(2)
  assert.equal(injected(decision).length, 0)
})
await okAsync('rate limit: a second armed conclusion inside verifyEvery stays quiet', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  d.firehose({ type: 'assistant/message', ...text('The issue is the watchdog, definitely.') })
  assert.equal(injected(await d.preStep(2)).length, 1, 'first nudge fires')
  // New conclusion immediately again — still inside the window.
  d.firehose({ type: 'assistant/message', ...text("That's why it died: the watchdog.") })
  const soon = await d.preStep(3)
  assert.equal(injected(soon).length, 0, 'inside verifyEvery no second nudge')
  d.firehose({ type: 'assistant/message', ...text('The culprit is confirmed once more, unchecked.') })
  const later = await d.preStep(2 + 6)
  assert.equal(injected(later).length, 1, 'verifyEvery steps later it fires again')
})
await okAsync('a fresh user message clears the arm (fresh intent)', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  d.firehose({ type: 'assistant/message', ...text('The root cause is that VBoxSVC crashes.') })
  d.firehose({ type: 'user/message', data: { content: 'ok, next question' } })
  assert.equal(injected(await d.preStep(2)).length, 0)
})
await okAsync('turn/start resets per-turn state', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  d.firehose({ type: 'tool/call', ...call('bash') })
  d.firehose({ type: 'tool/call', ...call('read') })
  d.firehose({ type: 'tool/call', ...call('bash') })
  d.firehose({ type: 'assistant/message', ...text('The root cause is X.') })
  d.firehose({ type: 'turn/start', data: { turn: 2 } })
  const decision = await d.preStep(6)
  assert.equal(injected(decision).length, 0, 'neither arm survives the turn boundary')
})

console.log('apply: plan-on-multistep')
await okAsync('step 5 with 3 tools and no todo gets exactly one plan nudge', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  for (let i = 0; i < 3; i++) d.firehose({ type: 'tool/call', ...call('bash') })
  const first = await d.preStep(5)
  const msgs = injected(first)
  assert.equal(msgs.length, 1)
  assert.match(msgs[0], /todo_write/)
  const second = await d.preStep(6)
  assert.equal(injected(second).length, 0, 'once per turn only')
})
await okAsync('a todo_write this turn satisfies the plan requirement', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  for (let i = 0; i < 4; i++) d.firehose({ type: 'tool/call', ...call('bash') })
  d.firehose({ type: 'tool/call', ...call('todo_write') })
  const decision = await d.preStep(5)
  assert.equal(injected(decision).length, 0)
})
await okAsync('verify nudge takes precedence over plan nudge in the same step', async () => {
  const d = driver()
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  d.firehose({ type: 'assistant/message', ...text('The root cause is X.') })
  for (let i = 0; i < 3; i++) d.firehose({ type: 'tool/call', ...call('bash') })
  const decision = await d.preStep(5)
  const msgs = injected(decision)
  assert.equal(msgs.length, 1, 'one nudge per step, never two')
  assert.match(msgs[0], /verify/i)
  // The plan nudge is still pending and lands the next step.
  const next = await d.preStep(6)
  assert.match(injected(next)[0], /todo_write/)
})
await okAsync('enabled:false disables both nudges', async () => {
  const d = driver({ enabled: false })
  d.firehose({ type: 'turn/start', data: { turn: 1 } })
  d.firehose({ type: 'assistant/message', ...text('The root cause is X.') })
  for (let i = 0; i < 3; i++) d.firehose({ type: 'tool/call', ...call('bash') })
  assert.equal(injected(await d.preStep(5)).length, 0)
})
await okAsync('reject decisions pass through untouched', async () => {
  const ctx = fakeCtx()
  plugin.apply(ctx)
  const decision = await ctx._listeners['agent/pre-step'](
    { agent: { id: 'S1' }, step: 5 },
    async () => ({ kind: 'reject' }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
})

console.log(`\n${passed} checks passed`)

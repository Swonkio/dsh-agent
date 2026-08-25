/**
 * dsh-memory skill-synthesis self-test: the pure helpers behind the detached
 * skill-synthesis review. Run: node tools/test-skill-synthesis.mjs
 */
import assert from 'node:assert/strict'
import {
  callBrief, isProcedural, formatProcedure, skillPrompt, skillReviewDecision,
} from '../lib/index.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

console.log('callBrief')
ok('prefers the human-relevant key (bash command)', () => {
  assert.equal(
    callBrief(JSON.stringify({ command: 'systemctl status rat-panel', timeoutMs: 5000 })),
    'systemctl status rat-panel',
  )
})
ok('falls back through file_path and other keys', () => {
  assert.equal(callBrief(JSON.stringify({ file_path: '/home/agent/panel/server.js', old_string: 'x' })), '/home/agent/panel/server.js')
  assert.equal(callBrief(JSON.stringify({ pattern: 'root cause', include: '*.js' })), 'root cause')
})
ok('caps and collapses the brief at ~60 chars', () => {
  const brief = callBrief(JSON.stringify({ command: `echo ${'word '.repeat(40)}` }))
  assert.ok(brief.length <= 60, `brief too long: ${brief.length}`)
  assert.ok(!brief.includes('\n'), 'whitespace collapsed')
})
ok('bad JSON yields an empty brief, not a throw', () => {
  assert.equal(callBrief('{not json'), '')
  assert.equal(callBrief(undefined), '')
  assert.equal(callBrief('null'), '')
})

console.log('isProcedural')
const seq = names => names.map(name => ({ name, brief: '' }))
ok('true past minTools when an action tool is present', () => {
  assert.equal(isProcedural(seq(['read', 'bash', 'write', 'edit', 'read'])), true)
  assert.equal(isProcedural(seq(['read', 'bash', 'read'])), false, 'too few calls')
  assert.equal(isProcedural(seq(['read', 'read', 'read', 'read', 'read', 'read'])), false, 'read-only is not a recipe')
  assert.equal(isProcedural(seq(['bash', 'bash', 'bash', 'bash'])), false, 'four calls, not five')
  assert.equal(isProcedural(undefined), false)
})
ok('minTools is configurable', () => {
  assert.equal(isProcedural(seq(['bash', 'write']), 2), true)
})

console.log('formatProcedure')
ok('renders a compact numbered list with briefs', () => {
  const text = formatProcedure([
    { name: 'read', brief: '/var/log/vbox-install.log' },
    { name: 'bash', brief: 'systemctl restart vboxdrv' },
    { name: 'todo_write', brief: '' },
  ])
  assert.equal(text, '1. read — /var/log/vbox-install.log\n2. bash — systemctl restart vboxdrv\n3. todo_write')
})
ok('caps total bytes', () => {
  const big = Array.from({ length: 100 }, (_, i) => ({ name: 'bash', brief: `command number ${i} ${'x'.repeat(50)}` }))
  const text = formatProcedure(big, 500)
  assert.ok(Buffer.byteLength(text) <= 500 + 4, `capped, got ${Buffer.byteLength(text)}`)
  assert.ok(text.endsWith('…'))
})
ok('tolerates non-array input', () => {
  assert.equal(formatProcedure(undefined), '')
})

console.log('skillPrompt')
ok('asks for skill_create with the nothing-to-keep escape, carrying the procedure', () => {
  const p = skillPrompt('restart the panel node', '1. bash — systemctl status rat-panel\n2. edit — /etc/systemd/system/rat-panel.service')
  assert.match(p, /skill_create/)
  assert.match(p, /nothing to keep/)
  assert.match(p, /USER REQUEST:\nrestart the panel node/)
  assert.match(p, /PROCEDURE FOLLOWED:\n1\. bash/)
  assert.match(p, /whenToUse/)
})

console.log('skillReviewDecision (15-min throttle)')
ok('fires when enabled and outside the window; throttles inside it', () => {
  const now = 1_000_000_000
  assert.equal(skillReviewDecision({ enabled: true, lastReviewMs: 0, now }), true)
  assert.equal(skillReviewDecision({ enabled: true, lastReviewMs: now - 10 * 60_000, now }), false, '10 min in: still throttled')
  assert.equal(skillReviewDecision({ enabled: true, lastReviewMs: now - 16 * 60_000, now }), true)
  assert.equal(skillReviewDecision({ enabled: false, lastReviewMs: 0, now }), false)
})

console.log(`\n${passed} checks passed`)

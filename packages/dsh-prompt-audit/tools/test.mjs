/**
 * dsh-prompt-audit self-test: the pure report renderer, plus the waterfall
 * capture through apply() with a fake context.
 * Run: node tools/test.mjs   (from ~/.dsh-agent/profiles for harness imports)
 */
import assert from 'node:assert/strict'
import { renderPromptReport, apply } from '../lib/index.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

console.log('renderPromptReport')
const snapshot = {
  at: Date.now() - 5000,
  sections: [
    { name: 'memory:index', bytes: 8192 },
    { name: 'persona', bytes: 500 },
    { name: 'memory:lessons', bytes: 2048 },
    { name: 'sandbox:policy', bytes: 300 },
  ],
  contexts: [{ name: 'runtime-context', bytes: 700 }],
  tools: 23,
  toolBytes: 21000,
  warnAt: 40000,
}

ok('renders sections sorted by size with a total and tool weight', () => {
  const text = renderPromptReport(snapshot)
  assert.match(text, /## System prompt — 11,040 bytes across 4 sections/)
  assert.match(text, /memory:index/)
  assert.ok(text.indexOf('memory:index') < text.indexOf('memory:lessons'), 'biggest first')
  assert.match(text, /## Tools — 23 schemas/)
  assert.match(text, /Prompt-side total: ~32,740 bytes/)
  assert.match(text, /assembled 5s ago/)
})
ok('warns when over the audit threshold', () => {
  const text = renderPromptReport({ ...snapshot, toolBytes: 90000 })
  assert.match(text, /⚠️ Above the 40,000-byte audit threshold/)
})
ok('no snapshot yet → friendly empty state', () => {
  assert.match(renderPromptReport(undefined), /No prompt assembly observed yet/)
})
ok('contexts omitted when none were captured', () => {
  const text = renderPromptReport({ ...snapshot, contexts: [] })
  assert.ok(!text.includes('Dynamic contexts'), 'no empty contexts section')
})

console.log('apply: waterfall capture')
await okAsync('captures sections, contexts, and tools from a real assembly pass', async () => {  const listeners = {}
  const commands = []
  const ctx = {
    on(event, handler) { listeners[event] = handler },
    commands: { register: cmd => commands.push(cmd) },
  }
  apply(ctx, { warnAtBytes: 40000 })
  assert.equal(commands.length, 1, 'registers the /prompt command')
  assert.equal(commands[0].name, 'prompt')

  const assembly = {
    sections: [{ name: 'a', text: 'x'.repeat(100) }, { name: 'b', text: 'y'.repeat(50) }],
    contexts: [{ name: 'ctx', text: 'z'.repeat(10) }],
    tools: [{ name: 'bash', description: 'd', parameters: { command: { type: 'string' } } }],
  }
  const passthrough = await listeners['system-prompt/assemble'](assembly, { scope: 'agent-1' }, async () => assembly)
  assert.deepEqual(passthrough, assembly, 'assembly passes through untouched')

  const report = await commands[0].handler()
  assert.match(report.kind === undefined ? report.text : report.text, /## System prompt — 150 bytes across 2 sections/)
  assert.match(report.text, /scope agent-1/)
  assert.match(report.text, /## Tools — 1 schemas/)
})

console.log(`\n${passed} checks passed`)

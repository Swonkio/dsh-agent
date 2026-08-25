/**
 * LIVE test A — lesson recall through the real dsh-memory apply().
 * Self-contained: writes its own scratch memory index into DSH_HOME (which
 * MUST point at a scratch home — refused otherwise), then drives the
 * relevance query through firehose events.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as memory from '../packages/dsh-memory/lib/index.js'

const home = process.env.DSH_HOME
assert.ok(home?.includes('test-home'), `refusing a non-scratch DSH_HOME (${home})`)

// The lesson corpus this test asserts against, so the two can never drift.
const LESSONS = [
  '- Lesson: vbox-log-before-concluding: When diagnosing the VirtualBox VM crash, read the vbox-install log with one command before stating the root cause',
  '- Lesson: npm-symlink-destruction: When npm install runs inside a symlinked kit package it deletes harness packages it calls extraneous',
  '- Local model serving: llama.cpp on 127.0.0.1:8080 with contextWindow matched',
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
memory.apply(ctx, { lessonsTopK: 2, lessonsMinScore: 0.2 })

assert.ok(sections['memory:lessons'], 'memory:lessons section registered')
assert.ok(sections['memory:lessons'].order === 18, `order 18, got ${sections['memory:lessons'].order}`)
console.log('  section memory:lessons registered at order', sections['memory:lessons'].order)

// Relevant query: the task is about the VBox VM crash diagnosis.
listeners['session/event']({ id: 'S1' }, { type: 'user/message', data: { content: 'the vbox VM crashes during install, find the root cause' } })
listeners['session/event']({ id: 'S1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'checking the virtualbox setup now' }] } } })

const text = sections['memory:lessons'].text()
console.log('--- rendered section ---')
console.log(text)
console.log('------------------------')
assert.match(text, /# Relevant past mistakes — apply these before acting:/)
assert.match(text, /vbox-log-before-concluding/, 'relevant lesson surfaced')
assert.ok(!text.includes('Local model serving'), 'non-lesson lines excluded')

// Drift the conversation to npm; recall must re-focus (this is the whole point).
listeners['session/event']({ id: 'S1' }, { type: 'user/message', data: { content: 'npm install wiped packages in the kit' } })
listeners['session/event']({ id: 'S1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the symlinked package lost its extraneous deps' }] } } })
const text2 = sections['memory:lessons'].text()
console.log('--- after drift ---')
console.log(text2)
console.log('-------------------')
assert.match(text2, /npm-symlink-destruction/, 'recall follows task drift')

// Irrelevant query on a FRESH apply instance → no section at all. (Query text
// is per-apply state shared with the shipped memory:index — separate sessions
// run in separate processes, so per-instance is the real granularity.)
{
  const sections2 = {}
  const listeners2 = {}
  const ctx2 = {
    on(event, handler) { listeners2[event] = handler },
    effect: () => {},
    systemPrompt: { section: s => { sections2[s.name] = s } },
    tools: { register: () => {} },
    commands: { register: () => {} },
  }
  memory.apply(ctx2, { lessonsTopK: 2, lessonsMinScore: 0.2 })
  listeners2['session/event']({ id: 'S1' }, { type: 'user/message', data: { content: 'completely unrelated gardening question about tomatoes' } })
  assert.equal(sections2['memory:lessons'].text(), '', 'irrelevant query yields no section')
}
console.log('✓ LIVE A PASS: lesson recall renders, re-focuses on drift, empty when irrelevant')

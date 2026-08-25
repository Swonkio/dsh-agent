/**
 * dsh-memory lesson-recall self-test: the pure ranking helper behind the
 * `memory:lessons` prompt section. Run: node tools/test-lesson-recall.mjs
 */
import assert from 'node:assert/strict'
import { rankLessons } from '../lib/index.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

const LINES = [
  '- Local model serving: an OpenAI-compatible server on 127.0.0.1:8080; contextWindow must match its real context size',
  '- Lesson: verify-before-concluding: When you assert a root cause about the VBox VM, read the vbox-install log with one command before acting on it',
  '- Lesson: npm-symlink-destruction: When npm install runs inside a symlinked kit package, it deletes harness packages it calls extraneous — never link @deepseek-ai into an npm package',
  '- Homelab topology: VMs win11 (.6) and win11b (.4) on the WormNet subnet',
  '- lesson: lowercase lesson titles also count: When the panel crashes, check the EISDIR handler first',
]

console.log('rankLessons')
ok('selects the lesson RELEVANT to the query, ranked first', () => {
  const hits = rankLessons(LINES, 'the vbox VM keeps crashing during install, need the root cause from the log before I act', 3, 0.2)
  assert.ok(hits.length >= 1, `expected at least one lesson, got ${hits.length}`)
  assert.match(hits[0], /verify-before-concluding/)
})
ok('non-lesson lines are never selected, however similar', () => {
  const hits = rankLessons(LINES, 'vbox VM win11 win11b WormNet subnet topology crashes install log', 3, 0.05)
  for (const line of hits) assert.match(line, /^-\s*(\*\*)?[Ll]esson/, `non-lesson line selected: ${line}`)
})
ok('empty query → []', () => {
  assert.deepEqual(rankLessons(LINES, '', 3, 0.2), [])
  assert.deepEqual(rankLessons(LINES, undefined, 3, 0.2), [])
})
ok('no lessons → []', () => {
  const plain = LINES.filter(line => !/[Ll]esson/.test(line))
  assert.deepEqual(rankLessons(plain, 'vbox vbox vbox log log crash crash root cause', 3, 0.1), [])
})
ok('respects k and minScore', () => {
  const broad = 'lesson lesson lesson vbox npm log symlink crash panel handler root cause install package harness extraneous acting'
  assert.ok(rankLessons(LINES, broad, 1, 0.1).length <= 1, 'k=1 caps the result')
  assert.deepEqual(rankLessons(LINES, broad, 3, 0.99), [], 'a minScore nothing reaches yields []')
})
ok('a query about npm picks the npm lesson over the vbox one', () => {
  const hits = rankLessons(LINES, 'npm install deleted harness packages in the symlinked kit package extraneous', 2, 0.15)
  if (hits.length > 0) assert.match(hits[0], /npm-symlink-destruction/, `expected npm lesson first, got: ${hits[0]}`)
  else assert.fail('expected the npm lesson to clear minScore')
})

console.log(`\n${passed} checks passed`)

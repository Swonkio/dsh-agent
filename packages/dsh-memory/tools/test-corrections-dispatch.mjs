/**
 * dsh-memory correction + dispatch + digest + efficacy self-test.
 * Run: node tools/test-corrections-dispatch.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isCorrection, correctionPrompt, correctionReviewDecision,
  combineReviewPayloads, digestPrompt, lessonTopic,
  noteLessonHits, noteLessonMisses,
} from '../lib/index.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

console.log('isCorrection')
ok('matches sharp corrections', () => {
  assert.equal(isCorrection('No, use the Q6 model not Q8'), true)
  assert.equal(isCorrection('wrong — the port is 8081'), true)
  assert.equal(isCorrection("Actually I wanted the bullet list, not a table"), true)
  assert.equal(isCorrection("don't restart it, just reload the config"), true)
  assert.equal(isCorrection('I said LOCAL model, not openrouter'), true)
  assert.equal(isCorrection('instead, edit the template directly'), true)
})
ok('does not match ordinary messages', () => {
  assert.equal(isCorrection('no'), false, 'too short')
  assert.equal(isCorrection('now run the tests please'), false, '"now" is not "no,"')
  assert.equal(isCorrection('can you check the logs?'), false)
  assert.equal(isCorrection('nostalgia is not a correction'), false, 'word starting with "no" but not the word "no"')
  assert.equal(isCorrection(''), false)
  assert.equal(isCorrection(undefined), false)
})

console.log('correctionPrompt + correctionReviewDecision')
ok('prompt frames the correction as highest-signal with the escape', () => {
  const p = correctionPrompt('no, use Q6', 'use the Q8 model for 256k')
  assert.match(p, /CORRECTED/)
  assert.match(p, /memory_save/)
  assert.match(p, /nothing to keep/)
  assert.match(p, /WHAT THE AGENT SAID:\nuse the Q8 model/)
  assert.match(p, /THE USER'S CORRECTION:\nno, use Q6/)
})
ok('5-minute throttle', () => {
  const now = 1_000_000_000
  assert.equal(correctionReviewDecision({ enabled: true, lastReviewMs: 0, now }), true)
  assert.equal(correctionReviewDecision({ enabled: true, lastReviewMs: now - 60_000, now }), false)
  assert.equal(correctionReviewDecision({ enabled: true, lastReviewMs: now - 6 * 60_000, now }), true)
})

console.log('combineReviewPayloads')
ok('a lone item passes through untouched', () => {
  assert.equal(combineReviewPayloads([{ kind: 'x', prompt: 'PROMPT-A' }]), 'PROMPT-A')
  assert.equal(combineReviewPayloads([]), '')
  assert.equal(combineReviewPayloads(undefined), '')
})
ok('several items become numbered independent tasks', () => {
  const combined = combineReviewPayloads([
    { kind: 'failure post-mortem', prompt: 'FAILURE-BODY' },
    { kind: 'skill synthesis', prompt: 'SKILL-BODY' },
    { kind: 'correction review', prompt: 'CORRECTION-BODY' },
  ])
  assert.match(combined, /3 INDEPENDENT review tasks/)
  assert.match(combined, /TASK 1\/3 — failure post-mortem/)
  assert.match(combined, /FAILURE-BODY/)
  assert.match(combined, /TASK 3\/3 — correction review/)
  assert.ok(combined.indexOf('FAILURE-BODY') < combined.indexOf('SKILL-BODY'), 'order preserved')
})

console.log('digestPrompt')
ok('carries the session id and exchanges, with the escape', () => {
  const p = digestPrompt(
    [{ user: 'restart the panel', assistant: 'done, healthz ok' }, { user: 'and the bot?', assistant: 'restarted too' }, { user: 'thanks', assistant: 'ok' }],
    'session-abc',
  )
  assert.match(p, /digest_save/)
  assert.match(p, /SESSION ID:\nsession-abc/)
  assert.match(p, /USER: restart the panel/)
  assert.match(p, /nothing to keep/)
})

console.log('lessonTopic')
ok('extracts the handle from a lesson line', () => {
  assert.equal(lessonTopic('- Lesson: vbox-log-before-concluding: When diagnosing…'), 'vbox-log-before-concluding')
  assert.equal(lessonTopic('- lesson: lowercase too: summary'), 'lowercase too')
  assert.equal(lessonTopic('- Local model serving: not a lesson'), null)
  assert.equal(lessonTopic('garbage'), null)
})

console.log('lesson efficacy logs')
await okAsync('hits and misses are written as bounded JSONL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-lessons-'))
  try {
    // The miss matcher scores against the lesson's full index line.
    await writeFile(join(home, 'MEMORY.md'), [
      '# Memory index',
      '- Lesson: topic-a: When the panel topic a crashes during restart, check the service file first',
      '- Lesson: topic-b: unrelated npm symlink harness packages extraneous deletion warning',
      '',
    ].join('\n'))
    noteLessonHits(home, ['- Lesson: topic-a: When the panel topic a crashes during restart, check the service file first', '- Lesson: topic-b: unrelated npm symlink harness packages'])
    noteLessonHits(home, ['- Lesson: topic-a: When the panel topic a crashes during restart, check the service file first'])
    const hits = (await readFile(join(home, '.lesson-hits.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(hits.length, 3)
    assert.deepEqual(hits.map(l => JSON.parse(l).topic).sort(), ['topic-a', 'topic-a', 'topic-b'])

    // A failure context lexically close to topic-a's line → one miss for topic-a only.
    await noteLessonMisses(home, 'the panel crashed during restart again, the service file was never checked')
    const misses = (await readFile(join(home, '.lesson-misses.jsonl'), 'utf8')).trim().split('\n')
    const topics = misses.map(l => JSON.parse(l).topic)
    assert.ok(topics.includes('topic-a'), `expected topic-a miss, got ${topics.join(',')}`)
    assert.ok(!topics.includes('topic-b'), 'unrelated lesson not marked')
    // noteLessonHits with nothing is a no-op; missing files read as empty.
    noteLessonHits(home, [])
    await noteLessonMisses(join(home, 'nonexistent'), 'anything')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

console.log(`\n${passed} checks passed`)

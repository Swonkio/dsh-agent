/**
 * Unit checks for dsh-learning-eval: scoring (especially that a forbidden term
 * zeroes an answer), the ceiling-control guard that keeps the headline honest,
 * task validation, and the A/B runner driven by a fake model.
 *
 * Usage: node tools/test.mjs
 * @module dsh-learning-eval/tools/test
 */

import { scoreAnswer, compareRuns, contains, normalize, mean, stddev } from '../lib/score.js'
import { runEval, summarize } from '../lib/runner.js'
import { validateTask, loadTasks } from '../lib/tasks.js'
import { renderReport } from '../lib/report.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0
const failures = []
const ok = (name, cond, detail = '') => { cond === true ? (passed += 1) : failures.push(`${name}${detail ? ' — ' + detail : ''}`) }
const here = dirname(fileURLToPath(import.meta.url))

// ── matching ────────────────────────────────────────────────────────────────
ok('normalize strips punctuation', normalize('Port: 7431!') === 'port 7431')
ok('contains ignores case', contains('The PORT is 7431', 'port is 7431'))
ok('contains ignores punctuation', contains('prod-east cluster', 'prod east'))
ok('empty needle never matches', !contains('anything', ''))

// ── scoring ─────────────────────────────────────────────────────────────────
{
  ok('all terms present scores 1', scoreAnswer('port 7431 loopback', { includes: ['7431', 'loopback'] }).score === 1)
  ok('half the terms scores 0.5', scoreAnswer('port 7431', { includes: ['7431', 'loopback'] }).score === 0.5)
  ok('missed terms are reported', scoreAnswer('port 7431', { includes: ['7431', 'loopback'] }).missed[0] === 'loopback')

  // The central scoring rule.
  const wrong = scoreAnswer('deploys go to prod-east, formerly staging-west', { includes: ['prod-east'], excludes: ['staging-west'] })
  ok('a forbidden term zeroes the answer outright', wrong.score === 0)
  ok('the forbidden term is named', wrong.forbidden[0] === 'staging-west')
  ok('a clean answer with excludes scores full', scoreAnswer('prod-east', { includes: ['prod-east'], excludes: ['staging-west'] }).score === 1)
  ok('no expectations scores 1', scoreAnswer('anything', {}).score === 1)
  ok('an empty answer scores 0', scoreAnswer('', { includes: ['7431'] }).score === 0)
}

// ── statistics ──────────────────────────────────────────────────────────────
ok('mean of empty is 0', mean([]) === 0)
ok('stddev of one sample is 0', stddev([1]) === 0)
ok('stddev detects spread', stddev([0, 1]) === 0.5)

// ── the ceiling guard ───────────────────────────────────────────────────────
{
  const helped = compareRuns([1, 1], [0, 0])
  ok('lift is computed', helped.lift === 1)
  ok('a task with a low control measures memory', helped.measuresMemory === true)
  ok('a clear difference is significant', helped.significant === true)

  const ceiling = compareRuns([1, 1], [1, 1])
  ok('a control at ceiling does NOT measure memory', ceiling.measuresMemory === false)

  const noisy = compareRuns([1, 0], [0.6, 0.4])
  ok('a difference inside the noise is not significant', noisy.significant === false)

  const hurt = compareRuns([0, 0], [1, 1])
  ok('a regression shows negative lift', hurt.lift === -1)
}

// ── summarize excludes ceiling tasks from the headline ──────────────────────
{
  const summary = summarize([
    { id: 'good', measuresMemory: true, lift: 1, treatment: 1, control: 0, significant: true, answers: { treatment: [], control: [] } },
    { id: 'ceil', measuresMemory: false, lift: 0, treatment: 1, control: 1, significant: false, answers: { treatment: [], control: [] } },
  ])
  ok('ceiling tasks are excluded from mean lift', summary.meanLift === 1, 'a diluted 0.5 would understate a working loop')
  ok('ceiling tasks are named', summary.ceiling[0] === 'ceil')
  ok('measuring count is right', summary.measuring === 1)
  ok('helped count is right', summary.helped === 1)
}

// ── task validation ─────────────────────────────────────────────────────────
{
  const good = { id: 't', prompt: 'p', memories: [{ topic: 'a', summary: 'b' }], expect: { includes: ['x'] } }
  ok('a well-formed task validates', validateTask(good) === good)
  const rejects = (task, why) => {
    try { validateTask(task); failures.push(`should reject: ${why}`) } catch { passed += 1 }
  }
  rejects({ ...good, id: '' }, 'empty id')
  rejects({ ...good, prompt: '  ' }, 'blank prompt')
  rejects({ ...good, memories: [] }, 'no memories to seed')
  rejects({ ...good, memories: [{ topic: 'a' }] }, 'memory without a summary')
  rejects({ ...good, expect: {} }, 'nothing to grade')
  rejects({ ...good, expect: { includes: 'x' } }, 'includes not an array')
  rejects(null, 'not an object')
}

// ── the shipped task set must be valid and must probe memory ────────────────
{
  const tasks = await loadTasks(join(here, '..', 'tasks'))
  ok('starter tasks load and validate', tasks.length >= 4)
  ok('every starter task seeds memory', tasks.every(t => t.memories.length > 0))
  // supersede-stale tests supersession by INCLUDE alone: a current answer has
  // prod-east, a stale answer says staging-west and lacks it. It must NOT
  // forbid staging-west, which appears in its own seeded memory.
  const supersede = tasks.find(t => t.id === 'supersede-stale')
  ok('the supersede task requires the current value', supersede?.expect.includes?.includes('prod-east') === true)
  ok('the supersede task does not forbid its own memory term', !(supersede?.expect.excludes ?? []).includes('staging-west'))
  // The self-clash guard must reject a task that forbids a term in its memory.
  let clashCaught = false
  try { validateTask({ id: 'clash', prompt: 'p', memories: [{ topic: 'a', summary: 'deploy to staging-west' }], expect: { includes: ['prod-east'], excludes: ['staging-west'] } }) }
  catch { clashCaught = true }
  ok('validateTask rejects an exclude that clashes with its own memory', clashCaught)
}

// ── the runner, driven by a fake model ──────────────────────────────────────
{
  const tasks = [{
    id: 'fake', prompt: 'what port?', memories: [{ topic: 'p', summary: 'port 7431' }], expect: { includes: ['7431'] },
  }]
  // A model that can only answer when the memory was seeded — the behaviour a
  // working loop should produce.
  const summary = await runEval({
    tasks,
    repeats: 2,
    seedHome: async ({ condition }) => condition,
    runTurn: async ({ home }) => (home === 'treatment' ? 'it is port 7431' : 'I do not know'),
  })
  ok('treatment scores full', summary.results[0].treatment === 1)
  ok('control scores zero', summary.results[0].control === 0)
  ok('lift is detected', summary.meanLift === 1)
  ok('repeats are recorded', summary.results[0].runs === 2)
  ok('answers are retained for inspection', summary.results[0].answers.treatment.length === 2)

  // A crashing backend must score zero, not abort the sweep.
  const crashed = await runEval({
    tasks,
    seedHome: async () => 'x',
    runTurn: async () => { throw new Error('backend exploded') },
  })
  ok('a crashed run scores zero instead of aborting', crashed.results[0].treatment === 0)
  ok('the error is retained', crashed.results[0].answers.treatment[0].error === 'backend exploded')

  const report = renderReport(summary, { model: 'test', repeats: 2 })
  ok('report states the verdict', report.includes('Verdict'))
  ok('report has a per-task table', report.includes('| task |'))
}

// ── a report where nothing measures memory says so loudly ───────────────────
{
  const summary = summarize([
    { id: 'a', measuresMemory: false, lift: 0, treatment: 1, control: 1, significant: false, answers: { treatment: [], control: [] } },
  ])
  const report = renderReport(summary)
  ok('an all-ceiling run warns about task design', report.includes('No task measured memory'))
}

// ── a regression is called out by name ──────────────────────────────────────
{
  const summary = summarize([{
    id: 'bad', measuresMemory: true, lift: -1, treatment: 0, control: 1, significant: true,
    answers: { treatment: [{ forbidden: ['staging-west'] }], control: [] },
  }])
  const report = renderReport(summary)
  ok('regressions get their own section', report.includes('made these WORSE'))
  ok('the forbidden value is surfaced', report.includes('staging-west'))
}

if (failures.length === 0) console.log(`${passed} passed, 0 failed`)
else { console.log(`${passed} passed, ${failures.length} failed`); for (const f of failures) console.log('  ✗', f); process.exit(1) }

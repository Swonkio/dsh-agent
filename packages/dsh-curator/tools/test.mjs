/**
 * Unit checks for dsh-curator: the outcome-vs-recency policy (especially that
 * a failing skill is flagged rather than retired), the invariants that protect
 * pinned entries and forbid deletion, the run gate, and the memory scan.
 *
 * Usage: node tools/test.mjs
 * @module dsh-curator/tools/test
 */

import {
  emptyRecord, recordOutcome, failureRate, classify, curationPlan,
  planIsEmpty, shouldRun, renderReport, renderLoopReport, daysSince, DEFAULTS,
} from '../lib/policy.js'
import { renderSkillOutcomes } from '../lib/index.js'
import { loadUsage, saveUsage, noteOutcome, archiveSkill, restoreSkill, setPinned, listSkills, scanMemory, loadLessonStats, loadBreaks, loadReviewAges } from '../lib/store.js'
import { skillNameFrom } from '../lib/index.js'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const failures = []
const ok = (name, cond, detail = '') => { cond === true ? (passed += 1) : failures.push(`${name}${detail ? ' — ' + detail : ''}`) }
const DAY = 86400000
const NOW = Date.parse('2026-06-01T00:00:00Z')
const daysAgo = n => new Date(NOW - n * DAY).toISOString()

// ── telemetry folding ───────────────────────────────────────────────────────
{
  let rec = emptyRecord(daysAgo(10))
  ok('empty record starts clean', rec.uses === 0 && rec.wins === 0 && rec.losses === 0)
  rec = recordOutcome(rec, 'win', daysAgo(9))
  rec = recordOutcome(rec, 'loss', daysAgo(8))
  ok('uses counts every load', rec.uses === 2)
  ok('wins and losses are separate', rec.wins === 1 && rec.losses === 1)
  ok('failure rate over decided outcomes', failureRate(rec) === 0.5)
  ok('no evidence yields null rate', failureRate(emptyRecord()) === null)
  const undecided = recordOutcome(emptyRecord(), 'unknown')
  ok('an undecided turn does not poison the rate', failureRate(undecided) === null)
  ok('an undecided turn still counts as a use', undecided.uses === 1)
  ok('firstUsed is preserved', rec.firstUsed === daysAgo(10))
}

// ── the central claim: failing ≠ unused ─────────────────────────────────────
{
  const failing = { ...emptyRecord(daysAgo(3)), uses: 10, wins: 3, losses: 7, lastUsed: daysAgo(1) }
  const decision = classify(failing, { now: NOW })
  ok('a failing skill is FLAGGED, not archived', decision.action === 'flag')
  ok('the reason explains revise-not-retire', decision.reason.includes('revise'))

  const idle = { ...emptyRecord(daysAgo(400)), uses: 5, wins: 5, losses: 0, lastUsed: daysAgo(400) }
  ok('a long-unused skill is archived', classify(idle, { now: NOW }).action === 'archive')

  const cooling = { ...emptyRecord(daysAgo(60)), uses: 5, wins: 5, losses: 0, lastUsed: daysAgo(60) }
  ok('a recently-idle skill goes stale first', classify(cooling, { now: NOW }).action === 'stale')

  const healthy = { ...emptyRecord(daysAgo(2)), uses: 20, wins: 19, losses: 1, lastUsed: daysAgo(1) }
  ok('a working skill is kept', classify(healthy, { now: NOW }).action === 'keep')

  // A high failure RATE on thin evidence is noise, not a verdict.
  const thin = { ...emptyRecord(daysAgo(2)), uses: 2, wins: 0, losses: 2, lastUsed: daysAgo(1) }
  ok('two failures is not enough evidence to flag', classify(thin, { now: NOW }).action === 'keep')

  // Failure outranks age: a failing skill that is ALSO idle must still be
  // flagged for revision rather than quietly archived.
  const failingAndOld = { ...emptyRecord(daysAgo(400)), uses: 10, wins: 2, losses: 8, lastUsed: daysAgo(400) }
  ok('failure outranks age', classify(failingAndOld, { now: NOW }).action === 'flag')
}

// ── invariants ──────────────────────────────────────────────────────────────
{
  const pinnedFailing = { ...emptyRecord(daysAgo(400)), uses: 10, wins: 0, losses: 10, lastUsed: daysAgo(400), pinned: true }
  ok('pinned bypasses every heuristic', classify(pinnedFailing, { now: NOW }).action === 'keep')
  ok('pinned says why', classify(pinnedFailing, { now: NOW }).reason.includes('pinned'))
  const archived = { ...emptyRecord(daysAgo(400)), state: 'archived', lastUsed: daysAgo(400) }
  ok('an archived skill is not re-archived', classify(archived, { now: NOW }).action === 'keep')
  ok('no policy path ever returns delete',
    ['flag', 'stale', 'archive', 'keep'].includes(classify({ ...emptyRecord(daysAgo(9999)), lastUsed: daysAgo(9999) }, { now: NOW }).action))
}

// ── plan assembly ───────────────────────────────────────────────────────────
{
  const skills = {
    'broken-deploy': { ...emptyRecord(daysAgo(2)), uses: 12, wins: 4, losses: 8, lastUsed: daysAgo(1) },
    'ancient-thing': { ...emptyRecord(daysAgo(400)), uses: 3, wins: 3, losses: 0, lastUsed: daysAgo(400) },
    'good-thing': { ...emptyRecord(daysAgo(1)), uses: 30, wins: 29, losses: 1, lastUsed: daysAgo(1) },
  }
  const plan = curationPlan({ skills, staleMemories: [], conflicts: [] }, { now: NOW })
  ok('healthy skills are absent from the plan', !plan.actions.some(a => a.name === 'good-thing'))
  ok('failing skills rank first', plan.actions[0].name === 'broken-deploy')
  ok('counts are reported', plan.counts.flagged === 1 && plan.counts.archive === 1)
  ok('plan is not empty', !planIsEmpty(plan))
  ok('an all-healthy plan is empty', planIsEmpty(curationPlan({ skills: { good: skills['good-thing'] } }, { now: NOW })))

  const report = renderReport(plan, new Date(NOW))
  ok('report names the failing skill', report.includes('broken-deploy'))
  ok('report separates revise from retire', report.includes('revise, do not retire'))
  ok('report is markdown', report.startsWith('# Curation report'))
  ok('an empty plan renders a clean bill', renderReport(curationPlan({ skills: {} }), new Date(NOW)).includes('Nothing to curate'))
}

// ── the run gate ────────────────────────────────────────────────────────────
{
  const busy = curationPlan({ skills: { x: { ...emptyRecord(daysAgo(400)), lastUsed: daysAgo(400) } } }, { now: NOW })
  ok('runs when idle, due, and there is work',
    shouldRun({ lastRunMs: 0, idleMs: 60 * 60000, plan: busy, now: NOW }))
  ok('does not run while the user is active',
    !shouldRun({ lastRunMs: 0, idleMs: 60000, plan: busy, now: NOW }))
  ok('does not run before the interval elapses',
    !shouldRun({ lastRunMs: NOW - 3600000, idleMs: 60 * 60000, plan: busy, now: NOW }))
  ok('does not spend a model call on an empty plan',
    !shouldRun({ lastRunMs: 0, idleMs: 60 * 60000, plan: curationPlan({ skills: {} }), now: NOW }))
  ok('daysSince handles nonsense', daysSince(undefined) === Infinity)
}

// ── attribution ─────────────────────────────────────────────────────────────
ok('skill name parsed from arguments', skillNameFrom('{"name":"deploy-service"}') === 'deploy-service')
ok('alternate key parsed', skillNameFrom('{"skill":"x"}') === 'x')
ok('unparseable arguments attribute nothing', skillNameFrom('not json') === null)
ok('empty name attributes nothing', skillNameFrom('{"name":"  "}') === null)

// ── store: persistence, archive, restore ────────────────────────────────────
{
  const home = await mkdtemp(join(tmpdir(), 'dsh-cur-'))
  const skills = join(home, 'skills')
  await mkdir(join(skills, 'my-skill'), { recursive: true })
  await writeFile(join(skills, 'my-skill', 'SKILL.md'), '# my skill\n')

  ok('missing usage reads as empty', Object.keys(await loadUsage(skills)).length === 0)
  await noteOutcome(skills, 'my-skill', 'win')
  await noteOutcome(skills, 'my-skill', 'loss')
  const usage = await loadUsage(skills)
  ok('outcomes persist', usage['my-skill'].uses === 2 && usage['my-skill'].losses === 1)

  await writeFile(join(skills, '.usage.json'), '{ broken json')
  ok('corrupt telemetry reads as empty rather than throwing', Object.keys(await loadUsage(skills)).length === 0)
  await saveUsage(skills, usage)

  ok('live skills are listed', (await listSkills(skills)).includes('my-skill'))
  const archived = await archiveSkill(skills, 'my-skill')
  ok('archive moves, it does not delete', await access(archived.archivedTo).then(() => true).catch(() => false))
  ok('archived skill leaves the live list', !(await listSkills(skills)).includes('my-skill'))
  ok('archive is recorded in telemetry', (await loadUsage(skills))['my-skill'].state === 'archived')
  ok('archived content survives intact',
    (await readFile(join(archived.archivedTo, 'SKILL.md'), 'utf8')).includes('my skill'))

  await restoreSkill(skills, 'my-skill')
  ok('restore brings it back', (await listSkills(skills)).includes('my-skill'))
  ok('restore clears the archived state', (await loadUsage(skills))['my-skill'].state === 'active')

  await setPinned(skills, 'my-skill', true)
  ok('pin persists', (await loadUsage(skills))['my-skill'].pinned === true)
}

// ── store: the memory scan ──────────────────────────────────────────────────
{
  const home = await mkdtemp(join(tmpdir(), 'dsh-scan-'))
  const memory = join(home, 'memory')
  await mkdir(join(memory, 'topics'), { recursive: true })
  await writeFile(join(memory, 'MEMORY.md'),
    '# Memory index\n\n'
    + '- Api gateway: the api gateway runs envoy, required for the grpc-web filter behind the load balancer\n'
    + '- Gateway binary: the api gateway runs stock nginx, not envoy\n'
    + '- Prune job: the build cache fills the disk without the nightly prune job\n')
  await writeFile(join(memory, 'topics', 'old-fact.md'),
    '---\nrecorded: 2024-01-01T00:00:00Z\nconfirmed: 2024-01-01T00:00:00Z\nconfirmations: 0\nconfidence: reported\n---\n# old\n')
  await writeFile(join(memory, 'topics', 'fresh-fact.md'),
    `---\nrecorded: ${daysAgo(2)}\nconfirmed: ${daysAgo(2)}\nconfirmations: 3\nconfidence: verified\n---\n# fresh\n`)

  const scan = await scanMemory(memory, { now: NOW })
  ok('scan finds the standing contradiction', scan.conflicts.length === 1)
  ok('it names both sides', scan.conflicts[0].a.includes('envoy') && scan.conflicts[0].b.includes('nginx'))
  ok('unrelated memory is not flagged', !JSON.stringify(scan.conflicts).includes('Prune job'))
  const stale = scan.staleMemories.map(m => m.topic)
  ok('an ancient unconfirmed fact is stale', stale.includes('old-fact'))
  ok('a fresh confirmed fact is not', !stale.includes('fresh-fact'))
  ok('an empty store scans cleanly',
    (await scanMemory(join(home, 'nope'))).conflicts.length === 0)
}

// ── lesson efficacy ──────────────────────────────────────────────────────────
{
  const stats = {
    'vbox-log-first': { hits: 6, misses: 2 },
    'healthy-lesson': { hits: 9, misses: 0 },
    'one-miss-noise': { hits: 1, misses: 1 },
    'misses-only': { hits: 0, misses: 4 },
  }
  const plan = curationPlan({ skills: {}, lessonStats: stats }, { now: NOW })
  const flagged = plan.ineffectiveLessons.map(l => l.topic)
  ok('a surfaced-often-but-failing lesson is flagged', flagged.includes('vbox-log-first'), flagged.join(','))
  ok('a lesson with no misses is left alone', !flagged.includes('healthy-lesson'))
  ok('too few hits is noise, not evidence', !flagged.includes('one-miss-noise'))
  ok('misses with no hits never flag (no prompt bytes spent)', !flagged.includes('misses-only'))
  ok('a lessons-only plan is not empty', !planIsEmpty(plan))
  const report = renderReport(plan, new Date(NOW))
  ok('report names the lesson with its counts', report.includes('Lesson: vbox-log-first') && report.includes('6'))
  const clean = curationPlan({ skills: {}, lessonStats: { fine: { hits: 5, misses: 0 } } })
  ok('a healthy lesson plan stays empty', planIsEmpty(clean))
  // Store side: loadLessonStats aggregates both JSONL logs.
  const lessonHome = await mkdtemp(join(tmpdir(), 'dsh-curator-lessons-'))
  try {
    await writeFile(join(lessonHome, '.lesson-hits.jsonl'), '{"topic":"t1","at":"2026-06-01T00:00:00Z"}\n{"topic":"t1","at":"2026-06-01T01:00:00Z"}\n{"topic":"t2","at":"2026-06-01T02:00:00Z"}\nnot json\n')
    await writeFile(join(lessonHome, '.lesson-misses.jsonl'), '{"topic":"t1","at":"2026-06-01T03:00:00Z"}\n')
    const loaded = await loadLessonStats(lessonHome)
    ok('hits aggregate per topic', loaded.t1.hits === 2 && loaded.t2.hits === 1)
    ok('misses attach to their topic', loaded.t1.misses === 1 && loaded.t2.misses === 0)
    ok('corrupt lines are skipped', loaded !== undefined)
    const empty = await loadLessonStats(join(lessonHome, 'missing'))
    ok('a missing home reads as empty stats', Object.keys(empty).length === 0)
  } finally {
    await rm(lessonHome, { recursive: true, force: true })
  }
}

// ── /loop dashboard + skill outcomes ────────────────────────────────────────
{
  const now = Date.parse('2026-08-25T12:00:00Z')
  const report = renderLoopReport({
    lessons: { total: 5, hits: 23, misses: 2, ineffective: [{ topic: 'vbox-log-first' }] },
    reviews: [{ kind: 'failure', agoMin: 12 }, { kind: 'correction', agoMin: 140 }],
    skills: { tracked: 4, flagged: 1 },
    breaks: [
      { at: '2026-08-24T10:00:00Z', kind: 'step', why: 'reached 61 steps' },
      { at: '2026-08-25T09:30:00Z', kind: 'stream', why: 'same reasoning repeated 6×' },
    ],
    digests: 3,
  }, now)
  ok('loop report shows lessons, reviews with ages, skills, digests', report.includes('Lessons: **5**') && report.includes('failure 12m ago') && report.includes('correction 2h ago') && report.includes('Session digests: **3**'))
  ok('breaks counted in a 7-day window', report.includes('**2**') && report.includes('same reasoning repeated'))
  ok('ineffective lessons named', report.includes('vbox-log-first') && report.includes('curate report'))
  ok('empty loop says so kindly', renderLoopReport({}, now).includes('Nothing has happened yet'))

  const usage = {
    'proven-skill': { wins: 6, losses: 1 },
    'failing-skill': { wins: 1, losses: 4 },
    'too-few-uses': { wins: 2, losses: 0 },
    archived: { wins: 9, losses: 0, state: 'archived' },
  }
  const rows = renderSkillOutcomes(usage, { minUsesForOutcome: 4 })
  ok('outcomes annotate proven and failing skills', rows.includes('✓ proven-skill — 6/7') && rows.includes('⚠ failing-skill — 1/5'))
  ok('under-used and archived skills stay silent', !rows.includes('too-few-uses') && !rows.includes('archived'))
  ok('no usage at all renders empty', renderSkillOutcomes({}) === '')
  const noHome = join(tmpdir(), 'dsh-curator-nope-' + Date.now())
  ok('loop-guard ledger reads and tolerates absence', Array.isArray(await loadBreaks(noHome)) && (await loadBreaks(noHome)).length === 0)
  ok('review ages tolerate a bare home', (await loadReviewAges(noHome)).length === 0)
}

if (failures.length === 0) console.log(`${passed} passed, 0 failed`)
else { console.log(`${passed} passed, ${failures.length} failed`); for (const f of failures) console.log('  ✗', f); process.exit(1) }

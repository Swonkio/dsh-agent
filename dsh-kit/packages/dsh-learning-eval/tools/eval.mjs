#!/usr/bin/env node
/**
 * Run the learning-loop eval against a real dsh install.
 *
 * Usage:
 *   node tools/eval.mjs [--tasks <dir>] [--repeats N] [--provider P] [--model M] [--out report.md]
 *
 * Each arm gets a THROWAWAY $DSH_HOME under the system temp dir, so the eval
 * can never read or write the user's real memory: a harness that seeded the
 * live store would teach the agent the answers it is about to be graded on.
 *
 * Runs under the no-tools `review` profile by default so the only source of an
 * answer is the context; see the --profile note below.
 *
 * @module dsh-learning-eval/tools/eval
 */

import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadTasks } from '../lib/tasks.js'
import { runEval } from '../lib/runner.js'
import { renderReport } from '../lib/report.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

function arg(flag, fallback) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? fallback : process.argv[index + 1]
}

const tasksDir = resolve(arg('--tasks', join(here, '..', 'tasks')))
const repeats = Number(arg('--repeats', '1'))
const provider = arg('--provider', 'local')
const model = arg('--model', 'qwen3.8-27b-uncensored')
// The REVIEW profile by default, not the agent profile. A memory eval has to
// hold "no other way to know" fixed: with shell and web available the control
// arm can go and research the answer, so a zero lift would mean "the agent
// found it another way", not "memory did not help" — and the two are
// indistinguishable in the score. The review profile has no shell, no fetch and
// no file reads, so the only place an answer can come from is the context.
const profile = arg('--profile', 'review')
const outPath = arg('--out', null)
// The answers are the only way to tell a genuine miss from a scoring artifact
// — a correct answer zeroed because a forbidden term also appears in the
// memory it was reading. Keeping them out of the report but available on
// request keeps the report short without making a zero unexplainable.
const answersPath = arg('--answers', null)
const dshBin = arg('--dsh', process.env.DSH_BIN ?? 'dsh')
// The throwaway homes carry ONLY memory; profiles and settings come from a
// real install, linked in read-only. Without this each arm would boot into an
// empty home with no profile to run and no provider configured, and both arms
// would score zero for reasons that have nothing to do with memory.
const baseHome = resolve(arg('--base', process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh-agent')))
const timeoutMs = Number(arg('--timeout', '600000'))

/** Build a throwaway home; the treatment arm gets the task's memories in it. */
async function seedHome({ task, condition }) {
  const home = await mkdtemp(join(tmpdir(), `dsh-eval-${condition}-`))
  // Everything except memory is shared with the base install, so the two arms
  // differ in exactly one variable.
  for (const entry of ['profiles', 'settings.yaml', 'SOUL.md', 'skills']) {
    try {
      await access(join(baseHome, entry))
      await symlink(join(baseHome, entry), join(home, entry))
    } catch { /* absent in the base install: nothing to share */ }
  }
  await mkdir(join(home, 'memory', 'topics'), { recursive: true })
  const lines = condition === 'treatment'
    ? task.memories.map(memory => `- ${memory.topic}: ${memory.summary}`)
    : []
  await writeFile(join(home, 'memory', 'MEMORY.md'),
    `# Memory index\n\nOne line per topic; detail in topics/<slug>.md.\n\n${lines.join('\n')}\n`)
  return home
}

async function runTurn({ prompt, home }) {
  const { stdout } = await run(dshBin, ['--profile', profile, '-p', prompt, '--provider', provider, '--model', model], {
    env: { ...process.env, DSH_HOME: home },
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout
}

const tasks = await loadTasks(tasksDir)
console.log(`${tasks.length} task(s), ${repeats} run(s) per arm, model ${model} — ${tasks.length * repeats * 2} turns total`)
console.log(`base install: ${baseHome}\n`)

const homes = []
const summary = await runEval({
  tasks,
  repeats,
  seedHome: async input => { const home = await seedHome(input); homes.push(home); return home },
  runTurn,
  onProgress: ({ task, condition, run: index, score }) =>
    console.log(`  ${task.padEnd(22)} ${condition.padEnd(10)} run ${index + 1}  score ${score.toFixed(2)}`),
})

const report = renderReport(summary, { model, repeats })
console.log(`\n${report}`)
if (outPath !== null) {
  await writeFile(outPath, report)
  console.log(`written to ${outPath}`)
}
if (answersPath !== null) {
  await writeFile(answersPath, `${JSON.stringify(summary.results.map(r => ({
    id: r.id, treatment: r.treatment, control: r.control, lift: r.lift, answers: r.answers,
  })), null, 2)}\n`)
  console.log(`answers written to ${answersPath}`)
}
for (const home of homes) await rm(home, { recursive: true, force: true })

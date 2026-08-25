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
 * @module dsh-learning-eval/tools/eval
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
const model = arg('--model', process.env.DSH_EVAL_MODEL ?? 'local-model')
const profile = arg('--profile', 'agent')
const outPath = arg('--out', null)
const dshBin = arg('--dsh', process.env.DSH_BIN ?? 'dsh')
const timeoutMs = Number(arg('--timeout', '600000'))

/** Build a throwaway home; the treatment arm gets the task's memories in it. */
async function seedHome({ task, condition }) {
  const home = await mkdtemp(join(tmpdir(), `dsh-eval-${condition}-`))
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
console.log(`${tasks.length} task(s), ${repeats} run(s) per arm, model ${model} — ${tasks.length * repeats * 2} turns total\n`)

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
for (const home of homes) await rm(home, { recursive: true, force: true })

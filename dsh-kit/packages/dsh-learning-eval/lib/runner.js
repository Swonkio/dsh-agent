/**
 * The A/B runner.
 *
 * For each task the harness runs the same prompt twice: once against a home
 * seeded with the memories the task depends on (treatment) and once against an
 * empty home (control). Everything else — model, profile, prompt — is held
 * identical, so the only thing that differs is whether the loop's output was
 * available.
 *
 * The control arm is the whole design. Measuring the treatment alone tells you
 * the agent answered correctly, not that MEMORY is why: a model that already
 * knew the answer scores the same either way, and a harness without a control
 * would report that as the loop working. Running both is twice the model time
 * and the only way the number means anything.
 *
 * `runTurn` is injected rather than imported so the policy above can be tested
 * without a model, and so the same harness can drive a local or hosted backend.
 *
 * @module dsh-learning-eval/runner
 */

import { scoreAnswer, compareRuns } from './score.js'

/**
 * Run the full task set under both conditions.
 *
 * @param {object} options
 * @param {Array} options.tasks - task objects; see tasks.js.
 * @param {Function} options.runTurn - `({ prompt, home, condition }) => Promise<string>`.
 * @param {Function} options.seedHome - `({ task, condition }) => Promise<string>` returns a DSH_HOME.
 * @param {number} [options.repeats] - runs per arm; >1 to see through sampling noise.
 * @param {Function} [options.onProgress]
 */
export async function runEval({ tasks, runTurn, seedHome, repeats = 1, onProgress }) {
  const results = []
  for (const task of tasks) {
    const arms = { treatment: [], control: [] }
    const answers = { treatment: [], control: [] }

    for (const condition of ['treatment', 'control']) {
      for (let run = 0; run < repeats; run += 1) {
        const home = await seedHome({ task, condition })
        let answer = ''
        let error
        try {
          answer = await runTurn({ prompt: task.prompt, home, condition, task })
        } catch (failure) {
          // A crashed run scores zero rather than aborting the sweep: one bad
          // task should not cost the whole set, and a zero is the honest score
          // for an agent that failed to answer.
          error = failure.message
        }
        const scored = scoreAnswer(answer, task.expect)
        arms[condition].push(scored.score)
        answers[condition].push({ answer, ...scored, ...(error === undefined ? {} : { error }) })
        onProgress?.({ task: task.id, condition, run, score: scored.score })
      }
    }

    results.push({
      id: task.id,
      prompt: task.prompt,
      ...compareRuns(arms.treatment, arms.control),
      answers,
    })
  }
  return summarize(results)
}

/**
 * Roll per-task results into a verdict.
 *
 * Only tasks that can actually detect memory contribute to the headline lift;
 * the rest are reported separately as a task-design problem. Averaging a task
 * whose control already scores full marks into the mean would dilute the
 * result toward zero and make a working loop look useless.
 */
export function summarize(results) {
  const measuring = results.filter(result => result.measuresMemory)
  const ceiling = results.filter(result => !result.measuresMemory)
  const lifts = measuring.map(result => result.lift)
  return {
    results,
    tasks: results.length,
    measuring: measuring.length,
    ceiling: ceiling.map(result => result.id),
    meanLift: lifts.length === 0 ? 0 : lifts.reduce((a, b) => a + b, 0) / lifts.length,
    helped: measuring.filter(result => result.lift > 0).length,
    hurt: measuring.filter(result => result.lift < 0).length,
    unchanged: measuring.filter(result => result.lift === 0).length,
  }
}

/**
 * Scoring for the learning-loop eval.
 *
 * Deterministic on purpose. The obvious way to grade an agent's answer is to
 * ask a model whether it was good, but a model judge makes the result depend
 * on a second sampled process — so a change in the score can come from the
 * judge drifting rather than the agent improving, and reproducing last week's
 * number becomes impossible. Substring checks are cruder and cannot grade
 * style, but they are free, instant, and identical every time they run, which
 * is what a regression signal has to be.
 *
 * A task therefore states what a correct answer must CONTAIN and what it must
 * NOT contain. The must-not half is what catches the failure mode this eval
 * exists to detect: an agent that has the fact in memory but states the stale
 * or contradictory version of it.
 *
 * @module dsh-learning-eval/score
 */

/** Normalise for comparison: case, punctuation and whitespace are not signal. */
export function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Does the haystack contain the needle, ignoring case and punctuation? */
export function contains(haystack, needle) {
  const hay = normalize(haystack)
  const pin = normalize(needle)
  return pin !== '' && hay.includes(pin)
}

/**
 * Score one answer against one task's expectations, in 0..1.
 *
 * Any forbidden string present is an automatic zero rather than a deduction.
 * Stating the wrong version of a fact is not a partially-correct answer — a
 * user acting on it is worse off than if the agent had said nothing — and a
 * scheme that let a confident wrong answer keep most of its marks for also
 * mentioning the right words would hide exactly the regression that matters.
 */
export function scoreAnswer(answer, expect = {}) {
  const includes = expect.includes ?? []
  const excludes = expect.excludes ?? []

  const forbidden = excludes.filter(term => contains(answer, term))
  if (forbidden.length > 0) return { score: 0, hit: [], missed: includes, forbidden }

  if (includes.length === 0) return { score: 1, hit: [], missed: [], forbidden: [] }
  const hit = includes.filter(term => contains(answer, term))
  const missed = includes.filter(term => !contains(answer, term))
  return { score: hit.length / includes.length, hit, missed, forbidden: [] }
}

/** Mean of a list; 0 for an empty one. */
export function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Population standard deviation, for reporting spread alongside a mean. */
export function stddev(values) {
  if (values.length < 2) return 0
  const average = mean(values)
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)))
}

/**
 * Compare a task's treatment (memory on) and control (memory off) runs.
 *
 * Two judgements come out of this, and keeping them apart is the point:
 *
 *   - `lift` — how much memory helped, treatment minus control.
 *   - `measuresMemory` — whether the task can detect that at all. If the
 *     control already scores full marks, the model knew the answer without
 *     memory, so a zero lift says nothing about the loop and everything about
 *     the task. Reporting that as "memory did not help" would be a lie of
 *     omission, so the harness names those tasks instead of averaging them in.
 */
export function compareRuns(treatmentScores, controlScores) {
  const treatment = mean(treatmentScores)
  const control = mean(controlScores)
  return {
    treatment,
    control,
    lift: treatment - control,
    treatmentSpread: stddev(treatmentScores),
    controlSpread: stddev(controlScores),
    runs: treatmentScores.length,
    // A control at ceiling cannot show lift; the task is not probing memory.
    measuresMemory: control < 0.999,
    // A difference smaller than the noise in either arm is not a finding.
    significant: Math.abs(treatment - control) > Math.max(stddev(treatmentScores), stddev(controlScores)),
  }
}

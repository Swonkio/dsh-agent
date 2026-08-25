/**
 * dsh-grounding — pure detection helpers.
 *
 * Free of any harness import so they can be unit-tested in isolation; the
 * plugin's hot path is otherwise just firehose bookkeeping. Two signals:
 *
 *   - conclusion phrases — the shape of a claim about a CAUSE or a CONFIRMED
 *     state ("the root cause is…", "that's why…"). Such a sentence is not
 *     wrong per se; it is only a risk when nothing was checked between the
 *     question and the assertion (the VM incident asserted "VBoxSVC crashes"
 *     without ever reading the log).
 *
 *   - plan cadence — whether a turn is deep enough into tool use that the
 *     absence of a todo_write is itself a signal. 158 steps with no plan is
 *     how a task thrashes; a one-line plan at step ~5 usually prevents it.
 *
 * @module dsh-grounding/detect
 */

/**
 * Phrases that assert a conclusion. Deliberately narrow: they must name a
 * CAUSE or a CONFIRMATION, not merely narrate ("I will check the log" is
 * fine; "the culprit is the log" is a claim).
 */
const CONCLUSION_PHRASES = /\b(?:root cause|the (?:problem|issue|reason) is|this is because|that'?s why|it'?s (?:definitely|clearly)|confirmed that|the culprit is)\b/i

/**
 * Does this text assert a conclusion about a cause or a confirmed state?
 * @param {string} text - assistant text (one message or a joined stretch).
 * @returns {boolean}
 */
export function hasConclusion(text) {
  if (typeof text !== 'string' || text === '') return false
  return CONCLUSION_PHRASES.test(text)
}

/**
 * Whether this pre-step is the moment to nudge for a plan.
 *
 * True when the turn has reached `planStep`, has already made at least
 * `planMinTools` tool calls (a two-call turn needs no plan — the nudge would
 * be noise), has NOT seen a todo_write, and has not been nudged already this
 * turn. `step >= planStep` (not `===`) so a skipped or rejected step cannot
 * silence it for the rest of the turn; the once-per-turn guarantee comes from
 * `plannedNudged` itself.
 *
 * @param {{step:number, toolCallsThisTurn:number, sawTodo:boolean, plannedNudged:boolean}} state
 * @param {{planStep?:number, planMinTools?:number}} [cfg]
 * @returns {boolean}
 */
export function shouldPlan({ step, toolCallsThisTurn, sawTodo, plannedNudged }, cfg = {}) {
  const planStep = cfg.planStep ?? 5
  const planMinTools = cfg.planMinTools ?? 3
  if (plannedNudged) return false
  if (sawTodo) return false
  return step >= planStep && toolCallsThisTurn >= planMinTools
}

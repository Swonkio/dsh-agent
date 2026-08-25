/**
 * dsh-grounding — verify-before-conclude + plan-on-multistep nudges.
 *
 * The loop-guard stops a turn that is ALREADY thrashing. This plugin attacks
 * the two behaviours that produce the thrash in the first place, both caught
 * early and both nudged gently (the local 27B reacts badly to spam):
 *
 *  A. verify-before-conclude. The VM incident's root cause: the agent
 *     asserted "VBoxSVC crashes" without ever reading the log, then spent 158
 *     steps acting on the wrong premise. Detection is cheap and deterministic:
 *     when an assistant message contains a conclusion phrase ("the root cause
 *     is…", "the culprit is…") and NO tool call has happened since the last
 *     user message or nudge, the conclusion is unverified — arm a nudge, and
 *     at the next step inject one short "check it against the real system
 *     before acting on it". Rate-limited to once per `verifyEvery` steps.
 *
 *  B. plan-on-multistep. A turn `planStep` steps in with ≥ `planMinTools`
 *     tool calls and no `todo_write` gets exactly one nudge to write a quick
 *     plan — a goal plus the few concrete steps. Plans are what keep a
 *     multi-step task from dissolving into screenshot-read-guess cycles.
 *
 * State is per session, reset on every turn boundary and on every user
 * message (fresh intent). Nothing here calls a model, writes a file, or can
 * end a turn: worst case it injects one extra user-visible context message.
 *
 * @module dsh-grounding
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { hasConclusion, shouldPlan } from './detect.js'

/** Stable Cordis plugin name (shows up in loader diagnostics). */
export const name = 'dsh-grounding'

/** Policy defaults; every field is overridable from the plugin's `config:` block. */
export const DEFAULTS = {
  enabled: true,
  /** Minimum tool calls between two verify nudges (steps). */
  verifyEvery: 6,
  /** Tool calls since the last checkpoint required to consider a conclusion verified. */
  minEvidence: 1,
  /** Step at which the absence of a plan first becomes worth a nudge. */
  planStep: 5,
  /** Tool calls this turn required before the plan nudge is worth its bytes. */
  planMinTools: 3,
}

/** The `{kind:'plugin'}` source stamped on everything this plugin injects. */
const SOURCE = { kind: 'plugin', plugin: 'dsh-grounding' }

/** The verify-before-conclude nudge. */
function verifyNudge() {
  return createUserMessage({
    content: [{
      type: 'text',
      text: '[grounding] You stated a conclusion but have not checked it against the '
        + 'actual system this stretch. Before acting on it or repeating it, verify with '
        + 'a tool (read the log / state). An unverified assumption is what turns into a loop.',
    }],
    source: SOURCE,
  })
}

/** The plan-on-multistep nudge. */
function planNudge() {
  return createUserMessage({
    content: [{
      type: 'text',
      text: '[grounding] You are several steps into a multi-step task with no plan. '
        + 'A quick todo_write (goal + the few concrete steps) keeps this from thrashing.',
    }],
    source: SOURCE,
  })
}

/**
 * Install both nudges.
 *
 * @param {object} ctx - Cordis plugin context; listeners unwind with it.
 * @param {object} [config] - policy overrides; see {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!Number.isInteger(cfg.verifyEvery) || cfg.verifyEvery < 1) {
    throw new Error(`dsh-grounding: verifyEvery must be an integer >= 1, got ${cfg.verifyEvery}`)
  }
  if (!Number.isInteger(cfg.minEvidence) || cfg.minEvidence < 0) {
    throw new Error(`dsh-grounding: minEvidence must be an integer >= 0, got ${cfg.minEvidence}`)
  }

  /**
   * Per-session grounding state. Keyed by session id because the firehose
   * and the pre-step waterfall both name it, and one process hosts several
   * sessions (review passes, cron).
   */
  const sessions = new Map()
  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        /** tool/call count since the last user message or verify nudge. */
        toolCallsSinceCheckpoint: 0,
        toolCallsThisTurn: 0,
        sawTodo: false,
        plannedNudged: false,
        verifyArmed: false,
        lastVerifyStep: undefined,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  // ── firehose: cheap, deterministic bookkeeping ─────────────────────────────
  ctx.on('session/event', (session, event) => {
    const state = stateFor(session?.id)
    if (event?.type === 'user/message') {
      // A fresh user message is a fresh intent: whatever was concluded before
      // it belongs to the previous question.
      state.toolCallsSinceCheckpoint = 0
      state.verifyArmed = false
      return
    }
    if (event?.type === 'turn/start') {
      state.toolCallsSinceCheckpoint = 0
      state.toolCallsThisTurn = 0
      state.sawTodo = false
      state.plannedNudged = false
      state.verifyArmed = false
      state.lastVerifyStep = undefined
      return
    }
    if (event?.type === 'tool/call') {
      state.toolCallsSinceCheckpoint += 1
      state.toolCallsThisTurn += 1
      if (event.data?.name === 'todo_write') state.sawTodo = true
      return
    }
    if (event?.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      if (!Array.isArray(blocks)) return
      const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join(' ')
      // A conclusion with no tool evidence since the checkpoint is a claim,
      // not a finding. Arm the nudge; do not interrupt anything mid-message.
      if (hasConclusion(text) && state.toolCallsSinceCheckpoint < cfg.minEvidence) state.verifyArmed = true
    }
  })

  // ── pre-step: the two nudges, at most one per step, both rate-limited ─────
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next()
    if (!cfg.enabled || decision.kind !== 'enter') return decision

    const state = stateFor(agent.id)
    // Verify nudge first: an unverified conclusion is the more expensive habit.
    if (state.verifyArmed) {
      const due = state.lastVerifyStep === undefined || step - state.lastVerifyStep >= cfg.verifyEvery
      if (due) {
        state.verifyArmed = false
        state.lastVerifyStep = step
        state.toolCallsSinceCheckpoint = 0
        return { kind: 'enter', messages: [...decision.messages, verifyNudge()] }
      }
      // Not due yet (a second armed conclusion inside the rate window): the
      // arm survives so the next eligible step still carries it.
    }
    if (shouldPlan(
      { step, toolCallsThisTurn: state.toolCallsThisTurn, sawTodo: state.sawTodo, plannedNudged: state.plannedNudged },
      cfg,
    )) {
      state.plannedNudged = true
      return { kind: 'enter', messages: [...decision.messages, planNudge()] }
    }
    return decision
  })
}

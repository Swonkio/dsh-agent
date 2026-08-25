/**
 * dsh-loop-guard — a loop circuit-breaker for the agent loop.
 *
 * The harness already ships `repeat-tool-reminder`, but it only fires on
 * BYTE-IDENTICAL consecutive tool calls and only ever nudges — it never stops.
 * The failure that actually strands a session is subtler: a turn that keeps
 * taking DIFFERENT steps forever (screenshot, bash, re-read, re-reason the same
 * contradiction, repeat — 150+ steps, half an hour, no conclusion), or a single
 * step whose reasoning spins on the same sentence without ever acting. Neither
 * is a repeated identical call, so nothing catches them today.
 *
 * This plugin adds two independent breakers, both bounded so recovery can never
 * itself loop:
 *
 *  1. Per-turn step breaker (`agent/pre-step`). Soft nudges once a turn crosses
 *     `softStep` steps ("you've taken N steps, name the one decisive action"),
 *     then a hard cut past `hardStep`: the proposed step is REJECTED, which the
 *     loop treats as a clean turn end, and a single focused follow-up turn is
 *     queued telling the model to conclude from what it already has. This is the
 *     fix for the 158-step oscillation.
 *
 *  2. Per-request reasoning breaker (`llm/stream`). While a model response
 *     streams, it watches for the same sentence recurring `repeatThreshold`
 *     times, for a response longer than `maxChars`, or for one that runs past
 *     `maxMs` of wall-clock — any of which truncates the stream cleanly (open
 *     blocks closed, a short visible note appended, a `stop` finish emitted)
 *     and queues the same focused follow-up. This is the fix for the reasoning
 *     that circles "So the root cause is…" forever.
 *
 * Both breakers share one per-session recovery budget: after `maxRecoveries`
 * consecutive breaks with no genuine user turn in between, the guard stops
 * queuing follow-ups and simply lets the turn end, handing control back to the
 * user rather than churning. A real user message resets the budget.
 *
 * Nothing here calls a model or blocks the turn's own progress; the detection
 * is deterministic string work on the hot path.
 *
 * @module dsh-loop-guard
 */

import { writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RepetitionCounter, stepVerdict } from './detect.js'

/** Stable Cordis plugin name (shows up in loader diagnostics). */
export const name = 'dsh-loop-guard'

/** The agent registry is needed to queue recovery follow-ups by session id. */
export const inject = ['agents']

/** Policy defaults; every field is overridable from the plugin's `config:` block. */
export const DEFAULTS = {
  enabled: true,
  // ── per-turn step breaker ────────────────────────────────────────────────
  /** First step at which soft nudges begin. */
  softStep: 25,
  /** Re-nudge every N steps after the soft line. */
  nudgeEvery: 10,
  /** Steps beyond which the turn is force-ended (reject the next step). */
  hardStep: 60,
  // ── per-request reasoning breaker ────────────────────────────────────────
  /** Watch the streamed response for loops/runaway (set false to disable only this half). */
  watchStream: true,
  /** A normalised sentence recurring this many times trips the breaker. */
  repeatThreshold: 6,
  /** Segments shorter than this many words are ignored (too generic to be a loop). */
  minWords: 6,
  /** Leading words that form a segment's identity key. */
  prefixWords: 8,
  /** Hard character ceiling for a single streamed response (~character, not token). */
  maxChars: 400000,
  /** Hard wall-clock ceiling for a single streamed response, ms. Backstop for a slow spin. */
  maxMs: 420000,
  // ── shared recovery budget ───────────────────────────────────────────────
  /** Consecutive auto-recoveries before the guard stops and hands control back. */
  maxRecoveries: 3,
}

/** The `{kind:'plugin'}` source stamped on everything this guard injects. */
const SOURCE = { kind: 'plugin', plugin: 'dsh-loop-guard' }

/**
 * Drop a breadcrumb naming the break, so the self-improvement post-mortem
 * (dsh-memory) can learn the precise cause. It is the ONLY record of a
 * reasoning-loop truncation, which otherwise ends its step normally and would
 * be invisible to failure learning. Fire-and-forget: a break must never wait
 * on disk, and a lost breadcrumb only costs one un-diagnosed lesson.
 *
 * @param {string} sessionId - the looping session, so the reader can attribute it.
 * @param {string} why - the human-readable break reason.
 * @param {'step'|'stream'} kind - which breaker fired.
 */
function recordBreak(sessionId, why, kind) {
  const line = JSON.stringify({ at: new Date().toISOString(), sessionId, kind, why })
  void writeFile(join(dshHomePath(), '.last-loop-break'), `${line}\n`).catch(() => {})
  // The durable ledger the /loop dashboard counts from — the breadcrumb is
  // consumed and deleted, so without this the dashboard would always read
  // zero. Capped at 200 lines; best-effort like everything a break writes.
  try {
    const ledger = join(dshHomePath(), '.loop-breaks.jsonl')
    const lines = readFileSync(ledger, 'utf8').split('\n').filter(l => l !== '').slice(-199)
    lines.push(line)
    writeFileSync(ledger, `${lines.join('\n')}\n`)
  } catch {
    // First break (no ledger yet) or a read race: this run simply is not
    // counted; the next one will be.
    try {
      appendFileSync(join(dshHomePath(), '.loop-breaks.jsonl'), `${line}\n`)
    } catch { /* telemetry only, never fail a break on it */ }
  }
}

/** The focused re-drive queued after a break. `why` names what tripped. */
function recoveryPrompt(why) {
  return '[loop-guard] The previous turn was stopped because it was looping — '
    + `${why}. Do NOT resume broad investigation or re-run diagnostics you have `
    + 'already run. Using only what this conversation already contains, take '
    + 'exactly ONE decisive action: state your conclusion or answer directly, '
    + 'or, if you are genuinely blocked, name the single specific blocker and '
    + 'stop. Choosing to conclude is expected here, not premature.'
}

/** The mid-turn nudge injected as extra context at a soft-line step. */
function stepNudge(step) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `[loop-guard] You have taken ${step} steps this turn without finishing. `
        + 'Step back before continuing: what is the goal, what do you already '
        + 'know for certain, and what is the single decisive next action? If you '
        + 'have enough to answer, answer now instead of gathering more.',
    }],
    source: SOURCE,
  })
}

/** The short, visible note appended to a truncated response so the user sees the cut. */
function breakNote(why, recovering) {
  return recovering
    ? `\n\n⚠️ loop-guard: interrupted this step (${why}). Refocusing on a concrete next action.`
    : `\n\n⚠️ loop-guard: interrupted this step (${why}), and I have broken repeated `
      + 'loops several times without progress — stopping so you can redirect me.';
}

/**
 * Advance the shared per-session recovery budget for one break.
 * @returns {boolean} whether an auto-recovery follow-up should be queued.
 */
function claimRecovery(state, sessionId, max) {
  const prior = state.get(sessionId) ?? 0
  const next = prior + 1
  state.set(sessionId, next)
  return next <= max
}

/**
 * Wrap a live model stream, truncating it the moment a loop or runaway is seen.
 * The emitted tail is always a VALID stream (every open block closed, exactly
 * one terminal `finish`), so the downstream stream invariant stays satisfied.
 *
 * @param {AsyncIterable} source - the downstream `llm/stream` chain.
 * @param {object} ctx - plugin context (for the agent registry).
 * @param {object} options - the frozen request; carries `sessionId`.
 * @param {object} cfg - resolved policy.
 * @param {Map} recoveries - shared per-session recovery budget.
 */
async function* guardStream(source, ctx, options, cfg, recoveries) {
  const sessionId = options.sessionId
  const startedAt = Date.now()
  const counter = new RepetitionCounter(cfg)
  /** index -> blockType for blocks opened but not yet closed. */
  const openKind = new Map()
  /** index -> accumulated text, so a truncation can assemble the block-end. */
  const openText = new Map()
  let maxIndex = -1
  let chars = 0
  let tripped = false

  const hasOpenToolCall = () => {
    for (const kind of openKind.values()) if (kind === 'tool-call') return true
    return false
  }

  for await (const chunk of source) {
    // Track block structure so a cut can close cleanly and never sever a tool call.
    switch (chunk.type) {
      case 'block-start':
        openKind.set(chunk.index, chunk.blockType)
        openText.set(chunk.index, '')
        if (chunk.index > maxIndex) maxIndex = chunk.index
        break
      case 'reasoning-delta':
      case 'text-delta':
        openText.set(chunk.index, (openText.get(chunk.index) ?? '') + chunk.text)
        break
      case 'block-end':
        openKind.delete(chunk.index)
        openText.delete(chunk.index)
        break
      default:
        break
    }

    yield chunk

    if (!cfg.enabled || !cfg.watchStream) continue
    if (chunk.type === 'finish') continue
    // Never cut while the model is mid tool call — that IS forward progress.
    if (hasOpenToolCall()) continue

    let why = null
    if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
      chars += chunk.text.length
      const hit = counter.push(chunk.text)
      if (hit) why = `the same reasoning repeated ${hit.count}×`
    }
    if (!why && chars > cfg.maxChars) why = `the response passed ${cfg.maxChars} characters without concluding`
    if (!why && Date.now() - startedAt > cfg.maxMs) {
      why = `the response ran past ${Math.round(cfg.maxMs / 1000)}s without concluding`
    }
    if (!why) continue

    // ── truncate ────────────────────────────────────────────────────────────
    tripped = true
    if (sessionId !== undefined) recordBreak(sessionId, why, 'stream')
    const recovering = sessionId !== undefined && claimRecovery(recoveries, sessionId, cfg.maxRecoveries)
    // Close every still-open reasoning/text block with its accumulated text.
    for (const [index, kind] of openKind) {
      yield { type: 'block-end', index, block: { type: kind, text: openText.get(index) ?? '' } }
    }
    // Append a short, visible note as its own text block.
    const noteIndex = maxIndex + 1
    const note = breakNote(why, recovering)
    yield { type: 'block-start', index: noteIndex, blockType: 'text' }
    yield { type: 'text-delta', index: noteIndex, text: note }
    yield { type: 'block-end', index: noteIndex, block: { type: 'text', text: note } }
    yield { type: 'finish', reason: { kind: 'stop' } }

    if (recovering) {
      const agent = ctx.agents?.get?.(sessionId)
      if (agent) agent.followup(createUserMessage({ content: [{ type: 'text', text: recoveryPrompt(why) }], source: SOURCE }))
    }
    return
  }

  // A response that finished on its own is progress: forgive the recovery budget.
  if (!tripped && sessionId !== undefined) recoveries.delete(sessionId)
}

/**
 * Install both breakers.
 * @param {object} ctx - Cordis plugin context; listeners unwind with it.
 * @param {object} [config] - policy overrides; see {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!Number.isInteger(cfg.hardStep) || cfg.hardStep < 2) {
    throw new Error(`dsh-loop-guard: hardStep must be an integer >= 2, got ${cfg.hardStep}`)
  }
  if (cfg.softStep >= cfg.hardStep) {
    throw new Error(`dsh-loop-guard: softStep (${cfg.softStep}) must be below hardStep (${cfg.hardStep})`)
  }

  /** Per-session consecutive-recovery budget, shared by both breakers. */
  const recoveries = new Map()

  // ── per-request reasoning breaker ──────────────────────────────────────────
  ctx.on('llm/stream', (options, next) => {
    if (!cfg.enabled || !cfg.watchStream) return next()
    if (!isAgentLoopRequest(options)) return next()
    return guardStream(next(), ctx, options, cfg, recoveries)
  })

  // ── per-turn step breaker ──────────────────────────────────────────────────
  ctx.on('agent/pre-step', async ({ agent, messages, step }, next) => {
    // A genuine user turn is a fresh start: forgive past breaks.
    if (messages.some(message => message.source.kind === 'user')) recoveries.delete(agent.id)

    const decision = await next()
    if (!cfg.enabled || decision.kind !== 'enter') return decision

    const verdict = stepVerdict(step, cfg)
    if (verdict === 'break') {
      recordBreak(agent.id, `it reached ${step} steps in one turn without finishing`, 'step')
      const recovering = claimRecovery(recoveries, agent.id, cfg.maxRecoveries)
      if (recovering) {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: recoveryPrompt(`it reached ${step} steps in one turn without finishing`) }],
          source: SOURCE,
        }))
      }
      // Rejecting the step ends the turn cleanly (loop treats it as 'blocked').
      return { kind: 'reject' }
    }
    if (verdict === 'nudge') {
      return { kind: 'enter', messages: [...decision.messages, stepNudge(step)] }
    }
    return decision
  })
}

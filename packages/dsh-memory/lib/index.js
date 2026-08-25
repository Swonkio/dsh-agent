/**
 * dsh-memory — the memory plugin: two kinds of memory, both plain files.
 *
 * Project memory is `remember`, which maintains QWEN.md at the project root
 * (the read side already exists: `dsh-agent-instructions` injects it into
 * every session there).
 *
 * User memory is the `$DSH_HOME/memory/` store (`memory_save` /
 * `memory_search`): durable facts that follow the user across projects, with
 * the MEMORY.md index injected into every system prompt. Procedural memory is
 * `skill_create`, the write half of the skills system — the shipped loader
 * only reads, so this is how a repeated procedure becomes a named skill.
 *
 * Files stay plain markdown on purpose: memory an agent writes is only as
 * good as the human's ability to read and correct it, and a durable wrong
 * "lesson" is worse than no memory at all.
 *
 * @module dsh-memory
 */

import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { conflictNotice } from 'dsh-epistemics'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  saveFact, search, indexTextSync, lastWriteMsSync, truncateForPrompt,
  selectMemoryLines, contentWords, similarity, DUPLICATE_AT,
  removeFact, editFact, indexText, MAX_INDEX_BYTES, scanMemoryText,
} from './memory-store.js'
import { writeSkill } from './skill-create.js'

/** Stable Cordis plugin name. */
export const name = 'tool-remember'

/** The registries this plugin writes into. */
export const inject = ['tools', 'systemPrompt', 'commands']

/** Sections the project memory file is organized into, in written order. */
const SECTIONS = {
  environment: 'Environment facts',
  mistake: 'Mistakes to avoid',
  howto: 'How to do things here',
  preference: 'Preferences',
}

/** Refuse to grow the project file past what the instruction loader reads. */
const MAX_BYTES = 60000

/**
 * Byte cap for the proactive lesson-recall section. Lessons earn their place
 * by being few and pointed; past this they are just the index again.
 */
const LESSON_CAP_BYTES = 2048

/**
 * Whether a completed turn warrants a background review: enabled, real
 * content on both sides, and outside the throttle window. The throttle
 * exists because a chatty evening is many turns of one conversation — one
 * review pass per few minutes captures it without one model call per message.
 */
export function reviewDecision({ enabled, lastUserText, lastAssistantText, lastReviewMs, now = Date.now(), throttleMs = 10 * 60 * 1000 }) {
  if (enabled !== true) return false
  if (lastUserText.trim() === '' || lastAssistantText.trim() === '') return false
  if (lastReviewMs > 0 && now - lastReviewMs < throttleMs) return false
  return true
}

/** The prompt the detached review session runs. */
export function reviewPrompt(userText, assistantText, capBytes = 4096) {
  const clip = text => (Buffer.byteLength(text) > capBytes ? `${text.slice(0, capBytes)}…` : text)
  return 'You are the self-improvement review for dsh-agent. Below is one exchange from the session that just ended. '
    + 'Identify DURABLE lessons only: verified facts about the user or their machines worth keeping across sessions, '
    + 'mistakes now understood, or procedures worth repeating. For each, call memory_save (one topic, one self-contained '
    + 'summary) or skill_create for a procedure worth teaching. Do NOT save ephemeral state, secrets, or anything '
    + 'obvious from context.\n'
    + 'Also DEEPEN YOUR MODEL OF THE USER: if this exchange revealed something durable about WHO THEY ARE — '
    + 'expertise, preferences, working style, environment, or current projects — call user_model(get), fold the '
    + 'new observation into the current model (correcting anything now known to be wrong), and write it back with '
    + 'user_model(set). Revise, do not merely append; keep it concise; record only what you actually observed.\n'
    + 'If there is nothing durable and nothing new about the user, reply exactly: nothing to keep\n\n'
    + `USER:\n${clip(userText)}\n\nASSISTANT:\n${clip(assistantText)}`
}

/**
 * The failure post-mortem's own throttle. Failures are rarer and more valuable
 * than routine reviews, so this window is shorter than reviewDecision's — but a
 * burst of failures inside one loop must still yield roughly ONE post-mortem,
 * not one per failed turn.
 */
export function failureReviewDecision({ enabled, lastReviewMs, now = Date.now(), throttleMs = 3 * 60 * 1000 }) {
  if (enabled !== true) return false
  if (lastReviewMs > 0 && now - lastReviewMs < throttleMs) return false
  return true
}

/**
 * Was this turn a mistake worth learning from? A loop-guard break always is; an
 * explicit failed/error/blocked end always is. A user abort or a nominally
 * "completed" turn counts only with corroborating struggle — several failing
 * tool calls or an abnormal step count — so a clean turn the user simply
 * redirected does not manufacture a false "lesson".
 *
 * @param {object} signals - `{ reason, toolErrors, stepCount, loopBreak }`.
 * @param {object} [thresholds] - `{ minErrors?, minSteps? }`.
 */
export function isLearnableFailure({ reason, toolErrors = 0, stepCount = 0, loopBreak = false }, thresholds = {}) {
  const minErrors = thresholds.minErrors ?? 3
  const minSteps = thresholds.minSteps ?? 25
  if (loopBreak) return true
  if (reason === 'failed' || reason === 'error' || reason === 'blocked') return true
  if (reason === 'aborted') return toolErrors >= minErrors || stepCount >= minSteps
  if (reason === 'completed') return toolErrors >= minErrors
  return false
}

/** Render collected failure evidence into a compact block for the post-mortem prompt. */
export function formatEvidence({ reason, stepCount, toolErrors, loopBreak }, capBytes = 3000) {
  const lines = [`Outcome: ${reason}`, `Steps taken in the turn: ${stepCount}`]
  if (loopBreak) lines.push(`Loop-guard interrupted the turn (${loopBreak}).`)
  if (toolErrors.length > 0) {
    lines.push(`Failing tool calls (${toolErrors.length}):`)
    for (const item of toolErrors) {
      const message = String(item.message).replace(/\s+/g, ' ').trim()
      lines.push(`  - ${item.name}: ${message.length > 240 ? `${message.slice(0, 240)}…` : message}`)
    }
  }
  const text = lines.join('\n')
  return Buffer.byteLength(text) > capBytes ? `${text.slice(0, capBytes)}…` : text
}

/** The prompt the detached FAILURE post-mortem runs. */
export function failurePrompt(userText, evidence, capBytes = 3000) {
  const clip = text => (Buffer.byteLength(text) > capBytes ? `${text.slice(0, capBytes)}…` : text)
  return 'You are the self-improvement post-mortem for dsh-agent. The turn below went WRONG — it failed, was '
    + 'interrupted, or thrashed without finishing. Extract ONE durable, actionable lesson so the same mistake is '
    + 'not repeated.\n'
    + 'Diagnose the ROOT cause, not the symptom. If the summary is not enough, use session_search to read what '
    + 'actually happened. Then, ONLY IF the lesson generalises beyond this one turn, call memory_save with a topic '
    + 'like "Lesson: <short handle>" and a summary phrased as "When X, do Y instead" (or "Avoid X because Y") — '
    + 'specific enough to change behaviour, not tied to throwaway details — and confidence "observed". '
    + 'Save at most ONE lesson. If the failure was a transient fluke, external, or not generalisable, reply '
    + 'exactly: nothing to keep\n'
    + 'Do NOT save secrets, one-off values, or anything already obvious.\n\n'
    + `USER REQUEST:\n${clip(userText)}\n\nWHAT WENT WRONG:\n${clip(evidence)}`
}

// ── proactive lesson recall ──────────────────────────────────────────────────

/**
 * An index line whose TITLE starts with "Lesson:" — the naming convention the
 * failure post-mortem is told to use, so lessons stay machine-recognisable
 * without a second store. Bold titles (`- **Lesson: …**: summary`) match too.
 */
const LESSON_LINE = /^-\s*(?:\*\*)?lesson\s*:/i

/**
 * Rank the index's lesson lines against what the session is working on right
 * now, and drop the rest.
 *
 * The general `memory:index` section is selected once against the OPENING
 * request and byte-capped; a "don't do the thing you're about to do" line
 * neither outranks ordinary facts there nor re-focuses when the task drifts
 * mid-session. This helper is the recall side of lessons: re-scored on every
 * prompt assembly against the LATEST user+assistant text, so the further the
 * turn drifts the more the lessons follow it.
 *
 * @param {string[]} lines - the index's `- ` lines, in stored order.
 * @param {string} query - relevance signal, typically `${lastUserText} ${lastAssistantText}`.
 * @param {number} [k=3] - how many lessons to return.
 * @param {number} [minScore=0.25] - floor on the module's `similarity` scale.
 * @returns {string[]} the top lesson lines, best first; [] when none qualify.
 */
export function rankLessons(lines, query, k = 3, minScore = 0.25) {
  if (!Array.isArray(lines) || k <= 0) return []
  const scored = []
  for (const line of lines) {
    if (!LESSON_LINE.test(line)) continue
    const score = similarity(line, String(query ?? ''))
    if (score >= minScore) scored.push({ line, score })
  }
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, k)
    .map(entry => entry.line)
}

// ── auto-skill synthesis ─────────────────────────────────────────────────────

/** Tools that CHANGE the world: their presence is what makes a tool run a recipe, not a read-around. */
const ACTION_TOOLS = new Set(['bash', 'pwsh', 'write', 'edit', 'str_replace_editor'])

/** Argument keys that tell a human what a call DID, most informative first. */
const BRIEF_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']

/** Longest brief kept per call — enough to recognise the step, not retell it. */
const BRIEF_CHARS = 60

/** Most tool calls remembered for one turn; past this the oldest are dropped. */
export const TOOL_SEQ_CAP = 40

/**
 * One call's human-relevant brief: the first ~60 chars of its most telling
 * argument (the bash `command`, an editor's `file_path`, …), best-effort —
 * unparsable arguments yield an empty brief and the bare tool name.
 *
 * @param {string} rawArgs - the raw JSON `arguments` string of a `tool/call`.
 * @returns {string}
 */
export function callBrief(rawArgs) {
  let args = {}
  try {
    args = JSON.parse(rawArgs ?? '{}')
  } catch {
    return ''
  }
  if (args === null || typeof args !== 'object') return ''
  const candidate = [BRIEF_KEYS.map(key => args[key]), Object.values(args)]
    .flat()
    .find(value => typeof value === 'string' && value !== '')
  if (candidate === undefined) return ''
  return candidate.replace(/\s+/g, ' ').trim().slice(0, BRIEF_CHARS)
}

/**
 * Was this turn's tool run a PROCEDURE — enough calls to be a recipe, and at
 * least one world-changing call (bash/write/edit)? Read-only stretches never
 * become skills: nothing to teach.
 *
 * @param {{name:string, brief:string}[]} toolSeq - this turn's calls, in order.
 * @param {number} [minTools=5] - calls required before it counts.
 * @returns {boolean}
 */
export function isProcedural(toolSeq, minTools = 5) {
  if (!Array.isArray(toolSeq) || toolSeq.length < minTools) return false
  return toolSeq.some(entry => ACTION_TOOLS.has(entry?.name))
}

/**
 * Render a tool run as the compact numbered list the synthesis review reads.
 *
 * @param {{name:string, brief:string}[]} toolSeq - this turn's calls, in order.
 * @param {number} [capBytes=2500] - byte ceiling for the rendered list.
 * @returns {string}
 */
export function formatProcedure(toolSeq, capBytes = 2500) {
  const lines = []
  for (const [index, entry] of (Array.isArray(toolSeq) ? toolSeq : []).entries()) {
    lines.push(`${index + 1}. ${entry?.name ?? '?'}${entry?.brief ? ` — ${entry.brief}` : ''}`)
  }
  const text = lines.join('\n')
  if (Buffer.byteLength(text) <= capBytes) return text
  // Byte-accurate cut (the em-dash separator is multi-byte), mirroring the
  // module's clip() contract: capBytes of content plus a 3-byte ellipsis.
  const marker = '…'
  const room = Math.max(0, capBytes - Buffer.byteLength(marker))
  return `${Buffer.from(text).subarray(0, room).toString('utf8')}${marker}`
}

/**
 * The skill-synthesis review's own gate. The rarest of the three review kinds
 * on purpose: it competes with the interactive session for the single local
 * GPU slot, so its window is the widest.
 */
export function skillReviewDecision({ enabled, lastReviewMs, now = Date.now(), throttleMs = 15 * 60 * 1000 }) {
  if (enabled !== true) return false
  if (lastReviewMs > 0 && now - lastReviewMs < throttleMs) return false
  return true
}

/** The prompt the detached skill-synthesis review runs. */
export function skillPrompt(userText, procedure, capBytes = 3000) {
  const clip = text => (Buffer.byteLength(text) > capBytes ? `${text.slice(0, capBytes)}…` : text)
  return 'You are the skill-synthesis review for dsh-agent. This turn completed a multi-step procedure (below). '
    + 'ONLY IF it is a repeatable recipe worth teaching (not a one-off investigation), call skill_create with a '
    + 'kebab-case name, a one-line description, a whenToUse trigger, and a body a future session could follow '
    + 'blind — the concrete steps, commands and gotchas, generalised past this one machine where you can. '
    + 'At most ONE skill. If the procedure is one-off, trivial, or already obvious, reply exactly: nothing to keep\n'
    + 'Do NOT save secrets, one-off values, or anything already obvious.\n\n'
    + `USER REQUEST:\n${clip(userText)}\n\nPROCEDURE FOLLOWED:\n${clip(procedure)}`
}

// ── correction capture ───────────────────────────────────────────────────────

/**
 * Openers that mark a user message as a CORRECTION of the assistant's previous
 * answer. A correction is the highest-signal feedback the loop ever receives:
 * the agent acted, the human said no. Deliberately opener-anchored and length-
 * floored — a bare "no" is ambiguous and a mid-paragraph "instead" is prose,
 * not a correction.
 */
const CORRECTION_OPENERS = /^(?:no+(?:pe)?|wrong|incorrect|not quite|almost|actually|don'?t|do not|stop|i said|instead|i wanted|i asked for|you (?:should|were supposed to))\b/i

/**
 * Was this user message a correction of the assistant's previous answer?
 * @param {string} text - the incoming user message.
 * @returns {boolean}
 */
export function isCorrection(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length < 10) return false
  if (trimmed.length > 2000) return false // a correction is sharp; an essay is a new task
  return CORRECTION_OPENERS.test(trimmed)
}

/**
 * The correction review's throttle. Corrections are rarer than turns and
 * worth more than routine reviews; the window sits between the two.
 */
export function correctionReviewDecision({ enabled, lastReviewMs, now = Date.now(), throttleMs = 5 * 60 * 1000 }) {
  if (enabled !== true) return false
  if (lastReviewMs > 0 && now - lastReviewMs < throttleMs) return false
  return true
}

/** The prompt the detached CORRECTION review runs. */
export function correctionPrompt(userText, assistantText, capBytes = 3000) {
  const clip = text => (Buffer.byteLength(text) > capBytes ? `${text.slice(0, capBytes)}…` : text)
  return 'You are the correction review for dsh-agent. The user just CORRECTED the agent\'s previous answer — '
    + 'this is the highest-signal feedback the loop receives. Determine what the agent got wrong and the durable '
    + 'rule that would have prevented it. ONLY IF that rule generalises beyond this one exchange, call memory_save: '
    + 'topic "Lesson: <short handle>" for a mistake (summary phrased "When X, do Y instead"), or topic '
    + '"Preference: <handle>" for a durable taste the user just revealed. Confidence "observed". At most ONE save. '
    + 'If the correction was one-off, contextual, or already obvious, reply exactly: nothing to keep\n'
    + 'Do NOT save secrets, one-off values, or anything already obvious.\n\n'
    + `WHAT THE AGENT SAID:\n${clip(assistantText)}\n\nTHE USER'S CORRECTION:\n${clip(userText)}`
}

// ── review dispatch: coalescing + idle drain ─────────────────────────────────

/**
 * Combine several queued review prompts into ONE review run. All review kinds
 * share the sandboxed profile and the same escape phrase, so one model call
 * can serve them; each sub-prompt keeps its self-contained instructions.
 *
 * @param {{kind:string, prompt:string}[]} items
 * @returns {string} a single prompt; a lone item passes through untouched.
 */
export function combineReviewPayloads(items) {
  const list = Array.isArray(items) ? items.filter(item => item?.prompt) : []
  if (list.length <= 1) return list[0]?.prompt ?? ''
  const parts = [`You have ${list.length} INDEPENDENT review tasks below. Handle each on its own; a task with nothing durable answers "nothing to keep".`]
  for (const [index, item] of list.entries()) {
    parts.push(`════ TASK ${index + 1}/${list.length} — ${item.kind} ════\n${item.prompt}`)
  }
  return parts.join('\n\n')
}

// ── session digests ──────────────────────────────────────────────────────────

/**
 * The prompt the detached DIGEST review runs. Fed the session's recent
 * exchanges, it writes a one-paragraph sidecar digest so future sessions can
 * recall what happened here without replaying raw events.
 */
export function digestPrompt(exchanges, sessionId, capBytes = 4000) {
  const clip = text => (Buffer.byteLength(text) > capBytes ? `${text.slice(0, capBytes)}…` : text)
  const transcript = (Array.isArray(exchanges) ? exchanges : [])
    .map((exchange, index) => `— exchange ${index + 1} —\nUSER: ${exchange.user}\nAGENT: ${exchange.assistant}`)
    .join('\n\n')
  return 'You are the session-digest review for dsh-agent. Below are the recent exchanges of one session. '
    + 'Call digest_save with sessionId and a markdown digest a future session could use blind: what was asked, '
    + 'what was actually done (tools run, files touched, commands), the key outcomes, and any gotcha worth '
    + 'remembering. One tight paragraph or a short bullet list — NOT a transcript. If the exchanges are trivial '
    + 'small talk with nothing worth recalling, reply exactly: nothing to keep\n\n'
    + `SESSION ID:\n${sessionId}\n\nEXCHANGES:\n${clip(transcript)}`
}

// ── lesson efficacy ──────────────────────────────────────────────────────────

/** The topic of a lesson index line (`- Lesson: handle: summary`) → `handle`. */
export function lessonTopic(line) {
  const match = /^-\s*(?:\*\*)?[Ll]esson\s*:\s*([^:]+):/.exec(String(line))
  return match === null ? null : match[1].trim()
}

/** Efficacy logs live beside the index; both are bounded, append-only JSONL. */
const LESSON_HITS_FILE = '.lesson-hits.jsonl'
const LESSON_MISSES_FILE = '.lesson-misses.jsonl'
/** Lines kept per log before it is trimmed to its tail. */
const LESSON_LOG_LINES = 500

/** Trim a JSONL log to its last N lines (best-effort, never throws). */
function trimLog(path) {
  try {
    const text = readFileSync(path, 'utf8')
    const lines = text.split('\n').filter(line => line !== '')
    if (lines.length > LESSON_LOG_LINES) writeFileSync(path, `${lines.slice(-LESSON_LOG_LINES).join('\n')}\n`)
  } catch { /* nothing to trim */ }
}

/**
 * Log the lessons one prompt actually surfaced (the hit side of efficacy).
 * Synchronous on purpose: it runs inside a prompt-section text() call.
 * Failures are swallowed — efficacy telemetry must never break a prompt.
 */
export function noteLessonHits(home, lessons) {
  try {
    if (!Array.isArray(lessons) || lessons.length === 0) return
    const path = join(home, LESSON_HITS_FILE)
    const at = new Date().toISOString()
    appendFileSync(path, lessons.map(line => `${JSON.stringify({ at, topic: lessonTopic(line) ?? line.slice(0, 60) })}\n`).join(''))
    trimLog(path)
  } catch { /* telemetry only */ }
}

/**
 * Mark a MISS for every recently-surfaced lesson relevant to a failure: the
 * lesson was in the prompt, the agent failed anyway — evidence it is not
 * working, which the curator turns into a rewrite-or-retire suggestion.
 * Relevance is scored against the lesson's full index line (a bare topic
 * handle carries too few words for the similarity scale).
 */
export async function noteLessonMisses(home, contextText) {
  try {
    const hits = readFileSync(join(home, LESSON_HITS_FILE), 'utf8')
      .split('\n').filter(line => line !== '').slice(-50)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(entry => entry?.topic)
    if (hits.length === 0) return
    const lines = indexTextSync(home).split('\n').filter(line => line.startsWith('- '))
    const lineByTopic = new Map()
    for (const line of lines) {
      const topic = lessonTopic(line)
      if (topic !== null) lineByTopic.set(topic, line)
    }
    const recentAt = Date.now() - 24 * 60 * 60 * 1000
    const seen = new Set()
    const misses = []
    for (const hit of hits) {
      if (seen.has(hit.topic)) continue
      if (Date.parse(hit.at) < recentAt) continue
      seen.add(hit.topic)
      const line = lineByTopic.get(hit.topic)
      if (line === undefined) continue
      if (similarity(line, String(contextText)) >= 0.25) {
        misses.push(`${JSON.stringify({ at: new Date().toISOString(), topic: hit.topic })}\n`)
      }
    }
    if (misses.length === 0) return
    const path = join(home, LESSON_MISSES_FILE)
    appendFileSync(path, misses.join(''))
    trimLog(path)
  } catch { /* telemetry only */ }
}

/**
 * Run one detached review PROCESS per distinct route, each carrying every
 * queued item for that route combined into a single prompt. This is the whole
 * spawn side of the review system: markers are stamped here (so a throttle
 * window always starts at the run that earned it), the reviews dir is shared,
 * and the child is detached and forgotten — a review must never be able to
 * fail the session that queued it.
 *
 * Lives at module scope, parameterised by the caller's queue state.
 * @param {{kind:string, prompt:string, markers:string[], provider:string, model:string, profile:string}[]} items
 * @param {{lastSpawnAt:number}} state - shared clock; updated on success.
 */
async function spawnReviews(items, state) {
  if (items.length === 0) return
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(dshHomePath(), 'reviews'), { recursive: true })
  // One process per distinct route; items on the same route coalesce.
  const routes = new Map()
  for (const item of items) {
    const key = `${item.provider}|${item.model}|${item.profile}`
    if (!routes.has(key)) routes.set(key, { ...item, prompts: [] })
    routes.get(key).prompts.push(item)
  }
  const { spawn } = await import('node:child_process')
  const { dshBinPath, envFileExports } = await import('../../dsh-cron/lib/jobs.js')
  const env = { ...(await envFileExports()), ...process.env }
  for (const route of routes.values()) {
    for (const marker of new Set(route.prompts.flatMap(item => item.markers))) {
      await writeFile(marker, `${new Date().toISOString()}\n`)
    }
    const child = spawn(process.execPath, [
      dshBinPath(), '--profile', route.profile, '-p', combineReviewPayloads(route.prompts),
      '--provider', route.provider, '--model', route.model,
    ], { cwd: join(dshHomePath(), 'reviews'), detached: true, stdio: 'ignore', env })
    child.unref()
  }
  state.lastSpawnAt = Date.now()
}

/**
 * Fire the detached review pass: a one-shot agent turn in its own session
 * namespace (~/.dsh/reviews) on the configured review route. The review
 * runs the sandboxed review profile, where backgroundReview is unset — no recursion.
 * `dispatch` (built in apply) decides spawn-now vs queue for coalescing/idle.
 */
async function maybeReviewOf(home, userText, assistantText, reviewProvider, reviewModel, reviewProfile, dispatch) {
  try {
    const { stat } = await import('node:fs/promises')
    const marker = join(home, '.last-review')
    let lastReviewMs = 0
    try {
      lastReviewMs = (await stat(marker)).mtimeMs
    } catch { /* never reviewed */ }
    if (!reviewDecision({ enabled: true, lastUserText: userText, lastAssistantText: assistantText, lastReviewMs })) return
    dispatch({
      kind: 'memory review',
      prompt: reviewPrompt(userText, assistantText),
      markers: [marker], provider: reviewProvider, model: reviewModel, profile: reviewProfile,
    })
  } catch (error) {
    // A review that cannot even spawn must never disturb the session that
    // triggered it; the throttle file simply was not written this time.
    console.error(`dsh-memory: background review skipped: ${error.message}`)
  }
}

/**
 * Read and consume the loop-guard breadcrumb, if a fresh one is on file. It is
 * the only record of a reasoning-loop truncation (which ends its step normally),
 * so failure learning depends on it. Stale breadcrumbs (>5 min, or a crash
 * leftover) are ignored and cleared so they cannot mislabel a later turn.
 *
 * @param {string} sessionId - the current session, to attribute the breadcrumb.
 * @returns {Promise<string|null>} the break reason, or null.
 */
async function consumeLoopBreak(sessionId) {
  const path = join(dshHomePath(), '.last-loop-break')
  try {
    const { readFile, rm } = await import('node:fs/promises')
    const raw = await readFile(path, 'utf8')
    await rm(path, { force: true })
    const record = JSON.parse(raw.trim().split('\n').pop())
    if (record.sessionId !== undefined && sessionId !== undefined && record.sessionId !== sessionId) return null
    if (Date.now() - Date.parse(record.at) > 5 * 60 * 1000) return null
    return String(record.why ?? 'a loop')
  } catch { return null }
}

/**
 * Fire the detached FAILURE post-mortem: same sandboxed one-shot machinery as
 * {@link maybeReviewOf}, but with the failure prompt, the gathered evidence,
 * and its own shorter throttle so a run of failures yields ~one lesson.
 */
async function maybeFailureReviewOf(home, userText, evidence, reviewProvider, reviewModel, reviewProfile, dispatch) {
  try {
    const { stat } = await import('node:fs/promises')
    const marker = join(home, '.last-failure-review')
    let lastReviewMs = 0
    try { lastReviewMs = (await stat(marker)).mtimeMs } catch { /* never reviewed */ }
    if (!failureReviewDecision({ enabled: true, lastReviewMs })) return
    if (userText.trim() === '' && evidence.trim() === '') return
    dispatch({
      kind: 'failure post-mortem',
      prompt: failurePrompt(userText, evidence),
      markers: [marker], provider: reviewProvider, model: reviewModel, profile: reviewProfile,
    })
  } catch (error) {
    console.error(`dsh-memory: failure post-mortem skipped: ${error.message}`)
  }
}

/**
 * Fire the detached CORRECTION review: the user corrected the agent, the
 * highest-signal feedback there is. Same dispatch machinery as the others.
 */
async function maybeCorrectionReviewOf(home, userText, assistantText, reviewProvider, reviewModel, reviewProfile, dispatch) {
  try {
    const { stat } = await import('node:fs/promises')
    const marker = join(home, '.last-correction-review')
    let lastReviewMs = 0
    try { lastReviewMs = (await stat(marker)).mtimeMs } catch { /* never reviewed */ }
    if (!correctionReviewDecision({ enabled: true, lastReviewMs })) return
    if (userText.trim() === '' || assistantText.trim() === '') return
    dispatch({
      kind: 'correction review',
      prompt: correctionPrompt(userText, assistantText),
      markers: [marker], provider: reviewProvider, model: reviewModel, profile: reviewProfile,
    })
  } catch (error) {
    console.error(`dsh-memory: correction review skipped: ${error.message}`)
  }
}

/**
 * Fire the detached SKILL-SYNTHESIS review: same sandboxed one-shot machinery
 * as {@link maybeReviewOf}, but fed the turn's tool PROCEDURE (which the
 * success review never sees) and gated by the widest of the three throttles —
 * three review kinds share one local GPU slot, and this is the most
 * dispensable of them.
 */
async function maybeSkillReviewOf(home, userText, procedure, reviewProvider, reviewModel, reviewProfile, dispatch) {
  try {
    const { stat } = await import('node:fs/promises')
    const marker = join(home, '.last-skill-review')
    let lastReviewMs = 0
    try { lastReviewMs = (await stat(marker)).mtimeMs } catch { /* never reviewed */ }
    if (!skillReviewDecision({ enabled: true, lastReviewMs })) return
    if (userText.trim() === '' && procedure.trim() === '') return
    dispatch({
      kind: 'skill synthesis',
      prompt: skillPrompt(userText, procedure),
      markers: [marker], provider: reviewProvider, model: reviewModel, profile: reviewProfile,
    })
  } catch (error) {
    console.error(`dsh-memory: skill-synthesis review skipped: ${error.message}`)
  }
}

/**
 * Fire the detached DIGEST review: one sidecar paragraph per session so
 * cross-session recall does not mean replaying raw events. Same dispatch
 * machinery; its throttle is the loosest because a digest is never urgent.
 */
async function maybeDigestReviewOf(home, exchanges, sessionId, reviewProvider, reviewModel, reviewProfile, dispatch) {
  try {
    const { stat } = await import('node:fs/promises')
    const marker = join(home, '.last-digest-review')
    let lastReviewMs = 0
    try { lastReviewMs = (await stat(marker)).mtimeMs } catch { /* never reviewed */ }
    if (lastReviewMs > 0 && Date.now() - lastReviewMs < 30 * 60 * 1000) return
    if (exchanges.length < 3) return
    dispatch({
      kind: 'session digest',
      prompt: digestPrompt(exchanges, sessionId),
      markers: [marker], provider: reviewProvider, model: reviewModel, profile: reviewProfile,
    })
  } catch (error) {
    console.error(`dsh-memory: session digest skipped: ${error.message}`)
  }
}

/** Walk up from `start` looking for a project root marker. */
async function projectRoot(start, markers) {
  let directory = resolve(start)
  for (;;) {
    for (const marker of markers) {
      try {
        await access(join(directory, marker))
        return directory
      } catch {
        // Not this level; keep walking.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return resolve(start)
    directory = parent
  }
}

/** Split an existing file into its section bodies, preserving unknown text. */
function parseSections(text) {
  const sections = new Map()
  let preamble = ''
  let current
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading !== null) {
      current = heading[1].trim()
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current === undefined) preamble += `${line}\n`
    else sections.get(current).push(line)
  }
  return { preamble, sections }
}

/** Reassemble the file from its parts, trimming runs of blank lines. */
function renderFile(preamble, sections) {
  const parts = [preamble.trim()]
  for (const title of [...Object.values(SECTIONS), ...[...sections.keys()].filter(k => !Object.values(SECTIONS).includes(k))]) {
    const body = sections.get(title)
    if (body === undefined) continue
    // A section is a bullet list; blank lines inside one are only ever an
    // artifact of round-tripping the file, never meaningful.
    const lines = body.map(line => line.trimEnd()).filter(line => line !== '')
    if (lines.length === 0) continue
    parts.push(`## ${title}`, lines.join('\n'))
  }
  return `${parts.filter(part => part !== '').join('\n\n')}\n`
}

/**
 * Register the tools and prompt sections.
 * @param {object} ctx - plugin context carrying `ctx.tools` and `ctx.systemPrompt`.
 * @param {object} config - `{ filename?, projectRootMarkers?, indexCapBytes?, nudgeAfterMs?, backgroundReview?, reviewProvider?, reviewModel?, reviewProfile?, learnFromFailures?, failureReviewProvider?, failureReviewModel?, lessonsTopK?, lessonsMinScore?, synthesizeSkills?, skillMinTools?, skillReviewProvider?, skillReviewModel?, learnFromCorrections?, correctionReviewProvider?, correctionReviewModel?, coalesceWindowMs?, idleAfterMs?, idleDrainCooldownMs?, lessonEfficacy?, digestSessions?, digestReviewProvider?, digestReviewModel?, enableDigestSave? }`.
 */
export function apply(ctx, config = {}) {
  const filename = config.filename ?? 'QWEN.md'
  const markers = config.projectRootMarkers ?? ['.git']
  const indexCapBytes = config.indexCapBytes ?? 4096
  const nudgeAfterMs = config.nudgeAfterMs ?? 6 * 60 * 60 * 1000
  // The background review runs as its own detached agent turn; which model it
  // uses is separate from the interactive default. It defaults to the same
  // hosted route the kit shipped with, so an unconfigured install behaves as
  // before, but a local-only deployment can point it at the local model.
  const reviewProvider = config.reviewProvider ?? 'zai'
  const reviewModel = config.reviewModel ?? 'glm-5.3'
  // The sandboxed profile the review runs in. It withholds shell, file
  // mutation, network, subagents and tool creation, because a review reads
  // untrusted text unattended; see profiles/review/cordis.patch.yml.
  const reviewProfile = config.reviewProfile ?? 'review'
  const memoryHome = dshHomePath('memory')
  // Failure-driven learning: a turn that failed, was interrupted, thrashed, or
  // tripped the loop-guard gets its own post-mortem that writes a durable
  // "Lesson: …" memory. Defaults to following backgroundReview, and to the same
  // route, so a local-only install keeps it all local; overridable separately.
  const learnFromFailures = config.learnFromFailures ?? (config.backgroundReview === true)
  const failureReviewProvider = config.failureReviewProvider ?? reviewProvider
  const failureReviewModel = config.failureReviewModel ?? reviewModel
  // Proactive lesson recall: the top few "Lesson: …" lines, re-scored against
  // the LATEST exchange on every prompt assembly, promoted to their own tiny
  // section just above the general memory index. Cheap (a kilobyte-scale file
  // read plus string scoring) and additive — memory:index is untouched.
  const lessonsTopK = config.lessonsTopK ?? 3
  const lessonsMinScore = config.lessonsMinScore ?? 0.25
  // Auto-skill synthesis: a COMPLETED turn whose tool run was a real procedure
  // (enough calls, at least one world-changing one) gets its own detached
  // review that may distil it into a named skill. Defaults to following
  // backgroundReview and its route, so a local-only install stays local.
  const synthesizeSkills = config.synthesizeSkills ?? (config.backgroundReview === true)
  const skillMinTools = config.skillMinTools ?? 5
  const skillReviewProvider = config.skillReviewProvider ?? reviewProvider
  const skillReviewModel = config.skillReviewModel ?? reviewModel
  // Correction capture: a user message that corrects the agent's previous
  // answer is the highest-signal learning moment in the loop. Own review kind,
  // own 5-min throttle, same sandbox and route defaults.
  const learnFromCorrections = config.learnFromCorrections ?? (config.backgroundReview === true)
  const correctionReviewProvider = config.correctionReviewProvider ?? reviewProvider
  const correctionReviewModel = config.correctionReviewModel ?? reviewModel
  // Review dispatch: reviews share ONE local model slot with the interactive
  // turn, so a second review within `coalesceWindowMs` of a spawn is QUEUED
  // rather than run, and the queue drains when the user goes idle — reviews
  // then never compete with a turn someone is waiting on. Queued items on the
  // same route run as ONE combined model call.
  const coalesceWindowMs = config.coalesceWindowMs ?? 2 * 60 * 1000
  const idleAfterMs = config.idleAfterMs ?? 5 * 60 * 1000
  const idleDrainCooldownMs = config.idleDrainCooldownMs ?? 10 * 60 * 1000
  // Lesson efficacy: log every lesson the prompt actually surfaces, and mark a
  // miss when a turn later fails with that lesson on record — the curator
  // turns "surfaced N times, never helped" into a rewrite-or-retire plan.
  const lessonEfficacy = config.lessonEfficacy ?? true
  // Session digests: when idle, occasionally distil this session's recent
  // exchanges into a sidecar digest file (via the review sandbox's
  // digest_save tool — it must be enabled in the REVIEW profile too).
  const digestSessions = config.digestSessions === true
  const digestReviewProvider = config.digestReviewProvider ?? reviewProvider
  const digestReviewModel = config.digestReviewModel ?? reviewModel
  // digest_save registers ONLY where a profile opts in (the review sandbox);
  // the interactive agent never needs it.
  const enableDigestSave = config.enableDigestSave === true

  // The relevance signal for memory injection: the newest thing the human
  // said. AssembleContext carries no conversation, so the plugin watches the
  // session firehose itself; before the first message of a session this is
  // empty and injection falls back to the most recent lines.
  let lastUserText = ''
  let lastAssistantText = ''
  // ── review dispatch state ─────────────────────────────────────────────────
  // The shared clock and queue every review kind dispatches through. A spawn
  // stamps lastSpawnAt; anything arriving inside the coalesce window queues
  // for the idle drain instead of competing with the live turn.
  const reviewState = { lastSpawnAt: 0, queue: [] }
  const dispatch = item => {
    if (coalesceWindowMs > 0 && Date.now() - reviewState.lastSpawnAt < coalesceWindowMs) {
      // One queued instance per kind: a trigger whose marker only stamps at
      // spawn time (the digest, from its 30s idle ticks) would otherwise
      // queue a near-identical copy of itself on every re-check.
      if (reviewState.queue.some(queued => queued.kind === item.kind)) return
      reviewState.queue.push(item)
      if (reviewState.queue.length > 8) reviewState.queue.shift()
      return
    }
    void spawnReviews([item], reviewState).catch(error => console.error(`dsh-memory: review spawn failed: ${error.message}`))
  }
  // The idle drain: one cheap timer for the whole plugin. When the user has
  // been quiet past `idleAfterMs` and reviews are waiting, run them ALL as
  // one combined call — the GPU is free precisely because nobody is waiting.
  let lastUserActivityAt = Date.now()
  let lastDrainAt = 0
  let recentExchanges = []
  let lastSessionId
  const drainQueue = () => {
    if (reviewState.queue.length === 0) return
    const items = reviewState.queue.splice(0)
    lastDrainAt = Date.now()
    void spawnReviews(items, reviewState).catch(error => console.error(`dsh-memory: idle review drain failed: ${error.message}`))
  }
  if (idleDrainCooldownMs > 0 && idleAfterMs > 0) {
    const timer = setInterval(() => {
      if (Date.now() - lastUserActivityAt < idleAfterMs) return
      if (Date.now() - lastDrainAt < idleDrainCooldownMs) return
      if (reviewState.queue.length > 0) { drainQueue(); return }
      if (digestSessions && recentExchanges.length >= 3) {
        void maybeDigestReviewOf(memoryHome, recentExchanges, lastSessionId ?? 'unknown-session', digestReviewProvider, digestReviewModel, reviewProfile, dispatch)
      }
    }, 30_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'dsh-memory: close idle-drain timer')
  }
  // The self-improvement trigger: a turn that loaded a skill and still
  // failed. A skill that steers wrong poisons every future session that
  // loads it, so the very next prompt carries a fix-it-now nudge (shown
  // once per incident, then cleared).
  let skillUsedThisTurn = false
  let skillFailedNudge = false
  // Per-turn failure evidence, reset at each turn boundary. `callNames` maps a
  // tool call's id to its name so a failing tool/result can be attributed.
  // `turnToolSeq` is the compact ordered tool run ({name, brief} per call) the
  // skill-synthesis review reads — the one thing it has that the success
  // review lacks: the PROCEDURE, not just the outcome.
  let turnStepCount = 0
  let turnToolErrors = []
  let callNames = new Map()
  let turnToolSeq = []
  const resetTurn = () => { turnStepCount = 0; turnToolErrors = []; callNames = new Map(); turnToolSeq = [] }
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'user/message') {
      lastSessionId = session?.id
      const content = event.data?.content
      const incoming = typeof content === 'string'
        ? content
        : (Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join(' ') : '')
      // Only a real human message counts: plugin injections (runtime context,
      // grounding nudges) arrive on the same channel but are not the user
      // talking, and must not fake activity or read as corrections.
      const source = event.data?.source
      if (source === undefined || source?.kind === 'user') {
        lastUserActivityAt = Date.now()
        // A correction of the previous answer is the highest-signal feedback
        // there is; give it its own review rather than hoping the routine
        // post-turn pass catches the exchange.
        if (learnFromCorrections && isCorrection(incoming) && lastAssistantText.trim() !== '') {
          void maybeCorrectionReviewOf(memoryHome, incoming, lastAssistantText, correctionReviewProvider, correctionReviewModel, reviewProfile, dispatch)
        }
      }
      lastUserText = incoming
      return
    }
    if (event?.type === 'assistant/message') {
      lastSessionId = session?.id
      const blocks = event.data?.message?.content
      if (Array.isArray(blocks)) lastAssistantText = blocks.filter(block => block?.type === 'text').map(block => block.text).join(' ')
      return
    }
    if (event?.type === 'turn/start') { resetTurn(); return }
    if (event?.type === 'step/start') { turnStepCount += 1; return }
    if (event?.type === 'tool/call') {
      if (event.data?.name === 'skill') skillUsedThisTurn = true
      if (event.data?.callId !== undefined) callNames.set(event.data.callId, event.data.name)
      // Remember the run, newest last, capped so a pathological turn cannot
      // grow it without bound (the oldest drop off first).
      turnToolSeq.push({ name: event.data?.name ?? 'tool', brief: callBrief(event.data?.arguments) })
      if (turnToolSeq.length > TOOL_SEQ_CAP) turnToolSeq.shift()
      return
    }
    if (event?.type === 'tool/result') {
      const block = event.data?.message?.content?.[0]
      const failed = event.data?.error !== undefined || block?.isError === true
      if (failed) {
        const message = Array.isArray(block?.content)
          ? block.content.filter(part => part?.type === 'text').map(part => part.text).join(' ')
          : (event.data?.error?.name ?? 'error')
        turnToolErrors.push({ name: callNames.get(block?.toolCallId) ?? 'tool', message })
      }
      return
    }
    if (event?.type === 'turn/end') {
      const reason = event.data?.reason?.kind
      if (skillUsedThisTurn && reason === 'failed') skillFailedNudge = true
      skillUsedThisTurn = false
      const stepCount = turnStepCount
      const toolErrors = turnToolErrors
      const toolSeq = turnToolSeq
      resetTurn()
      lastSessionId = session?.id

      // The digest reviewer's raw material: a bounded rolling record of what
      // was actually exchanged, captured at the boundary where it is complete.
      if (lastUserText.trim() !== '' || lastAssistantText.trim() !== '') {
        recentExchanges.push({ user: lastUserText, assistant: lastAssistantText })
        if (recentExchanges.length > 12) recentExchanges.shift()
      }

      // Success review: unchanged behaviour, gated on backgroundReview.
      if (reason === 'completed' && config.backgroundReview === true) {
        void maybeReviewOf(memoryHome, lastUserText, lastAssistantText, reviewProvider, reviewModel, reviewProfile, dispatch)
      }

      // Skill synthesis: a completed turn that genuinely ran a PROCEDURE may
      // be worth teaching as a named skill. The reviewer sees the tool
      // sequence — the thing the success review never gets — and is told to
      // decline one-offs. Own 15-min throttle: rarest of the three reviews,
      // and they all share the single local slot.
      if (reason === 'completed' && synthesizeSkills && isProcedural(toolSeq, skillMinTools)) {
        void maybeSkillReviewOf(memoryHome, lastUserText, formatProcedure(toolSeq), skillReviewProvider, skillReviewModel, reviewProfile, dispatch)
      }

      // Failure post-mortem: learn from what went wrong so it is not repeated.
      if (learnFromFailures) {
        void (async () => {
          const loopBreak = await consumeLoopBreak(session?.id)
          if (!isLearnableFailure({ reason, toolErrors: toolErrors.length, stepCount, loopBreak: loopBreak !== null })) return
          const evidence = formatEvidence({ reason, stepCount, toolErrors, loopBreak })
          // Lesson efficacy, miss side: a failure with a relevant lesson
          // recently surfaced is evidence the lesson is not working.
          if (lessonEfficacy) await noteLessonMisses(memoryHome, `${lastUserText} ${evidence}`)
          await maybeFailureReviewOf(memoryHome, lastUserText, evidence, failureReviewProvider, failureReviewModel, reviewProfile, dispatch)
        })()
      }
    }
  })

  ctx.tools.register(defineTool({
    name: 'remember',
    description:
      `Record a durable fact in ${filename}, the project memory file that is loaded into every future session here. `
      + 'Use it when you learn something that would otherwise have to be rediscovered: how this project is built or run, '
      + 'a mistake that wasted time and how to avoid it, an environment constraint, or a stated preference. '
      + 'Record only what you VERIFIED — a confidently wrong memory is worse than none, and it persists. '
      + 'Do not record transient state, secrets, or anything already obvious from the code. '
      + 'For facts about the USER or their machine that hold across projects, prefer memory_save.',
    parameters: {
      fact: {
        type: 'string',
        required: true,
        description: 'One specific, self-contained sentence. Include the WHY when it is not obvious. Bad: "be careful with the config". Good: "llama-swap --predict caps every request including compaction, which deadlocks long sessions".',
      },
      category: {
        type: 'string',
        required: true,
        enum: Object.keys(SECTIONS),
        description: 'environment: how this machine or project is set up. mistake: something that went wrong and how to avoid it. howto: a procedure worth repeating. preference: how the user wants things done.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          section: { type: 'string', required: true },
          status: { type: 'string', enum: ['recorded', 'already known'], required: true },
          bytes: { type: 'integer', required: true },
          existing: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'already known'
          ? `Already recorded in ${value.path}, as: "${value.existing}". Nothing added.`
          : `Recorded under "${value.section}" in ${value.path} (${value.bytes} bytes).`,
      }],
    },
    async execute(args) {
      const fact = args.fact.trim().replace(/\s+/g, ' ')
      if (fact === '') throw new Error('fact must not be empty')
      const section = SECTIONS[args.category]
      if (section === undefined) throw new Error(`unknown category "${args.category}"`)

      const root = await projectRoot(process.cwd(), markers)
      const path = join(root, filename)

      let existing = ''
      try {
        existing = await readFile(path, 'utf8')
      } catch {
        // First fact in this project; the file is created below.
      }

      const { preamble, sections } = parseSections(existing)
      const entry = `- ${fact}`
      // Compare against every section, not just the target one: the same fact
      // filed under a different category is still a duplicate.
      for (const [, body] of sections) {
        const match = body.find(line => line.trim() !== '' && similarity(line, entry) >= DUPLICATE_AT)
        if (match !== undefined) {
          return { path, section, status: 'already known', bytes: Buffer.byteLength(existing), existing: match.replace(/^-\s*/, '') }
        }
      }
      const target = sections.get(section) ?? []
      target.push(entry)
      sections.set(section, target)

      const header = preamble.trim() === ''
        ? `# Project memory\n\nMaintained by the agent via the \`remember\` tool, and read into every session here.\nEdit or delete anything that is wrong — it is a plain file.`
        : preamble
      const rendered = renderFile(header, sections)
      if (Buffer.byteLength(rendered) > MAX_BYTES) {
        throw new Error(`${filename} would exceed ${MAX_BYTES} bytes; prune it before recording more`)
      }
      await writeFile(path, rendered)
      return { path, section, status: 'recorded', bytes: Buffer.byteLength(rendered) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description:
      'Record a durable fact about the user, their machines, or their preferences in the user memory store, '
      + 'which is injected into every future session in every project. One call = one topic: a short title plus a '
      + 'summary that stands alone (it is the line the model reads at prompt time), with optional detail body. '
      + 'Saving to an existing topic REPLACES it — rewrite the whole fact, not a delta. '
      + 'Record only what you VERIFIED; a wrong durable memory is worse than none — say how you know with `confidence`. '+ 'If the save reports a CONTRADICTION with an existing memory, resolve it instead of leaving both on file. '
      + 'Project-specific facts belong in remember (QWEN.md) instead.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Short stable title for the fact, e.g. "Pi model serving" or "Preferred review style".',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'One self-contained sentence carrying the whole fact. Bad: "uses the port from before". Good: "llama-server serves bonsai-27b on 127.0.0.1:8080 with 8192 context, started manually".',
      },
      body: {
        type: 'string',
        description: 'Optional detail (commands, caveats, history) kept in the topic file; read on demand, not injected.',
      },
      confidence: {
        type: 'string',
        enum: ['verified', 'observed', 'reported'],
        description: 'How you know. verified: you ran it or read it out of the system itself. observed: you saw it happen but did not confirm it. reported: the user or a document said so. This decides how long the fact is trusted before it is flagged for re-checking, so do not inflate it.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          indexPath: { type: 'string', required: true },
          topicPath: { type: 'string', required: true },
          status: { type: 'string', enum: ['recorded', 'updated', 'already known'], required: true },
          bytes: { type: 'integer', required: true },
          confirmations: { type: 'integer' },
          conflicts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'string', required: true },
                score: { type: 'number', required: true },
                subject: { type: 'number' },
                signal: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.status === 'already known') return [{ type: 'text', text: 'Already in memory; nothing added.' }]
        const head = `${value.status === 'updated' ? 'Updated' : 'Recorded'} memory (${value.bytes} bytes index): ${value.topicPath}`
        // A contradiction is reported, never silently swallowed: the write has
        // already happened, and leaving the model unaware of the clash is how
        // two incompatible facts end up in every future prompt.
        const notice = conflictNotice(value.conflicts ?? [])
        return [{ type: 'text', text: notice === '' ? head : `${head}\n\n${notice}` }]
      },
    },
    async execute(args) {
      return saveFact(memoryHome, args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_edit',
    description:
      'Correct or tighten an existing memory: matched by a short UNIQUE substring of the current entry '
      + '(a few distinctive words suffice; zero or multiple matches return an error listing the candidates). '
      + 'Rewrites that entry\'s summary in the index and, when a body is given, replaces its topic detail '
      + '(empty body removes the detail file). Use this to consolidate near-duplicate memories into one tighter entry.',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: 'A substring unique to the one memory being edited, e.g. "bonsai 8080".',
      },
      summary: {
        type: 'string',
        description: 'The replacement summary line — self-contained, carries the whole fact.',
      },
      body: {
        type: 'string',
        description: 'Replacement topic detail (omit to keep the current detail; empty string removes it).',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          line: { type: 'string', required: true },
          topicPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Memory rewritten: ${value.line}` }],
    },
    async execute(args) {
      return editFact(memoryHome, args.match, { summary: args.summary, body: args.body })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description:
      'Remove a memory that is wrong or no longer worth its space, matched by a short UNIQUE substring '
      + '(zero or multiple matches return an error listing the candidates). Removes the index line and its topic file. '
      + 'Prefer memory_edit when the fact changed rather than died.',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: 'A substring unique to the one memory being removed.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'string', required: true },
          topicPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Removed: ${value.removed}` }],
    },
    async execute(args) {
      return removeFact(memoryHome, args.match)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description:
      'Search the user memory store before re-deriving something that past sessions may already have learned '
      + '(machines, endpoints, preferences, past decisions). Returns matching topics with their summaries and paths.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords of what you are looking for, e.g. "llama port context".' },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                topic: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                path: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No memories matched.'
          : value.results.map(hit => `- ${hit.topic}: ${hit.summary} (${hit.path})`).join('\n'),
      }],
    },
    async execute(args) {
      return { results: await search(memoryHome, args.query) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skill_create',
    description:
      'Capture a repeatable procedure as a named skill — procedural memory. When you notice yourself re-deriving '
      + 'the same steps (a deploy check, a debugging recipe, a file format), write it once as a skill and it becomes '
      + 'available in every future session immediately, no restart. Update with overwrite when the procedure improves. '
      + 'This is the write half of the skills system; everything you and the user can also read lives in the same files.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Kebab-case id, e.g. "verify-llama-server".',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One sentence: what this skill does. This is what future sessions see when deciding to use it.',
      },
      whenToUse: {
        type: 'string',
        description: 'Optional: the situations that call for this skill, phrased as a trigger.',
      },
      body: {
        type: 'string',
        required: true,
        description: 'The skill content as markdown: the steps, commands, and gotchas. Write it for a future session that knows nothing else.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace an existing skill of the same name (default false: refuse instead).',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          status: { type: 'string', enum: ['created', 'replaced'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.status === 'replaced' ? 'Replaced' : 'Created'} skill at ${value.path}. It is live in every session from now on.`,
      }],
    },
    async execute(args) {
      return writeSkill(dshHomePath('skills'), args)
    },
  }))

  // The digest reviewer's only output channel. Registered ONLY where a
  // profile opts in (the review sandbox) — the sandbox has no file writes by
  // design, and the digest is the one file it legitimately needs to produce.
  if (enableDigestSave) {
    ctx.tools.register(defineTool({
      name: 'digest_save',
      description:
        'Write the session digest (called by the session-digest review). One short markdown record of what the '
        + 'session asked and did, stored beside the session logs for future recall.',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'The session id from the prompt, verbatim.' },
        markdown: { type: 'string', required: true, description: 'The digest: what was asked, what was done, outcomes, gotchas. Tight — a paragraph or short list.' },
      },
      output: {
        kind: 'value',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Digest written to ${value.path} (${value.bytes} bytes).` }],
      },
      async execute(args) {
        const sessionId = String(args.sessionId).replace(/[^A-Za-z0-9_.-]/g, '')
        const markdown = String(args.markdown).trim()
        if (sessionId === '') throw new Error('sessionId must not be empty')
        if (markdown === '') throw new Error('markdown must not be empty')
        if (Buffer.byteLength(markdown) > 8192) throw new Error('digest exceeds 8192 bytes — tighten it')
        // Same refuse-first scan as memory: the digest is agent-authored text
        // a future session will read and trust.
        const threat = scanMemoryText(markdown)
        if (threat !== undefined) throw new Error(`digest rejected by security scan: ${threat}`)
        const dir = join(dshHomePath('sessions'), '.digests')
        await mkdir(dir, { recursive: true })
        const path = join(dir, `${sessionId}.md`)
        await writeFile(path, `# Session digest — ${sessionId}\n\n${markdown}\n`)
        return { path, bytes: Buffer.byteLength(markdown) }
      },
    }))
  }

  // ── system prompt sections ───────────────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'memory:lessons',
    order: 18,
    text: () => {
      const index = indexTextSync(memoryHome)
      if (index === '') return ''
      const lines = index.split('\n').filter(line => line.startsWith('- '))
      // The query is the LATEST exchange, not the opening request: recall
      // should follow the task as it drifts mid-session.
      const lessons = rankLessons(lines, `${lastUserText} ${lastAssistantText}`, lessonsTopK, lessonsMinScore)
      if (lessons.length === 0) return ''
      if (lessonEfficacy) noteLessonHits(memoryHome, lessons)
      return `# Relevant past mistakes — apply these before acting:\n${truncateForPrompt(lessons.join('\n'), LESSON_CAP_BYTES)}`
    },
  })

  ctx.systemPrompt.section({
    name: 'memory:index',
    order: 20,
    text: () => {
      const index = indexTextSync(memoryHome)
      if (index === '') return ''
      const bytes = Buffer.byteLength(index)
      const percent = Math.round((bytes / MAX_INDEX_BYTES) * 100)
      const lines = index.split('\n').filter(line => line.startsWith('- '))
      const { selected, total, mode } = selectMemoryLines(lines, lastUserText)
      const note = mode === 'selected' ? `\n(Showing ${selected.length} of ${total} memories by relevance to this conversation; memory_search reaches the rest.)` : ''
      const body = `${selected.join('\n')}${note}`
      return `# Memory [${percent}% — ${bytes}/${MAX_INDEX_BYTES} chars]\nPersistent memory from past sessions. Above ~80% consolidate with memory_edit/memory_forget before adding. Topic detail under memory/topics/ (memory_search finds it):\n\n${truncateForPrompt(body, indexCapBytes)}`
    },
  })

  ctx.systemPrompt.section({
    name: 'memory:instruction',
    order: 21,
    text: () => {
      let text = 'Durable facts about the user and their machines belong in memory: memory_save (one topic, one self-contained summary), memory_search before re-deriving what past sessions may have learned; memory_edit corrects or merges, memory_forget removes — when a save fails the capacity check, consolidate in the SAME turn using the entries the error lists. Record only verified facts.'
      const last = lastWriteMsSync(memoryHome)
      if (last > 0 && Date.now() - last > nudgeAfterMs) {
        text += `\nIt has been a while since memory was last written — if this session established something durable, save it.`
      }
      return text
    },
  })

  ctx.systemPrompt.section({
    name: 'skill:create-hint',
    order: 22,
    text: () => {
      let text = 'A procedure you have now done twice is worth capturing once: skill_create turns it into a named skill every future session can use — and when a skill proves wrong or incomplete mid-task, fix it immediately with skill_create (overwrite: true) rather than working around it; improved live, it is the loop teaching itself.'
      if (skillFailedNudge) {
        skillFailedNudge = false
        text += '\nThe previous turn loaded a skill and still failed. If the skill itself was wrong, stale, or incomplete, THIS is the moment to rewrite it with skill_create (overwrite: true) — otherwise every future session inherits the same failure.'
      }
      return text
    },
  })

  // A command, not a tool: the index is data the human may want to audit,
  // and auditing it should cost zero model tokens.
  ctx.commands.register({
    name: 'memory',
    description: 'show the persistent memory index (and where its files live)',
    handler: async () => {
      const index = indexTextSync(memoryHome)
      const lastWrite = lastWriteMsSync(memoryHome)
      const age = lastWrite === 0 ? 'never written' : `${Math.round((Date.now() - lastWrite) / 3600000)}h since last write`
      const bytes = Buffer.byteLength(index)
      const percent = Math.round((bytes / MAX_INDEX_BYTES) * 100)
      const usage = `[${percent}% — ${bytes}/${MAX_INDEX_BYTES} chars, ${age}]`
      if (index === '') {
        return { kind: 'success', text: `Memory store is empty (${age}).\nThe agent fills it with memory_save; files live under ${memoryHome}.` }
      }
      return {
        kind: 'success',
        text: `## Memory ${usage}\n\n${index.trim()}\n\n(Edit or delete lines in ${join(memoryHome, 'MEMORY.md')} — it is a plain file; topic detail under ${join(memoryHome, 'topics')})`,
      }
    },
  })
}

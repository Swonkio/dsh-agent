/**
 * Curation policy — pure decisions, no I/O.
 *
 * A learning loop that only ever ADDS is not learning, it is hoarding. Every
 * skill written and every memory saved is replayed into future prompts, so a
 * collection that grows without pruning steadily spends more of the context
 * window on advice that no longer applies. Something has to decide what to
 * retire. That is this module.
 *
 * The decision here is deliberately not the usual one. The obvious signals are
 * recency and use count — retire what is old and rarely used — and they are
 * what a usage log makes easy to collect. But they measure ATTENTION, not
 * VALUE: a skill invoked constantly that leaves the turn failing half the time
 * is actively harmful, and a use count rewards it for being harmful more
 * often. So the primary signal here is OUTCOME: after the agent used this
 * skill, did the turn succeed?
 *
 * That distinction changes what the right action is. A skill that is merely
 * unused should be archived — quietly, recoverably, because it might matter
 * again. A skill that is used and FAILS should not be archived at all: it is
 * being reached for, so the intent behind it is live and worth keeping; what
 * is wrong is its content. That one gets flagged for revision instead. Those
 * are opposite responses, and a count-based policy cannot tell the two cases
 * apart because both look like "a number went up".
 *
 * Two invariants, both load-bearing:
 *
 *   - Nothing is ever deleted. Archive is recoverable; a wrong retirement
 *     should cost a restore, not a rewrite.
 *   - A pinned entry is untouchable. The user's explicit judgement outranks
 *     every heuristic in this file.
 *
 * @module dsh-curator/policy
 */

/** Lifecycle states an entry can hold. */
export const STATES = ['active', 'stale', 'archived']

/** Defaults, all overridable per install. */
export const DEFAULTS = {
  /** No activity for this long → stale. */
  staleAfterDays: 45,
  /** Stale for this long on top → archive. */
  archiveAfterDays: 90,
  /** Below this many uses, a failure rate is noise rather than evidence. */
  minUsesForOutcome: 4,
  /** At or above this failure rate (with enough uses) → flag for revision. */
  failureRateAt: 0.4,
  /** Memory older than this, scaled by evidence, is worth re-checking. */
  memoryStaleAfterDays: 90,
  /** Below this many lesson hits, a miss is noise rather than evidence. */
  minHitsForLessonVerdict: 3,
}

/** A zeroed telemetry record. */
export function emptyRecord(now = new Date().toISOString()) {
  return { uses: 0, wins: 0, losses: 0, firstUsed: now, lastUsed: now, state: 'active', pinned: false }
}

/**
 * Fold one observed outcome into a record.
 *
 * `outcome` is 'win' when the turn that used the skill completed and 'loss'
 * when it failed. Anything else counts as a use without a verdict — the skill
 * was consulted but the turn's fate says nothing about it (cancelled, still
 * running), and scoring those either way would poison the rate.
 */
export function recordOutcome(record, outcome, now = new Date().toISOString()) {
  const base = record ?? emptyRecord(now)
  return {
    ...base,
    uses: base.uses + 1,
    wins: base.wins + (outcome === 'win' ? 1 : 0),
    losses: base.losses + (outcome === 'loss' ? 1 : 0),
    lastUsed: now,
    firstUsed: base.firstUsed ?? now,
  }
}

/** Failure rate over decided outcomes only; null when there is no evidence. */
export function failureRate(record) {
  const decided = (record.wins ?? 0) + (record.losses ?? 0)
  if (decided === 0) return null
  return (record.losses ?? 0) / decided
}

/** Days since an ISO timestamp; Infinity when unparseable or absent. */
export function daysSince(iso, now = Date.now()) {
  const at = Date.parse(String(iso))
  if (Number.isNaN(at)) return Infinity
  return (now - at) / 86400000
}

/**
 * Decide what should happen to one skill.
 *
 * Order matters and encodes the argument above: pinned wins over everything;
 * a failing skill is flagged BEFORE age is considered, because a skill that is
 * actively being used and failing is a live problem regardless of how recently
 * it was written; only then does disuse decide retirement.
 *
 * @returns {{action: 'keep'|'flag'|'stale'|'archive', reason: string}}
 */
export function classify(record, options = {}) {
  const config = { ...DEFAULTS, ...options }
  const now = config.now ?? Date.now()

  if (record.pinned === true) return { action: 'keep', reason: 'pinned by the user' }
  if (record.state === 'archived') return { action: 'keep', reason: 'already archived' }

  const rate = failureRate(record)
  const decided = (record.wins ?? 0) + (record.losses ?? 0)
  if (rate !== null && decided >= config.minUsesForOutcome && rate >= config.failureRateAt) {
    return {
      action: 'flag',
      reason: `fails ${Math.round(rate * 100)}% of the time across ${decided} decided uses — the intent is live but the content is wrong; revise it rather than retiring it`,
    }
  }

  const idle = daysSince(record.lastUsed, now)
  if (idle > config.staleAfterDays + config.archiveAfterDays) {
    return { action: 'archive', reason: `unused for ${Math.round(idle)} days` }
  }
  if (idle > config.staleAfterDays) {
    return { action: 'stale', reason: `unused for ${Math.round(idle)} days` }
  }
  return { action: 'keep', reason: 'in active use' }
}

/**
 * Build the full curation plan across skills, memory staleness and unresolved
 * contradictions.
 *
 * The plan is data, not action: it is rendered for a human and handed to the
 * review pass to act on. Keeping the decision separate from the mutation is
 * what makes the policy testable without a filesystem or a model.
 *
 * @param {object} input - `{ skills: Record<string,record>, staleMemories?: [], conflicts?: [] }`
 */
export function curationPlan(input, options = {}) {
  const config = { ...DEFAULTS, ...options }
  const skills = input.skills ?? {}
  const actions = []
  for (const [name, record] of Object.entries(skills)) {
    const { action, reason } = classify(record, config)
    if (action === 'keep') continue
    actions.push({ kind: 'skill', name, action, reason, uses: record.uses ?? 0, failureRate: failureRate(record) })
  }
  // Worst first: a failing skill outranks a merely idle one.
  const rank = { flag: 0, archive: 1, stale: 2 }
  actions.sort((a, b) => (rank[a.action] - rank[b.action]) || (b.uses - a.uses))

  // Lesson efficacy: surfaced often, and a turn still failed with it on
  // record. Advice the agent keeps receiving and keeps not following is worse
  // than no advice — it spends prompt bytes every turn saying something the
  // behavior demonstrably ignores. Rewrite (sharpen the "When X, do Y") or
  // retire; never silently keep.
  const ineffectiveLessons = []
  for (const [topic, stat] of Object.entries(input.lessonStats ?? {})) {
    if ((stat.hits ?? 0) >= config.minHitsForLessonVerdict && (stat.misses ?? 0) >= 1) {
      ineffectiveLessons.push({ topic, hits: stat.hits, misses: stat.misses })
    }
  }

  return {
    actions,
    ineffectiveLessons,
    staleMemories: input.staleMemories ?? [],
    conflicts: input.conflicts ?? [],
    counts: {
      skills: Object.keys(skills).length,
      flagged: actions.filter(a => a.action === 'flag').length,
      stale: actions.filter(a => a.action === 'stale').length,
      archive: actions.filter(a => a.action === 'archive').length,
    },
  }
}

/** True when the plan has nothing worth spending a model call on. */
export function planIsEmpty(plan) {
  return plan.actions.length === 0 && plan.staleMemories.length === 0 && plan.conflicts.length === 0
  && (plan.ineffectiveLessons ?? []).length === 0
}

/**
 * Should a curation pass run now?
 *
 * Inactivity-triggered rather than scheduled: curation competes with the user
 * for the same single local model slot, so it waits for a gap rather than
 * interrupting. An empty plan also means no run, so a quiet install never
 * spends a model call discovering there was nothing to do.
 */
export function shouldRun({ lastRunMs, idleMs, plan, now = Date.now(), intervalHours = 24, minIdleMinutes = 20 }) {
  if (plan !== undefined && planIsEmpty(plan)) return false
  if (idleMs !== undefined && idleMs < minIdleMinutes * 60000) return false
  if (lastRunMs > 0 && now - lastRunMs < intervalHours * 3600000) return false
  return true
}

/** Render a plan as the markdown report a human reads. */
export function renderReport(plan, now = new Date()) {
  const lines = [`# Curation report — ${now.toISOString().slice(0, 10)}`, '']
  if (planIsEmpty(plan)) {
    lines.push('Nothing to curate: no failing skills, no idle skills, no stale memories, no contradictions.')
    return `${lines.join('\n')}\n`
  }
  const { counts } = plan
  lines.push(`${counts.skills} skills tracked — ${counts.flagged} failing, ${counts.stale} idle, ${counts.archive} retirable.`, '')

  const section = (title, rows) => {
    if (rows.length === 0) return
    lines.push(`## ${title}`, '')
    for (const row of rows) lines.push(row)
    lines.push('')
  }

  section('Failing — revise, do not retire', plan.actions
    .filter(a => a.action === 'flag')
    .map(a => `- **${a.name}** — ${a.reason}`))
  section('Idle — archive (recoverable)', plan.actions
    .filter(a => a.action === 'archive')
    .map(a => `- **${a.name}** — ${a.reason}`))
  section('Going idle', plan.actions
    .filter(a => a.action === 'stale')
    .map(a => `- **${a.name}** — ${a.reason}`))
  section('Memories worth re-checking', plan.staleMemories
    .map(m => `- **${m.topic}** — ${m.ageDays}d old, budget ${m.budgetDays}d (${m.confidence}, ${m.confirmations} confirmations)`))
  section('Unresolved contradictions', plan.conflicts
    .map(c => `- ${c.a} **vs** ${c.b}${c.signal ? ` (${c.signal})` : ''}`))
  section('Lessons that are not working — rewrite or retire', (plan.ineffectiveLessons ?? [])
    .map(l => `- **Lesson: ${l.topic}** — surfaced ${l.hits}×, yet ${l.misses} relevant failure(s) followed; the advice is being read and ignored, so its wording is not changing behaviour`))

  return `${lines.join('\n')}\n`
}

/**
 * Render the /loop dashboard: one zero-token view of whether the learning
 * loop is actually alive. Pure — every input is pre-read telemetry.
 *
 * @param {object} input - `{ lessons: {total, hits, misses, ineffective: []},
 *   reviews: [{kind, agoMin}], skills: {tracked, flagged}, breaks: [{at, kind, why}],
 *   digests: number, lastBreaksDays?: number }`.
 * @returns {string} markdown.
 */
export function renderLoopReport(input, now = Date.now()) {
  const lessons = input.lessons ?? { total: 0, hits: 0, misses: 0, ineffective: [] }
  const reviews = input.reviews ?? []
  const breaks = input.breaks ?? []
  const weekMs = 7 * 86400000
  const recent = breaks.filter(b => now - Date.parse(b.at) < weekMs)

  const lines = ['# Learning loop', '']
  lines.push(`Lessons: **${lessons.total}** on file · surfaced **${lessons.hits}×** · **${lessons.misses}** miss(es) after being surfaced.`)
  if ((lessons.ineffective ?? []).length > 0) {
    lines.push(`⚠ ${lessons.ineffective.length} not working: ${lessons.ineffective.map(l => l.topic).join(', ')} — see \`curate report\`.`)
  }
  lines.push('')
  if (reviews.length === 0) {
    lines.push('Reviews: none have run yet — enable the learning triggers in the profile.')
  } else {
    lines.push(`Reviews (last run): ${reviews.map(r => `${r.kind} ${formatAgo(r.agoMin)}`).join(' · ')}`)
  }
  lines.push(`Skills tracked: **${input.skills?.tracked ?? 0}**${input.skills?.flagged ? ` · ⚠ ${input.skills.flagged} failing (flagged for revision)` : ''}`)
  lines.push(`Session digests: **${input.digests ?? 0}** written.`)
  lines.push(`Loop-guard breaks: **${recent.length}** in the last 7 days.`)
  for (const b of recent.slice(-3)) {
    lines.push(`- ${b.kind}: ${String(b.why).slice(0, 100)}`)
  }
  if (lessons.total === 0 && reviews.length === 0 && recent.length === 0 && (input.digests ?? 0) === 0) {
    lines.push('', '_Nothing has happened yet: the loop turns on with backgroundReview / learnFromFailures in the profile._')
  }
  return `${lines.join('\n')}\n`
}

/** "3 min ago" / "2 h ago" from a minute count. */
function formatAgo(min) {
  if (min < 60) return `${min}m ago`
  return `${Math.round(min / 60)}h ago`
}

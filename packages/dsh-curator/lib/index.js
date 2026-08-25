/**
 * dsh-curator — outcome telemetry and the curation pass.
 *
 * Two halves. The passive half watches the session firehose and records, for
 * every skill the agent loads, whether the turn that loaded it went on to
 * succeed. That is the evidence nothing else in the loop collects: the memory
 * review can tell you a skill was WRITTEN, and a usage log can tell you it was
 * READ, but only the turn's outcome speaks to whether it actually helped.
 *
 * The active half is the `curate` tool, which turns that evidence into a plan:
 * which skills to revise because they are failing, which to retire because
 * nothing reaches for them, which memories have aged past what their evidence
 * supports, and which pairs of memories openly contradict each other. Applying
 * the plan only ever archives, never deletes.
 *
 * @module dsh-curator
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { curationPlan, renderReport, renderLoopReport, planIsEmpty, DEFAULTS } from './policy.js'
import { loadUsage, noteOutcome, scanMemory, archiveSkill, restoreSkill, setPinned, markRun, loadLessonStats, loadBreaks, loadReviewAges } from './store.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-curator'

/** Registers tools, a command, and a prompt section; reads the firehose. */
export const inject = ['tools', 'commands', 'systemPrompt']

/**
 * Render the skill-outcome annotations for the prompt section. Pure.
 * Only skills with enough decided uses are annotated — a rate over two
 * tries is noise, and noise in the prompt costs every turn.
 */
export function renderSkillOutcomes(usage, options = {}) {
  const minUses = options.minUsesForOutcome ?? 4
  const rows = []
  for (const [name, record] of Object.entries(usage ?? {})) {
    if (record?.state === 'archived') continue
    const decided = (record.wins ?? 0) + (record.losses ?? 0)
    if (decided < minUses) continue
    const wins = record.wins ?? 0
    const mark = record.losses > wins ? '⚠' : '✓'
    rows.push(`${mark} ${name} — ${wins}/${decided} turns succeeded`)
  }
  return rows.sort().join('\n')
}

/** Pull a skill identifier out of a tool call's argument JSON. */
export function skillNameFrom(argumentsJson) {
  try {
    const parsed = JSON.parse(String(argumentsJson))
    for (const key of ['name', 'skill', 'skill_name', 'id']) {
      if (typeof parsed?.[key] === 'string' && parsed[key].trim() !== '') return parsed[key].trim()
    }
  } catch { /* unparseable arguments: no attribution, which is correct */ }
  return null
}

/**
 * @param {object} ctx - plugin context with `ctx.tools`.
 * @param {object} config - policy overrides; see policy.js DEFAULTS.
 */
export function apply(ctx, config = {}) {
  const home = dshHomePath()
  const skillsHome = config.skillsHome ?? join(home, 'skills')
  const memoryHome = config.memoryHome ?? join(home, 'memory')
  const policy = { ...DEFAULTS, ...config }

  // Skills loaded during the current turn, attributed when it ends. A turn can
  // load several; all of them share the turn's verdict, because there is no
  // finer-grained signal available and guessing which one was responsible
  // would invent evidence that does not exist.
  let loadedThisTurn = new Set()

  ctx.on('session/event', (_session, event) => {
    if (event?.type === 'tool/call' && event.data?.name === 'skill') {
      const skill = skillNameFrom(event.data?.arguments)
      if (skill !== null) loadedThisTurn.add(skill)
      return
    }
    if (event?.type === 'turn/end') {
      const kind = event.data?.reason?.kind
      const outcome = kind === 'completed' ? 'win' : kind === 'failed' ? 'loss' : 'unknown'
      const skills = [...loadedThisTurn]
      loadedThisTurn = new Set()
      if (skills.length === 0) return
      // Telemetry must never delay or break the turn that produced it.
      void (async () => {
        for (const skill of skills) {
          try {
            await noteOutcome(skillsHome, skill, outcome)
          } catch { /* a lost count is not worth a warning in the user's session */ }
        }
      })()
    }
  })

  ctx.tools.register(defineTool({
    name: 'curate',
    description:
      'Review the health of learned skills and memory. `report` shows which skills are failing when used '
      + '(revise those — the intent is live but the content is wrong), which are unused (archive those), which '
      + 'memories have aged past what their evidence supports, and which memories contradict each other. '
      + '`archive`/`restore` retire and recover a skill by name; archiving MOVES it, so it is always recoverable. '
      + '`pin` marks a skill as never-curated. Run report before acting.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['report', 'archive', 'restore', 'pin', 'unpin'],
        description: 'report: the full curation plan. archive/restore/pin/unpin: act on one skill named by `skill`.',
      },
      skill: {
        type: 'string',
        description: 'Skill name, required for archive, restore, pin and unpin.',
      },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          report: { type: 'string' },
          empty: { type: 'boolean' },
          skill: { type: 'string' },
          detail: { type: 'string' },
          counts: {
            type: 'object',
            additionalProperties: false,
            properties: {
              skills: { type: 'integer' },
              flagged: { type: 'integer' },
              stale: { type: 'integer' },
              archive: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'report' ? value.report : `${value.detail}`,
      }],
    },
    async execute(args) {
      if (args.action === 'report') {
        const usage = await loadUsage(skillsHome)
        const { staleMemories, conflicts } = await scanMemory(memoryHome, policy)
        const lessonStats = await loadLessonStats(memoryHome)
        const plan = curationPlan({ skills: usage, staleMemories, conflicts, lessonStats }, policy)
        await markRun(home)
        return { action: 'report', report: renderReport(plan), empty: planIsEmpty(plan), counts: plan.counts }
      }

      const skill = (args.skill ?? '').trim()
      if (skill === '') throw new Error(`${args.action} requires a skill name`)
      if (args.action === 'archive') {
        const result = await archiveSkill(skillsHome, skill)
        return { action: 'archive', skill, detail: `Archived "${skill}" to ${result.archivedTo} — recoverable with curate restore.` }
      }
      if (args.action === 'restore') {
        const result = await restoreSkill(skillsHome, skill)
        return { action: 'restore', skill, detail: `Restored "${skill}" to ${result.restoredTo}.` }
      }
      const pinned = args.action === 'pin'
      await setPinned(skillsHome, skill, pinned)
      return { action: args.action, skill, detail: `"${skill}" is now ${pinned ? 'pinned — curation will leave it alone' : 'unpinned'}.` }
    },
  }))

  // ── /loop — the learning-loop dashboard, zero model tokens ────────────────
  ctx.commands.register({
    name: 'loop',
    description: 'show whether the learning loop is alive: lessons, reviews, skill outcomes, guard breaks',
    handler: async () => {
      const [stats, reviews, breaks, usage, digests] = await Promise.all([
        loadLessonStats(memoryHome),
        loadReviewAges(memoryHome),
        loadBreaks(home),
        loadUsage(skillsHome),
        readdir(join(home, 'sessions', '.digests')).catch(() => []),
      ])
      const ineffective = Object.entries(stats)
        .filter(([, s]) => s.hits >= (policy.minHitsForLessonVerdict ?? 3) && s.misses >= 1)
        .map(([topic]) => ({ topic }))
      const flagged = Object.values(usage).filter(r => r?.state !== 'archived'
        && (r.wins ?? 0) + (r.losses ?? 0) >= (policy.minUsesForOutcome ?? 4)
        && (r.losses ?? 0) / ((r.wins ?? 0) + (r.losses ?? 0)) >= (policy.failureRateAt ?? 0.4)).length
      const text = renderLoopReport({
        lessons: {
          total: Object.keys(stats).length,
          hits: Object.values(stats).reduce((sum, s) => sum + s.hits, 0),
          misses: Object.values(stats).reduce((sum, s) => sum + s.misses, 0),
          ineffective,
        },
        reviews,
        skills: { tracked: Object.keys(usage).length, flagged },
        breaks,
        digests: digests.length,
      })
      return { kind: 'success', text }
    },
  })

  // ── outcome-aware skill annotations in the prompt ──────────────────────────
  // The catalog lists skills; only outcomes say which ones actually help.
  // This lets the model prefer proven skills and brace for failing ones
  // BEFORE loading them, instead of learning it the hard way each time.
  // Refreshed on a timer, read at assembly: a prompt-section text() must be
  // synchronous, so the file read happens off the hot path.
  const outcomesCache = { at: 0, text: '' }
  const refreshOutcomes = async () => {
    const usage = await loadUsage(skillsHome)
    const rows = renderSkillOutcomes(usage, policy)
    outcomesCache.text = rows === '' ? '' : `# Skill track record (learned outcomes, min ${policy.minUsesForOutcome ?? 4} uses)\nPrefer the ✓ skills; treat ⚠ skills as suspect — their content is due for revision.\n${rows}`
    outcomesCache.at = Date.now()
  }
  void refreshOutcomes()
  const outcomesTimer = setInterval(() => { void refreshOutcomes() }, 60_000)
  outcomesTimer.unref?.()
  ctx.effect(() => () => clearInterval(outcomesTimer), 'dsh-curator: close outcomes timer')

  ctx.systemPrompt.section({
    name: 'curator:skill-outcomes',
    order: 23,
    text: () => outcomesCache.text,
  })
}

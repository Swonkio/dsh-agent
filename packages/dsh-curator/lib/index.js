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

import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { curationPlan, renderReport, planIsEmpty, DEFAULTS } from './policy.js'
import { loadUsage, noteOutcome, scanMemory, archiveSkill, restoreSkill, setPinned, markRun, loadLessonStats } from './store.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-curator'

/** Reads the tool registry; subscribes to the session firehose. */
export const inject = ['tools']

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
}

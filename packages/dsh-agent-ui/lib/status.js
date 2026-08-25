/**
 * The living state of the learning loop, gathered into one model.
 *
 * This is the dashboard nothing else surfaces: how much the agent remembers,
 * how full its prompt-budget index is, how its skills are faring by OUTCOME
 * (from the curator's telemetry), whether any memories contradict each other
 * (from the epistemics scan), and whether it has a soul and a model of you.
 *
 * It reads plain files under $DSH_HOME and never a model, so it is instant and
 * safe to show on every launch. Everything is optional: a fresh install with
 * nothing in it produces a valid, all-zero report rather than an error.
 *
 * @module dsh-agent-ui/status
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Index lines of the memory store. */
async function memoryLines(memoryHome) {
  try {
    const text = await readFile(join(memoryHome, 'MEMORY.md'), 'utf8')
    return text.split('\n').filter(l => l.trim().startsWith('- '))
  } catch {
    return []
  }
}

/** Human "3h ago" from an ISO string or mtime; null when absent. */
export function ago(iso, now = Date.now()) {
  const at = typeof iso === 'number' ? iso : Date.parse(String(iso))
  if (Number.isNaN(at)) return null
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * Gather the report. Dependency-injected readers keep it testable without a
 * filesystem; the defaults read the real $DSH_HOME.
 *
 * @param {string} home - $DSH_HOME.
 * @param {object} deps - optional `{ scanMemory, curationPlan, loadUsage, listSkills }`
 *   from dsh-curator / dsh-epistemics; when absent those sections read as empty.
 */
export async function gatherStatus(home, deps = {}) {
  const memoryHome = join(home, 'memory')
  const skillsHome = join(home, 'skills')
  const now = deps.now ?? Date.now()

  const lines = await memoryLines(memoryHome)
  const indexBytes = lines.join('\n').length
  const indexCap = deps.indexCapBytes ?? 8192

  let topicCount = 0
  try { topicCount = (await readdir(join(memoryHome, 'topics'))).filter(f => f.endsWith('.md')).length } catch { /* none */ }

  const report = {
    memory: {
      entries: lines.length,
      topics: topicCount,
      indexBytes,
      indexCap,
      fullness: indexCap > 0 ? Math.min(1, indexBytes / indexCap) : 0,
      lastWrite: await mtimeAgo(join(memoryHome, '.last-write'), now),
    },
    skills: { total: 0, active: 0, stale: 0, flagged: 0, archived: 0 },
    contradictions: [],
    review: { lastRun: await mtimeAgo(join(memoryHome, '.last-review'), now) },
    curation: { lastRun: await mtimeAgo(join(home, '.last-curation'), now) },
    userModel: { present: false, bytes: 0, lastUpdate: null },
    soul: { present: false },
  }

  // User model + soul.
  try {
    const u = await readFile(join(home, 'USER.md'), 'utf8')
    report.userModel = { present: u.trim() !== '', bytes: Buffer.byteLength(u), lastUpdate: await mtimeAgo(join(home, 'USER.md'), now) }
  } catch { /* none */ }
  try { await stat(join(home, 'SOUL.md')); report.soul.present = true } catch { /* none */ }

  // Skills by outcome — via the curator, if wired in.
  if (typeof deps.loadUsage === 'function' && typeof deps.curationPlan === 'function') {
    try {
      const usage = await deps.loadUsage(skillsHome)
      const plan = deps.curationPlan({ skills: usage }, { now })
      report.skills.total = plan.counts.skills
      report.skills.flagged = plan.counts.flagged
      report.skills.stale = plan.counts.stale
      report.skills.archived = Object.values(usage).filter(r => r.state === 'archived').length
      report.skills.active = report.skills.total - report.skills.stale - report.skills.flagged
    } catch { /* leave zeros */ }
  } else if (typeof deps.listSkills === 'function') {
    try { report.skills.total = report.skills.active = (await deps.listSkills(skillsHome)).length } catch { /* zero */ }
  }

  // Standing contradictions — via the epistemics scan, if wired in.
  if (typeof deps.scanMemory === 'function') {
    try {
      const scan = await deps.scanMemory(memoryHome, { now })
      report.contradictions = scan.conflicts ?? []
      report.staleMemories = scan.staleMemories ?? []
    } catch { /* none */ }
  }
  report.memoryLines = lines
  return report
}

async function mtimeAgo(path, now) {
  try { return ago((await stat(path)).mtimeMs, now) } catch { return null }
}

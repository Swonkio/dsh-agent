/**
 * Curation I/O: telemetry, the recoverable archive, and the memory scan.
 *
 * Telemetry lives beside the skills it describes, in `skills/.usage.json`, so
 * a backup of the skills tree carries the evidence about those skills with it.
 * Archiving MOVES a skill into `skills/.archive/`; nothing here unlinks, so
 * every retirement is undoable with a rename.
 *
 * @module dsh-curator/store
 */

import { readFile, writeFile, mkdir, rename, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatter, stalenessReport, conflictScore, CONFLICT_AT } from 'dsh-epistemics'
import { emptyRecord, recordOutcome } from './policy.js'

const USAGE_FILE = '.usage.json'
const ARCHIVE_DIR = '.archive'

/** Read the usage map; a missing or corrupt file reads as empty. */
export async function loadUsage(skillsHome) {
  try {
    const parsed = JSON.parse(await readFile(join(skillsHome, USAGE_FILE), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    // Telemetry is an optimisation, never a dependency: a curator that
    // crashed the agent because a JSON file was truncated would be a far
    // worse bug than the lost counts.
    return {}
  }
}

/** Write the usage map atomically enough for a file only this module writes. */
export async function saveUsage(skillsHome, usage) {
  await mkdir(skillsHome, { recursive: true })
  const tmp = join(skillsHome, `${USAGE_FILE}.tmp`)
  await writeFile(tmp, `${JSON.stringify(usage, null, 2)}\n`)
  await rename(tmp, join(skillsHome, USAGE_FILE))
}

/** Fold one outcome for one skill into the persisted telemetry. */
export async function noteOutcome(skillsHome, name, outcome, now = new Date().toISOString()) {
  const usage = await loadUsage(skillsHome)
  usage[name] = recordOutcome(usage[name] ?? emptyRecord(now), outcome, now)
  await saveUsage(skillsHome, usage)
  return usage[name]
}

/** Pin or unpin a skill, so curation leaves it alone. */
export async function setPinned(skillsHome, name, pinned) {
  const usage = await loadUsage(skillsHome)
  usage[name] = { ...(usage[name] ?? emptyRecord()), pinned: pinned === true }
  await saveUsage(skillsHome, usage)
  return usage[name]
}

/**
 * Retire a skill by MOVING it into the archive. Never unlinks: a wrong
 * retirement must cost a restore, not a rewrite.
 */
export async function archiveSkill(skillsHome, name) {
  const from = join(skillsHome, name)
  const to = join(skillsHome, ARCHIVE_DIR, name)
  await mkdir(join(skillsHome, ARCHIVE_DIR), { recursive: true })
  await rename(from, to)
  const usage = await loadUsage(skillsHome)
  usage[name] = { ...(usage[name] ?? emptyRecord()), state: 'archived', archivedAt: new Date().toISOString() }
  await saveUsage(skillsHome, usage)
  return { name, archivedTo: to }
}

/** Bring an archived skill back. */
export async function restoreSkill(skillsHome, name) {
  const from = join(skillsHome, ARCHIVE_DIR, name)
  const to = join(skillsHome, name)
  await rename(from, to)
  const usage = await loadUsage(skillsHome)
  usage[name] = { ...(usage[name] ?? emptyRecord()), state: 'active', restoredAt: new Date().toISOString() }
  await saveUsage(skillsHome, usage)
  return { name, restoredTo: to }
}

/** Skill directories currently live (the archive is not listed). */
export async function listSkills(skillsHome) {
  try {
    const entries = await readdir(skillsHome, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/** Index lines of the user memory store. */
async function memoryIndexLines(memoryHome) {
  try {
    const text = await readFile(join(memoryHome, 'MEMORY.md'), 'utf8')
    return text.split('\n').filter(line => line.trim().startsWith('- '))
  } catch {
    return []
  }
}

/**
 * Scan the memory store for the two things curation cares about: facts that
 * have aged past the trust their evidence buys, and pairs of facts that
 * contradict each other and were never resolved.
 *
 * The contradiction sweep is pairwise over index lines. That is quadratic, but
 * the index is byte-capped precisely because it is injected into every prompt,
 * so n is dozens — the scan costs microseconds and needs no model.
 */
export async function scanMemory(memoryHome, options = {}) {
  const lines = await memoryIndexLines(memoryHome)

  const entries = []
  const topicsDir = join(memoryHome, 'topics')
  let files = []
  try {
    files = (await readdir(topicsDir)).filter(name => name.endsWith('.md'))
  } catch { /* no topics yet */ }
  for (const file of files) {
    try {
      const { meta } = parseFrontmatter(await readFile(join(topicsDir, file), 'utf8'))
      entries.push({ topic: file.replace(/\.md$/, ''), meta })
    } catch { /* unreadable topic: skip rather than fail the scan */ }
  }

  const conflicts = []
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const result = conflictScore(lines[i], lines[j])
      if (result.score >= (options.conflictAt ?? CONFLICT_AT)) {
        conflicts.push({ a: lines[i].trim(), b: lines[j].trim(), signal: result.signal, score: result.score })
      }
    }
  }
  conflicts.sort((a, b) => b.score - a.score)

  return {
    staleMemories: stalenessReport(entries, {
      staleAfterDays: options.memoryStaleAfterDays ?? 90,
      now: options.now,
    }),
    conflicts,
  }
}

/** When the last curation pass ran; 0 when never. */
export async function lastRunMs(home) {
  try {
    return (await stat(join(home, '.last-curation'))).mtimeMs
  } catch {
    return 0
  }
}

/** Mark a curation pass as having run now. */
export async function markRun(home) {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.last-curation'), `${new Date().toISOString()}\n`)
}

/**
 * Lesson efficacy, read back: how often each "Lesson: …" memory was actually
 * surfaced in a prompt (hits, logged by dsh-memory at assembly time) and how
 * often a turn STILL failed with that lesson on record (misses). A lesson
 * with many hits and a miss is advice the agent keeps receiving and keeps
 * not following — the strongest signal its content is wrong.
 *
 * @returns {Promise<Record<string, {hits:number, misses:number, lastHitAt?:string, lastMissAt?:string}>>}
 */
export async function loadLessonStats(memoryHome) {
  const stats = {}
  const read = async file => {
    try {
      return (await readFile(join(memoryHome, file), 'utf8')).split('\n').filter(line => line !== '')
    } catch {
      return []
    }
  }
  for (const line of await read('.lesson-hits.jsonl')) {
    try {
      const { topic, at } = JSON.parse(line)
      if (typeof topic !== 'string' || topic === '') continue
      stats[topic] ??= { hits: 0, misses: 0 }
      stats[topic].hits += 1
      stats[topic].lastHitAt = at
    } catch { /* corrupt line: skip */ }
  }
  for (const line of await read('.lesson-misses.jsonl')) {
    try {
      const { topic, at } = JSON.parse(line)
      if (typeof topic !== 'string' || topic === '') continue
      stats[topic] ??= { hits: 0, misses: 0 }
      stats[topic].misses += 1
      stats[topic].lastMissAt = at
    } catch { /* corrupt line: skip */ }
  }
  return stats
}

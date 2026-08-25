#!/usr/bin/env node
/**
 * dsh-cron — the crontab-side runner for scheduled agent tasks.
 *
 * Invoked two ways:
 *   dsh-cron                 fire every job whose time has come (crontab, * * * * *)
 *   dsh-cron --job <id>      fire one job immediately (the cronjob tool's run-now)
 *
 * Missed jobs fire ONCE and advance: a Pi that was off overnight runs the
 * morning job once when it boots, not five times back to back. These jobs are
 * summaries and checks, not side-effectful transactions; if that ever changes,
 * per-job catch-up policy belongs in the jobs document.
 *
 * Concurrency is guarded two ways: the crontab line wraps this in `flock -n`,
 * and this script keeps its own PID lockfile so a `run-now` spawned from a
 * live session cannot interleave jobs.json writes with a scheduled sweep.
 *
 * The crontab environment is nearly empty — it does not source ~/.bashrc — so
 * the crontab line sources $DSH_HOME/cron/env.sh first; without it, hosted
 * providers have no API key and every job dies on its first request.
 *
 * @module dsh-cron/bin/dsh-cron
 */

import { openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { cronHome, loadJobs, saveJobs, computeNext, spawnJob, appendResult, healEnvFile, looksLikeCredentialFailure } from '../lib/jobs.js'

const log = (text) => console.log(`${new Date().toISOString()} ${text}`)

/** Hold the single-instance lock; release on any exit path. */
function acquireLock() {
  const path = join(cronHome(), 'lock.pid')
  const claim = () => {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, `${process.pid}\n`)
      process.on('exit', () => { try { unlinkSync(path) } catch { /* already gone */ } })
      return true
    } catch {
      return false
    }
  }
  if (claim()) return true
  // Exists: a live holder means genuinely busy; a dead one means a crashed
  // run left the file behind — sweep it and claim again.
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    process.kill(pid, 0)
    return false
  } catch {
    try { unlinkSync(path) } catch { /* racing another sweeper; let it win */ }
    return claim()
  }
}

/** The lock status of a live holder, for callers that can wait. */
function lockHolderPid() {
  try {
    const pid = Number(readFileSync(join(cronHome(), 'lock.pid'), 'utf8').trim())
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

/** Run one job, record the outcome, and report it. */
async function runJob(job, timeoutMs) {
  log(`firing ${job.id} "${job.name}" on ${job.provider}/${job.model}`)
  let result = await spawnJob(job, { timeoutMs })
  if (result.status !== 'ok' && looksLikeCredentialFailure(result.output)) {
    // A rotated key starves every hosted job at once; re-read the shell
    // profile and give the job one immediate retry with the healed values.
    const healed = await healEnvFile()
    log(`job ${job.id} failed on credentials; ${healed.changed ? 'env.sh healed from ~/.bashrc, retrying once' : 'env.sh already matches ~/.bashrc (not stale)'}`)
    if (healed.changed) {
      result = await spawnJob(job, { timeoutMs, envOverride: healed.exports })
    }
  }
  await appendResult(job, result)
  if (job.telegram === true) {
    // Outbox delivery: queued here, sent whenever the Telegram gateway runs —
    // cron fires whether or not anyone is chatting.
    try {
      const { enqueue } = await import('../../dsh-telegram/lib/gateway.js')
      const seconds = Math.round(result.durationMs / 1000)
      const excerpt = result.output === '' ? '(no output)' : result.output.slice(0, 1200)
      await enqueue(`Cron ${job.name}: ${result.status} in ${seconds}s\n\n${excerpt}${result.output.length > 1200 ? '…' : ''}`)
    } catch (error) {
      log(`job ${job.id} telegram delivery skipped: ${error.message}`)
    }
  }
  log(`job ${job.id} ${result.status} in ${Math.round(result.durationMs / 1000)}s${result.sessionId === undefined ? '' : ` (session ${result.sessionId})`}`)
  return result
}

async function main() {
  const jobFlag = process.argv.indexOf('--job')
  const forcedId = jobFlag === -1 ? undefined : process.argv[jobFlag + 1]

  if (forcedId !== undefined) {
    // A run-now must actually run. The minute sweep holds the lock only for
    // the length of its own jobs, so wait it out rather than exiting silent.
    const deadline = Date.now() + 120000
    while (!acquireLock()) {
      if (Date.now() > deadline) {
        log(`lock busy for over two minutes; giving up on run-now "${forcedId}"`)
        process.exit(1)
      }
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  } else if (!acquireLock()) {
    // The scheduled sweep is crontab-driven once a minute; a busy lock now
    // means the previous sweep is still draining its jobs. Skip this tick.
    process.exit(0)
  }

  const doc = await loadJobs()
  if (doc.jobs.length === 0) process.exit(0)

  if (forcedId !== undefined) {
    const job = doc.jobs.find(j => j.id === forcedId || j.name === forcedId)
    if (job === undefined) {
      log(`no job "${forcedId}"`)
      process.exit(1)
    }
    const result = await runJob(job, 600000)
    // A manual fire reports but does not consume: the schedule stays armed.
    job.lastRun = new Date().toISOString()
    job.lastStatus = result.status
    if (result.sessionId !== undefined && job.continuous === true) job.sessionId = result.sessionId
    await saveJobs(doc)
    process.exit(0)
  }

  const now = new Date()
  const timeoutMs = 600000
  let changed = false
  for (const job of [...doc.jobs]) {
    if (job.enabled === false) continue
    // A nextRun missing from an older hand-edited file is computed, not fatal.
    const due = job.nextRun ?? computeNext(job)
    if (due === undefined || new Date(due).getTime() > now.getTime()) continue

    const result = await runJob(job, timeoutMs)
    job.lastRun = now.toISOString()
    job.lastStatus = result.status
    if (result.sessionId !== undefined && job.continuous === true) job.sessionId = result.sessionId
    if (job.oneShotAt !== undefined) {
      // A one-shot's purpose is spent; the results log keeps what it did.
      doc.jobs = doc.jobs.filter(j => j.id !== job.id)
    } else {
      job.nextRun = computeNext(job, now)
    }
    changed = true
  }
  if (changed) await saveJobs(doc)
  process.exit(0)
}

main().catch(error => {
  log(`runner failed: ${error?.stack ?? error}`)
  process.exit(1)
})

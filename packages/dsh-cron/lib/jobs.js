/**
 * The durable cron store and the job spawner, shared by the `cronjob` tool
 * (in-session) and the `dsh-cron` runner (crontab).
 *
 * State is one JSON document under `$DSH_HOME/cron/jobs.json`, written
 * atomically (tmp + rename): the crontab runner and an interactive session
 * can both reach for it, and a torn write would take every schedule with it.
 *
 * A job runs by spawning `dsh --profile cron -p <prompt> --provider … --model
 * …` — the tui surface's one-shot print mode, which persists a normal
 * resumable session. The dsh CLI is resolved through the profile flat
 * node_modules (`@deepseek-ai/dsh` is the app itself), so nothing here
 * hardcodes a checkout path.
 *
 * @module dsh-cron/lib/jobs
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parse, nextRun } from './cron-expr.js'

/** Everything a scheduled run may print; results.md carries the useful tail. */
const MAX_OUTPUT_BYTES = 4096

/** The cron state directory. */
export function cronHome() {
  return dshHomePath('cron')
}

/** Path of the jobs document. */
export function jobsPath() {
  return join(cronHome(), 'jobs.json')
}

/** Path of the human-readable run log. */
export function resultsPath() {
  return join(cronHome(), 'results.md')
}

/** Load the jobs document; missing file means no jobs, not an error. */
export async function loadJobs() {
  try {
    const parsed = JSON.parse(await readFile(jobsPath(), 'utf8'))
    if (Array.isArray(parsed?.jobs)) return parsed
  } catch {
    // Absent or unreadable: treat as empty rather than fatal, so one bad
    // write can never stop every schedule from firing.
  }
  return { version: 1, jobs: [] }
}

/** Write the jobs document atomically: readers never see a torn file. */
export async function saveJobs(doc) {
  await mkdir(cronHome(), { recursive: true })
  const tmp = join(cronHome(), `.jobs.${process.pid}.tmp`)
  await writeFile(tmp, `${JSON.stringify(doc, undefined, 2)}\n`)
  await rename(tmp, jobsPath())
}

/** A short opaque job id. */
export function newId() {
  return `j-${randomBytes(4).toString('hex')}`
}

/**
 * The next fire time of a job as an ISO string, or undefined if it has no
 * future occurrence. One-shots past their moment return their stored time —
 * whether a stale one-shot still fires is the runner's catch-up policy, not
 * the calendar's.
 */
export function computeNext(job, from = new Date()) {
  if (job.schedule?.cron !== undefined) {
    const next = nextRun(parse(job.schedule.cron), from)
    return next === undefined ? undefined : next.toISOString()
  }
  if (job.oneShotAt !== undefined) {
    const at = new Date(job.oneShotAt)
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
  }
  return undefined
}

/** Resolve a package inside the profile flat node_modules (the harness's own self-healed fallback). */
function flatResolve(packageName) {
  const anchor = join(dshHomePath(), 'profiles', 'node_modules', 'index.js')
  return createRequire(anchor).resolve(packageName)
}

/** Resolve the dsh CLI entry through the profile flat node_modules. */
export function dshBinPath() {
  const app = dirname(flatResolve('@deepseek-ai/dsh/package.json'))
  return join(app, 'lib', 'bin.js')
}

/** The harness's own cwd→project-dir encoder, loaded from the installed app. */
let formatModule

/**
 * The sessions-root subdirectory that holds sessions spawned from a given
 * working directory, derived with the harness's own encoder. Scoped on
 * purpose: a newest-session scan over the WHOLE root would happily attribute
 * one surface's session to another that wrote in the same ten seconds.
 */
async function projectDirFor(cwd) {
  if (formatModule === undefined) {
    const pkg = dirname(flatResolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json'))
    // The package exports map does not expose the format module; import the
    // built file directly by path.
    formatModule = await import(pathToFileURL(join(pkg, 'lib', 'types', 'format.js')).href)
  }
  return formatModule.projectDir(dshHomePath('sessions'), cwd)
}

/**
 * The newest session written after `sinceMs` inside the directory `cwd`'s
 * project owns. Print mode does not announce its session id, and callers
 * only need it for "resume this" pointers — a newest-file scan over one
 * small directory is cheaper than inventing a channel for it.
 * @returns {Promise<string | undefined>} the session directory name.
 */
export async function newestSessionFor(cwd, sinceMs) {
  let project
  try {
    project = await projectDirFor(cwd)
  } catch {
    return undefined
  }
  let best
  try {
    for (const session of (await readdir(project, { withFileTypes: true })).filter(e => e.isDirectory())) {
      // The log is `session.jsonl`, physically `.zstd`-suffixed when the
      // persistence layer compresses; either name marks the session dir.
      for (const name of ['session.jsonl', 'session.jsonl.zstd']) {
        try {
          const mtime = (await stat(join(project, session.name, name))).mtimeMs
          if (mtime > sinceMs && (best === undefined || mtime > best.mtime)) best = { mtime, id: session.name }
        } catch {
          // Not this file shape; try the other.
        }
      }
    }
  } catch {
    // No sessions for this working directory yet.
  }
  return best?.id
}

/**
 * Exports from `$DSH_HOME/cron/env.sh`, as a plain object. The crontab
 * sources that file before the runner, but a `--job` run-now spawned from a
 * session that happens to lack a key would otherwise fail its first request;
 * the file is the one place both paths can trust. Values already in the real
 * environment win.
 */
/** Exports from `$DSH_HOME/cron/env.sh`, as a plain object (see healEnvFile). */
export async function envFileExports() {
  const env = {}
  try {
    const text = await readFile(join(cronHome(), 'env.sh'), 'utf8')
    for (const match of text.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/gm)) {
      env[match[1]] = match[2]
    }
  } catch {
    // No env.sh (or unreadable): the caller's environment is all we have.
  }
  return env
}

/** Match one `export KEY=value` honoring double-quoted, single-quoted, and bare values. */
const SHELL_EXPORT = /^export ([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s#]+))/gm

/**
 * Re-extract `*_API_KEY` exports from ~/.bashrc into env.sh. Rotating a key
 * in the shell profile silently starves every scheduled job until someone
 * notices; the runner calls this on a credential failure so the machine
 * heals itself instead.
 * @returns {Promise<{ changed: boolean, exports: Record<string, string> }>}
 *   whether env.sh changed, and the full merged export set (for the retry).
 */
export async function healEnvFile() {
  let bash = ''
  try {
    bash = await readFile(join(process.env.HOME ?? '/home', '.bashrc'), 'utf8')
  } catch {
    return { changed: false, exports: {} }
  }
  const found = {}
  for (const match of bash.matchAll(SHELL_EXPORT)) {
    if (/_API_KEY$/.test(match[1])) found[match[1]] = match[2] ?? match[3] ?? match[4]
  }
  if (Object.keys(found).length === 0) return { changed: false, exports: {} }
  const path = join(cronHome(), 'env.sh')
  let current = ''
  try {
    current = await readFile(path, 'utf8')
  } catch {
    // First heal creates the file.
  }
  const merged = {}
  for (const match of current.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/gm)) merged[match[1]] = match[2]
  let changed = false
  for (const [key, value] of Object.entries(found)) {
    if (merged[key] !== value) {
      merged[key] = value
      changed = true
    }
  }
  if (changed) {
    const rendered = `${Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `export ${k}="${v}"`).join('\n')}\n`
    await writeFile(path, rendered, { mode: 0o600 })
  }
  return { changed, exports: merged }
}

/** Whether a run's output reads like an authentication failure worth healing. */
export function looksLikeCredentialFailure(output) {
  return /MISSING_CREDENTIAL|no credential|invalid[_ ]api[_ ]key|incorrect api key|\b401\b|unauthor/i.test(output)
}

/**
 * Run one job to completion: spawn the one-shot agent turn, cap its wall
 * time, and collect what it printed. Jobs run sequentially by design — this
 * box has one local model slot and one thermal budget.
 * @param {object} job - a jobs.json job entry.
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<{ status: 'ok'|'error'|'timeout', exitCode: number|null, durationMs: number, output: string, sessionId: string|undefined }>}
 */
export async function spawnJob(job, { timeoutMs = 600000, envOverride } = {}) {
  const fileEnv = await envFileExports()
  return new Promise(resolveJob => {
    const startedAt = Date.now()
    const sinceMs = startedAt - 1500
    const finish = async (status, exitCode, output) => {
      clearTimeout(timer)
      // The session log flushes as the child exits; give it a beat before
      // scanning for it, or the run's own "resume this" pointer misses.
      await new Promise(resolve => setTimeout(resolve, 2000))
      resolveJob({
        status,
        exitCode,
        durationMs: Date.now() - startedAt,
        output,
        // A continuous job resumes this id next fire; everyone else ignores it.
        sessionId: await newestSessionFor(cronHome(), sinceMs),
      })
    }

    // A continuous job carries its history: `--resume` its prior session so a
    // recurring brief remembers what it produced last time.
    const resume = typeof job.sessionId === 'string' && job.sessionId !== ''
      ? ['--resume', job.sessionId]
      : []
    const child = spawn(process.execPath, [
      dshBinPath(), '--profile', 'cron', '-p', job.prompt,
      '--provider', job.provider, '--model', job.model,
      ...resume,
    ], { cwd: cronHome(), env: { ...fileEnv, ...process.env, ...envOverride }, stdio: ['ignore', 'pipe', 'pipe'] })

    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { if (out.length < MAX_OUTPUT_BYTES * 2) out += chunk.toString() })
    child.stderr.on('data', chunk => { if (err.length < MAX_OUTPUT_BYTES * 2) err += chunk.toString() })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      // A model stuck mid-turn must still die: escalate after a grace period.
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)

    child.on('error', error => { void finish('error', null, `spawn failed: ${error.message}`) })
    child.on('close', (code, signal) => {
      const output = [out.trim(), err.trim() === '' ? '' : `[stderr]\n${err.trim()}`]
        .filter(part => part !== '').join('\n').slice(0, MAX_OUTPUT_BYTES)
      void finish(signal === null ? (code === 0 ? 'ok' : 'error') : 'timeout', code, output)
    })
  })
}

/**
 * Append one run record to results.md — the log a human (or the agent, via
 * /cron) reads to see what scheduled work actually did.
 */
export async function appendResult(job, result) {
  const when = new Date().toISOString()
  const seconds = Math.round(result.durationMs / 1000)
  const resume = result.sessionId === undefined ? '' : `\nsession: ${result.sessionId} — resume with: dsh --profile cron -r ${result.sessionId}`
  await mkdir(cronHome(), { recursive: true })
  await appendFile(resultsPath(), `## ${when} — ${job.name} (${result.status}, ${seconds}s)\nprompt: ${job.prompt}\n\n${result.output === '' ? '(no output)' : result.output}${resume}\n\n`)
}

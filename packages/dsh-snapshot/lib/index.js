/**
 * dsh-snapshot — durability for the learned state.
 *
 * Everything the self-improvement loop produces — memory, skills, telemetry,
 * profiles — lives in `$DSH_HOME` as plain files. Plain files die with the
 * disk. This plugin puts the home under git and keeps it there:
 *
 *   - on boot, `git init` + a refuse-first .gitignore (secrets, session
 *     bulk, caches never commit — see lib/ignore.js),
 *   - an idle auto-commit: when the user has been quiet, commit the memory
 *     and skills that changed, at most every `minIntervalMs`,
 *   - `/snapshot` — commit now / show status, zero model tokens,
 *   - `snapshotNow(home)` and `bundleTo(home, dir)` exported for the cron
 *     night pass and external scripts.
 *
 * Never blocks a turn: every git operation is fire-and-forget from the
 * session's point of view, and a home that is not a git repo (or a git
 * binary that is missing) degrades to "no snapshot" without a word.
 *
 * @module dsh-snapshot
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { renderGitignore, snapshotArgs, shouldSnapshot, renderStatus } from './ignore.js'

const run = promisify(execFile)

/** Stable Cordis plugin name. */
export const name = 'dsh-snapshot'

/** Registers one human command; listens to the session firehose for activity. */
export const inject = ['commands']

/** Policy defaults. */
export const DEFAULTS = {
  enabled: true,
  /** Minimum spacing between idle auto-commits. */
  minIntervalMs: 30 * 60 * 1000,
  /** User-quiet time before an idle commit is considered. */
  idleAfterMs: 5 * 60 * 1000,
  /** Where nightly bundles go; set falsy to disable bundling. */
  bundleDir: '',
  /** Offsite git remote for the learned state (a PRIVATE repo). Opt-in: it
   *  uploads the memory content to wherever it points, by design. */
  pushRemote: '',
}

/** Run git in the home; resolve undefined on any failure (never throw). */
async function git(home, args) {
  try {
    // A machine without git user.name/email configured must still snapshot:
    // scope an identity to this invocation only, never touching global config.
    const identity = ['-c', 'user.name=dsh-snapshot', '-c', 'user.email=dsh-snapshot@localhost']
    const { stdout } = await run('git', ['-C', home, ...identity, ...args], { timeout: 30000 })
    return stdout
  } catch {
    return undefined
  }
}

/**
 * One snapshot pass: add the tracked scope, commit if dirty.
 * Safe to call from anywhere (cron, tests); exports make it a tiny API.
 * @param {string} home - the DSH_HOME to snapshot (defaults to the live one).
 * @returns {Promise<{committed: boolean, lastCommitAt?: string, dirty: boolean, home: string}>}
 */
export async function snapshotNow(home = dshHomePath()) {
  // Ensure it is a repo with our ignore rules before touching anything.
  const ignorePath = join(home, '.gitignore')
  let ignore = ''
  try {
    ignore = await readFile(ignorePath, 'utf8')
  } catch { /* first run writes it below */ }
  if (!ignore.includes('dsh-snapshot')) {
    await writeFile(ignorePath, renderGitignore())
  }
  if (await git(home, ['rev-parse', '--git-dir']) === undefined) {
    await git(home, ['init', '--quiet'])
  }
  const tracked = (await Promise.all(
    ['.gitignore', 'memory', 'skills', 'topics', 'SOUL.md', 'USER.md', 'profiles', 'settings.yaml', 'cron/jobs.json']
      .map(async path => (await access(join(home, path)).then(() => path, () => null))),
  )).filter(path => path !== null)
  // Compare commit HASHES, not timestamps: two snapshots inside one second
  // (common in tests and scripted runs) share an ISO timestamp, and a hash
  // is unique per commit by construction. The ISO timestamp rides along for
  // age reporting.
  const head = format => git(home, ['log', '-1', `--format=${format}`])
  const before = await head('%H')
  for (const args of snapshotArgs(tracked)) await git(home, args)
  const after = await head('%H')
  const committedAt = (await head('%cI'))?.trim() || undefined
  const status = await git(home, ['status', '--porcelain', '--', ...tracked])
  return {
    committed: before !== after,
    lastCommitAt: committedAt,
    dirty: (status ?? '').trim() !== '',
    home,
  }
}

/**
 * Write a single-file restorable bundle of the home's history.
 * @returns {Promise<string|undefined>} the bundle path, or undefined on failure.
 */
export async function bundleTo(home = dshHomePath(), dir) {
  if (dir === undefined || dir === '') return undefined
  try {
    await mkdir(dir, { recursive: true })
    const out = join(dir, `dsh-home-${new Date().toISOString().slice(0, 10)}.bundle`)
    const done = await git(home, ['bundle', 'create', out, 'HEAD'])
    return done === undefined ? undefined : out
  } catch {
    return undefined
  }
}

/**
 * Push the snapshot repo to an offsite remote — the step that makes the
 * learned state survive the DISK, not just mistakes. Opt-in via `pushRemote`.
 *
 * Auth, in order: whatever credential helper the machine already has (SSH
 * remotes, gh-configured helpers), then `gh auth git-credential` inline.
 * A push that cannot authenticate resolves false; the local commit already
 * happened and the next successful push carries it.
 *
 * @returns {Promise<boolean>} whether the remote accepted the push.
 */
export async function pushSnapshot(home = dshHomePath(), remoteUrl) {
  if (remoteUrl === undefined || remoteUrl === '') return false
  const remote = 'origin'
  const current = (await git(home, ['remote', 'get-url', remote]))?.trim()
  if (current !== remoteUrl) {
    if (current !== undefined) await git(home, ['remote', 'remove', remote])
    if (await git(home, ['remote', 'add', remote, remoteUrl]) === undefined) return false
  }
  const branch = (await git(home, ['branch', '--show-current']))?.trim() || 'master'
  const withGh = ['-c', 'credential.helper=!gh auth git-credential']
  const pushed = await git(home, ['push', '-u', remote, branch])
    ?? await git(home, [...withGh, 'push', '-u', remote, branch])
  return pushed !== undefined
}

/**
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [config] - `{ enabled?, minIntervalMs?, idleAfterMs?, bundleDir?, pushRemote? }`.
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (!cfg.enabled) return

  let lastUserActivityAt = Date.now()
  let lastCommitMs = 0
  let bootstrapped = false

  const ensureRepo = async () => {
    if (bootstrapped) return
    bootstrapped = true
    // A first snapshot on boot means /snapshot always has an answer, and a
    // home that just got created is under protection immediately.
    const result = await snapshotNow()
    if (result.committed) lastCommitMs = Date.now()
    else if (result.lastCommitAt !== undefined) lastCommitMs = Date.parse(result.lastCommitAt)
  }
  void ensureRepo()

  ctx.on('session/event', (_session, event) => {
    if (event?.type === 'user/message') lastUserActivityAt = Date.now()
  })

  // The idle commit: cheap, unref'd, and never more often than minIntervalMs.
  const timer = setInterval(() => {
    if (Date.now() - lastUserActivityAt < cfg.idleAfterMs) return
    if (!shouldSnapshot({ lastCommitMs })) return
    void (async () => {
      const result = await snapshotNow()
      if (result.committed) lastCommitMs = Date.now()
      if (result.committed && cfg.bundleDir) await bundleTo(undefined, cfg.bundleDir)
      // Offsite only when something new was committed: an empty push is a
      // round trip for nothing, and a failed one retries on the next commit.
      if (result.committed && cfg.pushRemote) await pushSnapshot(undefined, cfg.pushRemote)
    })()
  }, 60_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'dsh-snapshot: close idle timer')

  ctx.commands.register({
    name: 'snapshot',
    description: 'commit the learned state (memory/skills/profiles) to the home git repo and show its status',
    handler: async () => {
      const result = await snapshotNow()
      if (result.committed) lastCommitMs = Date.now()
      const pushed = result.committed && cfg.pushRemote !== ''
        ? await pushSnapshot(undefined, cfg.pushRemote)
        : undefined
      return { kind: 'success', text: renderStatus(result) + (pushed === undefined ? '' : pushed ? '\n\nOffsite: pushed.' : '\n\nOffsite: push failed — the local commit stands; the next snapshot retries.') }
    },
  })
}

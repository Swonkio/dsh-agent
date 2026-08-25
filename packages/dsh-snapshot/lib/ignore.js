/**
 * dsh-snapshot — pure helpers for the git-backed state snapshot.
 *
 * The learning loop's whole output — memory, skills, telemetry, profiles —
 * lives in plain files under `$DSH_HOME`, which means one disk failure costs
 * the agent everything it ever learned. This module holds the decisions;
 * the I/O wrapper lives in index.js. Kept dependency- and harness-free so
 * every rule about WHAT is snapshotted is unit-testable.
 *
 * The single most important rule is the ignore list: a snapshot that ever
 * commits a secret is worse than no snapshot, so the list is refuse-first
 * and everything session-log-shaped is excluded too (large, churny, and
 * already compressed with zstd).
 *
 * @module dsh-snapshot/ignore
 */

/**
 * Paths (gitignore syntax) that must NEVER be committed. Secrets by name,
 * session/transcript bulk, derived caches, and lock/marker files whose only
 * content is timing that would produce a commit on every tick.
 */
export const IGNORE = [
  '# written by dsh-snapshot — secrets and bulk are never snapshotted',
  '# credentials: env-file exports and the harness credential store',
  'cron/env.sh',
  '.credentials.yaml',
  'telegram/config.json',
  '# session logs and attachments: large, churny, already compressed',
  'sessions/',
  'attachments/',
  'agent-history/',
  'reviews/',
  '# derived caches and locks',
  '*.sqlite',
  '*.sqlite-*',
  '.last-*',
  '.loop-breaks.jsonl',
  '# profile plugin links: machine-specific symlinks, rebuilt by install.sh',
  'profiles/node_modules/',
]

/** Render the ignore list as the .gitignore body. */
export function renderGitignore() {
  return `${IGNORE.join('\n')}\n`
}

/**
 * Does a path fall under snapshot protection at all? Only known-valuable
 * subtrees are committed; an unknown future directory stays untracked
 * rather than being committed by a blanket `git add -A` of the home.
 */
export const TRACKED = ['memory/', 'skills/', 'topics/', 'SOUL.md', 'USER.md', 'profiles/', 'settings.yaml', 'cron/jobs.json', '.gitignore']

/**
 * The git arguments for one snapshot pass: add the tracked scope, then
 * commit only if something actually changed. `git add` on a missing path
 * errors, so the caller filters TRACKED by existence first.
 *
 * @param {string[]} paths - existing tracked paths, relative to the home.
 * @returns {string[][]} argv arrays, in order.
 */
export function snapshotArgs(paths, now = new Date()) {
  const message = `snapshot ${now.toISOString()}`
  return [
    ['add', '--', ...paths],
    ['commit', '-m', message, '--quiet'],
  ]
}

/**
 * Should an idle-timer snapshot run now?
 *
 * @param {{lastCommitMs?: number, now?: number}} state
 * @param {{minIntervalMs?: number}} [options] - default 30 min between commits.
 * @returns {boolean}
 */
export function shouldSnapshot({ lastCommitMs = 0, now = Date.now() }, { minIntervalMs = 30 * 60 * 1000 } = {}) {
  if (lastCommitMs === 0) return true
  return now - lastCommitMs >= minIntervalMs
}

/**
 * The one-line status the /snapshot command shows. Pure.
 *
 * @param {{committed: boolean, lastCommitAt?: string, dirty: boolean, home: string}} result
 * @returns {string}
 */
export function renderStatus({ committed, lastCommitAt, dirty, home }) {
  const when = lastCommitAt === undefined ? 'never' : `${Math.round((Date.now() - Date.parse(lastCommitAt)) / 60000)} min ago`
  const state = committed ? 'snapshotted now' : dirty ? 'nothing new to commit' : 'clean'
  return `## State snapshot — ${home}\n\nLast commit: ${when} (${state}). Tracked: memory, skills, SOUL/USER, profiles, settings, cron jobs. Excluded by design: secrets, session logs, caches. Restorable with \`git clone\` or the bundle written by the nightly pass.`
}

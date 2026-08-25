#!/usr/bin/env node
/**
 * Regression check for the review sandbox.
 *
 * The background review runs unattended on untrusted text, so the set of
 * capabilities it can reach is a security boundary, not a preference. This
 * composes the review profile for real and fails if anything that can execute,
 * write, fetch or delegate has come back — the kind of change that is easy to
 * make by accident when adding a plugin to a shared bundle and impossible to
 * notice by reading a diff.
 *
 * Usage: DSH_HOME=<home> node tools/test-review-sandbox.mjs [--bin <dsh>]
 * Skips (exit 0) when no dsh binary is reachable, so it is safe in CI.
 *
 * @module dsh-agent/tools/test-review-sandbox
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const binIndex = process.argv.indexOf('--bin')
const bin = binIndex === -1 ? (process.env.DSH_BIN ?? 'dsh') : process.argv[binIndex + 1]

/** Anything matching these must never be enabled in the review profile. */
const FORBIDDEN = [
  /^tool-bash$/, /^bash-sandbox$/, /^tool-pwsh$/, /^pwsh-sandbox$/, /^shell-env$/,
  /^code-runtime$/, /^subprocess$/,
  /^tool-str-replace-editor$/, /^tool-fs$/, /^tool-fs-search$/,
  /^tool-web$/, /^web$/, /^web-fetch-/, /^web-search-/,
  /^tool-subagent/, /^subagent/, /^tool-jobs$/, /^jobs$/,
  /^agent-tools$/, /^tool-ralph$/, /^tool-workflow$/, /^workflow-worker-thread$/,
  /^tool-ask-user$/, /^user-questions$/,
]

/** The review cannot do its job without these. */
const REQUIRED = ['tool-remember', 'dsh-user-model', 'tool-session-query']

let stdout
try {
  ;({ stdout } = await run(bin, ['--profile', 'review', '--dump-config'], { maxBuffer: 32 * 1024 * 1024 }))
} catch (error) {
  console.log(`skipped — could not compose the review profile (${error.message.split('\n')[0]})`)
  process.exit(0)
}

const enabled = []
for (const block of stdout.split(/\n(?=- id: )/)) {
  const match = /^- id: ([A-Za-z0-9._-]+)/.exec(block)
  if (match === null) continue
  if (/^\s+disabled:\s*true/m.test(block)) continue
  enabled.push(match[1])
}

const breaches = enabled.filter(id => FORBIDDEN.some(pattern => pattern.test(id)))
const missing = REQUIRED.filter(id => !enabled.includes(id))

if (breaches.length === 0 && missing.length === 0) {
  console.log(`${enabled.length} plugins enabled, 0 capability breaches, all ${REQUIRED.length} learning tools present — sandbox intact`)
  process.exit(0)
}
if (breaches.length > 0) {
  console.log(`SANDBOX BREACH — the unattended review can reach: ${breaches.join(', ')}`)
  console.log('  Disable them in dsh-home/profiles/review/cordis.patch.yml before shipping.')
}
if (missing.length > 0) console.log(`review profile is missing its learning tools: ${missing.join(', ')}`)
process.exit(1)

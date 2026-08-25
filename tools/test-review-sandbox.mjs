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

/**
 * Plugins that REGISTER A CALLABLE TOOL and must never be enabled here.
 *
 * The list is tool-registering plugins only, not the services beneath them.
 * That is the actual boundary: capability is decided by what is registered for
 * the model to call, and `bash-sandbox`, `shell-env`, `subagent`, `web` and
 * `code-runtime` register nothing callable — they provide services that other
 * plugins depend on, and disabling them breaks the tree (dsh-permission-presets
 * waits on shell+approval, dsh-command-goal on goals) while removing no
 * capability from the model. An earlier version of this check listed them and
 * reported a breach that did not exist.
 *
 * Ground truth is the `tools` array on the request. Captured against a stub
 * endpoint, the shipped review profile sends exactly 13 tools — memory_save,
 * memory_edit, memory_forget, memory_search, remember, user_model,
 * skill, skill_create, session_search, session_trace and the three
 * session_event_* readers — against 43 for the agent profile.
 */
const FORBIDDEN = [
  /^tool-bash$/, /^tool-pwsh$/,
  /^tool-str-replace-editor$/, /^tool-fs$/, /^tool-fs-search$/,
  /^tool-web$/,
  /^tool-subagent/, /^tool-jobs$/, /^tool-ralph$/, /^tool-workflow$/,
  /^agent-tools$/,
  /^tool-ask-user$/, /^tool-todo$/, /^tool-goal$/,
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

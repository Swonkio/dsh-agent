#!/usr/bin/env node
/**
 * The dsh-agent launcher.
 *
 * On a bare interactive session it plays the awakening and prints the HUD,
 * then hands off to the harness CLI for the actual conversation. On anything
 * scripted — a `-p` one-shot, a pipe, `--json`, `--dump-config`, `--help` — it
 * shows NOTHING and execs straight through, so automation and the eval never
 * see a byte of chrome.
 *
 * The UI is best-effort: if any of it throws, the launcher still execs the
 * agent. A pretty boot must never be the reason the agent will not start.
 *
 * @module dsh-agent-ui/launcher
 */

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { wantsChrome } from '../lib/launch.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh-agent')
const harness = process.env.DSH_HARNESS_BIN ?? join(homedir(), 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js')

// Chrome is for humans at a fresh prompt only; the predicate is tested in lib.
const interactive = wantsChrome(args, { stdoutTTY: process.stdout.isTTY, stdinTTY: process.stdin.isTTY })

async function showChrome() {
  try {
    const [{ colorDepth }, { gatherStatus }, { renderHud }, { playBoot }] = await Promise.all([
      import('../lib/theme.js'), import('../lib/status.js'), import('../lib/hud.js'), import('../lib/boot.js'),
    ])
    const depth = colorDepth()
    let deps = {}
    try {
      const [cur, pol] = await Promise.all([import('dsh-curator/lib/store.js'), import('dsh-curator/lib/policy.js')])
      deps = { loadUsage: cur.loadUsage, scanMemory: cur.scanMemory, curationPlan: pol.curationPlan }
    } catch { /* curator optional */ }
    const report = await gatherStatus(home, deps)
    if (process.env.DSH_AGENT_NO_BOOT !== '1') await playBoot(report.memoryLines, { depth })
    process.stdout.write(renderHud(report, { depth, width: process.stdout.columns ?? 80 }) + '\n')
  } catch { /* never block the agent on chrome */ }
}

function exec() {
  const child = spawn(process.execPath, [harness, '--profile', 'agent', ...args], {
    stdio: 'inherit',
    env: { ...process.env, DSH_HOME: home },
  })
  child.on('exit', code => process.exit(code ?? 0))
  child.on('error', err => { process.stderr.write(`dsh-agent: cannot start harness at ${harness}: ${err.message}\n`); process.exit(127) })
}

if (interactive) await showChrome()
exec()

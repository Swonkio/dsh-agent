#!/usr/bin/env node
/**
 * dsh-agent-ui — the front-end for dsh-agent.
 *
 *   dsh-agent-ui status   the living learning-loop HUD (default)
 *   dsh-agent-ui wake     play the awakening boot, then the HUD
 *   dsh-agent-ui theme    a palette swatch for checking a terminal
 *   dsh-agent-ui banner   the wordmark line only (fast, for prompts/motd)
 *
 * $DSH_HOME selects which agent's mind to read (default ~/.dsh-agent). The
 * curator/epistemics packages are loaded if resolvable, so skills-by-outcome
 * and contradiction detection light up in a real install and degrade to
 * clean zeros where they are not installed.
 *
 * @module dsh-agent-ui/bin
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { colorDepth } from '../lib/theme.js'
import { gatherStatus } from '../lib/status.js'
import { renderHud } from '../lib/hud.js'
import { renderThemeMap } from '../lib/themecheck.js'
import { wordmark } from '../lib/render.js'
import { playBoot } from '../lib/boot.js'

const cmd = process.argv[2] ?? 'status'
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh-agent')
const depth = colorDepth()
const width = process.stdout.columns ?? 80

/** Load the curator/epistemics helpers if this install has them. */
async function loadDeps() {
  const deps = {}
  try {
    const cur = await import('dsh-curator/lib/store.js')
    const pol = await import('dsh-curator/lib/policy.js')
    deps.loadUsage = cur.loadUsage
    deps.scanMemory = cur.scanMemory
    deps.curationPlan = pol.curationPlan
  } catch { /* curator not installed: skills/contradictions read empty */ }
  return deps
}

if (cmd === 'theme') {
  process.stdout.write(renderThemeMap(depth) + '\n')
} else if (cmd === 'banner') {
  process.stdout.write(wordmark(depth) + '\n')
} else if (cmd === 'wake' || cmd === 'status') {
  const deps = await loadDeps()
  const report = await gatherStatus(home, deps)
  if (cmd === 'wake') await playBoot(report.memoryLines, { depth })
  process.stdout.write(renderHud(report, { depth, width }))
} else {
  process.stderr.write(`dsh-agent-ui: unknown command ${JSON.stringify(cmd)}\n`)
  process.stderr.write('usage: dsh-agent-ui [status|wake|theme|banner]\n')
  process.exit(2)
}

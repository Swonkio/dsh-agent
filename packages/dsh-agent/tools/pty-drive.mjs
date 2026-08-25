/**
 * A pty driver for exercising the terminal surface without a human: it boots
 * `dsh-agent` on a real pty, waits for the prompts it expects, sends
 * keystrokes, and prints the transcript it captured.
 *
 * Usage: node tools/pty-drive.mjs <script.json> [cwd]
 * The script is a list of steps: {"expect": "<regex>", "send": "text", "delay": ms}
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/home/agent/dsh-agent/node_modules/')
const pty = require('node-pty')

const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const cwd = process.argv[3] ?? process.cwd()

const child = pty.spawn(process.execPath, [
  '/home/agent/deepseek-harness/apps/cli/lib/bin.js', '--profile', 'agent',
  ...process.argv.slice(4),
], { name: 'xterm-256color', cols: 100, rows: 40, cwd, env: { ...process.env, TERM: 'xterm-256color' } })

let buffer = ''
child.onData(data => {
  buffer += data
  process.stdout.write(data)
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Wait until `pattern` appears in output after the current mark, or time out. */
async function waitFor(pattern, timeoutMs) {
  const regex = new RegExp(pattern)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (regex.test(buffer)) {
      process.stderr.write(`[drive] matched ${pattern}\n`)
      return true
    }
    if (Date.now() > deadline) {
      process.stdout.write(`\n[pty-drive] TIMEOUT waiting for ${pattern}\n`)
      return false
    }
    await sleep(150)
  }
}

let exited = false
child.onExit(({ exitCode }) => {
  exited = true
  process.stdout.write(`\n[pty-drive] exited with ${exitCode}\n`)
})

for (const step of steps) {
  if (step.expect !== undefined) {
    const ok = await waitFor(step.expect, step.timeout ?? 60000)
    if (!ok) break
  }
  if (step.delay !== undefined) await sleep(step.delay)
  if (step.send !== undefined) {
    process.stderr.write(`[drive] send ${JSON.stringify(step.send)}\n`)
    buffer = ''
    child.write(step.send)
  }
  if (exited) break
}

await sleep(step_tail())
if (!exited) child.kill()
process.exit(0)

function step_tail() { return 1500 }

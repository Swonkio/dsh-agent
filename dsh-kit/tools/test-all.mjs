#!/usr/bin/env node
/**
 * Run every package's unit suite from a bare checkout.
 *
 * Two things get in the way of `git clone && node tools/test.mjs`, and this
 * distinguishes them so a fresh clone produces a report rather than a stack
 * trace:
 *
 *   - SIBLING packages in this repo (dsh-curator needs dsh-epistemics). Node
 *     resolves those by package name, so they need a link; this creates it,
 *     because a dependency that lives in the same repo should not require a
 *     manual step.
 *   - The HARNESS packages (@deepseek-ai/*) that plugins declare as peers.
 *     Those only exist in a real install, so suites needing them are reported
 *     as SKIPPED rather than failed — a missing harness is a setup state, not
 *     a broken test, and conflating the two hides real failures.
 *
 * Usage: node dsh-kit/tools/test-all.mjs
 * @module dsh-kit/tools/test-all
 */

import { readdir, mkdir, symlink, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'packages')

/** Link every in-repo package into every other package's node_modules. */
async function linkSiblings(names) {
  for (const owner of names) {
    const modules = join(packagesDir, owner, 'node_modules')
    for (const target of names) {
      if (target === owner) continue
      const link = join(modules, target)
      try {
        await access(link)
        continue
      } catch { /* not linked yet */ }
      try {
        await mkdir(modules, { recursive: true })
        await symlink(join(packagesDir, target), link, 'dir')
      } catch { /* a pre-existing entry is fine */ }
    }
  }
}

const names = (await readdir(packagesDir, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
await linkSiblings(names)

let total = 0
const failed = []
const skipped = []

for (const name of names.sort()) {
  let suites = []
  try {
    suites = (await readdir(join(packagesDir, name, 'tools')))
      .filter(file => file.startsWith('test') && file.endsWith('.mjs'))
      .sort()
  } catch { continue }

  for (const suite of suites) {
    const label = `${name}/${suite}`
    try {
      const { stdout } = await run(process.execPath, [join('tools', suite)], {
        cwd: join(packagesDir, name),
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const line = stdout.trim().split('\n').pop() ?? ''
      total += Number(/^(\d+)/.exec(line)?.[1] ?? 0)
      console.log(`  PASS  ${label.padEnd(40)} ${line}`)
    } catch (error) {
      const text = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`
      const missing = /Cannot find package '(@deepseek-ai\/[^']+)'/.exec(text)
      if (missing !== null) {
        skipped.push(`${label} (needs ${missing[1]} — install the harness)`)
        console.log(`  SKIP  ${label.padEnd(40)} needs ${missing[1]}`)
        continue
      }
      failed.push(label)
      const line = (error.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? error.message.split('\n')[0]
      console.log(`  FAIL  ${label.padEnd(40)} ${line}`)
    }
  }
}

console.log(`\n${total} assertions passed · ${failed.length} suite(s) failed · ${skipped.length} skipped (harness not installed)`)
if (skipped.length > 0) console.log('Skipped suites run in a real install; see RESTORE.md.')
process.exit(failed.length === 0 ? 0 : 1)

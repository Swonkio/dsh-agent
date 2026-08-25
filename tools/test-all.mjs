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
 *   - EXTERNAL dependencies that were never installed — the @deepseek-ai
 *     harness peers a plugin declares, and ordinary npm deps like `diff`.
 *     Since siblings are linked first, anything still unresolved is one of
 *     these, so those suites are reported as SKIPPED rather than failed: a
 *     missing install is a setup state, not a broken test, and conflating the
 *     two hides the real failures.
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
      // Any package still unresolved AFTER sibling linking is an external
      // dependency this checkout never installed — harness peers and ordinary
      // npm deps alike. Both are setup state, not a broken test.
      const missing = /Cannot find package '([^']+)'/.exec(text)
      if (missing !== null) {
        skipped.push(`${label} (needs ${missing[1]} — not installed)`)
        console.log(`  SKIP  ${label.padEnd(40)} needs ${missing[1]}`)
        continue
      }
      failed.push(label)
      const line = (error.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? error.message.split('\n')[0]
      console.log(`  FAIL  ${label.padEnd(40)} ${line}`)
    }
  }
}

console.log(`\n${total} assertions passed · ${failed.length} suite(s) failed · ${skipped.length} skipped (deps not installed)`)
if (skipped.length > 0) console.log('Skipped suites run in a full install; see README.md → Testing.')
process.exit(failed.length === 0 ? 0 : 1)

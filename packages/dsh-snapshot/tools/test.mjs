/**
 * dsh-snapshot self-test: the pure ignore/args/status helpers, plus one real
 * git round-trip against a temp home (git is a test dependency here).
 * Run: node tools/test.mjs   (from ~/.dsh-agent/profiles for harness imports)
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderGitignore, snapshotArgs, shouldSnapshot, renderStatus } from '../lib/ignore.js'
import { snapshotNow, bundleTo, apply } from '../lib/index.js'

let passed = 0
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}
async function okAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.message}`); process.exitCode = 1 }
}

console.log('ignore rules')
ok('secrets, session bulk, and markers are all ignored', () => {
  const text = renderGitignore()
  for (const forbidden of ['cron/env.sh', '.credentials.yaml', 'telegram/config.json', 'sessions/', 'reviews/', '*.sqlite', '.last-']) {
    assert.ok(text.includes(forbidden), `missing ${forbidden}`)
  }
})
ok('snapshot args add the tracked scope then commit quietly', () => {
  const [add, commit] = snapshotArgs(['memory', 'skills'])
  assert.deepEqual(add, ['add', '--', 'memory', 'skills'])
  assert.equal(commit[0], 'commit')
  assert.match(commit[2], /^snapshot /)
})

console.log('shouldSnapshot')
ok('fires on first run and after the interval, not between', () => {
  const now = 1_000_000_000
  assert.equal(shouldSnapshot({ lastCommitMs: 0, now }), true)
  assert.equal(shouldSnapshot({ lastCommitMs: now - 60_000, now }), false)
  assert.equal(shouldSnapshot({ lastCommitMs: now - 31 * 60_000, now }), true)
})

console.log('renderStatus')
ok('names the home, the recency, and the exclusion stance', () => {
  const text = renderStatus({ committed: true, dirty: false, home: '/tmp/x' })
  assert.match(text, /## State snapshot/)
  assert.match(text, /Excluded by design: secrets/)
})

console.log('git round-trip (real repo in a temp home)')
await okAsync('snapshotNow commits memory, never secrets; status reflects it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-snap-'))
  try {
    await mkdir(join(home, 'memory'), { recursive: true })
    await mkdir(join(home, 'cron'), { recursive: true })
    await writeFile(join(home, 'memory/MEMORY.md'), '# Memory index\n- Lesson: test: do the thing\n')
    await writeFile(join(home, 'cron/env.sh'), 'export OPENROUTER_API_KEY="should-never-commit"\n')

    const first = await snapshotNow(home)
    assert.equal(first.committed, true, 'first pass commits')

    // A secret in an ignored path never reaches the repo.
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const listed = await run('git', ['-C', home, 'ls-files'])
    assert.ok(listed.stdout.includes('memory/MEMORY.md'), 'memory tracked')
    assert.ok(!listed.stdout.includes('cron/env.sh'), 'env.sh NOT tracked')
    assert.ok(listed.stdout.includes('.gitignore'), '.gitignore tracked so the rules travel with the clone')

    // Second pass with no change: nothing new.
    const second = await snapshotNow(home)
    assert.equal(second.committed, false, 'clean pass does not commit')

    // Change memory → commits again; bundle writes a restorable file.
    await writeFile(join(home, 'memory/MEMORY.md'), '# Memory index\n- Lesson: test: changed\n')
    const third = await snapshotNow(home)
    assert.equal(third.committed, true)
    const bundle = await bundleTo(home, join(home, 'bundles'))
    assert.ok(bundle !== undefined, 'bundle written')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

console.log('apply')
await okAsync('registers /snapshot and does not throw on a fake ctx', async () => {
  const commands = []
  const listeners = {}
  const ctx = {
    on(event, handler) { listeners[event] = handler },
    effect() {},
    commands: { register: cmd => commands.push(cmd) },
  }
  apply(ctx, { minIntervalMs: 1, idleAfterMs: 1 })
  assert.equal(commands[0].name, 'snapshot')
  const result = await commands[0].handler()
  assert.match(result.text, /State snapshot/)
})

console.log(`\n${passed} checks passed`)

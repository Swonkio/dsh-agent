/**
 * Unit checks for the Telegram gateway's pure parts: reply splitting, the
 * outbox round-trip, and config handling. The poll loop itself needs a real
 * bot and is exercised by hand.
 *
 * Usage: node tools/test.mjs
 * @module dsh-telegram/tools/test
 */

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitForTelegram } from '../lib/telegram-api.js'

let passed = 0
const failures = []

function is(name, actual, expected) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left === right) {
    passed += 1
    return
  }
  failures.push(`${name}\n    expected ${right}\n    actual   ${left}`)
}

// ── reply splitting ────────────────────────────────────────────────────────
is('short text is one chunk', splitForTelegram('hi'), ['hi'])
const long = `${'paragraph text here\n\n'.repeat(300)}the end`
const chunks = splitForTelegram(long)
is('long text splits under the limit', chunks.every(c => c.length <= 4096), true)
is('splits lose nothing', chunks.join('').replace(/\s+/g, ' ').length >= long.replace(/\s+/g, ' ').length - chunks.length * 2, true)
is('split prefers paragraph boundaries', splitForTelegram(`${'a'.repeat(4000)}\n\n${'b'.repeat(4000)}`).length, 2)

// ── config and outbox over a temp DSH_HOME ────────────────────────────────
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-telegram-test-'))
const { readConfig, writeConfig, enqueue } = await import('../lib/gateway.js')

is('missing config is empty', await readConfig(), {})
await writeConfig({ token: 'secret', allowedChatIds: [42], defaultChatId: 42 })
is('config round-trips', await readConfig(), { token: 'secret', allowedChatIds: [42], defaultChatId: 42 })
is('config is 0600', (statSync(join(process.env.DSH_HOME, 'telegram', 'config.json')).mode & 0o777), 0o600)

await enqueue('first message')
await enqueue('second message')
const outbox = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'telegram', 'outbox.json'), 'utf8'))
is('enqueue lands in the outbox with default chat', outbox.map(e => [e.chatId, e.text]), [[42, 'first message'], [42, 'second message']])
await enqueue('direct', 7)
is('enqueue with explicit chat overrides', JSON.parse(readFileSync(join(process.env.DSH_HOME, 'telegram', 'outbox.json'), 'utf8')).at(-1).chatId, 7)

if (failures.length > 0) {
  console.error(`${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`${passed} passed, 0 failed`)

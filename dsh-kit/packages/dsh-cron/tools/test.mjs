/**
 * Unit checks for the cron expression parser: grammar acceptance, field
 * errors, and next-run arithmetic including the never-firing bound.
 *
 * Usage: node tools/test.mjs
 * @module dsh-cron/tools/test
 */

import { parse, nextRun } from '../lib/cron-expr.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

function ok(name, condition, detail = '') {
  if (condition === true) {
    passed += 1
    return
  }
  failures.push(detail === '' ? name : `${name}\n    ${detail}`)
}

function throws(name, fn, needle) {
  try {
    fn()
    failures.push(`${name}\n    expected an error`)
  } catch (error) {
    if (needle === undefined || String(error.message).includes(needle)) passed += 1
    else failures.push(`${name}\n    expected message to mention "${needle}", got: ${error.message}`)
  }
}

const T = (s) => new Date(s).getTime()

// ── grammar ────────────────────────────────────────────────────────────────
is('star fields parse to full ranges', parse('30 8 * * *').fields[2].length, 31)
is('*/15 steps minutes', parse('*/15 * * * *').fields[0], [0, 15, 30, 45])
is('range with step', parse('10-40/10 * * * *').fields[0], [10, 20, 30, 40])
is('list of numbers', parse('0 6,12,18 * * *').fields[1], [6, 12, 18])
is('mixed list parts', parse('0,30-32/2 9 * * *').fields[0], [0, 30, 32])
is('7 normalizes to Sunday 0', parse('* * * * 7').fields[4], [0])
is('sunday range 5-7', parse('* * * * 5-7').fields[4], [0, 5, 6])
throws('six fields rejected', () => parse('* * * * * *'))
throws('four fields rejected', () => parse('* * * *'))
throws('out of range minute', () => parse('60 * * * *'))
throws('descending range rejected', () => parse('30-10 * * * *'))
throws('zero day-of-month rejected', () => parse('* * 0 * *'))
throws('zero step rejected', () => parse('*/0 * * * *'))
throws('named day rejected', () => parse('* * * * MON'))
throws('empty list item rejected', () => parse('1,,2 * * * *'))

// ── next-run arithmetic ───────────────────────────────────────────────────
is('daily 8:30 next from before', T(nextRun(parse('30 8 * * *'), new Date('2026-08-24T07:00:00'))), T(new Date('2026-08-24T08:30:00')))
is('daily 8:30 next from after', T(nextRun(parse('30 8 * * *'), new Date('2026-08-24T09:00:00'))), T(new Date('2026-08-25T08:30:00')))
is('result is strictly after the cursor', T(nextRun(parse('* * * * *'), new Date('2026-08-24T10:04:30'))), T(new Date('2026-08-24T10:05:00')))
is('cursor itself is never returned', T(nextRun(parse('5 * * * *'), new Date('2026-08-24T10:05:00'))), T(new Date('2026-08-24T11:05:00')))
is('weekdays only skips the weekend', T(nextRun(parse('30 8 * * 1-5'), new Date('2026-08-28T09:00:00'))), T(new Date('2026-08-31T08:30:00')))
is('monthly first', T(nextRun(parse('0 9 1 * *'), new Date('2026-08-24T10:00:00'))), T(new Date('2026-09-01T09:00:00')))
is('feb 29 finds next leap year', nextRun(parse('0 0 29 2 *'), new Date('2026-03-01T00:00:00'))?.getFullYear(), 2028)
ok('feb 30 never fires', nextRun(parse('0 0 30 2 *'), new Date('2026-01-01T00:00:00')) === undefined)
is('vixie OR: dom+dow both restricted', T(nextRun(parse('0 0 13 * 5'), new Date('2026-08-24T01:00:00'))), T(new Date('2026-08-28T00:00:00')))
is('every 15 minutes within the hour', T(nextRun(parse('*/15 * * * *'), new Date('2026-08-24T10:20:00'))), T(new Date('2026-08-24T10:30:00')))
is('yearly new year', T(nextRun(parse('0 0 1 1 *'), new Date('2026-08-24T00:00:00'))), T(new Date('2027-01-01T00:00:00')))
is('hour range steps', T(nextRun(parse('0 9-17/4 * * *'), new Date('2026-08-24T14:00:00'))), T(new Date('2026-08-24T17:00:00')))

// ── the cronjob tool over a temp DSH_HOME ─────────────────────────────────
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-cron-test-'))
const plugin = await import('../lib/index.js')
let registered
const fakeCtx = {
  tools: { register: tool => { registered = tool } },
  commands: { register: () => {} },
  systemPrompt: { section: () => () => {} },
}
plugin.apply(fakeCtx, {})
const run = (action, extra = {}) => registered.execute({ action, ...extra })

is('tool registers as cronjob', registered.name, 'cronjob')
async function rejectsNeedle(fn, needle) {
  try {
    await fn()
    return 'no error'
  } catch (error) {
    return error.message.includes(needle)
  }
}
is('create validates exclusive schedule', await rejectsNeedle(() => run('create', { name: 'x', cron: '* * * * *', at: '2099-01-01T00:00:00Z', prompt: 'p' }), 'exactly one'), true)
const created = await run('create', { name: 'weekly', cron: '0 9 * * 1', prompt: 'summarize the week' })
is('create stores defaults and nextRun', created.status.startsWith('created j-'), true)
is('create default model', (await run('list')).detail.includes('zai/glm-5.3'), true)
const jobId = created.status.split(' ')[1]
const updated = await run('update', { id: jobId, cron: '30 8 * * 1-5', prompt: 'summarize the day', continuous: true })
is('update changes schedule and re-arms', updated.detail.includes('30 8 * * 1-5') && updated.detail.includes('[continuous]'), true)
is('update rejects both schedule kinds', await rejectsNeedle(() => run('update', { id: jobId, cron: '* * * * *', at: '2099-01-01T00:00:00Z' }), 'not both'), true)
is('toggle disables', (await run('toggle', { id: jobId })).status.startsWith('disabled'), true)
is('toggle re-enables and re-arms', (await run('toggle', { id: jobId })).detail.includes('next: '), true)
is('delete removes', (await run('delete', { id: jobId })).status, `deleted ${jobId}`)
is('delete unknown errors', await rejectsNeedle(() => run('delete', { id: 'nope' }), 'no job'), true)

if (failures.length > 0) {
  console.error(`${failures.length} FAILED:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log(`${passed} passed, 0 failed`)

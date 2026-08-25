/**
 * Unit checks for dsh-user-model: the tool's get/set round-trip, the byte cap,
 * and the prompt-section registration behaviour (present when the file exists,
 * absent when it does not).
 *
 * Usage: node tools/test.mjs
 * @module dsh-user-model/tools/test
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const failures = []
const ok = (name, cond, detail = '') => { cond === true ? (passed += 1) : failures.push(`${name}${detail ? ' — ' + detail : ''}`) }

// A minimal fake context that captures what apply() registers.
function fakeCtx() {
  const sections = []
  let tool
  return {
    sections,
    getTool: () => tool,
    systemPrompt: { section: s => { sections.push(s); return () => {} } },
    tools: { register: t => { tool = t; return () => {} } },
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-um-'))
process.env.DSH_HOME = home
const { apply } = await import('../lib/index.js')

// 1. No file: no section registered, tool still present.
{
  const ctx = fakeCtx()
  apply(ctx, {})
  ok('no file → no section', ctx.sections.length === 0)
  ok('no file → tool present', ctx.getTool()?.name === 'user_model')
}

// 2. set creates the file; get reads it back.
{
  const ctx = fakeCtx()
  apply(ctx, {})
  const tool = ctx.getTool()
  const set = await tool.execute({ action: 'set', content: '## Expertise\nRuns local LLMs on a 3x GPU box.' })
  ok('set reports bytes', set.bytes > 0)
  ok('set wrote the file', readFileSync(join(home, 'USER.md'), 'utf8').includes('local LLMs'))
  const got = await tool.execute({ action: 'get' })
  ok('get round-trips content', got.content.includes('3x GPU box'))
  ok('get reports action', got.action === 'get')
}

// 3. With a file present, apply registers the injected section.
{
  writeFileSync(join(home, 'USER.md'), '## Preferences\nTerse, numbers over adjectives.\n')
  const ctx = fakeCtx()
  apply(ctx, {})
  ok('file → section registered', ctx.sections.length === 1)
  ok('section is ordered after soul', ctx.sections[0].order === 2)
  ok('section carries the content', ctx.sections[0].text.includes('numbers over adjectives'))
  ok('section names itself', ctx.sections[0].name === 'user:model')
}

// 4. set rejects an oversized model rather than truncating silently.
{
  const ctx = fakeCtx()
  apply(ctx, { maxBytes: 100 })
  let threw = false
  try { await ctx.getTool().execute({ action: 'set', content: 'x'.repeat(1000) }) } catch { threw = true }
  ok('oversized set is rejected', threw)
}

// 5. set requires content.
{
  const ctx = fakeCtx()
  apply(ctx, {})
  let threw = false
  try { await ctx.getTool().execute({ action: 'set', content: '   ' }) } catch { threw = true }
  ok('empty set is rejected', threw)
}

// 6. Injection is byte-capped for the prompt even when the file is larger.
{
  writeFileSync(join(home, 'USER.md'), 'A'.repeat(5000))
  const ctx = fakeCtx()
  apply(ctx, { maxBytes: 256 })
  ok('injected model content respects maxBytes', Buffer.byteLength(ctx.sections[0].text.split('\n\n').slice(1).join('\n\n')) <= 256 + 96)
  ok('truncation is marked', ctx.sections[0].text.includes('truncated'))
}

rmSync(home, { recursive: true, force: true })

if (failures.length === 0) console.log(`${passed} passed, 0 failed`)
else { console.log(`${passed} passed, ${failures.length} failed`); for (const f of failures) console.log('  ✗', f); process.exit(1) }

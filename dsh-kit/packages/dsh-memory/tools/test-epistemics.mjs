/**
 * Integration checks for the epistemics layer on the real memory store:
 * contradictions are reported on the write path, a topic never conflicts with
 * its own previous wording, provenance accrues in the topic file, and none of
 * it reaches the injected index.
 *
 * Kept separate from tools/test.mjs so the store's own suite stays readable.
 *
 * Usage: node tools/test-epistemics.mjs
 * @module dsh-memory/tools/test-epistemics
 */

import { saveFact } from '../lib/memory-store.js'
import { parseFrontmatter } from 'dsh-epistemics'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
const failures = []
const ok = (name, cond, detail = '') => { cond === true ? (passed += 1) : failures.push(`${name}${detail ? ' — ' + detail : ''}`) }
const home = async () => mkdtemp(join(tmpdir(), 'dsh-epi-'))

// 1. A contradictory fact is reported, and the write still lands.
{
  const h = await home()
  await saveFact(h, { topic: 'Solana node build', summary: 'the node runs jito-solana, required for the no-port-check flag behind NAT', confidence: 'verified' })
  const c = await saveFact(h, { topic: 'Node binary', summary: 'the node runs stock agave, not jito-solana', confidence: 'reported' })
  ok('contradiction is reported', (c.conflicts ?? []).length === 1)
  ok('it names the conflicting line', (c.conflicts?.[0]?.line ?? '').includes('jito-solana'))
  ok('it names the signal', c.conflicts?.[0]?.signal === 'polarity')
  ok('the write is not blocked', c.status === 'recorded')
  const index = await readFile(join(h, 'MEMORY.md'), 'utf8')
  ok('both facts are on file for the user to resolve', index.includes('Node binary') && index.includes('Solana node build'))
}

// 2. A topic never contradicts its own earlier wording.
{
  const h = await home()
  await saveFact(h, { topic: 'Solana node build', summary: 'the node runs jito-solana behind NAT' })
  const again = await saveFact(h, { topic: 'Solana node build', summary: 'the node does not run stock agave, it runs jito-solana behind NAT' })
  ok('self re-save reports no conflict', (again.conflicts ?? []).length === 0)
  ok('self re-save updates', again.status === 'updated')
}

// 3. An unrelated fact is not flagged.
{
  const h = await home()
  await saveFact(h, { topic: 'Solana node build', summary: 'the node runs jito-solana behind NAT' })
  const other = await saveFact(h, { topic: 'GPU fans', summary: 'the accounts drive overheats without the GPU fans at 100 percent' })
  ok('unrelated fact is clean', (other.conflicts ?? []).length === 0)
}

// 4. Provenance accrues in the topic file, and never in the index.
{
  const h = await home()
  const first = await saveFact(h, { topic: 'Model serving', summary: 'llama-swap serves the 27B on port 8080', body: 'detail', confidence: 'verified' })
  ok('first save has zero confirmations', first.confirmations === 0)
  const firstMeta = parseFrontmatter(await readFile(first.topicPath, 'utf8')).meta

  const second = await saveFact(h, { topic: 'Model serving', summary: 'llama-swap serves the 27B on port 8080 with 229376 context', body: 'detail', confidence: 'verified' })
  ok('re-saving confirms the fact', second.confirmations === 1)

  const { meta } = parseFrontmatter(await readFile(second.topicPath, 'utf8'))
  ok('topic carries recorded', typeof meta.recorded === 'string')
  ok('topic carries confirmed', typeof meta.confirmed === 'string')
  ok('topic carries confidence', meta.confidence === 'verified')
  // Compared against the value the FIRST save wrote, not against `confirmed`:
  // two saves can land in the same millisecond, and asserting they differ
  // makes the test depend on wall-clock rather than on the invariant.
  ok('recorded stays at the first sighting', meta.recorded === firstMeta.recorded)
  ok('confirmed is not behind recorded', Date.parse(meta.confirmed) >= Date.parse(meta.recorded))

  const index = await readFile(join(h, 'MEMORY.md'), 'utf8')
  ok('index carries NO provenance (it is injected every turn)',
    !index.includes('confidence') && !index.includes('confirmations') && !index.includes('---'))
}

// 5. A body-less fact still gets provenance (the topic file is written anyway).
{
  const h = await home()
  const r = await saveFact(h, { topic: 'Terse fact', summary: 'the router UPnP is enabled and persisted by a systemd timer' })
  const { meta } = parseFrontmatter(await readFile(r.topicPath, 'utf8'))
  ok('body-less topic still records provenance', typeof meta.recorded === 'string')
  ok('confidence defaults to reported', meta.confidence === 'reported')
}

if (failures.length === 0) console.log(`${passed} passed, 0 failed`)
else { console.log(`${passed} passed, ${failures.length} failed`); for (const f of failures) console.log('  ✗', f); process.exit(1) }

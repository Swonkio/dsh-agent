/**
 * Unit checks for dsh-epistemics: contradiction scoring (each signal, and the
 * subject gate that must suppress all of them), provenance folding, and the
 * evidence-scaled staleness budget.
 *
 * Usage: node tools/test.mjs
 * @module dsh-epistemics/tools/test
 */

import {
  conflictScore, findConflicts, conflictNotice, CONFLICT_AT,
  parseFrontmatter, renderFrontmatter, recordProvenance, stalenessReport, ageInDays,
  contentTerms, quantities, claimOf,
} from '../lib/index.js'

let passed = 0
const failures = []
const ok = (name, cond, detail = '') => { cond === true ? (passed += 1) : failures.push(`${name}${detail ? ' — ' + detail : ''}`) }
const conflicts = (a, b) => conflictScore(a, b).score >= CONFLICT_AT

// ── tokenizing ──────────────────────────────────────────────────────────────
ok('claimOf strips the index prefix', claimOf('- Node: runs jito-solana') === 'Node runs jito-solana')
ok('claimOf passes a bare line through', claimOf('runs jito') === 'runs jito')
ok('contentTerms drops stopwords', !contentTerms('the node is a box').has('the'))
ok('quantities finds identifiers', quantities('uses Q8_0 at port 8080').has('q8_0'))
ok('quantities ignores bare words', !quantities('uses quant').has('uses'))

// ── the three conflict signals ──────────────────────────────────────────────
ok('antonym: enabled vs disabled',
  conflicts('MTP speculative decoding is enabled on the server', 'MTP speculative decoding is disabled on the server'))
ok('antonym: works vs broken',
  conflicts('manual port forwarding works on the TP-Link router', 'manual port forwarding is broken on the TP-Link router'))
ok('polarity: negation on one side only',
  conflicts('the solana node requires the no-port-check flag', 'the solana node does not require the no-port-check flag'))
ok('quantity: different ports, same subject',
  conflicts('llama-swap listens on port 8080', 'llama-swap listens on port 8081'))
ok('quantity: different quants, same subject',
  conflicts('the model runs Q8_0 at 229376 context', 'the model runs Q6_K at 327680 context'))

// ── the subject gate must suppress unrelated lines ──────────────────────────
ok('different subjects do not conflict despite an antonym',
  !conflicts('the router UPnP is enabled', 'the GPU fan service is disabled'))
ok('different subjects do not conflict despite negation',
  !conflicts('the bot must never use a public RPC', 'the accounts drive does not overheat'))
ok('unrelated lines score zero',
  conflictScore('memblaze cooling is load-bearing', 'nitro reads ethereum blobs').score === 0)

// ── agreement must not read as conflict ─────────────────────────────────────
ok('the same fact restated does not conflict',
  !conflicts('llama-swap is firewalled to loopback only', 'llama-swap is bound to loopback only'))
ok('a superset of quantities does not conflict',
  !conflicts('llama-swap listens on port 8080', 'llama-swap listens on port 8080 and 9090'))
ok('an elaboration does not conflict',
  !conflicts('the node runs jito-solana', 'the node runs jito-solana for the no-port-check flag'))

// ── reporting ───────────────────────────────────────────────────────────────
{
  const lines = [
    '- Router: manual port forwarding is broken, UPnP works',
    '- Cooling: the accounts drive overheats without fans at 100%',
    '- Node: runs jito-solana, not stock Agave',
  ]
  const found = findConflicts('- Router: manual port forwarding works fine now', lines)
  ok('findConflicts locates the right line', found.length >= 1 && found[0].line.includes('Router'))
  ok('findConflicts ranks worst first', found.every((c, i) => i === 0 || found[i - 1].score >= c.score))
  ok('findConflicts respects limit', findConflicts('- Router: forwarding works', lines, { limit: 1 }).length <= 1)
  const notice = conflictNotice(found)
  ok('notice names the conflicting line', notice.includes('Router'))
  ok('notice tells the model what to do', notice.includes('memory_edit'))
  ok('empty conflicts produce no notice', conflictNotice([]) === '')
}

// ── frontmatter ─────────────────────────────────────────────────────────────
{
  const text = '---\nrecorded: 2026-01-01T00:00:00Z\nconfirmations: 3\nconfidence: verified\n---\nbody here\n'
  const { meta, body } = parseFrontmatter(text)
  ok('parses string fields', meta.confidence === 'verified')
  ok('parses numeric fields as numbers', meta.confirmations === 3)
  ok('returns the body without the block', body.trim() === 'body here')
  ok('round-trips', parseFrontmatter(renderFrontmatter(meta, body)).meta.confirmations === 3)
  ok('no frontmatter is left alone', parseFrontmatter('just a body').body === 'just a body')
  ok('unterminated frontmatter is left alone', parseFrontmatter('---\nbroken').meta.confidence === undefined)
  ok('empty meta renders bare body', renderFrontmatter({}, 'x') === 'x')
}

// ── provenance ──────────────────────────────────────────────────────────────
{
  const first = recordProvenance({}, { confidence: 'observed', now: '2026-01-01T00:00:00Z' })
  ok('first sighting has zero confirmations', first.confirmations === 0)
  ok('first sighting sets recorded', first.recorded === '2026-01-01T00:00:00Z')
  const second = recordProvenance(first, { now: '2026-02-01T00:00:00Z' })
  ok('re-saving counts as a confirmation', second.confirmations === 1)
  ok('recorded stays at the first sighting', second.recorded === '2026-01-01T00:00:00Z')
  ok('confirmed moves forward', second.confirmed === '2026-02-01T00:00:00Z')
  ok('confidence carries over when unspecified', second.confidence === 'observed')
  ok('an unknown confidence does not overwrite', recordProvenance(first, { confidence: 'bogus' }).confidence === 'observed')
  ok('source is recorded when given', recordProvenance({}, { source: 'sess-1' }).source === 'sess-1')
  ok('source is omitted when absent', recordProvenance({}).source === undefined)
}

// ── staleness ───────────────────────────────────────────────────────────────
{
  ok('ageInDays computes', Math.round(ageInDays('2026-01-01T00:00:00Z', Date.parse('2026-01-11T00:00:00Z'))) === 10)
  ok('unparseable dates are infinitely old', ageInDays('nonsense') === Infinity)
  const now = Date.parse('2026-06-01T00:00:00Z')
  const entries = [
    { topic: 'fresh', meta: { confirmed: '2026-05-25T00:00:00Z', confidence: 'reported', confirmations: 0 } },
    { topic: 'old-reported', meta: { confirmed: '2025-06-01T00:00:00Z', confidence: 'reported', confirmations: 0 } },
    { topic: 'old-verified', meta: { confirmed: '2026-01-01T00:00:00Z', confidence: 'verified', confirmations: 5 } },
  ]
  const report = stalenessReport(entries, { staleAfterDays: 90, now })
  const topics = report.map(r => r.topic)
  ok('fresh facts are not stale', !topics.includes('fresh'))
  ok('an old unconfirmed fact is stale', topics.includes('old-reported'))
  ok('evidence buys a longer leash', !topics.includes('old-verified'),
    'verified+5 confirmations should outlive 151 days')
  ok('report carries the numbers', report[0].ageDays > 0 && report[0].budgetDays > 0)
}

if (failures.length === 0) console.log(`${passed} passed, 0 failed`)
else { console.log(`${passed} passed, ${failures.length} failed`); for (const f of failures) console.log('  ✗', f); process.exit(1) }

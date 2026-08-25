/**
 * dsh-epistemics — truth maintenance for the memory store.
 *
 * The memory store already refuses DUPLICATES: a fact too similar to one on
 * file is dropped. The failure it cannot see is the opposite one — a fact that
 * is similar in SUBJECT but opposite in CLAIM. "the node runs envoy-proxy" and
 * "the node runs stock nginx" are only ~60% similar, so both survive, and from
 * then on every session is handed both and believes whichever it reads first.
 * A duplicate wastes a line; a contradiction corrupts the model of the world,
 * and it persists, which is exactly what makes it worse than having no memory.
 *
 * So this module scores the second thing: given a candidate line and the lines
 * already on file, which existing ones does it CONTRADICT? The answer is a
 * heuristic, not a proof — there is no model call here, by design, because
 * this runs on the write path of every memory and must be free and
 * deterministic. It looks for three signals a contradiction leaves in text:
 *
 *   - polarity   — one side negated, the other not ("does NOT need a proxy")
 *   - antonymy   — a known opposite pair (enabled/disabled, works/broken)
 *   - quantity   — the same subject asserted with different numbers or
 *                  identifiers (port 8080 vs 8081, Q8 vs Q6, 15TB vs 8TB)
 *
 * weighted by how strongly the two lines share a subject at all. Being a
 * heuristic, it does not block a write: it REPORTS, and the caller decides.
 * That keeps a false positive cheap (one extra sentence to the model) while a
 * true positive prevents a permanent wrong belief.
 *
 * Provenance lives in the topic file's frontmatter, never in the index line.
 * The index is injected into EVERY session's system prompt under a byte cap;
 * metadata there would be paid for on every turn forever. Frontmatter is read
 * only when a topic is opened, so dating and confirming memories costs nothing
 * at inference time.
 *
 * @module dsh-epistemics
 */

/** Words too common to identify a subject. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'and', 'or', 'but', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'by',
  'from', 'has', 'have', 'had', 'can', 'will', 'would', 'should', 'must', 'do', 'does', 'did',
  'you', 'your', 'we', 'our', 'they', 'their', 'when', 'then', 'than', 'so', 'if', 'not', 'no',
])

/** Tokens that flip the polarity of a claim. */
const NEGATORS = new Set([
  'not', 'never', 'no', 'none', 'cannot', 'cant', 'wont', 'without', 'fails', 'failed', 'broken',
  'unsupported', 'unavailable', 'disabled', 'off', 'false', 'stop', 'stopped', 'removed', 'dropped',
])

/**
 * Opposite pairs. Each entry maps a token to the set it contradicts. Kept
 * small and concrete on purpose: a broad thesaurus produces false positives,
 * and a false contradiction that nags on every save is worse than a missed one.
 */
const ANTONYMS = [
  ['enabled', 'disabled'], ['on', 'off'], ['works', 'broken'], ['working', 'broken'],
  ['up', 'down'], ['true', 'false'], ['yes', 'no'], ['start', 'stop'], ['started', 'stopped'],
  ['open', 'closed'], ['allow', 'deny'], ['allowed', 'blocked'], ['present', 'absent'],
  ['local', 'remote'], ['public', 'private'], ['sync', 'async'], ['fast', 'slow'],
  ['success', 'failure'], ['succeeds', 'fails'], ['supported', 'unsupported'],
  ['required', 'optional'], ['safe', 'unsafe'], ['secure', 'insecure'],
]

const ANTONYM_OF = new Map()
for (const [left, right] of ANTONYMS) {
  if (!ANTONYM_OF.has(left)) ANTONYM_OF.set(left, new Set())
  if (!ANTONYM_OF.has(right)) ANTONYM_OF.set(right, new Set())
  ANTONYM_OF.get(left).add(right)
  ANTONYM_OF.get(right).add(left)
}

/** Split a line into lowercased word/number tokens. */
export function tokenize(text) {
  return String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []
}

/** Content tokens: what the line is ABOUT, with stopwords removed. */
export function contentTerms(text) {
  return new Set(tokenize(text).filter(token => !STOPWORDS.has(token) && token.length > 1))
}

/**
 * Quantity-bearing tokens — bare numbers and identifiers that carry one
 * (q8_0, 15tb, 8080, v2). These are where a "same subject, different value"
 * contradiction shows up.
 */
export function quantities(text) {
  const out = new Set()
  for (const token of tokenize(text)) {
    if (/\d/.test(token)) out.add(token)
  }
  return out
}

/** Strip the "- Title: " prefix an index line carries, if present. */
export function claimOf(line) {
  const match = /^-\s*([^:]+):\s*(.*)$/.exec(String(line).trim())
  return match === null ? String(line).trim() : `${match[1]} ${match[2]}`
}

/**
 * Is this term distinctive enough to identify a subject?
 *
 * There is no corpus here to compute IDF against, so distinctiveness is
 * approximated by shape: compound identifiers (envoy-proxy, grpc-web,
 * q8_0), anything carrying a digit, and longer words are the tokens that name
 * a specific thing. Short common verbs like "runs" are not. This is the
 * difference between two lines being ABOUT the same thing and merely sharing
 * English.
 */
export function isDistinctive(term) {
  return term.length >= 6 || /[\d._-]/.test(term)
}

/** Distinctive terms weigh double when measuring subject agreement. */
function weigh(term) {
  return isDistinctive(term) ? 2 : 1
}

function totalWeight(terms) {
  let sum = 0
  for (const term of terms) sum += weigh(term)
  return sum
}

/**
 * Weighted overlap measured against the SMALLER side.
 *
 * Measuring against the smaller side is deliberate: a fact and a more detailed
 * restatement of the same fact are about the same subject, and penalising the
 * longer one for carrying detail (as a symmetric measure like Jaccard does)
 * is what lets a real contradiction slip under the threshold.
 */
function weightedContainment(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const term of a) if (b.has(term)) shared += weigh(term)
  const floor = Math.min(totalWeight(a), totalWeight(b))
  return floor === 0 ? 0 : shared / floor
}

/** Do the two sides name at least one specific thing in common? */
function sharesDistinctiveTerm(a, b) {
  for (const term of a) if (isDistinctive(term) && b.has(term)) return true
  return false
}

/**
 * Score how strongly two claims contradict each other, in 0..1.
 *
 * Subject agreement gates everything: two lines about different things cannot
 * contradict, however many negations they contain. On top of that gate, the
 * strongest single conflict signal decides the score, rather than a sum —
 * three weak hints on unrelated tokens are not evidence, one clean antonym is.
 *
 * @param {string} candidate - the line about to be written.
 * @param {string} existing - a line already on file.
 * @returns {{score: number, subject: number, signal: string|null, detail: string}}
 */
export function conflictScore(candidate, existing) {
  const left = claimOf(candidate)
  const right = claimOf(existing)
  const leftTerms = contentTerms(left)
  const rightTerms = contentTerms(right)

  // Subject gate, in two parts. First: the two sides must name at least one
  // specific thing in common, which is what stops "the router UPnP is enabled"
  // from contradicting "the GPU fan service is disabled" — a clean antonym
  // pair over entirely unrelated subjects. Second: they must substantially
  // overlap once distinctive terms are weighted.
  if (!sharesDistinctiveTerm(leftTerms, rightTerms)) return { score: 0, subject: 0, signal: null, detail: '' }
  const subject = weightedContainment(leftTerms, rightTerms)
  if (subject < 0.34) return { score: 0, subject, signal: null, detail: '' }

  const leftTokens = tokenize(left)
  const rightTokens = tokenize(right)

  // 1. Antonym pair present across the two sides.
  for (const token of leftTokens) {
    const opposites = ANTONYM_OF.get(token)
    if (opposites === undefined) continue
    for (const other of rightTokens) {
      if (opposites.has(other)) {
        return { score: Math.min(1, subject * 1.35), subject, signal: 'antonym', detail: `"${token}" vs "${other}"` }
      }
    }
  }

  // 2. Polarity asymmetry: one side negated, the other not.
  const leftNeg = leftTokens.some(token => NEGATORS.has(token))
  const rightNeg = rightTokens.some(token => NEGATORS.has(token))
  if (leftNeg !== rightNeg) {
    return {
      score: Math.min(1, subject * 1.2),
      subject,
      signal: 'polarity',
      detail: leftNeg ? 'the new fact is negated, the existing one is not' : 'the existing fact is negated, the new one is not',
    }
  }

  // 3. Quantity disagreement: same subject, different numbers/identifiers.
  // Only counts when BOTH sides carry quantities and they do not intersect —
  // otherwise "port 8080" vs "port 8080 and 8081" would read as a conflict.
  const leftQuantities = quantities(left)
  const rightQuantities = quantities(right)
  if (leftQuantities.size > 0 && rightQuantities.size > 0) {
    let shared = 0
    for (const value of leftQuantities) if (rightQuantities.has(value)) shared += 1
    if (shared === 0) {
      return {
        score: Math.min(1, subject * 1.1),
        subject,
        signal: 'quantity',
        detail: `${[...leftQuantities].join(', ')} vs ${[...rightQuantities].join(', ')}`,
      }
    }
  }

  return { score: 0, subject, signal: null, detail: '' }
}

/** Default score above which a conflict is worth reporting to the caller. */
export const CONFLICT_AT = 0.5

/**
 * Find the existing lines a candidate appears to contradict, worst first.
 * @param {string} candidate - the line about to be written.
 * @param {string[]} lines - lines already on file.
 * @param {object} options - `{ threshold?: number, limit?: number }`.
 */
export function findConflicts(candidate, lines, options = {}) {
  const threshold = options.threshold ?? CONFLICT_AT
  const limit = options.limit ?? 3
  const found = []
  for (const line of lines) {
    if (String(line).trim() === '') continue
    const result = conflictScore(candidate, line)
    if (result.score >= threshold) found.push({ line: String(line).trim(), ...result })
  }
  found.sort((a, b) => b.score - a.score)
  return found.slice(0, limit)
}

/**
 * A sentence for the model when a write looks like a contradiction. The write
 * still happens — this is a report, not a veto — so the wording has to make
 * the next action obvious rather than merely raise an alarm.
 */
export function conflictNotice(conflicts) {
  if (conflicts.length === 0) return ''
  const items = conflicts.map(c => `  • "${c.line}" (${c.signal}: ${c.detail})`).join('\n')
  return `This appears to CONTRADICT memory already on file:\n${items}\n`
    + 'If the new fact is right, correct the old one with memory_edit (or memory_forget) — leaving both means every '
    + 'future session is handed two incompatible facts. If the old one is right, revise what you just saved.'
}

// ── provenance ──────────────────────────────────────────────────────────────

/**
 * Parse leading YAML-ish frontmatter. Deliberately tiny: the fields are flat
 * scalars written by this module, and pulling in a YAML parser for four keys
 * would add a dependency to a package that otherwise has none.
 * @returns {{meta: object, body: string}}
 */
export function parseFrontmatter(text) {
  const source = String(text)
  if (!source.startsWith('---\n')) return { meta: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: source }
  const meta = {}
  for (const line of source.slice(4, end).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (match === null) continue
    const raw = match[2].trim()
    meta[match[1]] = /^-?\d+$/.test(raw) ? Number(raw) : raw.replace(/^["']|["']$/g, '')
  }
  const rest = source.slice(end + 4)
  return { meta, body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

/** Render frontmatter + body back to a topic file. */
export function renderFrontmatter(meta, body) {
  const keys = Object.keys(meta).filter(key => meta[key] !== undefined && meta[key] !== '')
  if (keys.length === 0) return String(body)
  const head = keys.map(key => `${key}: ${meta[key]}`).join('\n')
  return `---\n${head}\n---\n${String(body)}`
}

/** How sure the writer was. `verified` survives curation; `reported` decays. */
export const CONFIDENCE = ['verified', 'observed', 'reported']

/**
 * Fold a new sighting of a fact into its provenance.
 *
 * Re-saving a fact that is already on file is the only evidence available that
 * it is still true, so it raises `confirmations` and moves `confirmed` forward.
 * That count is what lets the curator tell a fact that has held up a dozen
 * times from one asserted once and never seen again.
 *
 * @param {object} previous - existing frontmatter, if any.
 * @param {object} update - `{ confidence?, source?, now? }`.
 */
export function recordProvenance(previous = {}, update = {}) {
  const now = update.now ?? new Date().toISOString()
  const confidence = CONFIDENCE.includes(update.confidence) ? update.confidence : (previous.confidence ?? 'reported')
  const first = previous.recorded ?? now
  const confirmations = typeof previous.confirmations === 'number' ? previous.confirmations : 0
  return {
    recorded: first,
    confirmed: now,
    confirmations: previous.recorded === undefined ? 0 : confirmations + 1,
    confidence,
    ...(update.source === undefined ? {} : { source: update.source }),
  }
}

/** Days between an ISO timestamp and now; Infinity when unparseable. */
export function ageInDays(iso, now = Date.now()) {
  const at = Date.parse(String(iso))
  if (Number.isNaN(at)) return Infinity
  return (now - at) / 86400000
}

/**
 * Which facts have gone stale enough to be worth re-checking.
 *
 * Staleness is not age alone. A fact confirmed repeatedly, or recorded as
 * verified, has earned a longer leash than one reported once — so the budget
 * scales with the evidence behind it. This is the signal the curator consumes;
 * it never deletes anything on its own.
 *
 * @param {Array<{topic: string, meta: object}>} entries
 * @param {object} options - `{ staleAfterDays?: number, now?: number }`.
 */
export function stalenessReport(entries, options = {}) {
  const base = options.staleAfterDays ?? 90
  const now = options.now ?? Date.now()
  const out = []
  for (const entry of entries) {
    const meta = entry.meta ?? {}
    const confirmations = typeof meta.confirmations === 'number' ? meta.confirmations : 0
    const trust = meta.confidence === 'verified' ? 2 : meta.confidence === 'observed' ? 1.4 : 1
    const budget = base * trust * (1 + Math.min(confirmations, 5) * 0.4)
    const age = ageInDays(meta.confirmed ?? meta.recorded, now)
    if (age > budget) out.push({ topic: entry.topic, ageDays: Math.round(age), budgetDays: Math.round(budget), confidence: meta.confidence ?? 'reported', confirmations })
  }
  out.sort((a, b) => (b.ageDays - b.budgetDays) - (a.ageDays - a.budgetDays))
  return out
}

/**
 * dsh-loop-guard — pure detection helpers.
 *
 * Kept free of any harness import so they can be unit-tested in isolation and
 * so the write/stream hot path pays nothing but string work. Two independent
 * signals live here:
 *
 *   - segment repetition — the "same sentence, over and over" spin. A model
 *     stuck in a reasoning loop re-emits the same opening again and again
 *     ("So the root cause is that the VBoxSVC crashes…", "Let me check the
 *     crash log."). We normalise each completed sentence/line to a short
 *     leading-word key so a paraphrase with a different suffix still collides,
 *     count the keys, and trip when one recurs too often.
 *
 *   - step cadence — whether a given step number in a turn has crossed the
 *     soft nudge line or the hard circuit-breaker line. This is what catches
 *     the 150-step tool oscillation that byte-identical repeat detection
 *     (which needs the SAME arguments) never sees.
 *
 * @module dsh-loop-guard/detect
 */

/** Sentence / line boundaries we split streamed text on. */
const BOUNDARY = /[\n.!?;:]/

/**
 * Normalise one text segment to its identity key, or null when it is too thin
 * to identify a repeat. Lowercased, punctuation flattened to spaces, collapsed,
 * then reduced to its first `prefixWords` words — so
 * "so the root cause is that the vboxsvc crashes during the install" and
 * "so the root cause is that the vboxsvc crashes" share one key.
 *
 * @param {string} segment - one completed sentence or line.
 * @param {number} minWords - reject segments shorter than this (too generic).
 * @param {number} prefixWords - how many leading words form the key.
 * @returns {string|null} the key, or null to ignore this segment.
 */
export function segmentKey(segment, minWords, prefixWords) {
  const words = String(segment)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  if (words.length < minWords) return null
  return words.slice(0, prefixWords).join(' ')
}

/**
 * A rolling repetition counter fed the streamed reasoning/text of ONE model
 * request. `push` returns the offending key once any segment's count reaches
 * the threshold, else null. It buffers a partial trailing segment across calls
 * (deltas arrive a token at a time) and caps its own memory so a genuinely
 * long, non-repeating response cannot grow it without bound.
 */
export class RepetitionCounter {
  /** @param {{repeatThreshold:number, minWords:number, prefixWords:number, maxKeys?:number}} cfg */
  constructor(cfg) {
    this.repeatThreshold = cfg.repeatThreshold
    this.minWords = cfg.minWords
    this.prefixWords = cfg.prefixWords
    this.maxKeys = cfg.maxKeys ?? 8000
    this.counts = new Map()
    this.pending = ''
  }

  /**
   * Feed one text delta.
   * @param {string} text - the newly streamed characters.
   * @returns {{key:string, count:number}|null} a trip when a key crosses the threshold.
   */
  push(text) {
    this.pending += text
    let hit = null
    let index
    // eslint-disable-next-line no-cond-assign
    while ((index = this.pending.search(BOUNDARY)) !== -1) {
      const segment = this.pending.slice(0, index)
      this.pending = this.pending.slice(index + 1)
      const key = segmentKey(segment, this.minWords, this.prefixWords)
      if (key === null) continue
      const count = (this.counts.get(key) ?? 0) + 1
      this.counts.set(key, count)
      if (count >= this.repeatThreshold && hit === null) hit = { key, count }
    }
    if (this.counts.size > this.maxKeys) this.counts.clear()
    return hit
  }
}

/**
 * Classify a step number against the soft/hard lines.
 *
 * @param {number} step - 1-based step index within the current turn.
 * @param {{softStep:number, hardStep:number, nudgeEvery:number}} cfg
 * @returns {'break'|'nudge'|null} `break` past the hard line, `nudge` on a soft cadence hit, else null.
 */
export function stepVerdict(step, cfg) {
  if (step > cfg.hardStep) return 'break'
  if (step < cfg.softStep) return null
  // Nudge at the soft line and every `nudgeEvery` steps after it.
  return (step - cfg.softStep) % cfg.nudgeEvery === 0 ? 'nudge' : null
}

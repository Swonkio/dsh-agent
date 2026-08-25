/**
 * The living status HUD: the gathered report rendered as dsh-agent's panels.
 *
 * It answers, at a glance, the questions the learning loop raises and nothing
 * else does — how much is remembered, how full the always-injected index is,
 * how skills fare by outcome, whether anything contradicts itself, when the
 * agent last taught itself something. Failing skills and standing
 * contradictions are the only things drawn in the warn colour, because they
 * are the only things that ask for a human.
 *
 * @module dsh-agent-ui/hud
 */

import { PALETTE, paint } from './theme.js'
import { wordmark, meter, panel, kv, visibleWidth } from './render.js'

const dim = (t, depth) => paint(t, PALETTE.muted, depth)
const good = (t, depth) => paint(t, PALETTE.alive, depth)
const warn = (t, depth) => paint(t, PALETTE.warn, depth)
const strong = (t, depth) => paint(t, PALETTE.text, depth)

/** Render the whole HUD as a string. `width` in columns. */
export function renderHud(report, { depth = 3, width = 80 } = {}) {
  const w = Math.min(76, Math.max(40, width))
  const inner = w - 4
  const out = []

  out.push('')
  out.push('  ' + wordmark(depth) + '   ' + dim('the agent that remembers', depth))
  out.push('')

  // ── Memory ──
  const m = report.memory
  const memRows = [
    kv('entries', strong(String(m.entries), depth) + dim(`  ·  ${m.topics} topic files`, depth), inner, depth),
    kv('index budget',
      meter(m.fullness, 22, depth, { ramp: true }) + '  ' + dim(`${Math.round(m.fullness * 100)}%`, depth),
      inner, depth),
    kv('last learned', m.memory && m.lastWrite ? strong(m.lastWrite, depth) : (m.lastWrite ? strong(m.lastWrite, depth) : dim('—', depth)), inner, depth),
  ]
  out.push(indent(panel('memory', memRows, w, depth)))

  // ── Skills, by outcome ──
  const s = report.skills
  const skillRows = []
  if (s.total === 0) {
    skillRows.push(dim('no learned skills yet — the agent writes them as it works', depth))
  } else {
    skillRows.push(kv('active',
      good(String(s.active), depth)
      + (s.stale ? dim(`   ·   ${s.stale} going idle`, depth) : '')
      + (s.archived ? dim(`   ·   ${s.archived} archived`, depth) : ''),
      inner, depth))
    if (s.flagged > 0) {
      skillRows.push(kv('failing when used', warn(`${s.flagged}  ⚠ revise, don't retire`, depth), inner, depth))
    }
  }
  out.push(indent(panel('skills', skillRows, w, depth)))

  // ── Integrity: contradictions + user model + soul ──
  const integ = []
  const c = report.contradictions ?? []
  if (c.length === 0) {
    integ.push(kv('memory integrity', good('consistent', depth), inner, depth))
  } else {
    integ.push(kv('contradictions', warn(`${c.length} standing — resolve with memory_edit`, depth), inner, depth))
    for (const conflict of c.slice(0, 2)) {
      integ.push(dim('  ⚡ ' + trim(conflict.a, 30) + ' ✕ ' + trim(conflict.b, 30), depth))
    }
  }
  integ.push(kv('user model', report.userModel.present
    ? good('present', depth) + dim(report.userModel.lastUpdate ? `  ·  ${report.userModel.lastUpdate}` : '', depth)
    : dim('not yet built', depth), inner, depth))
  integ.push(kv('soul', report.soul.present ? good('loaded', depth) : dim('none', depth), inner, depth))
  out.push(indent(panel('integrity', integ, w, depth)))

  // ── The loop ──
  const loopRows = [
    kv('self-review', report.review.lastRun ? strong(report.review.lastRun, depth) : dim('not yet run', depth), inner, depth),
    kv('curation', report.curation.lastRun ? strong(report.curation.lastRun, depth) : dim('not yet run', depth), inner, depth),
  ]
  out.push(indent(panel('learning loop', loopRows, w, depth)))
  out.push('')
  return out.join('\n')
}

const indent = block => block.split('\n').map(l => '  ' + l).join('\n')
const trim = (line, n) => {
  const t = String(line).replace(/^-\s*/, '')
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

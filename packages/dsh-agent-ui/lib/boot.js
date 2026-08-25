/**
 * The awakening — dsh-agent's signature boot.
 *
 * No other terminal agent does this, because no other one has a persistent
 * mind to show: on launch, dsh-agent draws what it REMEMBERS as a constellation
 * — one star per memory — then lights the synapses between related memories,
 * and the wordmark condenses out of the centre. It is Hermes's desktop learning
 * graph, rendered as a two-second star-field in the terminal, from the real
 * MEMORY.md and nothing invented.
 *
 * Three honesty rules the animation keeps:
 *   - it draws the actual graph; an empty memory shows a single forming spark,
 *     not fake stars, so the picture never lies about how much is known;
 *   - it is skippable and self-limiting (a hard frame budget), never a thing
 *     that stands between the user and their prompt;
 *   - it renders only on an interactive TTY — piped or scripted launches get
 *     nothing on stdout, so `dsh-agent -p '…'` stays clean.
 *
 * @module dsh-agent-ui/boot
 */

import { Canvas } from './canvas.js'
import { buildGraph, layout } from './graph.js'
import { heat, PALETTE, paint, RESET } from './theme.js'
import { wordmark } from './render.js'

const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'
const HOME = '\x1b[H'
const CLEAR = '\x1b[2J'

/** Ease 0..1. */
const ease = t => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t))

/**
 * Compose one frame at progress p (0..1) into a string of `rows` lines.
 * Pure: given the same graph, size, depth and p it returns the same frame, so
 * a test can assert on the final frame without a clock.
 */
export function frame(graph, placed, { cols, rows, depth, p }) {
  const canvas = new Canvas(cols, rows)
  const W = canvas.width
  const H = canvas.height
  const toX = x => x * (W - 1)
  const toY = y => y * (H - 1)

  // Stars ignite in id order across the first 60% of the animation.
  const litUntil = ease(Math.min(1, p / 0.6))
  const nodeLit = i => (placed.length <= 1 ? 1 : 1 - i / placed.length) <= litUntil + 1e-9

  // Beams draw over 30%–90%, each between two already-lit stars.
  const beamP = ease(Math.min(1, Math.max(0, (p - 0.3) / 0.6)))
  for (const edge of graph.edges) {
    const a = placed[edge.a]
    const b = placed[edge.b]
    if (!nodeLit(edge.a) || !nodeLit(edge.b)) continue
    const reach = beamP // 0..1 fraction of the beam drawn
    const ax = toX(a.x); const ay = toY(a.y)
    const bx = toX(a.x + (b.x - a.x) * reach)
    const by = toY(a.y + (b.y - a.y) * reach)
    const h = 0.25 + 0.35 * Math.max(a.heat, b.heat)
    canvas.line(ax, ay, bx, by, () => heat(h, depth), 0.35)
  }

  // Stars on top, brightest = most connected. A gentle twinkle keeps it alive.
  placed.forEach((node, i) => {
    if (!nodeLit(i)) return
    const twinkle = 0.85 + 0.15 * Math.sin(p * 12 + i * 1.7)
    const h = Math.min(1, node.heat * twinkle)
    const x = toX(node.x); const y = toY(node.y)
    canvas.plot(x, y, heat(h, depth), 0.6 + 0.4 * node.heat)
    // A tiny cross-glow for the hottest nodes.
    if (node.heat > 0.75) {
      canvas.plot(x + 1, y, heat(h * 0.6, depth), 0.5)
      canvas.plot(x - 1, y, heat(h * 0.6, depth), 0.5)
    }
  })

  const grid = canvas.toString(depth).split('\n')

  // The wordmark condenses in over the last 35%, centred.
  if (p > 0.65) {
    const mark = wordmark(depth)
    const markW = mark.replace(/\x1b\[[0-9;]*m/g, '').length
    const midRow = Math.floor(rows / 2)
    const col = Math.max(0, Math.floor((cols - markW) / 2))
    const reveal = ease((p - 0.65) / 0.35)
    if (reveal > 0.15) {
      const plain = grid[midRow] ?? ' '.repeat(cols)
      grid[midRow] = spliceVisible(plain, col, ` ${mark} `)
    }
  }
  return grid.join('\n')
}

/** Overwrite `insert` at visible column `col` of `base` (escape-aware-ish). */
function spliceVisible(base, col, insert) {
  // base has no escapes (grid rows may — but the midRow star row rarely aligns
  // with the mark; we simply pad a plain line to be safe).
  const plain = base.replace(/\x1b\[[0-9;]*m/g, '')
  const left = plain.slice(0, col).padEnd(col, ' ')
  const insertW = insert.replace(/\x1b\[[0-9;]*m/g, '').length
  const right = plain.slice(col + insertW)
  return left + insert + right
}

/** Blocking sleep via a promise. */
const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Play the awakening to `stream`, then leave the terminal clean for the HUD.
 *
 * @param {string[]} memoryLines - MEMORY.md index lines.
 * @param {object} opts - `{ stream, depth, cols, rows, durationMs, fps, signal }`.
 * @returns {Promise<void>} resolves when the animation is done or skipped.
 */
export async function playBoot(memoryLines, opts = {}) {
  const stream = opts.stream ?? process.stdout
  const depth = opts.depth ?? 3
  if (!stream.isTTY && opts.force !== true) return // never animate into a pipe
  const cols = Math.min(70, opts.cols ?? stream.columns ?? 70)
  const rows = opts.rows ?? 12
  const durationMs = opts.durationMs ?? 1800
  const fps = opts.fps ?? 30

  const graph = buildGraph(memoryLines)
  const placed = layout(graph.nodes, { rotate: 0.6 })

  let skipped = false
  const onKey = () => { skipped = true }
  const wasRaw = stream.isTTY && process.stdin.isTTY
  if (wasRaw) {
    try { process.stdin.setRawMode(true) } catch { /* not always permitted */ }
    process.stdin.resume()
    process.stdin.once('data', onKey)
  }
  const cleanup = () => {
    if (wasRaw) {
      try { process.stdin.setRawMode(false) } catch { /* ignore */ }
      process.stdin.pause()
      process.stdin.removeListener('data', onKey)
    }
    stream.write(SHOW)
  }
  process.once('SIGINT', () => { cleanup(); process.exit(130) })

  stream.write(HIDE + CLEAR)
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps))
  try {
    for (let i = 0; i <= frames; i += 1) {
      if (skipped || opts.signal?.aborted) break
      const p = i / frames
      stream.write(HOME + frame(graph, placed, { cols, rows, depth, p }) + '\n')
      await sleep(1000 / fps)
    }
    // Always end on the settled final frame.
    stream.write(HOME + frame(graph, placed, { cols, rows, depth, p: 1 }) + '\n')
    stream.write(RESET + '\n')
  } finally {
    cleanup()
  }
}

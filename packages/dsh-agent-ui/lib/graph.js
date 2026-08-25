/**
 * The agent's memory as a synaptic graph.
 *
 * This is the data behind the boot animation: every memory the agent holds is
 * a node, and two memories that share distinctive words are linked. It is the
 * same shape as Hermes's desktop "learning graph" — non-base knowledge as
 * nodes, lexical overlap as edges — but built to be drawn as a star-field in
 * the terminal rather than a GUI, and with no model call: pure text.
 *
 * A node's HEAT (0..1) is how strongly the agent holds it — how many other
 * memories connect to it, so a fact the whole picture leans on burns brightest.
 * That is honest: the most-connected memory really is the one most load-bearing
 * in the prompt.
 *
 * @module dsh-agent-ui/graph
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'and', 'or', 'but', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'by', 'from', 'has',
  'have', 'had', 'can', 'will', 'not', 'no', 'you', 'your', 'we', 'our', 'they', 'their', 'must',
])

/** Distinctive tokens of a line: long words and anything with a digit or dash. */
export function terms(text) {
  const out = new Set()
  for (const token of String(text).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []) {
    if (STOPWORDS.has(token) || token.length < 2) continue
    if (token.length >= 5 || /[\d._-]/.test(token)) out.add(token)
  }
  return out
}

/** The short label a node shows: the topic before the first colon, trimmed. */
export function labelOf(line) {
  const match = /^-\s*([^:]+):/.exec(String(line).trim())
  const raw = match !== null ? match[1] : String(line).replace(/^-\s*/, '')
  return raw.trim().slice(0, 22)
}

/**
 * Build nodes and edges from MEMORY.md index lines.
 * @param {string[]} lines - index lines (with or without the leading "- ").
 * @param {object} options - `{ linkAt?: number }` shared-term threshold.
 * @returns {{nodes: Array, edges: Array}}
 */
export function buildGraph(lines, options = {}) {
  const linkAt = options.linkAt ?? 1
  // Drop blanks and marker-only lines ('-', '- '): a memory needs content
  // after the bullet, or it becomes a nameless star.
  const clean = lines.map(l => String(l).trim()).filter(l => l.replace(/^-\s*/, '').trim() !== '')
  const nodes = clean.map((line, id) => ({
    id,
    label: labelOf(line),
    terms: terms(line),
    degree: 0,
    heat: 0,
  }))

  const edges = []
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      let shared = 0
      for (const t of nodes[i].terms) if (nodes[j].terms.has(t)) shared += 1
      if (shared >= linkAt) {
        edges.push({ a: i, b: j, weight: shared })
        nodes[i].degree += 1
        nodes[j].degree += 1
      }
    }
  }

  const maxDegree = nodes.reduce((m, n) => Math.max(m, n.degree), 0)
  for (const node of nodes) {
    // Even an unconnected memory glows a little — it is still known.
    node.heat = maxDegree === 0 ? 0.5 : 0.35 + 0.65 * (node.degree / maxDegree)
  }
  return { nodes, edges }
}

/**
 * Place nodes on a unit canvas [0,1]x[0,1], deterministically.
 *
 * A ring by default — a constellation reads best as a loose circle — with the
 * most-connected nodes pulled toward the centre, where the wordmark forms, so
 * the picture literally centres on what the agent most relies on. Deterministic
 * from the node id so the same memory lands in the same place every boot; a
 * mind that rearranged itself on every wake would feel unreliable, not alive.
 *
 * @returns the nodes with `x`,`y` added (0..1).
 */
export function layout(nodes, options = {}) {
  const n = nodes.length
  if (n === 0) return nodes
  const golden = Math.PI * (3 - Math.sqrt(5))
  const maxDegree = nodes.reduce((m, node) => Math.max(m, node.degree), 1)
  return nodes.map((node, i) => {
    // Phyllotaxis: even angular spread, radius growing with index — an organic
    // spiral rather than a rigid ring.
    const angle = i * golden + (options.rotate ?? 0)
    const spread = Math.sqrt((i + 0.5) / n)
    // Central pull for well-connected nodes.
    const pull = 1 - 0.45 * (node.degree / maxDegree)
    const radius = 0.13 + 0.34 * spread * pull
    return {
      ...node,
      x: 0.5 + radius * Math.cos(angle),
      y: 0.5 + radius * Math.sin(angle),
    }
  })
}

/**
 * Approximate what a terminal showed, given a raw pty capture: for each
 * physical line keep only what survived the last carriage return (the spinner
 * repaints in place), then drop SGR sequences.
 *
 * Usage: node tools/transcript.mjs <capture.log>
 */
import { readFileSync } from 'node:fs'

const ESC = String.fromCharCode(27)
const raw = readFileSync(process.argv[2], 'utf8')
for (const line of raw.split('\n')) {
  // A pty ends lines with CR LF, so drop that trailing CR before taking the
  // last in-place repaint of the line.
  const visible = line.replace(/\r$/, '').split('\r').pop()
  process.stdout.write(`${visible.replace(new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g'), '')}\n`)
}

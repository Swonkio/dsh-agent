/**
 * Reading the guest's screen: locating text on it, and knowing when it has
 * stopped changing.
 *
 * Both exist to remove guesswork that the model would otherwise have to
 * supply. Without text location every click is a coordinate estimated by eye
 * off a screenshot, and a button that moves by ten pixels between builds
 * silently misses. Without settle detection every step is followed by a fixed
 * sleep chosen blind — too short and the next keystroke lands in the previous
 * window, too long and a simple sequence takes a minute.
 * @module dsh-computer-use/screen
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

/** Where transient screenshots go while a settle check compares them. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-screen-'))

/** Fraction of pixels that must differ for two frames to count as different. */
const CHANGE_THRESHOLD = 0.0015

/**
 * Capture the guest's screen to a PNG.
 * @param {string} vm - the VirtualBox machine name.
 * @param {string} path - destination file.
 * @returns {Promise<void>} resolves once the file is written.
 */
export async function capture(vm, path) {
  await run('VBoxManage', ['controlvm', vm, 'screenshotpng', path], { timeout: 20000 })
}

/**
 * Fraction of pixels differing between two PNGs.
 *
 * Compared at a heavily reduced size: a settle check only needs to know
 * whether anything moved, and downsampling makes it both fast and immune to
 * the single-pixel cursor blink that would otherwise read as constant motion.
 * @param {string} a - first image path.
 * @param {string} b - second image path.
 * @returns {number} the differing fraction, 0 to 1.
 */
export function difference(a, b) {
  const script = `
from PIL import Image
import sys
size = (160, 120)
one = Image.open(sys.argv[1]).convert('L').resize(size)
two = Image.open(sys.argv[2]).convert('L').resize(size)
pa, pb = one.load(), two.load()
diff = 0
for y in range(size[1]):
    for x in range(size[0]):
        if abs(pa[x, y] - pb[x, y]) > 12:
            diff += 1
print(diff / (size[0] * size[1]))
`
  const out = execFileSync('python3', ['-c', script, a, b], { encoding: 'utf8', timeout: 20000 })
  return Number(out.trim())
}

/**
 * Wait until the screen stops changing.
 *
 * Polls until two consecutive frames are effectively identical, then returns.
 * A timeout returns rather than throwing: a screen that never settles (a
 * spinner, a video, a blinking caret in a wide field) is a normal state to act
 * in, not a failure, and the caller still gets a current screenshot.
 * @param {string} vm - the VirtualBox machine name.
 * @param {number} timeoutMs - how long to keep waiting.
 * @returns {Promise<{settled: boolean, waitedMs: number}>} whether it went quiet, and how long it took.
 */
export async function settle(vm, timeoutMs = 8000) {
  const started = Date.now()
  const one = join(SCRATCH, 'settle-a.png')
  const two = join(SCRATCH, 'settle-b.png')
  await capture(vm, one)
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => { setTimeout(resolve, 320) })
    await capture(vm, two)
    if (difference(one, two) < CHANGE_THRESHOLD) {
      return { settled: true, waitedMs: Date.now() - started }
    }
    await capture(vm, one)
  }
  return { settled: false, waitedMs: Date.now() - started }
}

/**
 * Read every word on screen with its bounding box.
 * @param {string} path - a PNG of the screen.
 * @returns {Promise<Array<{text: string, x: number, y: number, width: number, height: number, confidence: number}>>}
 *   one entry per recognised word.
 */
export async function words(path) {
  // psm 11 finds sparse text anywhere on the image, which is what a desktop
  // is; the page-oriented modes assume a document and drop scattered labels.
  const { stdout } = await run('tesseract', [path, 'stdout', '--psm', '11', 'tsv'], { timeout: 30000, maxBuffer: 8 << 20 })
  const rows = []
  for (const line of stdout.split('\n').slice(1)) {
    const parts = line.split('\t')
    if (parts.length < 12) continue
    const text = parts[11]?.trim()
    if (text === undefined || text === '') continue
    const confidence = Number(parts[10])
    if (!Number.isFinite(confidence) || confidence < 40) continue
    rows.push({
      text,
      x: Number(parts[6]),
      y: Number(parts[7]),
      width: Number(parts[8]),
      height: Number(parts[9]),
      confidence,
    })
  }
  return rows
}

/**
 * Find on-screen text and return the point to click for it.
 *
 * Matches a multi-word query by scanning for a run of consecutive words on the
 * same text line, so "Sign in" is found even though OCR reports "Sign" and
 * "in" separately. The returned point is the centre of the matched run's
 * combined box.
 * @param {string} path - a PNG of the screen.
 * @param {string} query - the label to find; matched case-insensitively.
 * @returns {Promise<{x: number, y: number, text: string, confidence: number} | undefined>}
 *   the click point, or undefined when the text is not on screen.
 */
export async function locate(path, query) {
  const wanted = query.trim().toLowerCase().split(/\s+/)
  const found = await words(path)
  let best
  for (let i = 0; i + wanted.length <= found.length; i += 1) {
    const run = found.slice(i, i + wanted.length)
    // Same line, left to right: OCR emits words in reading order, so a run
    // that jumps rows is two unrelated labels that happen to read alike.
    const sameLine = run.every(word => Math.abs(word.y - run[0].y) <= run[0].height)
    if (!sameLine) continue
    const matches = run.every((word, at) => word.text.toLowerCase().replace(/[^a-z0-9]/g, '')
      .includes(wanted[at].replace(/[^a-z0-9]/g, '')))
    if (!matches) continue
    const left = Math.min(...run.map(word => word.x))
    const right = Math.max(...run.map(word => word.x + word.width))
    const top = Math.min(...run.map(word => word.y))
    const bottom = Math.max(...run.map(word => word.y + word.height))
    const confidence = Math.min(...run.map(word => word.confidence))
    if (best === undefined || confidence > best.confidence) {
      best = {
        x: Math.round((left + right) / 2),
        y: Math.round((top + bottom) / 2),
        text: run.map(word => word.text).join(' '),
        confidence,
      }
    }
  }
  return best
}

/** Remove the scratch directory this module captures into. */
export function cleanup() {
  rmSync(SCRATCH, { recursive: true, force: true })
}

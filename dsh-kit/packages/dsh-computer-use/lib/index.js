/**
 * dsh-computer-use — a `computer_use` tool that drives a VirtualBox VM.
 *
 * The model sees one tool with an `action` discriminator: `screenshot`, `key`,
 * `type`, `wait`. Every action returns the screen afterwards, so the loop is
 * act-then-observe in a single call rather than the model having to remember
 * to look.
 *
 * Screen and keyboard go through `VBoxManage controlvm`, NOT through VNC. That
 * matters: VirtualBox serves one VNC client at a time, so an agent sharing the
 * VNC port with a human viewer gets locked out. The host-side channel has no
 * such contention and needs no credentials.
 *
 * Mouse is deliberately absent — see the README. `VBoxManage` exposes no
 * pointer injection, so a tool offering `click` here would be lying.
 *
 * @module dsh-computer-use
 */

import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { keyToScancodes, textToScancodes } from './scancodes.js'
import { click as vncClick, drag as vncDrag, scroll as vncScroll } from './vnc.js'
import { capture as captureScreen, locate, settle as settleScreen, words } from './screen.js'

/** Stable Cordis plugin name. */
export const name = 'tool-computer-use'

/** The registry plus the durable image store the screenshots ride on. */
export const inject = ['tools', 'attachments']

/** How long a single VBoxManage invocation may take. */
const COMMAND_TIMEOUT_MS = 30000

/** Scancodes are injected in batches; a whole page of them can exceed argv. */
const SCANCODE_BATCH = 120

/** Poll interval while waiting for the screen to stop changing. */
const SETTLE_POLL_MS = 90

/** Give up waiting for a stable screen after this long. */
const SETTLE_MAX_MS = 1600

/**
 * How much each screen edge is divided by before the frame enters context.
 * 2 quarters the pixel count, and so the image tokens.
 */
const SCREEN_DIVISOR = 2

/** Where a `find` step writes the frame it runs OCR over. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'dsh-cu-'))

/**
 * How long a between-steps settle will wait before giving up and continuing.
 *
 * Shorter than the end-of-call settle: a step boundary only needs the previous
 * action's UI to appear, and a screen that is genuinely still animating (a
 * progress bar, a video) is a normal state to act in rather than something to
 * keep waiting on.
 */
const INTER_STEP_SETTLE_MS = 4000


/** Per-agent memory of the last screen returned, so an unchanged one is not resent. */
const lastScreen = new WeakMap()

/** Run one VBoxManage subcommand. */
function vbox(args, signal) {
  return vboxRun('VBoxManage', args, signal)
}

/**
 * Run one external command with the module's shared timeout and cancellation.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<string>} the command's stdout.
 */
function vboxRun(command, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, signal }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command} ${args[0]} failed: ${(stderr || error.message).trim().slice(0, 300)}`))
        return
      }
      resolve(stdout)
    })
  })
}

/** Whether the VM is running; every action needs it to be. */
async function assertRunning(vm, signal) {
  const info = await vbox(['showvminfo', vm, '--machinereadable'], signal)
  const state = /^VMState="([^"]*)"/m.exec(info)?.[1]
  if (state !== 'running') {
    throw new Error(`VM "${vm}" is ${state ?? 'unknown'}, not running — start it with: VBoxManage startvm ${vm} --type headless`)
  }
}

/** Capture the framebuffer as PNG bytes. */
async function screenshot(vm, signal) {
  const path = join(tmpdir(), `dsh-cu-${randomUUID()}.png`)
  try {
    await vbox(['controlvm', vm, 'screenshotpng', path], signal)
    await downscale(path, signal)
    return await readFile(path)
  } finally {
    await unlink(path).catch(() => {})
  }
}

/**
 * Shrink a captured frame before it enters model context.
 *
 * A 1024x768 screen costs roughly 970 image tokens, and a session that drives
 * a VM accumulates dozens of them; halving each edge quarters the pixels and
 * so quarters that cost. Text stays legible at this factor for the purpose the
 * image serves — judging layout and confirming a click landed — because
 * reading the screen's TEXT is a separate path (`read`, and `find`) that runs
 * OCR over the ORIGINAL capture. Nothing that depends on character accuracy
 * reads the downscaled image.
 *
 * A failure here is not fatal: the full-size frame is still a correct frame,
 * so a missing imaging tool costs tokens rather than the screenshot.
 * @param {string} path - the PNG to rewrite in place.
 * @param {AbortSignal} [signal] - caller cancellation.
 */
async function downscale(path, signal) {
  try {
    await vboxRun('python3', [
      '-c',
      'import sys;from PIL import Image;'
      + 'im=Image.open(sys.argv[1]);'
      + `im.resize((max(1,im.width//${SCREEN_DIVISOR}), max(1,im.height//${SCREEN_DIVISOR})), Image.LANCZOS)`
      + '.save(sys.argv[1], optimize=True)',
      path,
    ], signal)
  } catch {
    // Downscaling is an optimisation; the original frame is still correct.
  }
}

/** Send scancodes, batched so no single argv gets unreasonably long. */
async function sendScancodes(vm, codes, signal) {
  for (let at = 0; at < codes.length; at += SCANCODE_BATCH) {
    const batch = codes.slice(at, at + SCANCODE_BATCH).map(code => code.toString(16).padStart(2, '0'))
    await vbox(['controlvm', vm, 'keyboardputscancode', ...batch], signal)
  }
}

/**
 * Wait for the screen to stop changing, rather than for a fixed delay.
 *
 * A fixed settle is wrong in both directions: too short and the model sees the
 * pre-repaint screen and concludes its keystroke did nothing; too long and
 * every action pays for the slowest case. Polling until two consecutive
 * captures match costs ~135 ms when the guest is quick and still bounds the
 * pathological case.
 *
 * @returns the settled PNG bytes.
 */
async function settledScreenshot(vm, signal, minMs) {
  const deadline = Date.now() + SETTLE_MAX_MS
  if (minMs > 0) await sleep(minMs, signal)
  let previous = await screenshot(vm, signal)
  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS, signal)
    const current = await screenshot(vm, signal)
    if (current.equals(previous)) return current
    previous = current
  }
  return previous
}

/** PNG dimensions, read straight from the IHDR chunk. */
function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Sleep, honoring cancellation. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

/**
 * Drop the image block from every EARLIER computer_use result on the surface,
 * leaving the newest screenshot as the only one the model still sees.
 *
 * This is the difference between a GUI session that stays workable and one
 * that spirals: each screenshot costs ~230 image tokens, they are near
 * identical, and a stale one is worse than useless — it invites the model to
 * reason about a screen that is no longer there. Two hundred calls of those
 * is what drives a step into repeating itself until it hits the output cap.
 *
 * The shipped `compaction-tool-result-pruner` cannot do this: it prunes text
 * and explicitly retains non-text blocks. So the tool prunes its own history,
 * using the same append-only replacement contract — the original event stays
 * in the durable log for replay and inspection; only the model-facing surface
 * shrinks.
 *
 * @param session - the calling agent's session.
 * Runs at `agent/pre-step`, the same boundary the shipped pruner uses. That
 * matters: a tool body cannot append to the session it is executing inside —
 * the append is reentrant and rejects — so pruning from `execute` silently did
 * nothing. Between steps the surface is stable and replacement is legal.
 *
 * @param session - the agent's session.
 * @param keep - how many of the most recent screenshots to leave intact.
 */
function pruneStaleScreens(session, keep = 1) {
  // Scan the SURFACE, not the raw log. A replaced event stays in the
  // append-only log carrying its original image, so scanning events finds
  // already-pruned nodes and tries to replace them again — which fails with
  // "start seq N not found in surface" on every later pass.
  const carrying = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.events[seq]
    if (event === undefined || event.type !== 'tool/result') continue
    if (event.data.meta?.tool !== TOOL_NAME) continue
    const blocks = event.data.message?.content?.[0]?.content
    if (!Array.isArray(blocks)) continue
    if (!blocks.some(block => block?.type === 'image')) continue
    carrying.push({ seq, event })
  }
  const stale = keep > 0 ? carrying.slice(0, -keep) : carrying
  let pruned = 0
  for (const { seq, event } of stale) {
    const blocks = event.data.message.content[0].content
    const text = blocks.filter(block => block?.type !== 'image')
    const message = {
      ...event.data.message,
      content: [{ ...event.data.message.content[0], content: [
        ...text,
        { type: 'text', text: '(screenshot dropped — only the most recent screen is kept)' },
      ] }],
    }
    try {
      session.append('tool/result', { ...event.data, message }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned += 1
    } catch (error) {
      console.error(`computer_use: could not prune screenshot at seq ${seq}: ${String(error).slice(0, 160)}`)
      return pruned
    }
  }
  return pruned
}

/** Marker written into each result's meta so pruning only touches our own. */
const TOOL_NAME = 'computer_use'

/** Read the console password from a file, so it is not inlined in config. */
function readPassword(file) {
  if (file === undefined) return undefined
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
}

/** VMs already confirmed running, so the check is not repaid on every call. */
const checkedRunning = new Set()

/**
 * Register the tool.
 * @param ctx - plugin context carrying `ctx.tools` and `ctx.attachments`.
 * @param config - `{ vm, settleMs?, observe? }`.
 */
export function apply(ctx, config = {}) {
  // One entry per machine the agent may drive. Keeping the console details
  // beside each VM is what lets a single tool target several machines; the
  // model picks one by name and never sees a port or a password.
  const machines = config.vms ?? { [config.vm ?? 'default']: {
    vncPort: config.vncPort ?? 5900,
    vncPasswordFile: config.vncPasswordFile,
    vncPassword: config.vncPassword,
  } }
  const names = Object.keys(machines)
  const defaultVm = config.defaultVm ?? names[0]

  /**
   * Where one VM's VNC console lives. Clicking goes through VNC because
   * `VBoxManage` has no pointer injection at all; the VM wants
   * `--vrde-multi-con on` so this second connection does not evict a human
   * viewer.
   */
  const vncOptions = vm => {
    const entry = machines[vm] ?? {}
    return {
      host: entry.vncHost ?? config.vncHost ?? '127.0.0.1',
      port: entry.vncPort ?? 5900,
      password: entry.vncPassword ?? readPassword(entry.vncPasswordFile),
    }
  }
  // The guest needs a moment to repaint after input before the screenshot is
  // worth taking; too short and the model sees the pre-action screen and
  // concludes its keystroke did nothing.
  const settleMs = config.settleMs ?? 700

  // Prune between steps, before the next request is assembled — the same
  // boundary `compaction-tool-result-pruner` uses.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      pruneStaleScreens(payload.agent.session, config.keepScreens ?? 1)
    } catch (error) {
      console.error(`computer_use: prune pass failed: ${String(error).slice(0, 160)}`)
    }
    return next()
  })

  ctx.tools.register(defineTool({
    name: 'computer_use',
    description:
      `Control a virtual machine (${names.join(' or ')}): see its screen, press keys, type text, click, scroll and drag. `
      + 'Every action returns a screenshot of the screen afterwards, so you can see the result immediately. '
      + 'PREFER "find" over "click": find locates a button or label by its text and clicks it, so you do not have to '
      + 'estimate pixel coordinates. Use "click" only for things with no readable label. '
      + 'The screen is waited on between steps automatically, so you rarely need "wait". '
      + 'Batch a whole sequence into ONE call rather than calling repeatedly.',
    parameters: {
      vm: {
        type: 'string',
        enum: names,
        description: `Which machine to drive. Defaults to ${defaultVm}.`,
      },
      read: {
        type: 'boolean',
        description:
          'Also return the screen as TEXT, read off the pixels. Much cheaper than looking at the screenshot and '
          + 'often enough on its own — use it when you need to know what a window says rather than where things are.',
      },
      steps: {
        type: 'array',
        required: true,
        description:
          'The actions to perform in order, in ONE call. Batch a whole sequence rather than '
          + 'calling this tool repeatedly: [{"key":"win+r"},{"type":"notepad"},{"key":"Enter"},{"find":"File"}]. '
          + 'An empty array just looks at the screen without touching anything.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string', description: 'Press one key or chord: "Enter", "tab", "up", "ctrl+alt+delete", "win+r".' },
            type: { type: 'string', description: 'Type this literal text. A newline presses Enter.' },
            find: {
              type: 'string',
              description:
                'Click the on-screen text that matches this, located by reading the screen — e.g. "Sign in", "OK", "File". '
                + 'Case-insensitive, and matches a run of words on one line. Prefer this over "click": it needs no coordinates '
                + 'and does not break when a control moves. Fails with the visible screen text listed, so a miss tells you what IS there.',
            },
            button: {
              type: 'string',
              enum: ['left', 'right', 'middle', 'double'],
              description: 'Which click a "find" step performs. Defaults to left.',
            },
            scroll: {
              type: 'string',
              description: 'Scroll at a point, as "x,y,notches" — positive scrolls down, negative up: "512,400,3".',
            },
            drag: {
              type: 'string',
              description: 'Press at one point and release at another, as "x1,y1,x2,y2" — for selecting, moving or resizing.',
            },
            wait: { type: 'number', description: 'Pause this many seconds (1-30). Rarely needed; steps already wait for the screen to settle.' },
            click: {
              type: 'string',
              description: 'Click at a screen coordinate, as "x,y" in pixels read off the screenshot — e.g. "512,400". Append ",right" or ",double" to change the click: "512,400,right".',
            },
          },
        },
      },
    },
    output: {
      kind: 'value',
      // The registry rejects an object schema that does not state whether it
      // accepts extra keys; every level has to say so explicitly.
      // This DSL marks requiredness per property, not with a schema-level
      // `required` array, and every object must state additionalProperties.
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          detail: { type: 'string', required: true },
          // Absent, not null, when the screen did not change: the DSL has no
          // nullable, and an omitted optional says the same thing.
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
        },
      },
      // render receives (args, value) — a one-parameter form silently reads the
      // ARGUMENTS object and fails on the missing image.
      presentationMeta: (_args, _value) => ({ tool: TOOL_NAME }),
      render: (_args, value) => value.image === undefined ? [{ type: 'text', text: value.detail }] : [
        { type: 'text', text: `${value.detail}\nScreen after (${value.image.width}x${value.image.height}):` },
        {
          type: 'image',
          attachment: {
            attachmentId: value.image.attachmentId,
            mediaType: value.image.mediaType,
            bytes: value.image.bytes,
            width: value.image.width,
            height: value.image.height,
          },
        },
      ],
    },
    async execute(args, exec) {
      const vm = typeof args.vm === 'string' && args.vm !== '' ? args.vm : defaultVm
      if (!names.includes(vm)) throw new Error(`unknown vm "${vm}"; known: ${names.join(', ')}`)
      // The running check is once per process, not once per call: it cost
      // 112 ms of every action and the state does not change under us
      // silently — a stopped VM fails the very next command anyway.
      if (!checkedRunning.has(vm)) {
        await assertRunning(vm, exec.signal)
        checkedRunning.add(vm)
      }

      const steps = Array.isArray(args.steps) ? args.steps : []
      const done = []
      for (const step of steps) {
        if (typeof step?.key === 'string' && step.key !== '') {
          const codes = keyToScancodes(step.key)
          if (codes === undefined) throw new Error(`unknown key "${step.key}"`)
          await sendScancodes(vm, codes, exec.signal)
          done.push(`pressed ${step.key}`)
        } else if (typeof step?.type === 'string' && step.type !== '') {
          await sendScancodes(vm, textToScancodes(step.type), exec.signal)
          // Never echo typed text: it may be a password and this lands in
          // durable session history.
          done.push(`typed ${[...step.type].length} chars`)
        } else if (typeof step?.click === 'string' && step.click !== '') {
          const [rawX, rawY, modifier] = step.click.split(',').map(part => part.trim())
          const x = Number(rawX)
          const y = Number(rawY)
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`click must be "x,y" in pixels, got "${step.click}"`)
          }
          const button = modifier === 'right' ? 3 : modifier === 'middle' ? 2 : 1
          await vncClick(vncOptions(vm), x, y, button, modifier === 'double')
          done.push(`clicked ${x},${y}${modifier === undefined || modifier === '' ? '' : ` (${modifier})`}`)
        } else if (typeof step?.find === 'string' && step.find !== '') {
          const shot = join(SCRATCH, `find-${process.pid}.png`)
          await captureScreen(vm, shot)
          const hit = await locate(shot, step.find)
          if (hit === undefined) {
            const seen = (await words(shot)).map(word => word.text).join(' ')
            throw new Error(
              `could not find "${step.find}" on ${vm}'s screen. `
              + `Visible text: ${seen.slice(0, 400)}${seen.length > 400 ? '…' : ''}`,
            )
          }
          const button = step.button === 'right' ? 3 : step.button === 'middle' ? 2 : 1
          await vncClick(vncOptions(vm), hit.x, hit.y, button, step.button === 'double')
          done.push(`clicked "${hit.text}" at ${hit.x},${hit.y}`)
        } else if (typeof step?.scroll === 'string' && step.scroll !== '') {
          const [rawX, rawY, rawN] = step.scroll.split(',').map(part => part.trim())
          const [x, y, notches] = [Number(rawX), Number(rawY), Number(rawN)]
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(notches)) {
            throw new Error(`scroll must be "x,y,notches", got "${step.scroll}"`)
          }
          await vncScroll(vncOptions(vm), x, y, notches)
          done.push(`scrolled ${notches > 0 ? 'down' : 'up'} ${Math.abs(notches)} at ${x},${y}`)
        } else if (typeof step?.drag === 'string' && step.drag !== '') {
          const parts = step.drag.split(',').map(part => Number(part.trim()))
          if (parts.length < 4 || parts.some(value => !Number.isFinite(value))) {
            throw new Error(`drag must be "x1,y1,x2,y2", got "${step.drag}"`)
          }
          await vncDrag(vncOptions(vm), { x: parts[0], y: parts[1] }, { x: parts[2], y: parts[3] })
          done.push(`dragged ${parts[0]},${parts[1]} to ${parts[2]},${parts[3]}`)
        } else if (typeof step?.wait === 'number') {
          const seconds = Math.max(0.1, Math.min(30, step.wait))
          await sleep(seconds * 1000, exec.signal)
          done.push(`waited ${seconds}s`)
        } else {
          throw new Error('each step needs exactly one of "key", "type", "click", "find", "scroll", "drag" or "wait"')
        }

        // Settle BETWEEN steps, not only at the end. A click that opens a
        // window has not finished doing so when the next step runs, so a
        // sequence like [click, type] types into whatever still had focus.
        // An explicit `wait` is the one step that already said how long to
        // pause, so it is not followed by another.
        if (typeof step?.wait !== 'number' && steps.length > 1) {
          await settleScreen(vm, INTER_STEP_SETTLE_MS)
        }
      }

      const bytes = await settledScreenshot(vm, exec.signal, steps.length === 0 ? 0 : settleMs)
      let detail = done.length === 0 ? 'Looked at the screen.' : `Did: ${done.join(', ')}.`

      // Screen text is appended to the detail rather than replacing the
      // screenshot: text says what a window contains, the image says where
      // things are, and a caller that asked for both usually needs both.
      if (args.read === true) {
        const shot = join(SCRATCH, `read-${process.pid}.png`)
        await captureScreen(vm, shot)
        const seen = (await words(shot)).map(word => word.text).join(' ')
        detail += `\nScreen text: ${seen.slice(0, 4000)}${seen.length > 4000 ? '…' : ''}`
      }

      // An unchanged screen carries no information but costs ~230 image
      // tokens and invalidates cache reuse, so say so in words instead.
      const agent = exec.agent
      const previous = agent === undefined ? undefined : lastScreen.get(agent)
      if (previous !== undefined && previous.equals(bytes)) {
        return { action: 'steps', detail: `${detail} The screen is unchanged.` }
      }
      if (agent !== undefined) lastScreen.set(agent, bytes)

      const { width, height } = pngSize(bytes)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('no attachment store is mounted; computer_use cannot return the screen')
      const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: `${vm}-screen.png` })
      return {
        action: 'steps',
        detail,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width ?? width,
          height: ref.height ?? height,
        },
      }
    },
  }))
}

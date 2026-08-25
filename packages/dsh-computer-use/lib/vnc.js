/**
 * A minimal RFB (VNC) client — just enough to move and click.
 *
 * `VBoxManage` has no pointer injection, so keyboard-only control cannot press
 * a button that has no keyboard path. The VM's own VNC server does carry
 * pointer events, so this opens a second connection alongside whatever human
 * viewer is attached (the VM needs `--vrde-multi-con on`) and speaks just the
 * handshake plus PointerEvent.
 *
 * Deliberately dependency-free: vncdotool is installed here but its OpenSSL
 * binding is broken, and the protocol subset needed for a click is small.
 * @module dsh-computer-use/vnc
 */

import { connect } from 'node:net'
import { execFileSync } from 'node:child_process'

/** RFB security type for classic VNC password authentication. */
const SECURITY_VNC_AUTH = 2

/** RFB security type meaning the server wants no authentication. */
const SECURITY_NONE = 1

/** Client-to-server message id for a pointer event. */
const MSG_POINTER = 5

/**
 * VNC's DES variant reverses the bit order of every key byte. The password is
 * truncated or null-padded to exactly 8 bytes first.
 */
function vncKey(password) {
  const key = Buffer.alloc(8)
  Buffer.from(password ?? '', 'latin1').copy(key, 0, 0, 8)
  for (let at = 0; at < 8; at += 1) {
    let byte = key[at]
    let reversed = 0
    for (let bit = 0; bit < 8; bit += 1) reversed |= ((byte >> bit) & 1) << (7 - bit)
    key[at] = reversed
  }
  return key
}

/**
 * Encrypt the 16-byte challenge as two ECB blocks under the VNC key.
 *
 * Shelled out to `openssl` rather than `node:crypto`: OpenSSL 3 moved DES to
 * the legacy provider, so `createCipheriv('des-ecb', …)` throws
 * `digital envelope routines::unsupported` unless node was started with
 * `--openssl-legacy-provider` — which a tool loaded inside the harness cannot
 * arrange for itself. (The same breakage is why the installed vncdotool fails.)
 */
function vncResponse(challenge, password) {
  return execFileSync('openssl', [
    'enc', '-des-ecb', '-provider', 'legacy', '-provider', 'default',
    '-K', vncKey(password).toString('hex'), '-nopad',
  ], { input: challenge, maxBuffer: 1024 })
}

/**
 * A buffered reader over the socket.
 *
 * Reading by attaching and detaching `data` handlers and pushing leftovers
 * back with `unshift` does not reliably re-deliver them, which deadlocks the
 * handshake. One accumulator plus a waiter queue is both simpler and correct.
 */
function reader(socket) {
  let buffer = Buffer.alloc(0)
  let waiter
  const settle = () => {
    if (waiter === undefined || buffer.length < waiter.length) return
    const { length, resolve } = waiter
    waiter = undefined
    const taken = buffer.subarray(0, length)
    buffer = buffer.subarray(length)
    resolve(taken)
  }
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    settle()
  })
  socket.on('error', error => {
    if (waiter !== undefined) waiter.reject(error)
  })
  socket.on('close', () => {
    if (waiter !== undefined) waiter.reject(new Error('vnc: connection closed mid-handshake'))
  })
  return length => new Promise((resolve, reject) => {
    waiter = { length, resolve, reject }
    settle()
  })
}

/**
 * Open a VNC session, run `body` with a pointer helper, then close.
 * @param options - `{ host, port, password }`.
 * @param body - receives `{ pointer(x, y, buttons), size }`.
 */
export async function withVnc(options, body) {
  const socket = connect({ host: options.host ?? '127.0.0.1', port: options.port })
  socket.setNoDelay(true)
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    const read = reader(socket)

    // Version handshake — answer with the version the server offered.
    const version = await read(12)
    socket.write(version)

    // Security handshake.
    const count = (await read(1))[0]
    if (count === 0) throw new Error('vnc: server refused the connection')
    const types = await read(count)
    let chosen
    if (types.includes(SECURITY_VNC_AUTH)) chosen = SECURITY_VNC_AUTH
    else if (types.includes(SECURITY_NONE)) chosen = SECURITY_NONE
    else throw new Error(`vnc: no supported security type in [${[...types].join(', ')}]`)
    socket.write(Buffer.from([chosen]))
    if (chosen === SECURITY_VNC_AUTH) {
      const challenge = await read(16)
      socket.write(vncResponse(challenge, options.password))
    }
    const result = (await read(4)).readUInt32BE(0)
    if (result !== 0) throw new Error('vnc: authentication failed (wrong console password?)')

    // ClientInit: 1 = share the desktop, so a human viewer is not kicked off.
    socket.write(Buffer.from([1]))
    const serverInit = await read(24)
    const width = serverInit.readUInt16BE(0)
    const height = serverInit.readUInt16BE(2)
    const nameLength = serverInit.readUInt32BE(20)
    if (nameLength > 0) await read(nameLength)

    /** Send one PointerEvent. `buttons` is a bitmask; bit 0 is the left button. */
    const pointer = (x, y, buttons = 0) => {
      const message = Buffer.alloc(6)
      message.writeUInt8(MSG_POINTER, 0)
      message.writeUInt8(buttons, 1)
      message.writeUInt16BE(Math.max(0, Math.min(width - 1, Math.round(x))), 2)
      message.writeUInt16BE(Math.max(0, Math.min(height - 1, Math.round(y))), 4)
      socket.write(message)
    }
    return await body({ pointer, size: { width, height } })
  } finally {
    socket.destroy()
  }
}

/** Sleep helper for the small waits a click needs. */
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Move to a point and click.
 * @param options - `{ host, port, password }`.
 * @param x - target column in screen pixels.
 * @param y - target row in screen pixels.
 * @param button - 1 left, 2 middle, 3 right.
 * @param double - whether to send a second press.
 */
export async function click(options, x, y, button = 1, double = false) {
  const mask = 1 << (button - 1)
  return withVnc(options, async ({ pointer, size }) => {
    pointer(x, y, 0)
    await pause(60)
    pointer(x, y, mask)
    await pause(60)
    pointer(x, y, 0)
    if (double) {
      await pause(90)
      pointer(x, y, mask)
      await pause(60)
      pointer(x, y, 0)
    }
    // Give the server a moment to process before the socket closes.
    await pause(180)
    return size
  })
}

/**
 * Scroll at a point by sending wheel button presses.
 *
 * RFB has no wheel axis: a wheel notch is a press-and-release of button 4 (up)
 * or 5 (down), so a scroll of N notches is N press/release pairs rather than
 * one event carrying a magnitude.
 * @param options - `{ host, port, password }`.
 * @param x - target column in screen pixels.
 * @param y - target row in screen pixels.
 * @param notches - wheel notches; negative scrolls up, positive scrolls down.
 */
export async function scroll(options, x, y, notches) {
  const mask = notches < 0 ? 1 << 3 : 1 << 4
  const count = Math.min(30, Math.abs(Math.round(notches)))
  return withVnc(options, async ({ pointer, size }) => {
    pointer(x, y, 0)
    await pause(40)
    for (let n = 0; n < count; n += 1) {
      pointer(x, y, mask)
      await pause(18)
      pointer(x, y, 0)
      await pause(24)
    }
    await pause(180)
    return size
  })
}

/**
 * Press at one point, move, and release at another.
 *
 * The move is broken into steps because a single jump between press and
 * release looks like a teleport to the guest: drag targets that track the
 * pointer (selections, sliders, window frames) need intermediate positions to
 * follow, and many ignore a drag that never reports motion.
 * @param options - `{ host, port, password }`.
 * @param from - `{ x, y }` where the drag starts.
 * @param to - `{ x, y }` where it ends.
 * @param button - 1 left, 2 middle, 3 right.
 */
export async function drag(options, from, to, button = 1) {
  const mask = 1 << (button - 1)
  return withVnc(options, async ({ pointer, size }) => {
    pointer(from.x, from.y, 0)
    await pause(60)
    pointer(from.x, from.y, mask)
    await pause(90)
    const steps = 12
    for (let i = 1; i <= steps; i += 1) {
      pointer(from.x + (to.x - from.x) * (i / steps), from.y + (to.y - from.y) * (i / steps), mask)
      await pause(22)
    }
    await pause(60)
    pointer(to.x, to.y, 0)
    await pause(180)
    return size
  })
}

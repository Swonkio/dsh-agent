/**
 * dsh-telegram — the messaging gateway, in Hermes's shape but sized for a Pi
 * someone owns: one manually-started process long-polling the Bot API (no
 * inbound network, no daemon), each authorized chat backed by its own
 * resumable agent session, and an outbox file anything can append to —
 * cron jobs deliver through it whether or not the gateway is running.
 *
 * Security stance: the bot token lives in `$DSH_HOME/telegram/config.json`
 * (0600, gitignored), and ONLY chats on `allowedChatIds` are answered.
 * Anyone else messaging the bot gets told how the owner can authorize them —
 * their own chat id, which they already know, and nothing else. A bot that
 * runs shell-capable agent turns cannot be an open relay.
 *
 * @module dsh-telegram/lib/gateway
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { dshBinPath, envFileExports, newestSessionFor } from '../../dsh-cron/lib/jobs.js'
import { getUpdates, sendMessage, call, getFile, downloadFile } from './telegram-api.js'
import { describeImage, transcribeVoice, largestPhoto, MAX_MEDIA_BYTES } from './media.js'

/** The gateway's own directory: config, per-chat sessions, outbox, and the
 *  working directory its agent turns run in (giving Telegram its own session
 *  namespace, separate from interactive and cron sessions). */
export function telegramHome() {
  return dshHomePath('telegram')
}

const configPath = () => join(telegramHome(), 'config.json')
const chatsPath = () => join(telegramHome(), 'chats.json')
const outboxPath = () => join(telegramHome(), 'outbox.json')

/** Load config; missing file is an empty config, not an error. */
export async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

/** Write config 0600 — it holds the bot token. */
export async function writeConfig(config) {
  await mkdir(telegramHome(), { recursive: true })
  await writeFile(configPath(), `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 })
}

/** Per-chat session ids for conversational continuity. */
async function readChats() {
  try {
    return JSON.parse(await readFile(chatsPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function writeChats(chats) {
  await mkdir(telegramHome(), { recursive: true })
  await writeFile(chatsPath(), `${JSON.stringify(chats, undefined, 2)}\n`)
}

// ── outbox ─────────────────────────────────────────────────────────────────
// The delivery seam between anything (cron, scripts) and the gateway: append
// here, the running gateway sends on its next loop; a gateway started later
// drains the backlog. Delivery survives the gateway being off.

async function readOutbox() {
  try {
    return JSON.parse(await readFile(outboxPath(), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Queue a message for delivery to a chat (default: the configured one).
 * Safe from any process; atomic rename keeps concurrent writers whole.
 */
export async function enqueue(text, chatId) {
  const config = await readConfig()
  const target = chatId ?? config.defaultChatId
  if (target === undefined) throw new Error('no chatId given and config has no defaultChatId')
  const outbox = await readOutbox()
  outbox.push({ chatId: target, text: String(text), at: new Date().toISOString() })
  await mkdir(telegramHome(), { recursive: true })
  const tmp = join(telegramHome(), `.outbox.${process.pid}.tmp`)
  await writeFile(tmp, `${JSON.stringify(outbox, undefined, 2)}\n`)
  await rename(tmp, outboxPath())
}

/** Send every queued message; returns how many went out. */
async function drainOutbox(token) {
  const outbox = await readOutbox()
  if (outbox.length === 0) return 0
  for (const entry of outbox) {
    try {
      await sendMessage(token, entry.chatId, entry.text)
    } catch (error) {
      // An unfetchable chat (blocked bot, bad id) would otherwise clog the
      // queue forever; log-and-drop is the honest failure for a chat log.
      console.error(`outbox: send to ${entry.chatId} failed: ${error.message}`)
    }
  }
  await writeFile(outboxPath(), '[]\n')
  return outbox.length
}

// ── agent turns ────────────────────────────────────────────────────────────

/**
 * Run one prompt through the one-shot agent surface, optionally resuming a
 * prior session. Telegram replies want seconds, not minutes: a hard timeout
 * converts to a short apology instead of a hung chat.
 * @returns {Promise<{ text: string, sessionId: string | undefined, status: string }>}
 */
export async function runTurn({ prompt, resumeId, provider = 'zai', model = 'glm-5.3', timeoutMs = 180000 }) {
  const fileEnv = await envFileExports()
  return new Promise(resolve => {
    const startedAt = Date.now()
    const sinceMs = startedAt - 1500
    let out = ''
    let err = ''
    const finish = async (status) => {
      clearTimeout(timer)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2000))
      resolve({
        status,
        text: [out.trim(), err.trim() === '' ? '' : `[error]\n${err.trim()}`].filter(p => p !== '').join('\n') || '(no output)',
        sessionId: await newestSessionFor(telegramHome(), sinceMs),
      })
    }
    const resume = typeof resumeId === 'string' && resumeId !== '' ? ['--resume', resumeId] : []
    const child = spawn(process.execPath, [
      dshBinPath(), '--profile', 'cron', '-p', prompt, '--provider', provider, '--model', model, ...resume,
    ], { cwd: telegramHome(), env: { ...fileEnv, ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { if (out.length < 32768) out += chunk.toString() })
    child.stderr.on('data', chunk => { if (err.length < 8192) err += chunk.toString() })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)
    child.on('error', error => { err += `\n${error.message}`; void finish('error') })
    child.on('close', (code, signal) => void finish(signal === null ? (code === 0 ? 'ok' : 'error') : 'timeout'))
  })
}

// ── the poll loop ──────────────────────────────────────────────────────────

/**
 * Run the gateway until interrupted. Long-polls (50s holds), so the loop is
 * quiet when nobody writes and responsive the moment they do.
 * @param {{ provider?: string, model?: string, turnTimeoutMs?: number }} [options]
 */
export async function runGateway(options = {}) {
  const config = await readConfig()
  if (config.token === undefined || config.token === '') {
    throw new Error('no bot token: create a bot with @BotFather, then run:  dsh-telegram set-token <token>')
  }
  const me = await call(config.token, 'getMe')
  console.log(`gateway: polling as @${me.username}; authorized chats: ${(config.allowedChatIds ?? []).join(', ') || 'NONE yet'}`)
  await mkdir(telegramHome(), { recursive: true })

  let offset = 0
  for (;;) {
    try {
      await drainOutbox(config.token)
      const updates = await getUpdates(config.token, { offset, timeoutSeconds: 50 })
      for (const update of updates) {
        offset = update.update_id + 1
        const message = update.message
        if (message?.text === undefined) continue
        await handleMessage(config, message, options)
      }
    } catch (error) {
      // Poll errors (network blips, Telegram 5xx) must never kill the
      // gateway; back off briefly and poll again.
      console.error(`gateway: ${error.message}`)
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}

/** Authorize, answer, and remember the session for one incoming message. */
async function handleMessage(config, message, options) {
  const chatId = message.chat.id
  const allowed = config.allowedChatIds ?? []
  if (!allowed.includes(chatId)) {
    const hint = allowed.length === 0
      ? 'This bot is new and unlocked. To authorize yourself, add your chat id to allowedChatIds in ~/.dsh/telegram/config.json (then set defaultChatId to the same value).'
      : 'This bot answers authorized chats only.'
    await sendMessage(config.token, chatId, `${hint}\nYour chat id: ${chatId}`)
    console.log(`gateway: denied chat ${chatId} ("${(message.text ?? message.caption ?? '<media>').slice(0, 40)}")`)
    return
  }
  await call(config.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  // The typing gesture expires after ~5s, and a voice note can spend a minute
  // in local transcription before the model turn even starts; keep the
  // gesture alive for the whole handling of this message.
  const typer = setInterval(() => { void call(config.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}) }, 4500)

  try {
    // Photos get eyes (hosted vision), voice gets ears (local whisper), and
    // the TASK model stays glm-5.3: the cheap specialist passes what it saw
    // or heard to the heavyweight generalist that answers.
    let prompt
    if (message.voice !== undefined || message.audio !== undefined) {
      prompt = await voicePrompt(config, message)
      if (prompt === undefined) {
        await sendMessage(config.token, chatId, 'That voice note came back empty — nothing I could transcribe. Try again a bit closer to the mic?')
        return
      }
      console.log(`gateway: chat ${chatId}: voice "${prompt.slice(0, 60)}"`)
    } else if (message.photo !== undefined || isImageDocument(message.document)) {
      prompt = await photoPrompt(config, message)
      if (prompt === undefined) {
        await sendMessage(config.token, chatId, 'That image was too large or unreadable (8 MB cap).')
        return
      }
      console.log(`gateway: chat ${chatId}: photo (caption ${(message.caption ?? '').slice(0, 40)})`)
    } else if (typeof message.text === 'string' && message.text.trim() !== '') {
      prompt = message.text.trim()
      console.log(`gateway: chat ${chatId}: "${prompt.slice(0, 80)}"`)
    } else {
      await sendMessage(config.token, chatId, 'I take text, photos, and voice notes.')
      return
    }

    const chats = await readChats()
    const result = await runTurn({
      prompt,
      resumeId: chats[String(chatId)],
      provider: options.provider ?? config.provider ?? 'zai',
      model: options.model ?? config.model ?? 'glm-5.3',
      timeoutMs: options.turnTimeoutMs ?? 180000,
    })
    if (result.sessionId !== undefined) chats[String(chatId)] = result.sessionId
    await writeChats(chats)
    await sendMessage(config.token, chatId, result.text)
    console.log(`gateway: chat ${chatId}: replied (${result.status})`)
  } finally {
    clearInterval(typer)
  }
}

/** A Telegram document that is really an image (uncompressed photo sends). */
function isImageDocument(document) {
  return document !== undefined && typeof document.mime_type === 'string' && document.mime_type.startsWith('image/')
}

/** Fetch one Telegram file by id, bounded by the media size cap. */
async function fetchMedia(config, fileId) {
  const info = await getFile(config.token, fileId)
  if ((info.file_size ?? 0) > MAX_MEDIA_BYTES) return undefined
  return downloadFile(config.token, info.file_path)
}

/** Voice note → local whisper → the prompt the task model answers. */
async function voicePrompt(config, message) {
  const media = message.voice ?? message.audio
  const bytes = await fetchMedia(config, media.file_id)
  if (bytes === undefined) return undefined
  const tmp = join(telegramHome(), `voice-${Date.now()}.ogg`)
  await writeFile(tmp, bytes)
  try {
    const text = await transcribeVoice({
      filePath: tmp,
      command: config.transcribeCommand ?? 'whisper',
      model: config.transcribeModel ?? 'base',
    })
    if (text === '') return undefined
    return `The user sent a Telegram voice message. Its transcription: "${text}"\nRespond to what they said.`
  } catch (error) {
    console.error(`gateway: transcription failed: ${error.message}`)
    return undefined
  } finally {
    await import('node:fs/promises').then(fs => fs.rm(tmp, { force: true }))
  }
}

/** Photo → hosted vision description → the prompt the task model answers. */
async function photoPrompt(config, message) {
  const fileId = message.photo !== undefined
    ? largestPhoto(message.photo).file_id
    : message.document.file_id
  const bytes = await fetchMedia(config, fileId)
  if (bytes === undefined) return undefined
  const mime = message.photo !== undefined ? 'image/jpeg' : message.document.mime_type
  const key = process.env.GLM_API_KEY ?? (await envFileExports()).GLM_API_KEY
  if (key === undefined) throw new Error('no GLM_API_KEY for the vision call (shell or ~/.dsh/cron/env.sh)')
  const caption = (message.caption ?? '').trim()
  const description = await describeImage({
    apiKey: key,
    base64: bytes.toString('base64'),
    mimeType: mime,
    model: config.visionModel ?? undefined,
    question: caption === '' ? undefined : `Answer about this image: ${caption}`,
  })
  return `The user sent a Telegram photo${caption === '' ? '' : ` captioned: "${caption}"`}. A vision model examined it:\n"${description}"\nRespond to the user accordingly (they cannot see the description, only your reply).`
}

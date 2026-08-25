/**
 * The first-run setup page — Hermes's `hermes setup`, sized for this kit.
 *
 * Shown once before the first interactive session (marker: `$DSH_HOME/
 * setup-done`), re-openable any time as `/setup`. It walks the pieces that
 * need a human: the Telegram bot (token, pairing, gateway), the SOUL.md
 * persona file, and a plain-facts system check (default model, API key,
 * crontab, snapshot repo, memory store).
 *
 * Everything here uses the surface's own primitives — Screen for output,
 * `select` for menus, the Keyboard stack for line input — so the page reads
 * as native, and every step is skippable: an incomplete setup simply shows
 * again next launch.
 *
 * @module dsh-agent/lib/setup
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { select, box, wrap } from './term.js'
import { ui, glyph } from './theme.js'
import { keyboard } from './keys.js'

/** The marker whose presence suppresses the first-run page. */
export const SETUP_DONE = () => dshHomePath('setup-done')

/** The starter persona, offered verbatim when SOUL.md is missing. */
const SOUL_STARTER = `# Soul

You live on a Raspberry Pi 5 in your user's home. The user runs experiments —
local models, agent harnesses, home-lab plumbing — and likes to understand
rather than be handed magic.

Voice: plain, direct, technical. Terse beats thorough; numbers beat adjectives.
Edit this file to shape how the agent speaks and behaves: it is read into every
session.
`

/**
 * Read one line from the keyboard: typed characters, paste, backspace.
 * @returns {Promise<string | undefined>} the line, or undefined on escape.
 */
function promptLine(screen, label, { placeholder = '' } = {}) {
  return new Promise(resolve => {
    let text = ''
    const pop = keyboard.push(key => {
      if (key.name === 'return') {
        pop()
        screen.line()
        resolve(text)
      } else if (key.name === 'escape' || (key.name === 'c' && key.ctrl === true)) {
        pop()
        screen.line()
        resolve(undefined)
      } else if (key.name === 'backspace' || key.name === 'delete') {
        text = text.slice(0, -1)
        screen.write('\b \b')
      } else if (key.name === 'paste' && typeof key.text === 'string') {
        text += key.text.trim()
        screen.write(key.text.trim())
      } else if (key.name === 'char' && typeof key.sequence === 'string') {
        text += key.sequence
        screen.write(key.sequence)
      }
    })
    screen.line(`${ui.accent(glyph.prompt)} ${label}${placeholder === '' ? '' : ui.muted(` (${placeholder})`)}`)
    screen.write('  ')
  })
}

/** A yes/no via the native menu. */
async function confirm(screen, title) {
  return await select(screen, { title, items: [{ label: 'yes' }, { label: 'no' }] }) === 0
}

/** Hold until Enter, so printed facts can be read. */
async function pause(screen, text = 'press enter to continue') {
  await new Promise(resolve => {
    const pop = keyboard.push(key => {
      if (key.name === 'return' || key.name === 'escape') {
        pop()
        resolve(undefined)
      }
    })
    screen.line(ui.muted(`  … ${text}`))
  })
}

// ── steps ──────────────────────────────────────────────────────────────────

/** Telegram: token, chat pairing by listening for the first message, gateway. */
async function setupTelegram(screen) {
  const { readConfig, writeConfig } = await import('../../dsh-telegram/lib/gateway.js')
  const { call, getUpdates } = await import('../../dsh-telegram/lib/telegram-api.js')
  const config = await readConfig()

  if (config.token !== undefined && config.token !== '') {
    try {
      const me = await call(config.token, 'getMe')
      screen.line(`  Telegram already configured: bot @${me.username}, authorized chats: ${(config.allowedChatIds ?? []).join(', ') || 'none'}`)
      if (!await confirm(screen, 'Set up a different bot token?')) return
    } catch (error) {
      screen.line(ui.danger(`  Stored token failed: ${error.message}`))
    }
  }

  const token = await promptLine(screen, 'Paste the bot token from @BotFather (/newbot):', { placeholder: 'esc to skip' })
  if (token === undefined || token === '' || !token.includes(':')) {
    screen.line(ui.muted('  Telegram setup skipped — run /setup or dsh-telegram set-token anytime'))
    return
  }
  try {
    const me = await call(token, 'getMe')
    const next = { ...config, token }
    await writeConfig(next)
    screen.line(`  Token stored; bot is @${me.username}`)

    screen.line(ui.accent(`  Now send ANY message to @${me.username} in Telegram, then come back here.`))
    const pair = await confirm(screen, 'Ready to listen for your message? (waits up to 90s)')
    if (pair) {
      screen.line('  listening…')
      const deadline = Date.now() + 90000
      let chatId
      while (chatId === undefined && Date.now() < deadline) {
        try {
          const updates = await getUpdates(token, { offset: 0, timeoutSeconds: 2 })
          const message = updates.find(u => u.message?.chat?.id !== undefined)
          if (message !== undefined) chatId = message.message.chat.id
        } catch {
          // Transient poll failure; the deadline is the bound.
        }
        if (chatId === undefined) await new Promise(r => setTimeout(r, 1000))
      }
      if (chatId === undefined) {
        screen.line(ui.danger('  No message arrived in 90s — pair later with: dsh-telegram allow <your-chat-id>'))
      } else {
        const allowed = [...new Set([...(next.allowedChatIds ?? []), chatId])]
        await writeConfig({ ...next, allowedChatIds: allowed, defaultChatId: next.defaultChatId ?? chatId })
        screen.line(`  Chat ${chatId} authorized (delivery default). Telegram is live.`)
      }
    }

    if (await confirm(screen, 'Start the Telegram gateway now, in the background?')) {
      const { spawn } = await import('node:child_process')
      const { open } = await import('node:fs/promises')
      const runner = fileURLToPath(new URL('../../dsh-telegram/bin/dsh-telegram.mjs', import.meta.url))
      const log = await open(dshHomePath('telegram', 'gateway.log'), 'a')
      const child = spawn(process.execPath, [runner, 'run'], {
        detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
      })
      child.unref()
      // The child duplicated the fd at spawn; the parent's copy must close,
      // or Node collects it later with a deprecation warning.
      await log.close()
      screen.line('  Gateway started (log: ~/.dsh/telegram/gateway.log; stop with: pkill -f dsh-telegram)')
    } else {
      screen.line(ui.muted('  Start it whenever you want:  dsh-telegram run'))
    }
  } catch (error) {
    screen.line(ui.danger(error.network === true
      ? `  Could not reach api.telegram.org: ${error.message}`
      : `  Telegram rejected that token: ${error.message}`))
  }
}

/** SOUL.md: offer the starter when missing, show the head when present. */
async function setupSoul(screen) {
  const path = dshHomePath('SOUL.md')
  if (existsSync(path)) {
    const first = readFileSync(path, 'utf8').split('\n').find(l => l.trim() !== '') ?? ''
    screen.line(`  SOUL.md present: "${first.slice(0, 70)}"`)
    screen.line(ui.muted(`  Edit ${path} anytime; it is read into every session.`))
    return
  }
  if (await confirm(screen, 'Create a starter SOUL.md (the persona injected into every session)?')) {
    writeFileSync(path, SOUL_STARTER)
    screen.line(`  Written: ${path} — edit it to shape the agent's voice.`)
  } else {
    screen.line(ui.muted(`  Skipped; create ${path} by hand whenever.`))
  }
}

/** Best-effort default-model read from settings.yaml (display only). */
export function parseDefaultModel(yamlText) {
  const match = /agent-default-model:\s*\n\s*provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/.exec(yamlText)
  return match === null ? undefined : `${match[2]} (${match[1]})`
}

/** The plain-facts checklist: what works, what needs a look. */
export async function systemChecks() {
  const checks = []
  try {
    const settings = readFileSync(dshHomePath('settings.yaml'), 'utf8')
    const model = parseDefaultModel(settings)
    checks.push([model !== undefined, `default model: ${model ?? 'unreadable from settings.yaml'}`])
  } catch {
    checks.push([false, 'settings.yaml not found'])
  }
  const keyPresent = process.env.GLM_API_KEY !== undefined
    || (() => { try { return readFileSync(dshHomePath('cron', 'env.sh'), 'utf8').includes('GLM_API_KEY') } catch { return false } })()
  checks.push([keyPresent, 'GLM_API_KEY available (shell or cron env.sh)'])
  let cron = false
  try {
    cron = execFileSync('crontab', ['-l'], { encoding: 'utf8' }).includes('dsh-cron')
  } catch { /* no crontab */ }
  checks.push([cron, 'cron scheduler installed (crontab dsh-cron line)'])
  checks.push([existsSync(dshHomePath('.git')), 'nightly snapshot repo (~/.dsh/.git)'])
  try {
    const index = readFileSync(dshHomePath('memory', 'MEMORY.md'), 'utf8')
    checks.push([true, `memory store: ${(index.match(/^- /gm) ?? []).length} entries`])
  } catch {
    checks.push([false, 'memory store: empty (the agent fills it via memory_save)'])
  }
  return checks
}

async function setupChecks(screen) {
  for (const [ok, text] of await systemChecks()) {
    screen.line(`  ${ok ? ui.success('+') : ui.danger('×')} ${text}`)
  }
  await pause(screen)
}

// ── the page ───────────────────────────────────────────────────────────────

/**
 * Run the setup page.
 * @param {import('./term.js').Screen} screen - the live screen.
 * @returns {Promise<'done' | 'skipped'>} whether the first-run marker was written.
 */
export async function runSetup(screen) {
  screen.blank()
  screen.write(box(['dsh-agent setup'], { title: 'first run' }))
  screen.line(ui.muted(wrap('Each step is optional; esc backs out of anything. An unfinished setup simply shows again next launch.', 76)))
  for (;;) {
    const pick = await select(screen, {
      title: 'What would you like to set up?',
      items: [
        { label: 'Telegram', hint: 'chat with this Pi from your phone' },
        { label: 'SOUL.md', hint: 'the persona read into every session' },
        { label: 'System check', hint: 'model, key, cron, snapshots, memory' },
        { label: 'Finish', hint: "done — don't show this on launch" },
        { label: 'Exit for now', hint: 'shows again next launch' },
      ],
      footer: '↑↓ move · enter select · esc exit',
    })
    if (pick === undefined || pick === 4) return 'skipped'
    if (pick === 0) await setupTelegram(screen)
    if (pick === 1) await setupSoul(screen)
    if (pick === 2) await setupChecks(screen)
    if (pick === 3) {
      writeFileSync(SETUP_DONE(), `${new Date().toISOString()}\n`)
      screen.line(ui.success('  Setup marked complete — /setup reopens this page anytime.'))
      await pause(screen, 'press enter to start your session')
      return 'done'
    }
  }
}

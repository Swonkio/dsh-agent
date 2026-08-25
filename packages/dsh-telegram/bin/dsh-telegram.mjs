#!/usr/bin/env node
/**
 * dsh-telegram — CLI front for the gateway.
 *
 *   dsh-telegram set-token <token>    store the @BotFather token (0600)
 *   dsh-telegram allow <chatId>       authorize a chat (and make it the default)
 *   dsh-telegram send [chatId] <text>  queue a message (drained by the gateway)
 *   dsh-telegram run                  start polling (ctrl+c to stop)
 *
 * Run it in a terminal or under tmux when you want Telegram alive; cron
 * deliveries queue in the outbox and flush whenever the gateway runs next.
 *
 * @module dsh-telegram/bin/dsh-telegram
 */

import process from 'node:process'
import { readConfig, writeConfig, runGateway, enqueue } from '../lib/gateway.js'

const usage = `usage: dsh-telegram <command>
  set-token <token>    store the bot token from @BotFather
  allow <chatId>       authorize a chat id and set it as the delivery default
  send [chatId] <text> queue a message for delivery (default chat when omitted)
  run                  start the gateway (long-poll until ctrl+c)

First run: message your bot once, read the chat id it replies with, then:
  dsh-telegram allow <that-id>`

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined) {
    console.error(usage)
    process.exit(1)
  }

  if (command === 'set-token') {
    const token = rest[0]
    if (token === undefined || token === '') {
      console.error('usage: dsh-telegram set-token <token>   (from @BotFather, /newbot)')
      process.exit(1)
    }
    const config = await readConfig()
    config.token = token
    await writeConfig(config)
    console.log('token stored in ~/.dsh/telegram/config.json (0600). Now run: dsh-telegram run')
    return
  }

  if (command === 'allow') {
    const chatId = Number(rest[0])
    if (!Number.isInteger(chatId)) {
      console.error('usage: dsh-telegram allow <chatId>   (the id the bot replied with)')
      process.exit(1)
    }
    const config = await readConfig()
    config.allowedChatIds = [...new Set([...(config.allowedChatIds ?? []), chatId])]
    config.defaultChatId ??= chatId
    await writeConfig(config)
    console.log(`authorized chat ${chatId} (default delivery: ${config.defaultChatId})`)
    return
  }

  if (command === 'send') {
    const args = [...rest]
    const maybeId = Number(args[0])
    const chatId = Number.isInteger(maybeId) ? args.shift() : undefined
    const text = args.join(' ').trim()
    if (text === '') {
      console.error('usage: dsh-telegram send [chatId] <text>')
      process.exit(1)
    }
    await enqueue(text, chatId === undefined ? undefined : Number(chatId))
    console.log('queued; the running gateway delivers it on its next loop')
    return
  }

  if (command === 'run') {
    await runGateway()
    return
  }

  console.error(`unknown command "${command}"\n\n${usage}`)
  process.exit(1)
}

main().catch(error => {
  console.error(`dsh-telegram: ${error.message}`)
  process.exit(1)
})

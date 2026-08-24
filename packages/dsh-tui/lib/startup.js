/**
 * The terminal app's command-line provider: it parses this surface's flags and
 * publishes them as the ordinary `tuiStartup` service. The runner is a plain
 * consumer that injects it, exactly as the web and headless surfaces do with
 * their own providers.
 * @module dsh-tui/startup
 */

import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service key provided by this plugin and injected by the runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** Permission preset names the base composition ships. */
const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * This app's command: the flags, their descriptions, and the help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand() {
  return new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal session: stream one agent, answer its questions, and keep the conversation.')
    .helpOption('-h, --help', 'show this help')
    .argument('[prompt...]', 'an opening prompt; the session stays interactive after it unless --print is set')
    .option('-p, --print', 'run the opening prompt non-interactively, print the reply, and exit')
    .option('-c, --continue', 'resume the most recent session started in this working directory')
    .option('-r, --resume [sessionId]', 'resume a session by id, or pick one from a list when no id is given')
    .option('--provider <name>', 'provider route for this session (defaults to the saved selection)')
    .option('--model <id>', 'model id for this session (defaults to the saved selection)')
    .option('--max-tokens <n>', 'output token cap for each request', value => {
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--max-tokens must be a positive integer, got ${value}`)
      return parsed
    })
    .option('--permission-mode <mode>', `permission preset for this session (${PERMISSION_MODES.join(' | ')})`)
    .option('--no-thinking', 'hide streamed reasoning text')
    .option('--verbose', 'render full tool output instead of a bounded preview')
    .addHelpText('after', `
Keys:
  enter          send        ctrl+j / alt+enter  newline
  tab            complete a /command or an @path
  ctrl+o         reopen the last tool result in full
  esc            clear the prompt, or interrupt a running turn
  ctrl+c twice   exit (ctrl+d also exits)
  /help          every command this build composes

Examples:
  dsh --profile tui                                  open an empty session
  dsh --profile tui "fix the failing test"           open with a first prompt
  dsh --profile tui -c                               continue this directory's last session
  dsh --profile tui -r                               pick a session to resume
  dsh --profile tui --model qwen3.8-27b-medium       pin one model for this session
  dsh --profile tui -p "summarize README.md"         one-shot, no terminal UI
`)
}

/**
 * Parse and provide this invocation as an ordinary Cordis service. On `--help`
 * or a rejected invocation nothing is provided, so the runner never mounts.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
  const program = tuiCommand()
  program.action((promptWords, options) => {
    const mode = options.permissionMode
    if (mode !== undefined && !PERMISSION_MODES.includes(mode)) {
      program.error(`error: --permission-mode must be one of ${PERMISSION_MODES.join(', ')}, got ${JSON.stringify(mode)}`)
    }
    const prompt = promptWords.join(' ').trim()
    if (options.print === true && prompt === '') {
      program.error('error: --print needs an opening prompt, for example: dsh --profile tui -p "summarize README.md"')
    }
    if (options.continue === true && options.resume !== undefined) {
      program.error('error: --continue and --resume select the same thing; pass only one')
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      prompt,
      print: options.print === true,
      continueLast: options.continue === true,
      // `-r` with no id is `true`: the runner then offers the picker.
      resume: options.resume === true ? 'pick' : options.resume,
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
      permissionMode: mode,
      thinking: options.thinking !== false,
      verbose: options.verbose === true,
    })
  })
  parseCmdline(ctx, program)
}

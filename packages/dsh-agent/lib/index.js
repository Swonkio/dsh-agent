/**
 * dsh-agent — the interactive terminal surface. It mounts over `dsh-base` with
 * no Host, HTTP, or browser layer: one Agent created (or resumed) in process,
 * the durable session feed rendered to scrollback, and stdin owned by this
 * plugin until the user exits.
 *
 * The seams it fills are the ones every dsh client fills: an approval answerer
 * (`approval/request`), a user-questions provider, and a command adapter over
 * `ctx.commands`. Everything else — tools, sandbox, skills, subagents, plan
 * mode, compaction — is the base composition, untouched.
 *
 * @module dsh-agent
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  box, ellipsize, litText, screenWidth, Screen, select, watchKeys, width, wrap,
} from './term.js'
import { glyph, PULSE, pulseColor, ui } from './theme.js'
import { keyboard } from './keys.js'
import { Editor } from './editor.js'
import { Renderer, renderMarkdown } from './render.js'
import { boot } from './boot.js'
import { runSetup, SETUP_DONE } from './setup.js'
import { draftDial, gauge, ribbon, rotor, scope, shimmer, trace } from './anim.js'
import { String1D } from './field.js'
import * as backend from './backend.js'

/** Stable Cordis plugin name. */
export const name = 'agent-runner'

/** Core services the surface cannot run without. */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools', 'agentStartup']

/** Commands this surface owns; everything else goes to `ctx.commands`. */
const LOCAL_COMMANDS = [
  ['help', 'list commands and keys'],
  ['model', 'switch the model for this session'],
  ['status', 'session, model, permissions, and context usage'],
  ['tools', 'list the tools this agent can call'],
  ['export', 'write this session to a markdown file'],
  ['jobs', 'list background jobs this session started'],
  ['clear', 'start a new session in the same directory'],
  ['resume', 'switch to another session'],
  ['thinking', 'toggle streamed reasoning'],
  ['think', 'set reasoning effort for the next message (off|low|medium|high)'],
  ['backend', 'local model: speculative decode, cache, throughput'],
  ['cache', 'save or restore the backend KV cache slot'],
  ['verbose', 'toggle full tool output'],
  ['setup', 'reopen the first-run setup page (telegram, soul, system check)'],
  ['exit', 'leave (ctrl+d, or ctrl+c twice)'],
]

/** A gap longer than this is a pause (tool call, prefill), not slow generation. */
const STALL_MS = 1000

/** How much each new interval moves the decayed average. */
const RATE_SMOOTHING = 0.15

/** Repaints of decode speed kept for the status-line sparkline. */
const RATE_HISTORY = 48

/**
 * Width of the token oscilloscope in character cells, and the string's own
 * resolution. Braille packs two pixel columns per cell, so the simulation runs
 * at twice the display width and every pixel column is a real sample rather
 * than an interpolation.
 */
/** Cells the rate-history trace occupies while tokens are flowing. */
const TRACE_CELLS = 10

const SCOPE_CELLS = 18

/** The instrument area's width, held constant across turn phases. */
const INSTRUMENT_CELLS = SCOPE_CELLS + TRACE_CELLS + 3
const TOKEN_STRING_CELLS = SCOPE_CELLS * 2

/** Impulse per arriving token, and integration steps per repaint. Tuned together. */
const PLUCK_STRENGTH = 0.22
const STRING_STEPS_PER_PAINT = 3

/**
 * Tokens one forward pass can yield at best: `--spec-draft-n-max` plus the
 * model's own token. Only the dial's full-scale point, so a backend running a
 * different draft depth reads slightly off rather than wrong.
 */
const SPEC_DRAFT_CEILING = 7

/** Render a token count as a short human figure. */
function short(count) {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/** Format an epoch-ms timestamp as a compact local date. */
function when(time) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const now = Date.now()
  const day = 86_400_000
  if (now - date.getTime() < day) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The terminal surface: one screen, one keyboard, one live Agent. */
export class AgentSurface {
  constructor(ctx, startup, exit) {
    this.ctx = ctx
    this.startup = startup
    this.exit = exit
    this.screen = new Screen()
    this.verbose = startup.verbose === true
    this.thinking = startup.thinking !== false
    this.autoAllow = new Set()
    this.tokens = { input: 0, output: 0 }
    this.activity = 'Working'
    this.turnStart = 0
    /** A `/think` level armed for the next prompt only; undefined uses the backend default. */
    this.effort = undefined
    this.title = undefined
    this.lastInterrupt = 0
    this.disposers = []
    this.quiet = startup.print === true
    this.stream = { tokens: 0, last: 0, interval: undefined, samples: 0 }
    this.rateHistory = []
    // Plucked by every arriving token in countDelta and stepped once per HUD
    // paint. Its shape is the generation cadence: a burst launches a train of
    // crests, a pause lets them ring down and reflect, and a stall goes flat.
    this.string = new String1D(TOKEN_STRING_CELLS)
    this.turnTokens = 0
    this.editor = new Editor({
      screen: this.screen,
      historyPath: dshHomePath('agent-history'),
      completions: (token, line) => this.complete(token, line),
      onKey: key => this.editorKey(key),
      hint: () => this.composerHint(),
      placeholder: 'ask anything — / for commands, @ for files',
    })
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Boot the surface: resolve the session, create the agent, then take stdin. */
  async run() {
    // Loader siblings mount concurrently; a half-composed tree would give the
    // agent an incomplete tool and adapter surface.
    await this.ctx.get('loader')?.await()
    // The first interactive launch stops at the setup page: Telegram pairing,
    // SOUL.md, a system check. Print mode and non-TTY runs never block on it.
    if (this.startup.print !== true && keyboard.interactive && !existsSync(SETUP_DONE())) {
      await runSetup(this.screen)
    }
    this.answerApprovals()
    this.answerQuestions()
    await this.startAgent(await this.resolveResumeTarget())
    if (this.startup.print === true) {
      await this.turn(this.startup.prompt)
      this.finishPrint()
      return
    }
    await this.banner()
    if (this.resumed) this.replay()
    if (typeof this.startup.prompt === 'string' && this.startup.prompt !== '') {
      this.screen.blank()
      this.screen.line(`${ui.accent(glyph.prompt)} ${this.startup.prompt}`)
      await this.turn(this.startup.prompt)
    }
    await this.loop()
  }

  /** Print the final assistant text for `--print` and leave. */
  finishPrint() {
    const text = this.lastAssistantText()
    const reason = this.lastTurnReason
    this.screen.hideStatus()
    if (text !== '') process.stdout.write(`${text}\n`)
    if (reason?.kind === 'error') {
      process.stderr.write(`dsh-agent: ${reason.error?.code ?? 'ERROR'}: ${reason.error?.message ?? 'the turn failed'}\n`)
    }
    this.exit(reason === undefined || reason.kind === 'completed' ? 0 : 1)
  }

  /** Create or resume the live Agent and subscribe the renderer to its feed. */
  async startAgent(resumeSessionId) {
    const defaults = this.ctx.agentDefaultModel.currentSelection()
    this.selection = {
      current: {
        provider: this.startup.provider ?? defaults.provider,
        model: this.startup.model ?? defaults.model,
        ...defaults.reasoningEffort === undefined ? {} : { reasoningEffort: defaults.reasoningEffort },
      },
      assembled: undefined,
    }
    const agentOptions = {
      provider: this.selection.current.provider,
      model: this.selection.current.model,
      ...this.startup.maxTokens === undefined ? {} : { maxTokens: this.startup.maxTokens },
    }
    const setup = agentCtx => { installModelSelection(agentCtx, this.selection) }
    this.handle = resumeSessionId === undefined
      ? await this.ctx.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
      : await this.ctx.agents.resume({ resumeSessionId, agentOptions, setup })
    this.agent = this.handle.agent
    await this.agent.whenIdle()
    this.applyPermissionMode()
    this.renderer = new Renderer(this.screen, {
      tools: this.ctx.tools,
      scope: () => this.agent,
      cwd: process.cwd(),
      verbose: this.verbose,
      thinking: this.thinking,
      onTitle: title => { this.title = title },
    })
    this.watchSession()
    this.resumed = resumeSessionId !== undefined
    // Resolved once so the footer can report occupancy rather than a bare
    // token count; a provider that advertises no capacity leaves it undefined.
    await this.resolveContextWindow()
  }

  /** Mirror the durable feed of THIS session onto the screen. */
  watchSession() {
    const dispose = this.ctx.on('session/event', (session, event) => {
      if (session.id !== this.agent.session.id) {
        if (!this.quiet && this.isDescendant(session.id)) {
          if (event.type === 'tool/call') this.activity = `subagent → ${event.data.name}`
          this.renderer.child(event)
        }
        return
      }
      this.observe(event)
      if (this.quiet) return
      try {
        this.renderer.render(event)
      } catch (error) {
        // Session-event listeners fail in isolation, so a render fault would
        // otherwise be invisible: report it and keep the feed alive.
        this.screen.line(ui.danger(`  render failed for ${event.type}: ${errorText(error)}`))
      }
    })
    this.disposers.push(dispose)
  }

  /**
   * Whether a session belongs to work this agent delegated. This surface
   * creates exactly one root agent, so every other LIVE agent in the registry
   * is a descendant of it — which also catches grandchildren, where a direct
   * `isOwnedBy` check would not.
   */
  isDescendant(sessionId) {
    const agents = this.ctx.get('agents')
    const child = agents?.get(sessionId)
    if (child === undefined || this.agent === undefined) return false
    return !agents.roots().includes(child)
  }

  /** Track the facts the status line reports. */
  observe(event) {
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'usage') this.countUsage(chunk.usage)
      else if (chunk.type === 'text-delta') {
        this.activity = 'Responding'
        this.countDelta()
      } else if (chunk.type === 'reasoning-delta') {
        this.activity = 'Thinking'
        this.countDelta()
      }
      return
    }
    if (event.type === 'assistant/message') {
      if (event.data.usage !== undefined) this.countUsage(event.data.usage)
      return
    }
    if (event.type === 'tool/call') {
      this.activity = event.data.name
      return
    }
    if (event.type === 'turn/end') {
      this.lastTurnReason = event.data.reason
      return
    }
    if (event.type === 'tool/result' || event.type === 'step/start') this.activity = 'Working'
  }

  /**
   * Fold one streamed delta into the live rate. Providers report usage only
   * when a step settles, so the figure the user watches comes from the stream
   * itself — one delta is one token here (measured at 1.02 tokens per chunk on
   * this provider).
   *
   * The rate is a decayed average of the interval BETWEEN deltas, not tokens
   * divided by wall time, because a turn is full of pauses that are not slow
   * generation: a tool call, or the prefill of a step whose context just grew.
   * Averaging those in reports a speed the model never ran at, and a windowed
   * average keeps reporting it long after the stall has passed. Intervals over
   * a second are treated as pauses and skipped entirely, so the number always
   * describes tokens actually being produced.
   */
  countDelta() {
    const now = Date.now()
    const previous = this.stream.last
    if (previous > 0) {
      const interval = now - previous
      if (interval <= STALL_MS) {
        this.stream.interval = this.stream.interval === undefined
          ? interval
          : this.stream.interval * (1 - RATE_SMOOTHING) + interval * RATE_SMOOTHING
        this.stream.samples += 1
      }
    }
    this.stream.last = now
    this.stream.tokens += 1
    this.turnTokens += 1
    // Pluck at the far end so crests travel the whole width before reflecting;
    // plucking mid-string would put the newest token in the middle of its own
    // history, which reads as noise rather than as flow.
    this.string.pluck(this.string.size - 2, PLUCK_STRENGTH)
  }

  /** The current generation speed, once enough intervals have been seen. */
  rate() {
    const value = this.rateValue()
    return value === undefined ? undefined : `${value} tok/s`
  }

  /**
   * The same figure as {@link rate} unformatted, for the animations that are
   * driven by it. The wave's phase velocity is this number, so a stalled
   * backend visibly stops moving instead of idling at a decorative speed.
   * @returns {number | undefined} tokens per second, or undefined before four intervals.
   */
  rateValue() {
    const { interval, samples } = this.stream
    if (interval === undefined || interval <= 0 || samples < 4) return undefined
    return Math.round(1000 / interval)
  }

  /** Fold one provider usage record into the session counters. */
  countUsage(usage) {
    if (usage === undefined) return
    this.tokens.input += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    this.tokens.output += usage.outputTokens ?? 0
  }

  /** Apply `--permission-mode` to the live session, when one was asked for. */
  applyPermissionMode() {
    const mode = this.startup.permissionMode
    if (mode === undefined) return
    try {
      this.ctx.get('permissionPresets')?.set(this.agent.session, mode)
    } catch (error) {
      this.warn(`could not select the ${mode} preset: ${errorText(error)}`)
    }
  }

  // ── the conversation loop ────────────────────────────────────────────────

  /** Read, dispatch, repeat, until the user leaves. */
  async loop() {
    for (;;) {
      this.screen.blank()
      const line = await this.editor.read(`${glyph.prompt} `)
      if (line === undefined) {
        this.leave()
        return
      }
      if (line === null) {
        if (Date.now() - this.lastInterrupt < 3000) {
          this.leave()
          return
        }
        this.lastInterrupt = Date.now()
        this.screen.line(ui.muted('  (press ctrl+c again to exit, or ctrl+d)'))
        continue
      }
      this.lastInterrupt = 0
      const text = line.trim()
      if (text === '') continue
      try {
        if (text.startsWith('/')) {
          if (await this.command(text) === 'exit') return
          continue
        }
        await this.turn(text)
      } catch (error) {
        // A failed turn is a durable `turn/end` the renderer already reported;
        // reaching here means the surface itself threw, and losing the session
        // over it would be worse than reporting and asking again.
        this.screen.hideStatus()
        this.warn(ui.danger(errorText(error)))
      }
    }
  }

  /**
   * Refresh the backend snapshot the HUD reads.
   *
   * Deliberately fire-and-forget: the HUD repaints 20 times a second and must
   * never await anything, so this is kicked off at turn boundaries and the
   * rows render whatever snapshot happens to be current. A backend that is
   * absent or slow leaves the cells empty rather than stalling a frame.
   */
  refreshBackend() {
    backend.stats().then(stats => { this.backendStats = stats }).catch(() => {
      // Introspection is decoration; a failed probe keeps the previous
      // snapshot and the HUD simply shows one fewer cell.
    })
  }

  /** Send one prompt and stream its turn to quiescence. */
  async turn(text) {
    this.refreshBackend()
    this.turnStart = Date.now()
    this.activity = 'Thinking'
    this.stream = { tokens: 0, last: 0, interval: undefined, samples: 0 }
    this.rateHistory = []
    // Plucked by every arriving token in countDelta and stepped once per HUD
    // paint. Its shape is the generation cadence: a burst launches a train of
    // crests, a pause lets them ring down and reflect, and a stall goes flat.
    this.string = new String1D(TOKEN_STRING_CELLS)
    this.turnTokens = 0
    const watcher = this.watchTurnKeys()
    this.showStatus()
    try {
      this.agent.followup(createUserMessage({
        content: [{ type: 'text', text: this.applyEffort(text) }],
        source: { kind: 'user' },
      }))
      await this.agent.whenIdle()
    } finally {
      this.screen.hideStatus()
      watcher.stop()
      this.turnKeys = undefined
      this.renderer.flush()
    }
    await this.flushSession()
    this.refreshPressure()
  }

  /** Persist the turn before the next prompt, so ctrl+c never loses it. */
  async flushSession() {
    try {
      await this.ctx.sessions.flush(this.agent.session)
    } catch (error) {
      this.warn(`session flush failed: ${errorText(error)}`)
    }
  }

  /**
   * Own the keyboard while a turn streams: esc/ctrl+c interrupt, and anything
   * typed is queued as the next prompt rather than dropped — the agent claims
   * it at the next turn boundary, so the user never waits to type.
   */
  watchTurnKeys() {
    let cancelled = false
    this.pending = ''
    this.turnKeys = watchKeys(key => {
      const sequence = typeof key.sequence === 'string' ? key.sequence : ''
      if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) {
        if (this.pending !== '') {
          this.pending = ''
          return
        }
        if (cancelled && key.ctrl === true) {
          this.leave()
          return
        }
        cancelled = true
        this.activity = 'Interrupting'
        this.agent.cancel({ kind: 'user' })
        return
      }
      if (key.name === 'paste') {
        // A paste mid-turn is type-ahead like any other input; newlines become
        // spaces so the queued prompt stays one message.
        this.pending += key.text.replace(/\s+/g, ' ')
        return
      }
      if (key.ctrl === true || key.alt === true) return
      if (key.name === 'return') {
        const text = this.pending.trim()
        this.pending = ''
        if (text !== '') this.enqueue(text)
        return
      }
      if (key.name === 'backspace') {
        this.pending = this.pending.slice(0, -1)
        return
      }
      if (sequence.length === 1 && sequence >= ' ') this.pending += sequence
    })
    return this.turnKeys
  }

  /** Queue one prompt typed while the turn was still running. */
  enqueue(text) {
    if (text.startsWith('/')) {
      this.note(ui.warning('slash commands run between turns — send it again at the prompt'))
      return
    }
    this.agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    this.note(ui.muted(`queued: ${ellipsize(text, screenWidth() - 12)}`))
  }

  /**
   * The animated HUD under a running turn.
   *
   * Two rows rather than one: the first is the turn's own state (what it is
   * doing, how fast, how long), the second is the backend's (how well the
   * draft head is landing, how full the context is). They are separated
   * because they answer different questions — the first tells the user whether
   * to keep waiting, the second whether the machine is configured well — and
   * mixing them into one row made both harder to read.
   *
   * Repaints at 20fps instead of the default 10: the wave's phase velocity is
   * the model's decode rate, and at 10fps a fast backend aliases into a
   * stutter that looks like a stall.
   */
  showStatus() {
    this.screen.showStatus(frame => {
      const elapsed = Math.round((Date.now() - this.turnStart) / 1000)
      const rate = this.rate()
      const live = this.rateValue()
      if (live !== undefined) {
        this.rateHistory.push(live)
        if (this.rateHistory.length > RATE_HISTORY) this.rateHistory.shift()
      }
      const out = Math.max(this.turnTokens, this.tokens.output)
      const waiting = this.turnTokens === 0 && elapsed >= 8
      const activity = waiting ? 'Waiting for the first token' : this.activity
      const label = activity === 'Thinking' ? shimmer(activity, frame) : ui.bold(activity)

      // ONE instrument slot, at a fixed width and a fixed column. What sits in
      // it depends on what is true right now: the plucked-string scope once
      // tokens are arriving and it has a waveform to show, the light ribbon
      // before that, when the scope would be a flat line and the rate trace an
      // empty row. Holding the slot's geometry constant is what stops the line
      // from jumping as a turn moves between phases.
      const flowing = live !== undefined
      const facts = [`${elapsed}s`, ...rate === undefined ? [] : [rate], `${short(out)} tokens`]
      const cols = screenWidth()
      const room = cols - width(`${activity}${facts.join(' · ')}`) - 12
      // The instrument area is a fixed-width region, divided differently by
      // phase rather than grown and shrunk. Letting the trace appear only when
      // flowing would push the facts sideways exactly as a turn gets busy,
      // which is the worst moment for the line to move under the reader's eye.
      const slot = room < INSTRUMENT_CELLS
        ? ''
        : flowing
          ? `${scope(this.string, SCOPE_CELLS)} ${trace(this.rateHistory, TRACE_CELLS)}  `
          : `${ribbon(frame, SCOPE_CELLS + TRACE_CELLS + 1)}  `
      const top = `${rotor(frame)} ${label}  ${slot}${ui.muted(facts.join(' · '))}`

      const rows = [top]
      const backend = this.backendRow(cols)
      if (backend !== undefined) rows.push(backend)
      if (this.pending !== undefined && this.pending !== '') rows.push(this.pendingRow())
      return rows
    }, 20)
  }

  /** The queued-prompt row, shown only while something is waiting to send. */
  pendingRow() {
    return `  ${ui.accent(glyph.prompt)} ${ellipsize(this.pending, screenWidth() - 6)}`
  }

  /**
   * The backend row: draft efficiency, context pressure, and an indeterminate
   * sweep. `backendStats` is refreshed off the paint path, so this only ever
   * reads the last snapshot and never blocks a frame on the network.
   * @param {number} frame - the repaint counter.
   * @param {number} cols - the usable terminal width.
   * @returns {string} one rendered row.
   */
  backendRow(cols) {
    const cells = []
    const perStep = this.backendStats?.tokensPerStep
    // A draft figure below 1.05 means the head is contributing nothing
    // measurable yet; a dial pinned at empty is worse than no dial.
    if (perStep !== undefined && perStep > 1.05) {
      cells.push(`${ui.muted('draft')} ${draftDial(perStep, SPEC_DRAFT_CEILING, 8)} ${perStep.toFixed(1)}`)
    }
    // A context bar reading 0% is noise: it says only that the turn has not
    // started, which the row above already says better.
    const context = this.measureContext()
    if (context !== undefined && context.percent > 0) {
      cells.push(`${ui.muted('ctx')} ${this.contextBar(10)}`)
    }
    // No readings, no row. The status collapses to a single line rather than
    // reserving space for instruments that have nothing to report.
    if (cells.length === 0) return undefined
    return `  ${cells.join(ui.line('  │  '))}`
  }

  /**
   * The line under the composer: what this session is, in the space a reader
   * glances at between prompts. It replaces the per-turn footer, so the
   * transcript keeps only conversation.
   */
  composerHint() {
    const { provider, model } = this.selection?.current ?? {}
    if (model === undefined) return ''
    const facts = [ui.text(model)]
    // Context pressure is the one number here that changes what happens next,
    // because crossing the threshold spends a turn on summarization instead of
    // on the user's work.
    const bar = this.contextBar(10)
    if (bar !== undefined) facts.push(bar)
    else if (this.pressure !== undefined) facts.push(this.pressure)
    if (this.tokens.output > 0) facts.push(`${short(this.tokens.input)} in · ${short(this.tokens.output)} out`)
    // Armed effort is shown because it is invisible otherwise: the directive
    // rides inside the next message and is consumed by the chat template.
    if (this.effort !== undefined) facts.push(ui.accent(`think:${this.effort}`))
    if (this.autoAllow.size > 0) facts.push(`${this.autoAllow.size} auto-allowed`)
    facts.push(`${glyph.prompt} enter sends · ctrl+j newline`)
    return facts.join('  ·  ')
  }

  /**
   * Refresh the cached context reading. Measurement walks the whole surface,
   * so it happens once per turn rather than on every composer repaint.
   */
  refreshPressure() {
    this.pressure = this.contextPressure()
    this.percent = this.contextPercent()
  }

  /** Context occupancy as a plain number, for the meter. */
  contextPercent() {
    return this.measureContext()?.percent
  }

  /**
   * Measure context occupancy once, for every surface that reports it.
   *
   * The composer hint, the turn HUD and `/status` all show the same figure;
   * measuring separately in each let them disagree within a frame, since the
   * session can grow between calls.
   * @returns {{ used: number, capacity: number, percent: number } | undefined}
   *   the occupancy, or undefined when either half is unavailable.
   */
  measureContext() {
    const meterService = this.ctx.get('tokenMeter')
    const capacity = typeof this.contextWindow === 'number' && this.contextWindow > 0 ? this.contextWindow : undefined
    if (meterService === undefined || capacity === undefined) return undefined
    try {
      const measured = meterService.measure(this.agent.session)
      const used = measured.totalTokens ?? measured.surfaceTokens
      if (typeof used !== 'number') return undefined
      return { used, capacity, percent: Math.min(100, Math.round((used / capacity) * 100)) }
    } catch {
      return undefined
    }
  }

  /**
   * The context bar: how full the window is, as a filled meter, a percentage,
   * and the counts behind it.
   *
   * All three are shown because they answer different questions. The bar is
   * read at a glance, the percentage is what the compaction threshold is
   * stated in, and the raw counts are the only form that says how much room is
   * actually left — a percentage of an unknown window is not actionable.
   * @param {number} cells - width of the meter in cells.
   * @returns {string | undefined} the rendered bar, or undefined when unmeasured.
   */
  contextBar(cells) {
    const context = this.measureContext()
    if (context === undefined) return undefined
    const { used, capacity, percent } = context
    return `${gauge(percent / 100, cells)} ${String(percent).padStart(2)}%`
      + ` ${ui.muted(`${short(used)}/${short(capacity)}`)}`
  }

  /** Measured context occupancy for the status/footer lines. */
  contextPressure() {
    const meter = this.ctx.get('tokenMeter')
    if (meter === undefined) return undefined
    try {
      const measured = meter.measure(this.agent.session)
      const total = measured.totalTokens ?? measured.surfaceTokens
      if (typeof total !== 'number') return undefined
      const capacity = typeof this.contextWindow === 'number' && this.contextWindow > 0 ? this.contextWindow : undefined
      if (capacity === undefined) return `${short(total)} ctx`
      const percent = Math.min(100, Math.round((total / capacity) * 100))
      // Compaction is the harness's job, but its approach is the user's
      // business: the figure warms up as the window fills.
      const paint = percent >= 85 ? ui.danger : percent >= 70 ? ui.warning : text => text
      return paint(`${percent}% ctx`)
    } catch {
      return undefined
    }
  }

  /** Resolve and cache the selected model's advertised context window. */
  async resolveContextWindow() {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return
    try {
      const { provider, model } = this.selection.current
      const info = await llm.resolveModelInfo(provider, model)
      this.contextWindow = info?.context?.contextWindow
      // The same lookup answers whether this route accepts images, which the
      // banner reports so the answer is visible before the model has to say it.
      this.vision = info?.inputModalities?.includes('image') === true
    } catch {
      this.contextWindow = undefined
    }
  }

  // ── resume ───────────────────────────────────────────────────────────────

  /** Decide which session this invocation opens. */
  async resolveResumeTarget() {
    const { resume, continueLast } = this.startup
    if (typeof resume === 'string' && resume !== 'pick') return SessionId(resume)
    // A fresh session asks persistence nothing: listing (and titling) the
    // history is work only the two resume paths need.
    if (continueLast !== true && resume !== 'pick') return undefined
    const sessions = await this.recentSessions()
    if (resume === 'pick') return this.pickSession(sessions)
    // Skip empty sessions. A run that opened and exited without a prompt
    // leaves a session with no content, and resuming THAT instead of the real
    // last conversation is worse than useless — it looks like the history was
    // lost. The heuristic titler names a session from its first human message,
    // so a missing title is a reliable "nothing was said here".
    const here = sessions.find(entry => entry.cwd === process.cwd() && entry.title !== undefined)
      ?? sessions.find(entry => entry.cwd === process.cwd())
    if (here === undefined) {
      this.warn('no earlier session in this directory; starting a new one')
      return undefined
    }
    return SessionId(here.id)
  }

  /** List persisted sessions, newest first, with titles when they are cheap. */
  async recentSessions(limit = 15) {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return []
    let headers
    try {
      headers = await persistence.list()
    } catch (error) {
      this.warn(`could not list sessions: ${errorText(error)}`)
      return []
    }
    const recent = [...headers]
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, limit)
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return recent
    return Promise.all(recent.map(async header => {
      try {
        const title = await query.readTitle(header.id)
        return { ...header, title: title?.title }
      } catch {
        return header
      }
    }))
  }

  /** Offer the recent-session menu. */
  async pickSession(sessions) {
    if (sessions.length === 0) {
      this.warn('no earlier sessions found; starting a new one')
      return undefined
    }
    const chosen = await select(this.screen, {
      title: ui.bold('Resume a session'),
      items: sessions.map(entry => ({
        label: entry.title ?? ui.muted('(empty session)'),
        hint: `${when(entry.createdAt)}${entry.cwd === undefined ? '' : ` · ${entry.cwd}`}`,
      })),
      footer: 'enter to resume · esc to start a new session',
    })
    return chosen === undefined ? undefined : SessionId(sessions[chosen].id)
  }

  /** Print a compact recap of the transcript a resumed session already holds. */
  replay() {
    // `user/message` events ARE the message; `assistant/message` wraps one.
    // Synthetic injections share the user event type, so the human prompts are
    // the ones whose source says `user`.
    const surface = this.agent.session.events.flatMap(event => {
      if (event.type === 'assistant/message') return [{ role: 'assistant', message: event.data.message }]
      if (event.type !== 'user/message') return []
      return event.data.source?.kind === 'user' ? [{ role: 'user', message: event.data }] : []
    })
    this.screen.blank()
    this.screen.line(ui.muted(`  resumed ${this.agent.session.id} · ${surface.length} messages`))
    for (const entry of surface.slice(-4)) {
      const text = textOf(entry.message).trim()
      if (text === '') continue
      const first = ellipsize(text.split('\n').filter(line => line.trim() !== '')[0] ?? '', screenWidth() - 6)
      const mark = entry.role === 'user' ? ui.accent(glyph.prompt) : ui.muted(glyph.info)
      this.screen.line(`  ${mark} ${ui.muted(first)}`)
    }
  }

  // ── seams every dsh client fills ─────────────────────────────────────────

  /** Answer `approval/request` for this agent from the terminal. */
  answerApprovals() {
    const dispose = this.ctx.on('approval/request', async (request, next) => {
      if (request.agent?.id !== this.agent?.id) return next()
      if (this.autoAllow.has(request.toolName)) return 'allowed-once'
      if (request.signal?.aborted === true) return 'cancelled'
      const choice = await this.withInput(() => select(this.screen, {
        title: `${ui.warning(glyph.warn)} ${ui.bold(request.toolName)} ${ui.muted('needs approval')}`
          + (request.reason === undefined ? '' : `\n  ${ui.muted(wrap(request.reason, screenWidth() - 2, '  '))}`),
        items: [
          { label: 'Allow once' },
          { label: `Allow every ${request.toolName} call this session` },
          { label: 'Reject' },
        ],
        footer: 'enter to choose · esc rejects',
      }))
      if (choice === 1) this.autoAllow.add(request.toolName)
      const allowed = choice === 0 || choice === 1
      this.renderer?.under(allowed
        ? ui.success(choice === 1 ? `allowed — every ${request.toolName} call this session` : 'allowed once')
        : ui.danger('rejected'))
      return allowed ? 'allowed-once' : 'rejected'
    })
    this.disposers.push(dispose)
  }

  /** Provide the terminal answer surface for `ask_user_question`. */
  answerQuestions() {
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) return
    const dispose = questions.registerProvider({
      ask: async request => {
        const answers = []
        for (const item of request.questions) {
          answers.push(await this.withInput(() => this.askOne(item)))
        }
        return { answers }
      },
    })
    this.disposers.push(dispose)
  }

  /** Ask one question and normalize the human's answer. */
  async askOne(item) {
    this.screen.blank()
    const plan = item.intent?.kind === 'plan-review'
    if (plan) this.screen.line(ui.bold(ui.accent('Plan for review')))
    else if (typeof item.header === 'string' && item.header !== '') this.screen.line(ui.bold(item.header))
    if (typeof item.detail === 'string' && item.detail !== '') {
      this.screen.line('')
      // A plan IS markdown; anything else is supporting prose. Both read
      // better through the same styling the assistant's own text gets.
      this.screen.line(renderMarkdown(item.detail, screenWidth() - 2))
      this.screen.line('')
    }
    this.screen.line(`${ui.thought(glyph.ask)} ${ui.bold(wrap(item.question, screenWidth()))}`)
    const options = Array.isArray(item.options) ? item.options : []
    if (options.length === 0 || item.multiSelect === true) {
      return this.askFreeform(item, options)
    }
    const chosen = await select(this.screen, {
      items: [
        ...options.map(option => ({ label: option.label, hint: option.description })),
        { label: ui.muted('Other (type an answer)') },
      ],
      footer: 'enter to answer',
    })
    if (chosen === undefined || chosen === options.length) {
      const custom = await this.editor.read('answer ')
      return { id: item.id, selected: [], ...typeof custom === 'string' && custom.trim() !== '' ? { custom: custom.trim() } : {} }
    }
    return { id: item.id, selected: [options[chosen].label] }
  }

  /** Multi-select and open questions share one numbered free-text form. */
  async askFreeform(item, options) {
    options.forEach((option, index) => {
      this.screen.line(`  ${ui.accent(String(index + 1))} ${option.label}${option.description === undefined ? '' : ui.muted(` — ${option.description}`)}`)
    })
    const hint = options.length === 0 ? 'answer ' : 'answer (numbers, or free text) '
    const raw = await this.editor.read(hint)
    const answer = typeof raw === 'string' ? raw.trim() : ''
    if (answer === '') return { id: item.id, selected: [] }
    const picked = answer.split(/[\s,]+/)
      .map(part => Number(part))
      .filter(value => Number.isInteger(value) && value >= 1 && value <= options.length)
      .map(value => options[value - 1].label)
    if (picked.length > 0 && /^[\s\d,]+$/.test(answer)) return { id: item.id, selected: picked }
    return { id: item.id, selected: picked, custom: answer }
  }

  /**
   * Run an interactive prompt from inside a running turn: the status line and
   * the interrupt watcher both own stdin, so they stand down for the question.
   */
  async withInput(operation) {
    const hadStatus = this.screen.status !== undefined
    this.screen.hideStatus()
    // The turn watcher is listening on the same stdin: without standing it
    // down, every key answering the question is ALSO typed into the queued
    // prompt.
    this.turnKeys?.pause()
    try {
      return await operation()
    } finally {
      this.turnKeys?.resume()
      if (hadStatus) this.showStatus()
    }
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /**
   * Completion source for the composer: slash commands at the start of a line,
   * `@` workspace paths anywhere in it.
   */
  complete(token, line) {
    if (token.startsWith('@')) {
      return completePath(token.slice(1)).map(path => ({ value: `@${path}` }))
    }
    if (!token.startsWith('/') || line.trimStart() !== token) return []
    const described = new Map(LOCAL_COMMANDS.map(([command, description]) => [command, description]))
    for (const command of this.registryCommands()) {
      if (!described.has(command.name)) described.set(command.name, command.description)
    }
    return [...described.entries()]
      .sort(([left], [right]) => left < right ? -1 : 1)
      .map(([command, description]) => ({ value: `/${command}`, hint: description }))
      .filter(candidate => candidate.value.startsWith(token))
  }

  /** Keys the composer hands to the surface; `true` means it was handled. */
  editorKey(key) {
    if (key.ctrl === true && key.name === 'o') {
      this.editor.eraseBlock()
      this.expandLastResult()
      this.editor.paint(true)
      return true
    }
    return false
  }

  /**
   * Reasoning-effort directives understood by the Sharp chat template.
   *
   * llama.cpp ignores the wire `reasoning_effort` field entirely — verified by
   * sending `xhigh` and `none` to an entry pinned at `low` and getting `low`
   * behaviour both times. The template instead scans every system and user
   * message for these literal markers, so the only way to move effort from a
   * client is to put one in the text. Effort is otherwise fixed per llama-swap
   * entry and would need a config edit and a model reload to change.
   */
  static EFFORT = {
    off: '<|think_off|>',
    none: '<|think_off|>',
    minimal: '<|think_low|>',
    low: '<|think_low|>',
    medium: '<|think_medium|>',
    high: '<|think_xhigh|>',
    xhigh: '<|think_xhigh|>',
    max: '<|think_xhigh|>',
  }

  /**
   * The levels offered to the user, one per distinct behaviour.
   *
   * The template has four tiers, not eight: `high`, `xhigh` and `max` all
   * resolve to the same marker, as do `off`/`none` and `low`/`minimal`. Every
   * spelling is ACCEPTED because they are the words llama.cpp's
   * `reasoning_effort` and the chat template already use — a command that
   * rejects the vocabulary the rest of the stack speaks is just a trap — but
   * only the canonical four are advertised, so the menu does not imply
   * distinctions the model cannot make.
   */
  static EFFORT_OFFERED = ['off', 'low', 'medium', 'high']

  /**
   * Arm a one-shot effort directive for the next prompt.
   * @param {string} argument - the requested level, or empty to report the current arming.
   */
  setEffort(argument) {
    const level = argument.trim().toLowerCase()
    if (level === '') {
      this.note(this.effort === undefined
        ? ui.muted('reasoning effort: the backend default — /think off|low|medium|high to override the next message')
        : `next message: ${ui.accent(this.effort)}`)
      return
    }
    if (level === 'default' || level === 'reset') {
      this.effort = undefined
      this.note(ui.muted('reasoning effort back to the backend default'))
      return
    }
    if (!Object.hasOwn(AgentSurface.EFFORT, level)) {
      this.warn(`unknown effort "${level}" — use ${AgentSurface.EFFORT_OFFERED.join(', ')}, or default`)
      return
    }
    this.effort = level
    // Say which tier it resolved to when the word the user typed is an alias,
    // so `xhigh` and `high` visibly landing in the same place is not mistaken
    // for the command ignoring the difference.
    const marker = AgentSurface.EFFORT[level].replace(/[<>|]|think_/g, '')
    const resolved = marker === level ? '' : ui.muted(` (${marker})`)
    this.note(`next message runs at ${ui.accent(level)} reasoning effort${resolved}`)
  }

  /**
   * Prefix one outgoing prompt with the armed directive and disarm it.
   *
   * The marker is consumed by the template and never reaches the model as
   * prose, but it does enter durable session history, which is what makes the
   * effort of a past turn visible when the log is read back.
   * @param {string} text - the user's prompt.
   * @returns {string} the prompt, with a directive prepended when one is armed.
   */
  applyEffort(text) {
    if (this.effort === undefined) return text
    const marker = AgentSurface.EFFORT[this.effort]
    this.effort = undefined
    return `${marker} ${text}`
  }

  /**
   * Report what the local backend is doing, for the figures the OpenAI route
   * does not carry. Silent about a remote provider rather than reporting a
   * missing local backend as a fault.
   */
  async showBackend() {
    const stats = await backend.stats()
    if (stats === undefined) {
      this.note(ui.muted('no local llama-swap backend on this route'))
      return
    }
    const ceiling = SPEC_DRAFT_CEILING
    const perStep = stats.tokensPerStep
    const rows = [
      ['model', ui.text(stats.model)],
      ['drafting', `${draftDial(perStep, ceiling, 16)} ${perStep === undefined
        ? ui.muted('no decode steps yet')
        : `${perStep.toFixed(2)} tok/step ${ui.muted(`of ${ceiling} max`)}`}`],
      ['decode', `${Math.round(stats.decodePerSecond ?? 0)} tok/s`],
      ['prefill', `${Math.round(stats.prefillPerSecond ?? 0)} tok/s`],
      ['served', `${short(stats.promptTotal)} in · ${short(stats.predictedTotal)} out ${ui.muted('since load')}`],
    ]
    this.screen.blank()
    this.screen.line(ui.bold('Backend'))
    for (const [key, value] of rows) this.screen.line(`  ${ui.muted(key.padEnd(13))} ${value}`)
  }

  /**
   * Save or restore the backend's KV cache slot.
   *
   * Deliberately manual: measured at ~100 KB per cached token on this
   * deployment, so a full context is tens of gigabytes and an automatic
   * per-turn save would write more than it ever saves. Restoring a prefix that
   * no longer matches the conversation costs an ordinary prefill, so the
   * failure mode is lost time, never a wrong answer.
   * @param {string} argument - `save` or `restore`, optionally with a slot name.
   */
  async cacheSlot(argument) {
    const [action, ...rest] = argument.trim().split(/\s+/)
    if (action !== 'save' && action !== 'restore') {
      this.warn('usage: /cache save|restore [name]')
      return
    }
    const name = (rest.join('-') || String(this.agent.session.id)).replace(/[^\w.-]/g, '-')
    const file = `${name}.bin`
    this.note(ui.muted(`${action === 'save' ? 'saving' : 'restoring'} ${file}…`))
    const result = await backend.slot(action, file)
    if (result === undefined) {
      this.warn(`cache ${action} failed — the backend needs --slot-save-path and a local route`)
      return
    }
    const tokens = result.n_saved ?? result.n_restored
    const bytes = result.n_written ?? result.n_read
    const ms = result.timings?.save_ms ?? result.timings?.restore_ms
    this.note(`${ui.success(glyph.done)} ${action}d ${short(tokens ?? 0)} tokens`
      + `${bytes === undefined ? '' : ui.muted(` · ${(bytes / 1e9).toFixed(2)} GB`)}`
      + `${ms === undefined ? '' : ui.muted(` · ${Math.round(ms)}ms`)}`)
  }


  /** Commands the composition registered for this agent. */
  registryCommands() {
    try {
      return this.ctx.get('commands')?.list(this.agent) ?? []
    } catch {
      return []
    }
  }

  /**
   * Dispatch one slash line: this surface's own commands first, then the
   * plugin registry, which is where `/compact`, `/plan`, `/goal`, and every
   * other composed command lives.
   * @returns `'exit'` when the surface should stop reading input.
   */
  async command(line) {
    const [word, ...rest] = line.slice(1).split(/\s+/)
    const argument = rest.join(' ').trim()
    switch (word) {
      case 'exit': case 'quit': this.leave(); return 'exit'
      case 'help': this.help(); return undefined
      case 'status': await this.status(); return undefined
      case 'tools': this.listTools(); return undefined
      case 'model': await this.switchModel(argument); return undefined
      case 'thinking':
        this.thinking = !this.thinking
        this.renderer.options.thinking = this.thinking
        this.note(`reasoning ${this.thinking ? 'shown' : 'hidden'}`)
        return undefined
      case 'verbose':
        this.verbose = !this.verbose
        this.renderer.options.verbose = this.verbose
        this.note(`tool output ${this.verbose ? 'full' : 'bounded'}`)
        return undefined
      case 'think': this.setEffort(argument); return undefined
      case 'setup':
        await runSetup(this.screen)
        this.screen.blank()
        return undefined
      case 'backend': await this.showBackend(); return undefined
      case 'cache': await this.cacheSlot(argument); return undefined
      case 'export': this.exportSession(argument); return undefined
      case 'jobs': this.listJobs(); return undefined
      case 'clear': await this.newSession(); return undefined
      case 'resume': await this.switchSession(); return undefined
      default: return this.registryCommand(line)
    }
  }

  /** Forward one line to `ctx.commands` and render its result. */
  async registryCommand(line) {
    const commands = this.ctx.get('commands')
    if (commands === undefined) {
      this.warn(`unknown command ${line.split(/\s+/)[0]}`)
      return undefined
    }
    const controller = new AbortController()
    const watcher = this.watchTurnKeys()
    const seqBefore = this.agent.session.seq
    this.turnStart = Date.now()
    this.activity = 'Running command'
    this.showStatus()
    let execution
    try {
      // Registry commands take no images — the service signature is
      // (agent, line, signal); a fourth argument lands ON the signal and
      // crashes its abort wiring ("signal.addEventListener is not a function").
      execution = await commands.execute(this.agent, line, controller.signal)
      // A command may schedule model-visible work on the agent (plan mode
      // submits its message); it streams under the same status line.
      await this.agent.whenIdle()
    } catch (error) {
      execution = { result: { kind: 'error', text: errorText(error) } }
    } finally {
      this.screen.hideStatus()
      watcher.stop()
      this.turnKeys = undefined
      this.renderer.flush()
    }
    if (execution === undefined) {
      this.warn(`unknown command ${line.split(/\s+/)[0]} — /help lists them`)
      return undefined
    }
    const { kind, text } = execution.result
    if (typeof text === 'string' && text !== '') {
      this.screen.blank()
      this.screen.line(kind === 'error' ? ui.danger(wrap(text, screenWidth())) : renderMarkdown(text))
    } else if (kind === 'error') {
      this.warn('the command failed')
    }
    if (this.agent.session.seq !== seqBefore) {
      await this.flushSession()
      this.refreshPressure()
    }
    return undefined
  }

  /** `/help`: this surface's keys and every command the build composes. */
  help() {
    this.screen.blank()
    this.screen.line(ui.bold('Commands'))
    for (const [command, description] of LOCAL_COMMANDS) {
      this.screen.line(`  ${ui.accent(`/${command}`.padEnd(12))} ${ui.muted(description)}`)
    }
    const registry = this.registryCommands()
    if (registry.length > 0) {
      this.screen.line('')
      this.screen.line(ui.bold('Composed by plugins'))
      for (const command of registry) {
        this.screen.line(`  ${ui.accent(`/${command.name}`.padEnd(12))} ${ui.muted(ellipsize(command.description, screenWidth() - 16))}`)
      }
    }
    this.screen.line('')
    this.screen.line(ui.bold('Keys'))
    for (const [key, description] of [
      ['enter', 'send'],
      ['ctrl+j', 'newline (alt+enter works too)'],
      ['paste', 'multi-line pastes arrive as one prompt'],
      ['tab', 'complete a /command or an @path'],
      ['ctrl+o', 'reopen the last tool result in full'],
      ['esc', 'clear the prompt, or interrupt a running turn'],
      ['ctrl+c', 'interrupt, or exit when idle (twice)'],
      ['ctrl+a/e/u/k/w', 'line start / end / kill back / kill forward / kill word'],
      ['up / down', 'history, or move between lines'],
    ]) {
      this.screen.line(`  ${ui.accent(key.padEnd(15))} ${ui.muted(description)}`)
    }
  }

  /** `/status`: what this session is made of right now. */
  async status() {
    await this.resolveContextWindow()
    const { provider, model, reasoningEffort } = this.selection.current
    const preset = this.currentPreset()
    const lines = [
      ['session', this.agent.session.id],
      ['title', this.title ?? '(none yet)'],
      ['cwd', process.cwd()],
      ['model', `${provider}/${model}${reasoningEffort === undefined ? '' : ` (${reasoningEffort})`}`],
      ['context', this.contextBar(16) ?? this.contextSummary()],
      ['tokens', `${short(this.tokens.input)} in · ${short(this.tokens.output)} out`],
      ['effort', this.effort === undefined ? 'backend default' : `${this.effort} (next message)`],
      ['permissions', preset ?? 'unknown'],
      ['auto-allowed', this.autoAllow.size === 0 ? '(none)' : [...this.autoAllow].join(', ')],
      ['tools', String(this.toolNames().length)],
    ]
    this.screen.blank()
    this.screen.line(ui.bold('Session'))
    for (const [key, value] of lines) {
      this.screen.line(`  ${ui.muted(key.padEnd(13))} ${value}`)
    }
    // A local backend has properties no session field can carry; on a remote
    // route this simply adds nothing rather than reporting an absence.
    const stats = await backend.stats()
    if (stats === undefined) return
    this.screen.blank()
    this.screen.line(ui.bold('Backend'))
    this.screen.line(`  ${ui.muted('drafting'.padEnd(13))} ${draftDial(stats.tokensPerStep, SPEC_DRAFT_CEILING, 16)}`
      + ` ${stats.tokensPerStep === undefined ? ui.muted('idle') : `${stats.tokensPerStep.toFixed(2)} tok/step`}`)
    this.screen.line(`  ${ui.muted('throughput'.padEnd(13))} ${Math.round(stats.decodePerSecond ?? 0)} tok/s decode`
      + ` ${ui.muted('·')} ${Math.round(stats.prefillPerSecond ?? 0)} tok/s prefill`)
  }

  /** "12.4k of 295k (4%)" — the same reading the composer's hint row carries. */
  contextSummary() {
    const meter = this.ctx.get('tokenMeter')
    if (meter === undefined) return 'unmeasured'
    let total
    try {
      const measured = meter.measure(this.agent.session)
      total = measured.totalTokens ?? measured.surfaceTokens
    } catch {
      return 'unmeasured'
    }
    if (typeof total !== 'number') return 'unmeasured'
    const capacity = typeof this.contextWindow === 'number' && this.contextWindow > 0 ? this.contextWindow : undefined
    if (capacity === undefined) return `${short(total)} tokens`
    return `${short(total)} of ${short(capacity)} (${Math.min(100, Math.round((total / capacity) * 100))}%)`
  }

  /** The permission preset in force for this session, when the service knows. */
  currentPreset() {
    try {
      return this.ctx.get('permissionPresets')?.current(this.agent.session.events)
    } catch {
      return undefined
    }
  }

  /** Every tool name this agent can call, from the model-facing projection. */
  toolNames() {
    try {
      return this.ctx.tools.schemas(this.agent).map(schema => schema.name).sort()
    } catch {
      return []
    }
  }

  /** `/tools`. */
  listTools() {
    const names = this.toolNames()
    this.screen.blank()
    if (names.length === 0) {
      this.screen.line(ui.muted('  no tools are registered for this agent'))
      return
    }
    this.screen.line(ui.bold(`Tools (${names.length})`))
    this.screen.line(`  ${wrap(names.join(', '), screenWidth() - 2, '  ')}`)
  }

  /** `/model [id]`: switch the live selection, and future steps follow it. */
  async switchModel(argument) {
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      this.warn('no llm service is composed')
      return
    }
    if (argument !== '') {
      // Split at the FIRST slash only: a model id may contain more of them.
      const slash = argument.indexOf('/')
      const [provider, model] = slash === -1
        ? [this.selection.current.provider, argument]
        : [argument.slice(0, slash), argument.slice(slash + 1)]
      this.selection.current = { provider, model }
      await this.resolveContextWindow()
      this.note(`model: ${provider}/${model}`)
      return
    }
    const routes = []
    for (const provider of llm.listProviders()) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch {
        // A provider that cannot list (no key, endpoint down) simply offers
        // nothing here; `/model <provider>/<id>` still routes to it.
        models = []
      }
      for (const model of models) {
        routes.push({ provider: model.provider ?? provider.id, model: model.id, label: model.name ?? model.id })
      }
    }
    if (routes.length === 0) {
      this.warn('no provider advertises a model; pass one explicitly: /model <provider>/<id>')
      return
    }
    const current = routes.findIndex(route => route.provider === this.selection.current.provider && route.model === this.selection.current.model)
    const chosen = await select(this.screen, {
      title: ui.bold('Select a model'),
      initial: current === -1 ? 0 : current,
      items: routes.map(route => ({ label: route.label ?? route.model, hint: `${route.provider}/${route.model}` })),
      footer: 'enter to select · esc to keep the current model',
    })
    if (chosen === undefined) return
    this.selection.current = { provider: routes[chosen].provider, model: routes[chosen].model }
    await this.resolveContextWindow()
    this.note(`model: ${routes[chosen].provider}/${routes[chosen].model}`)
  }

  /** `/export [path]`: write the transcript as markdown. */
  exportSession(argument) {
    const target = resolve(process.cwd(), argument === '' ? `${this.agent.session.id}.md` : argument)
    try {
      writeFileSync(target, this.transcript())
    } catch (error) {
      this.warn(`could not write ${target}: ${errorText(error)}`)
      return
    }
    this.note(`exported to ${target}`)
  }

  /** The session as markdown: the human-visible turns, with tool calls named. */
  transcript() {
    const { provider, model } = this.selection.current
    const out = [
      `# ${this.title ?? 'dsh session'}`,
      '',
      `- session: \`${this.agent.session.id}\``,
      `- cwd: \`${process.cwd()}\``,
      `- model: \`${provider}/${model}\``,
      `- exported: ${new Date().toISOString()}`,
      '',
    ]
    for (const event of this.agent.session.events) {
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        out.push('## User', '', textOf(event.data).trim(), '')
        continue
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data.message).trim()
        if (text !== '') out.push('## Assistant', '', text, '')
        continue
      }
      if (event.type === 'tool/call') {
        out.push(`- **${event.data.name}** \`${ellipsize(event.data.arguments.replace(/\s+/g, ' '), 160)}\``)
        continue
      }
      if (event.type === 'tool/result' && event.data.message?.content?.[0]?.isError === true) {
        out.push(`  - failed: ${ellipsize(blockText(event.data.message.content[0].content).replace(/\s+/g, ' '), 200)}`)
      }
    }
    return `${out.join('\n')}\n`
  }

  /** `/jobs`: what this session left running in the background. */
  listJobs() {
    const jobs = this.ctx.get('jobs')
    this.screen.blank()
    if (jobs === undefined) {
      this.screen.line(ui.muted('  no job registry is composed'))
      return
    }
    const snapshots = jobs.list(this.agent)
    if (snapshots.length === 0) {
      this.screen.line(ui.muted('  no background jobs'))
      return
    }
    this.screen.line(ui.bold(`Jobs (${snapshots.length})`))
    for (const job of snapshots) {
      const age = Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)
      const color = job.status === 'running' ? ui.accent : job.status === 'done' ? ui.success : ui.warning
      this.screen.line(`  ${color(job.status.padEnd(9))} ${ui.accent(job.id.padEnd(10))} ${ellipsize(job.label, screenWidth() - 30)} ${ui.muted(`${age}s`)}`)
    }
  }

  /** `/clear`: retire this agent and open a fresh session in the same cwd. */
  async newSession() {
    await this.replaceAgent(undefined)
    this.note(`new session ${this.agent.session.id}`)
  }

  /** `/resume`: pick another session and swap the live agent for it. */
  async switchSession() {
    const target = await this.pickSession(await this.recentSessions())
    if (target === undefined) return
    await this.replaceAgent(target)
    this.replay()
  }

  /** Dispose the live agent and start another one in its place. */
  async replaceAgent(resumeSessionId) {
    for (const dispose of this.disposers.splice(0)) dispose()
    await this.handle.dispose()
    this.tokens = { input: 0, output: 0 }
    this.title = undefined
    this.answerApprovals()
    this.answerQuestions()
    await this.startAgent(resumeSessionId)
  }

  // ── output helpers ───────────────────────────────────────────────────────

  /** The welcome banner. */
  async banner() {
    const { provider, model } = this.selection.current
    const home = process.env.HOME ?? ''
    const cwd = home !== '' && process.cwd().startsWith(home) ? `~${process.cwd().slice(home.length)}` : process.cwd()
    const vision = this.vision === true
    // The reactor spins up first, then the panel resolves under it. The rail
    // carries what the session is actually bound to, so the sequence ends by
    // telling the user something rather than only looking like it did.
    if (!this.quiet) {
      // contextWindow is resolved lazily from the route, so it may not be known
      // yet at banner time; the rail simply carries one fewer cell then.
      const window = typeof this.contextWindow === 'number' && this.contextWindow > 0 ? this.contextWindow : undefined
      const rail = [model, ...vision ? ['vision'] : [], ...window === undefined ? [] : [`${short(window)} ctx`]]
      const mark = litText(`${glyph.call} dsh`, (Date.now() % 100000) / 900)
      await boot(this.screen, `  ${mark}${ui.muted('   an agent in your terminal')}`, rail)
    }
    this.screen.blank()
    const lines = box([
      `${ui.muted('model')}   ${ui.text(model)} ${ui.muted(`· ${provider}${vision ? ' · vision' : ''}`)}`,
      `${ui.muted('cwd')}     ${ui.token(cwd)}`,
      `${ui.muted('keys')}    ${ui.muted('/ commands  ·  @ files  ·  esc interrupts  ·  ctrl+o expands  ·  ctrl+d exits')}`,
    ], { full: true, title: 'SESSION' }).split('\n')
    // Revealed a row at a time: a third of a second of motion that tells the
    // eye where the panel's edges are before the first prompt lands.
    for (const line of lines) {
      this.screen.line(line)
      if (keyboard.interactive) await new Promise(resolve => { setTimeout(resolve, 38) })
    }
  }



  /** ctrl+o: reopen the most recent tool result in full. */
  expandLastResult() {
    if (this.renderer === undefined) return
    this.renderer.expandLast()
  }

  /** A one-line surface note. */
  note(text) {
    this.screen.blank()
    this.screen.line(`${ui.muted(glyph.info)} ${text}`)
  }

  /** A one-line warning. */
  warn(text) {
    this.screen.blank()
    this.screen.line(`${ui.warning(glyph.warn)} ${text}`)
  }

  /** The last assistant text in the log, for `--print`. */
  lastAssistantText() {
    const events = this.agent.session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const text = textOf(event.data.message)
      if (text.trim() !== '') return text
    }
    return ''
  }

  /** Leave cleanly: the launcher's bounded shutdown disposes the tree. */
  leave() {
    this.screen.hideStatus()
    keyboard.detach()
    this.screen.atLineStart()
    const spent = this.tokens.output > 0
      ? ui.muted(`  ${short(this.tokens.input)} in · ${short(this.tokens.output)} out`)
      : ''
    this.screen.line(`${litText(`${glyph.call} dsh`, (Date.now() % 100000) / 900)}${ui.muted('  session closed')}${spent}`)
    this.exit(0)
  }

  /** Report a failure that escaped the loop and stop with a failing code. */
  crash(error) {
    this.screen.hideStatus()
    this.screen.atLineStart()
    process.stderr.write(`dsh-agent: ${errorText(error)}\n`)
    this.exit(1)
  }
}

/**
 * Complete a workspace-relative path fragment for an `@` reference. Exported
 * for the test suite; the surface reaches it through {@link AgentSurface.complete}. Directory
 * candidates keep their trailing slash so the next tab descends into them.
 */
export function completePath(fragment) {
  const base = fragment.endsWith('/') ? fragment : dirname(fragment)
  const prefix = fragment.endsWith('/') ? '' : basename(fragment)
  const directory = resolve(process.cwd(), base === '.' ? '' : base)
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const shown = base === '.' || base === '' ? '' : `${base.replace(/\/$/, '')}/`
  return entries
    .filter(entry => entry.name.startsWith(prefix))
    .filter(entry => prefix.startsWith('.') || !entry.name.startsWith('.'))
    .filter(entry => !['node_modules', '.git'].includes(entry.name))
    .slice(0, 100)
    .map(entry => `${shown}${entry.name}${isDirectory(join(directory, entry.name)) ? '/' : ''}`)
    .sort()
}

/** Whether `path` is a directory, following links, without throwing. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Flatten a content-block list to text. */
function blockText(blocks) {
  return (blocks ?? []).filter(block => block?.type === 'text').map(block => block.text).join('')
}

/** Flatten a message's text blocks. */
function textOf(message) {
  return (message?.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Human text for any thrown value. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the terminal surface.
 * @param ctx - plugin context carrying the core services and the launcher's exit request.
 */
export function apply(ctx) {
  const startup = ctx.get('agentStartup')
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('agent-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  if (startup === undefined) return
  const surface = new AgentSurface(ctx, startup, exit)
  void surface.run().catch(error => { surface.crash(error) })
}

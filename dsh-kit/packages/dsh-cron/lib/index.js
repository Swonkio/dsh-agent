/**
 * dsh-cron — durable scheduled agentic tasks, in the Hermes shape: one
 * `cronjob` tool the model drives (it derives the five-field expression from
 * natural language itself), one `/cron` command for the human, and one
 * crontab-driven runner that fires prompts through the `cron` profile
 * whether or not any session is open.
 *
 * The tool and the runner share `lib/jobs.js`, so a job created in
 * conversation and a job fired at 3am behave identically: same spawn, same
 * timeout, same results.md entry. `run-now` hands off to the runner binary
 * detached rather than blocking the turn — a scheduled agent run takes
 * minutes, and the conversation should not wait for it.
 *
 * @module dsh-cron
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  cronHome, loadJobs, saveJobs, newId, computeNext, resultsPath,
} from './jobs.js'
import { parse } from './cron-expr.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-cron'

/** The registries this plugin writes into. */
export const inject = ['tools', 'commands', 'systemPrompt']

/** How much of the run digest may reach the prompt; it is awareness, not a log. */
const DIGEST_CAP_BYTES = 512

/** The runner script, one directory up from this module. */
const RUNNER_PATH = fileURLToPath(new URL('../bin/dsh-cron.mjs', import.meta.url))

/**
 * Register the cronjob tool and the /cron command.
 * @param {object} ctx - plugin context carrying `ctx.tools` and `ctx.commands`.
 * @param {object} config - `{ defaultProvider?, defaultModel?, jobTimeoutMs? }`.
 */
export function apply(ctx, config = {}) {
  const defaultProvider = config.defaultProvider ?? 'zai'
  const defaultModel = config.defaultModel ?? 'glm-5.3'
  const jobTimeoutMs = config.jobTimeoutMs ?? 600000

  /** One-line summary of a job for tool output and /cron. */
  const describe = job => [
    `${job.id}  ${job.enabled === false ? 'OFF' : 'on '}  ${job.schedule?.cron ?? `@${job.oneShotAt}`}${job.continuous === true ? '  [continuous]' : ''}${job.telegram === true ? '  [→telegram]' : ''}`,
    `  next: ${job.nextRun ?? '-'}  last: ${job.lastRun ?? '-'} (${job.lastStatus ?? 'never'})`,
    `  ${job.provider}/${job.model}  "${job.name}"`,
  ].join('\n')

  /**
   * The `## <iso> — <name> (<status>, <Ns>)` header lines from the tail of
   * results.md — the newest fact about scheduled work, without its bodies.
   * Failures sort ahead of successes: a job that died overnight is the one
   * fact the next conversation must not bury under routine successes.
   */
  const recentRunLines = () => {
    let headers
    try {
      const text = readFileSync(resultsPath(), 'utf8')
      headers = text.split('\n').filter(line => line.startsWith('## ')).slice(-5)
    } catch {
      return []
    }
    const status = line => /\((ok),/.test(line) ? 'ok' : 'failed'
    // Headers begin with an ISO timestamp, so plain string order is time order.
    const newestFirst = (left, right) => (left < right ? 1 : left > right ? -1 : 0)
    const failed = headers.filter(line => status(line) === 'failed').sort(newestFirst)
    const ok = headers.filter(line => status(line) === 'ok').sort(newestFirst)
    return [...failed.map(line => `FAILED ${line.slice(3)}`), ...ok.map(line => line.slice(3))]
  }

  /** Fire the runner detached for one job; results land in results.md. */
  function runDetached(jobId) {
    const child = spawn(process.execPath, [RUNNER_PATH, '--job', jobId], {
      cwd: cronHome(),
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()
  }

  ctx.tools.register(defineTool({
    name: 'cronjob',
    description:
      'Manage durable scheduled agent tasks. A job runs its prompt through a one-shot agent session on its schedule '
      + '— even with no session open — and appends what it produced to the cron results log (/cron shows it). '
      + 'SCHEDULE GRAMMAR (derive it from the user\'s words yourself): five fields "minute hour day-of-month month day-of-week", '
      + 'each `*`, a number, `a-b`, `a-b/n`, `*` with `/n`, or comma lists; e.g. "30 8 * * 1-5" = weekdays 08:30, '
      + '"*/15 * * * *" = every 15 minutes. For one-shot delays prefer `at` with a full ISO timestamp. '
      + 'Jobs default to a hosted fast model; keep local-model jobs rare (a local turn takes many minutes). '
      + 'Actions: create | list | delete | toggle | run-now.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'list', 'update', 'delete', 'toggle', 'run-now'],
        description: 'create: add a job (needs name, schedule, prompt). list: show all jobs. update: change schedule/prompt/model/name by id. delete: remove by id. toggle: enable/disable by id. run-now: fire one job immediately in the background.',
      },
      name: { type: 'string', description: 'create/update: short human label, e.g. "morning-brief".' },
      cron: { type: 'string', description: 'create/update: five-field cron expression (mutually exclusive with at).' },
      at: { type: 'string', description: 'create/update: one-shot ISO timestamp, e.g. 2026-08-25T09:00:00-04:00 (mutually exclusive with cron).' },
      prompt: { type: 'string', description: 'create/update: the prompt each run executes. Self-contained — no conversation context exists there.' },
      provider: { type: 'string', description: `create/update: provider route (default ${defaultProvider}).` },
      model: { type: 'string', description: `create/update: model id (default ${defaultModel}).` },
      continuous: { type: 'boolean', description: 'create/update: each run resumes the job\'s previous session, so recurring work remembers its own history. Needs a model with a large context window — not the local 8k one.' },
      deliverTelegram: { type: 'boolean', description: 'create/update: deliver each run\'s result to the user\'s Telegram (via the dsh-telegram outbox; delivered whenever the gateway runs).' },
      id: { type: 'string', description: 'update/delete/toggle/run-now: the job id from list.' },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.status}${value.detail === undefined ? '' : `\n${value.detail}`}` }],
    },
    async execute(args) {
      const doc = await loadJobs()

      if (args.action === 'list') {
        return { status: doc.jobs.length === 0 ? 'no jobs' : `${doc.jobs.length} job(s)`, detail: doc.jobs.map(describe).join('\n\n') }
      }

      if (args.action === 'create') {
        if ((args.cron === undefined) === (args.at === undefined)) {
          throw new Error('exactly one of cron or at is required')
        }
        if (args.prompt === undefined || args.prompt.trim() === '') throw new Error('prompt is required')
        const name = (args.name ?? args.prompt.slice(0, 24)).trim().replace(/\s+/g, '-')
        const job = {
          id: newId(),
          name,
          enabled: true,
          prompt: args.prompt.trim(),
          provider: args.provider ?? defaultProvider,
          model: args.model ?? defaultModel,
          ...(args.continuous === true ? { continuous: true, sessionId: null } : {}),
          ...(args.deliverTelegram === true ? { telegram: true } : {}),
          createdAt: new Date().toISOString(),
          lastRun: null,
          lastStatus: null,
        }
        if (args.cron !== undefined) {
          parse(args.cron)
          job.schedule = { cron: args.cron.trim() }
        } else {
          const at = new Date(args.at)
          if (Number.isNaN(at.getTime())) throw new Error(`at is not a valid timestamp: ${args.at}`)
          if (at.getTime() <= Date.now()) throw new Error('at must be in the future')
          job.oneShotAt = at.toISOString()
        }
        const next = computeNext(job)
        if (next === undefined) throw new Error('this schedule never fires (check the day/month fields)')
        job.nextRun = next
        doc.jobs.push(job)
        await saveJobs(doc)
        return { status: `created ${job.id}`, detail: `${describe(job)}\nresults will appear in ${resultsPath()}` }
      }

      if (args.action === 'update') {
        const job = doc.jobs.find(j => j.id === args.id || j.name === args.id)
        if (job === undefined) throw new Error(`no job with id or name "${args.id}"`)
        const changes = []
        if (args.name !== undefined) { job.name = args.name.trim().replace(/\s+/g, '-'); changes.push('name') }
        if (args.prompt !== undefined) { job.prompt = args.prompt.trim(); changes.push('prompt') }
        if (args.provider !== undefined) { job.provider = args.provider; changes.push('provider') }
        if (args.model !== undefined) { job.model = args.model; changes.push('model') }
        if (args.continuous !== undefined) {
          job.continuous = args.continuous
          if (args.continuous !== true) delete job.sessionId
          else if (job.sessionId === undefined) job.sessionId = null
          changes.push('continuous')
        }
        if (args.deliverTelegram !== undefined) {
          if (args.deliverTelegram) job.telegram = true
          else delete job.telegram
          changes.push('telegram delivery')
        }
        // A schedule change replaces the whole schedule arm and re-arms from
        // now; a new schedule kind drops the other arm's field.
        if (args.cron !== undefined || args.at !== undefined) {
          if (args.cron !== undefined && args.at !== undefined) throw new Error('pass cron or at, not both')
          if (args.cron !== undefined) {
            parse(args.cron)
            job.schedule = { cron: args.cron.trim() }
            delete job.oneShotAt
          } else {
            const at = new Date(args.at)
            if (Number.isNaN(at.getTime())) throw new Error(`at is not a valid timestamp: ${args.at}`)
            job.oneShotAt = at.toISOString()
            delete job.schedule
          }
          job.nextRun = computeNext(job)
          if (job.nextRun === undefined) throw new Error('this schedule never fires (check the day/month fields)')
          changes.push('schedule')
        } else if (job.nextRun === undefined) {
          job.nextRun = computeNext(job)
        }
        await saveJobs(doc)
        return { status: `updated ${job.id} (${changes.join(', ') || 'no fields'})`, detail: describe(job) }
      }

      if (args.action === 'delete') {
        const before = doc.jobs.length
        doc.jobs = doc.jobs.filter(job => job.id !== args.id && job.name !== args.id)
        if (doc.jobs.length === before) throw new Error(`no job with id or name "${args.id}"`)
        await saveJobs(doc)
        return { status: `deleted ${args.id}` }
      }

      if (args.action === 'toggle') {
        const job = doc.jobs.find(j => j.id === args.id || j.name === args.id)
        if (job === undefined) throw new Error(`no job with id or name "${args.id}"`)
        const wasEnabled = job.enabled !== false
        job.enabled = !wasEnabled
        if (job.enabled) job.nextRun = computeNext(job) ?? job.nextRun
        await saveJobs(doc)
        return { status: job.enabled ? `enabled ${job.id}` : `disabled ${job.id}`, detail: describe(job) }
      }

      if (args.action === 'run-now') {
        const job = doc.jobs.find(j => j.id === args.id || j.name === args.id)
        if (job === undefined) throw new Error(`no job with id or name "${args.id}"`)
        runDetached(job.id)
        return { status: `firing ${job.id} in the background`, detail: `output will be appended to ${resultsPath()} (check /cron in a minute)` }
      }

      throw new Error(`unknown action "${args.action}"`)
    },
  }))

  ctx.commands.register({
    name: 'cron',
    description: 'list scheduled agent tasks and recent results',
    input: { hint: '[name]' },
    handler: async invocation => {
      const filter = invocation.rawInput.trim()
      const doc = await loadJobs()
      const selected = filter === ''
        ? doc.jobs
        : doc.jobs.filter(job => job.id.includes(filter) || job.name.includes(filter))
      const jobs = doc.jobs.length === 0
        ? 'No cron jobs. Create one by asking the agent, or: cronjob create …'
        : [...selected].sort((a, b) => (a.nextRun ?? '').localeCompare(b.nextRun ?? '')).map(describe).join('\n\n')
      let results = ''
      try {
        results = (await readFile(resultsPath(), 'utf8')).trim().split('\n')
        results = `\n\n## last results\n${results.slice(-30).join('\n')}`
      } catch {
        // No results yet.
      }
      return { kind: 'success', text: `## jobs\n${jobs}${results}` }
    },
  })

  // Scheduled runs happen while nobody is watching; without this section the
  // interactive agent would not know its own automations ran overnight.
  ctx.systemPrompt.section({
    name: 'cron:digest',
    order: 23,
    text: () => {
      const lines = recentRunLines()
      if (lines.length === 0) return ''
      const failures = lines.filter(line => line.startsWith('FAILED'))
      const callout = failures.length === 0
        ? ''
        : `ATTENTION: ${failures.length} scheduled run(s) failed — mention this to the user and offer to investigate (/cron, ~/.dsh/cron/results.md).\n`
      const digest = `${callout}${lines.join('\n')}`.slice(0, DIGEST_CAP_BYTES)
      return `# Scheduled tasks\nThese automated runs fired recently (failures first; full log at ~/.dsh/cron/results.md, /cron shows jobs):\n${digest}`
    },
  })
}

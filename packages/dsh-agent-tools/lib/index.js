/**
 * dsh-agent-tools — the agent's own tool factory.
 *
 * At boot this plugin scans `$DSH_HOME/tools/*.tool.json` and registers every
 * definition as a real schema-carrying tool: name, parameters, description,
 * execution. A tool created this session therefore appears at the NEXT
 * session start (and in every surface: TUI, Telegram, cron) — the harness
 * loads tools at boot, and definitions are data, so there is no live
 * code-loading to do safely.
 *
 * Creation goes through `tool_create`, which validates, security-scans, and
 * persists; the background review may call it too. `tool_forget` removes.
 * The definition grammar and its safety rules live in lib/definitions.js.
 *
 * @module dsh-agent-tools
 */

import { spawn } from 'node:child_process'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  parseDefinition, interpolate, scrubEnv, loadDefinitionsSync,
  saveDefinition, removeDefinition, definitionPath,
} from './definitions.js'

/** Stable Cordis plugin name. */
export const name = 'agent-tools'

/** Definitions register tools; creation is itself a tool. */
export const inject = ['tools']

/** Run one definition's command: scrubbed env, bounded time, bounded output. */
function runDefinitionTool(definition) {
  return async args => {
    const command = interpolate(definition.command, args)
    return await new Promise(resolve => {
      let out = ''
      let err = ''
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: dshHomePath(),
        env: scrubEnv(process.env),
      })
      child.stdout.on('data', chunk => { if (out.length < 16384) out += chunk.toString() })
      child.stderr.on('data', chunk => { if (err.length < 4096) err += chunk.toString() })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 3000)
      }, definition.timeoutMs)
      const finish = (status, exitCode) => {
        clearTimeout(timer)
        const output = [out.trim(), err.trim() === '' ? '' : `[stderr]\n${err.trim()}`].filter(p => p !== '').join('\n')
        resolve({ status, exitCode, output: output === '' ? '(no output)' : output.slice(0, 16384) })
      }
      child.on('error', error => { err += `\nspawn failed: ${error.message}`; finish('error', undefined) })
      child.on('close', (code, signal) => finish(signal === null ? (code === 0 ? 'ok' : 'error') : 'timeout', code))
    })
  }
}

/** The defineTool parameter block for one definition. */
function parametersFor(definition) {
  const parameters = {}
  for (const [key, schema] of Object.entries(definition.params ?? {})) {
    parameters[key] = {
      type: schema.type,
      required: schema.required !== false,
      ...(schema.description !== undefined ? { description: schema.description } : {}),
      ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
    }
  }
  return parameters
}

/**
 * Register every definition plus the factory tools.
 * @param {object} ctx - plugin context carrying `ctx.tools`.
 */
export function apply(ctx) {
  for (const definition of loadDefinitionsSync()) {
    try {
      ctx.tools.register(defineTool({
        name: definition.name,
        description: `${definition.description} (agent-created tool)`,
        parameters: parametersFor(definition),
        output: {
          kind: 'value',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['ok', 'error', 'timeout'], required: true },
              exitCode: { type: 'integer' },
              output: { type: 'string', required: true },
            },
          },
          render: (args, value) => [{ type: 'text', text: `${value.status}\n${value.output}` }],
        },
        execute: runDefinitionTool(definition),
      }))
    } catch (error) {
      // A duplicate name against a harness tool lands here: skip loudly.
      console.error(`dsh-agent-tools: could not register "${definition.name}": ${error.message}`)
    }
  }

  ctx.tools.register(defineTool({
    name: 'tool_create',
    description:
      'Create a new tool from a validated command template — the capability becomes a named, schema-carrying tool '
      + 'available in every future session (TUI, Telegram, cron) after the next start. Give params explicit types and '
      + 'descriptions; reference them in command as {{param_name}} (values are safely quoted — they cannot inject shell). '
      + 'The command runs with /bin/sh from ~/.dsh with API keys scrubbed from its environment, bounded by timeoutMs. '
      + 'Prefer snake_case names that cannot collide with built-in tools (check with /tools).',
    parameters: {
      name: { type: 'string', required: true, description: 'snake_case tool name, e.g. "pi_throttling".' },
      description: { type: 'string', required: true, description: 'One sentence: what the tool does and when to call it. Future sessions choose tools by this.' },
      command: { type: 'string', required: true, description: 'Shell command template; parameters appear as {{param_name}}. Piping and redirection are allowed.' },
      params: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description: 'Parameter schemas keyed by name: {type: string|number|boolean, description, enum?, required?}. Every {{placeholder}} must be declared.',
      },
      timeoutMs: { type: 'number', description: 'Execution cap in ms (default 30000, max 120000).' },
      overwrite: { type: 'boolean', description: 'Replace an existing tool of the same name (default false: refuse).' },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          status: { type: 'string', enum: ['created', 'replaced'], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.status === 'replaced' ? 'Replaced' : 'Created'} tool at ${value.path}. It registers at the NEXT session start (restart, new session, or the next cron fire).` }],
    },
    async execute(args) {
      const exists = await import('node:fs/promises').then(fs => fs.access(definitionPath(args.name)).then(() => true).catch(() => false))
      if (exists && args.overwrite !== true) throw new Error(`tool "${args.name}" already exists; pass overwrite to replace it`)
      const definition = parseDefinition(args)
      const path = await saveDefinition(definition)
      return { path, status: exists ? 'replaced' : 'created' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'tool_forget',
    description: 'Remove an agent-created tool (by its snake_case name). Built-in tools cannot be removed this way.',
    parameters: {
      name: { type: 'string', required: true, description: 'The tool name as shown in /tools.' },
    },
    output: {
      kind: 'value',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          removed: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Removed tool definition: ${value.removed}` }],
    },
    async execute(args) {
      if (!/^[a-z][a-z0-9_]*$/.test(args.name)) throw new Error('tool name must be snake_case')
      await removeDefinition(args.name)
      return { removed: definitionPath(args.name) }
    },
  }))
}

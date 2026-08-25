/**
 * Tool definitions: the trusted shape between "the agent wrote a JSON file"
 * and "the harness runs a command".
 *
 * A definition is data, never code — the dangerous alternative (model-authored
 * plugin JS loaded into the agent process, unsandboxed, at every boot) is
 * deliberately not buildable here. Three rules carry the safety:
 *
 * 1. Parameter values are single-quote-escaped when interpolated, so a value
 *    like `x; curl evil` stays one argument instead of becoming shell.
 *    Shell features in the TEMPLATE are allowed — the template's author is
 *    the agent, whose bash access is equivalent — but user/session-supplied
 *    values cannot widen it.
 * 2. The child environment is scrubbed of key-bearing variables. The agent
 *    process holds the GLM key; a tool's output must never become a channel
 *    for printing it.
 * 3. Every definition passes the same text security scan as memory and
 *    skills before it is written or loaded.
 *
 * @module dsh-agent-tools/lib/definitions
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { scanMemoryText } from '../../dsh-memory/lib/memory-store.js'

/** Where definitions live; one file per tool, snapshotted like all state. */
export function toolsDir() {
  return dshHomePath('tools')
}

const NAME = /^[a-z][a-z0-9_]*$/
const TYPES = new Set(['string', 'number', 'boolean'])
const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/**
 * Validate one definition and apply defaults.
 * @param {object} raw - `{ name, description, command, params?, timeoutMs? }`.
 * @returns {object} the normalized definition.
 * @throws {Error} naming every problem found, for the model to fix in one retry.
 */
export function parseDefinition(raw) {
  const problems = []
  const name = raw?.name
  if (typeof name !== 'string' || !NAME.test(name)) problems.push('name must be snake_case starting with a letter')
  if (typeof raw?.description !== 'string' || raw.description.trim() === '') problems.push('description must not be empty')
  if (typeof raw?.command !== 'string' || raw.command.trim() === '') problems.push('command must not be empty')

  const params = raw?.params ?? {}
  const declared = new Set(Object.keys(params))
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    problems.push('params must be a mapping of parameter name to its schema')
  } else {
    for (const [key, schema] of Object.entries(params)) {
      if (!NAME.test(key)) problems.push(`param "${key}" must be snake_case`)
      if (typeof schema?.type !== 'string' || !TYPES.has(schema.type)) problems.push(`param "${key}" type must be string|number|boolean`)
    }
  }
  for (const match of (raw?.command ?? '').matchAll(PLACEHOLDER)) {
    if (!declared.has(match[1])) problems.push(`command uses {{${match[1]}}} but it is not declared in params`)
  }
  const timeoutMs = Math.min(Math.max(Number(raw?.timeoutMs ?? 30000), 1000), 120000)
  if (!Number.isFinite(timeoutMs)) problems.push('timeoutMs must be a number')
  if (problems.length > 0) throw new Error(`invalid tool definition: ${problems.join('; ')}`)

  const definition = {
    name,
    description: raw.description.trim(),
    command: raw.command.trim(),
    params,
    timeoutMs,
    createdAt: raw.createdAt ?? new Date().toISOString(),
  }
  const threat = scanMemoryText(`${definition.name}\n${definition.description}\n${definition.command}`)
  if (threat !== undefined) {
    throw new Error(`tool definition rejected by security scan: ${threat}. Tools run shell commands on every future boot — write the capability plainly.`)
  }
  return definition
}

/** Definition file path for a tool name. */
export function definitionPath(name) {
  return join(toolsDir(), `${name}.tool.json`)
}

/**
 * Interpolate declared parameter values into the command template. Values are
 * single-quoted and quote-escaped: a parameter value can never break out of
 * its argument.
 */
export function interpolate(command, args) {
  return command.replace(PLACEHOLDER, (_, key) => {
    const value = args[key]
    if (value === undefined) throw new Error(`parameter "${key}" is required by this tool's command`)
    return `'${String(value).replace(/'/g, "'\\''")}'`
  })
}

/** A child environment with every key-bearing variable removed. */
export function scrubEnv(env) {
  const clean = {}
  for (const [key, value] of Object.entries(env)) {
    if (/_API_KEY$|TOKEN|SECRET|CREDENTIAL|PASSWORD|KEYFILE/i.test(key)) continue
    clean[key] = value
  }
  return clean
}

/** Load every valid definition; a broken file is skipped loudly, never fatal. */
export function loadDefinitionsSync() {
  const definitions = []
  let entries
  try {
    entries = readdirSync(toolsDir())
  } catch {
    return []
  }
  for (const entry of entries.filter(name => name.endsWith('.tool.json'))) {
    try {
      definitions.push(parseDefinition(JSON.parse(readFileSync(join(toolsDir(), entry), 'utf8'))))
    } catch (error) {
      console.error(`dsh-agent-tools: skipping ${entry}: ${error.message}`)
    }
  }
  return definitions
}

/** Persist one definition (atomic enough: single small JSON file). */
export async function saveDefinition(definition) {
  await mkdir(toolsDir(), { recursive: true })
  await writeFile(definitionPath(definition.name), `${JSON.stringify(definition, undefined, 2)}\n`)
  return definitionPath(definition.name)
}

/** Remove one definition by tool name. */
export async function removeDefinition(name) {
  await rm(definitionPath(name), { force: true })
}

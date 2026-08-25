/**
 * The write half of the skills system: the shipped `skill-filesystem` layer
 * only reads (deliberately — a loader that also writes blurs who owns the
 * file), so procedural memory has no way to create itself. This is that way.
 *
 * Files land in `$DSH_HOME/skills/<name>.md` — the flat layout the loader
 * accepts alongside `<dir>/SKILL.md` — and the loader's watcher picks them up
 * live, no restart. Frontmatter keys mirror the loader's schema exactly,
 * including its kebab-case boolean keys; the loader rejects the camelCase
 * spellings outright.
 *
 * @module dsh-memory/lib/skill-create
 */

import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scanMemoryText } from './memory-store.js'

/** The loader's own skill-name grammar (dsh-skill SKILL_NAME), mirrored. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A skill body beyond this is a document, not a procedure. */
export const MAX_BODY_BYTES = 32768

/**
 * Write one skill file.
 * @param {string} skillsDir - `$DSH_HOME/skills`.
 * @param {{ name: string, description: string, whenToUse?: string, body: string, overwrite?: boolean }} skill
 * @returns {{ path: string, status: 'created' | 'replaced' }}
 */
export async function writeSkill(skillsDir, { name, description, whenToUse, body, overwrite }) {
  if (!SKILL_NAME.test(name)) {
    throw new Error(`skill name must be kebab-case (lowercase letters, digits, single hyphens), got "${name}"`)
  }
  if (description === undefined || description.trim() === '') throw new Error('description must not be empty')
  if (body === undefined || body.trim() === '') throw new Error('body must not be empty')
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error(`skill body exceeds ${MAX_BODY_BYTES} bytes`)
  // Skills are replayed into prompts just like memory; same injection stance.
  const threat = scanMemoryText(`${description}\n${whenToUse ?? ''}\n${body}`)
  if (threat !== undefined) {
    throw new Error(`skill rejected by security scan: ${threat}. A skill rides every session that loads it — write the procedure without embedded instructions to the reader or obfuscation.`)
  }

  // The name is filesystem-facing; the regex already excludes separators and
  // dot segments, so no traversal path can be spelled, but resolve stays
  // inside the skills root regardless.
  const path = join(skillsDir, `${name}.md`)
  let status = 'created'
  try {
    await access(path)
    if (overwrite !== true) throw new Error(`skill "${name}" already exists; pass overwrite to replace it`)
    status = 'replaced'
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: ${yamlScalar(description.trim())}`,
    ...(whenToUse !== undefined && whenToUse.trim() !== '' ? [`whenToUse: ${yamlScalar(whenToUse.trim())}`] : []),
    '---',
    '',
  ].join('\n')

  await mkdir(skillsDir, { recursive: true })
  await writeFile(path, `${frontmatter}${body.trim()}\n`)
  return { path, status }
}

/**
 * Quote a frontmatter scalar safely: the loader parses this file as YAML, so
 * a description containing a colon or quote must arrive as a quoted string,
 * and embedded quotes must be doubled inside it.
 */
function yamlScalar(text) {
  if (/[:#\n]/.test(text) === false && !text.startsWith('"')) return text
  return `"${text.replace(/"/g, '""')}"`
}

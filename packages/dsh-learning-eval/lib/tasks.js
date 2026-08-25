/**
 * Task loading and validation.
 *
 * A task is a fact the agent could not know unless the loop stored it, a
 * prompt that requires the fact, and what a correct answer must and must not
 * contain. Validation is strict because a malformed task fails silently — it
 * scores zero in both arms and quietly drags the mean toward "no effect".
 *
 * @module dsh-learning-eval/tasks
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Throw unless the task is well-formed; returns it for chaining. */
export function validateTask(task) {
  if (task === null || typeof task !== 'object') throw new Error('task must be an object')
  for (const field of ['id', 'prompt']) {
    if (typeof task[field] !== 'string' || task[field].trim() === '') {
      throw new Error(`task ${task.id ?? '<unnamed>'}: "${field}" must be a non-empty string`)
    }
  }
  const expect = task.expect ?? {}
  const includes = expect.includes ?? []
  const excludes = expect.excludes ?? []
  if (!Array.isArray(includes) || !Array.isArray(excludes)) {
    throw new Error(`task ${task.id}: expect.includes and expect.excludes must be arrays`)
  }
  if (includes.length === 0 && excludes.length === 0) {
    throw new Error(`task ${task.id}: needs at least one expect.includes or expect.excludes term, or it grades nothing`)
  }
  if (!Array.isArray(task.memories) || task.memories.length === 0) {
    throw new Error(`task ${task.id}: needs at least one memory to seed, or the treatment arm is identical to the control`)
  }
  for (const memory of task.memories) {
    if (typeof memory?.topic !== 'string' || typeof memory?.summary !== 'string') {
      throw new Error(`task ${task.id}: each memory needs a topic and a summary`)
    }
  }
  return task
}

/** Load every .json task in a directory. */
export async function loadTasks(dir) {
  const files = (await readdir(dir)).filter(name => name.endsWith('.json')).sort()
  const tasks = []
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(dir, file), 'utf8'))
    for (const task of Array.isArray(parsed) ? parsed : [parsed]) tasks.push(validateTask(task))
  }
  return tasks
}

/**
 * Eyes and ears for the gateway.
 *
 * Vision rides the hosted GLM vision model through the same z.ai coding plan
 * as everything else — the plan serves it as `glm-4.6v` (there is no 5v; the
 * vision line kept the 4.6v naming). It answers only what the image shows:
 * the transcription of what was seen is then handed to the task model, which
 * keeps the user's split — cheap eyes, heavyweight brain.
 *
 * Voice is transcribed ON this Pi with openai-whisper (models cached, ffmpeg
 * installed): the coding plan carries no ASR (probed: every model id answers
 * Unknown Model), and a hosted hop for something a 4-core CPU already does
 * locally would only add latency and egress.
 *
 * @module dsh-telegram/lib/media
 */

import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

/** The plan's vision model; kept in config so a future id is a config change. */
export const DEFAULT_VISION_MODEL = 'glm-4.6v'

/** The local whisper binary the voice path shells out to. */
export const DEFAULT_TRANSCRIBE_COMMAND = 'whisper'

/** Media beyond this size is refused before any base64 or API hop. */
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024

/**
 * Ask the vision model about one image.
 * @param {{ apiKey: string, base64: string, mimeType?: string, question?: string, model?: string, baseUrl?: string }} input
 * @returns {Promise<string>} the model's answer about the image.
 */
export async function describeImage({ apiKey, base64, mimeType = 'image/jpeg', question, model = DEFAULT_VISION_MODEL, baseUrl = 'https://api.z.ai/api/coding/paas/v4' }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: question ?? 'Describe this image precisely and concisely: objects, text visible, anything notable.' },
        ],
      }],
    }),
    signal: AbortSignal.timeout(120000),
  })
  const body = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }))
  if (body.error !== undefined) throw new Error(`vision ${model}: ${body.error.message}`)
  const content = body.choices?.[0]?.message?.content?.trim()
  if (content === undefined || content === '') throw new Error(`vision ${model}: empty answer`)
  return content
}

/**
 * Transcribe one audio file with the local whisper CLI.
 * @param {{ filePath: string, command?: string, model?: string }} input
 * @returns {Promise<string>} the transcription (whisper writes a .txt beside
 *   its output dir; empty string when the model heard nothing).
 */
export async function transcribeVoice({ filePath, command = DEFAULT_TRANSCRIBE_COMMAND, model = 'base' }) {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-voice-'))
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, [filePath, '--model', model, '--fp16', 'False', '--output_format', 'txt', '--output_dir', workDir, '--verbose', 'False'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', chunk => { err += chunk.toString() })
      child.on('error', reject)
      child.on('close', code => (code === 0 ? resolve(code) : reject(new Error(`whisper exited ${code}: ${err.slice(-400)}`))))
    })
    const base = filePath.split('/').pop().replace(/\.[^.]+$/, '')
    return (await readFile(join(workDir, `${base}.txt`), 'utf8')).trim()
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

/** Pick the photo variant worth sending: Telegram sends smallest-first. */
export function largestPhoto(photo) {
  return [...photo].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
}

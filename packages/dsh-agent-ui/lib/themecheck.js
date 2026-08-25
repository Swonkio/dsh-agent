/**
 * A one-screen swatch of the palette and meters, so a new terminal can be
 * checked for truecolor/256/mono rendering at a glance.
 * @module dsh-agent-ui/themecheck
 */
import { PALETTE, paint } from './theme.js'
import { meter, spark, wordmark } from './render.js'

export function renderThemeMap(depth) {
  const rows = ['', '  ' + wordmark(depth) + `   depth=${depth} (${depth === 3 ? 'truecolor' : depth === 2 ? '256' : 'mono'})`, '']
  for (const [name, col] of Object.entries(PALETTE)) {
    rows.push('  ' + paint('████', col, depth) + '  ' + paint(name, col, depth))
  }
  rows.push('')
  rows.push('  heat  ' + meter(1, 30, depth, { ramp: true }))
  rows.push('  live  ' + meter(0.7, 30, depth))
  rows.push('  spark ' + spark([0.1, 0.3, 0.5, 0.7, 0.9, 0.7, 0.4, 0.2], depth))
  rows.push('')
  return rows.join('\n')
}

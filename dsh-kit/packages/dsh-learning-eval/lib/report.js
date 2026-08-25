/**
 * Rendering the eval verdict.
 *
 * The report leads with the number that answers the question the eval was
 * built to ask — did memory help — and then immediately qualifies it, because
 * a lift figure without its spread and its task count invites more confidence
 * than the run supports.
 *
 * @module dsh-learning-eval/report
 */

const pct = value => `${(value * 100).toFixed(0)}%`
const signed = value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(0)}%`

/** Render a summary as markdown. */
export function renderReport(summary, meta = {}) {
  const lines = ['# Learning-loop eval', '']
  if (meta.model !== undefined) lines.push(`Model: \`${meta.model}\` · ${meta.repeats ?? 1} run(s) per arm · ${summary.tasks} task(s)`, '')

  if (summary.measuring === 0) {
    lines.push('**No task measured memory.** Every control arm already scored full marks, which means the model')
    lines.push('answered without help — these tasks cannot detect whether the loop works. Write tasks about facts')
    lines.push('the model could not know: the user\'s own machines, ports, preferences and past decisions.', '')
  } else {
    lines.push(`## Verdict: memory changed the answer by ${signed(summary.meanLift)}`, '')
    lines.push(`Across ${summary.measuring} task(s) that can detect memory: **${summary.helped} helped**, `
      + `${summary.hurt} hurt, ${summary.unchanged} unchanged.`, '')
  }

  if (summary.ceiling.length > 0) {
    lines.push(`> ${summary.ceiling.length} task(s) excluded from the headline — the control already scored full `
      + `marks, so they measure the model, not the loop: ${summary.ceiling.join(', ')}`, '')
  }

  lines.push('## Per task', '')
  lines.push('| task | memory on | memory off | lift | significant |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const result of summary.results) {
    const note = result.measuresMemory ? (result.significant ? 'yes' : 'within noise') : 'n/a — control at ceiling'
    lines.push(`| ${result.id} | ${pct(result.treatment)} | ${pct(result.control)} | ${signed(result.lift)} | ${note} |`)
  }
  lines.push('')

  const regressions = summary.results.filter(result => result.measuresMemory && result.lift < 0)
  if (regressions.length > 0) {
    lines.push('## Regressions — memory made these WORSE', '')
    for (const result of regressions) {
      const forbidden = result.answers.treatment.flatMap(a => a.forbidden ?? [])
      lines.push(`- **${result.id}** (${signed(result.lift)})`
        + (forbidden.length > 0 ? ` — stated a forbidden value: ${[...new Set(forbidden)].join(', ')}` : ''))
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

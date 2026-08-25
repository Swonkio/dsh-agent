/**
 * A five-field cron expression parser and next-run calculator.
 *
 * Scope is the classic crontab grammar only: `minute hour day-of-month month
 * day-of-week`, each field `*`, a number, `a-b`, `a-b/n`, `*` with a `/n`
 * step, or a comma-separated list of those. No names (MON, JAN), no
 * `L`/`W`/`#`, no seconds or years. A model facing the `cronjob` tool derives the expression
 * from natural language itself; the parser only has to validate what arrives
 * and compute when it next fires.
 *
 * All arithmetic is in the machine's LOCAL time, matching what a user means
 * by "8:30 every morning" and what system crontab itself does. Across a
 * spring-forward gap a missing local time normalizes forward (2:30 becomes
 * 3:30), which is the same behavior vixie cron's clock-handling produces.
 *
 * Day-of-month and day-of-week follow vixie cron's OR rule: when BOTH fields
 * are restricted (neither is `*`), a day matches if either field matches.
 *
 * @module dsh-cron/lib/cron-expr
 */

/** Inclusive bounds of each field, in order. 7 is accepted as Sunday. */
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
]

/** Parse one field into a sorted list of the values it matches. */
function parseField(field, spec, index) {
  const { name, min, max } = field
  const values = new Set()
  for (const part of spec.split(',')) {
    if (part === '') throw new Error(`empty list item in ${name} field`)
    // Split a trailing /step off the range; `*` is the full-range shorthand.
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      range = part.slice(0, slash)
      step = Number(part.slice(slash + 1))
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step "${part.slice(slash + 1)}" in ${name} field`)
    }
    let lo = min
    let hi = max
    if (range !== '*') {
      const dash = range.indexOf('-')
      if (dash === -1) {
        lo = hi = Number(range)
      } else {
        lo = Number(range.slice(0, dash))
        hi = Number(range.slice(dash + 1))
      }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || lo > max || hi < min || hi > max) {
      throw new Error(`"${spec}" is not a valid ${name} field (${min}-${max})`)
    }
    if (lo > hi) throw new Error(`descending range "${range}" in ${name} field`)
    for (let value = lo; value <= hi; value += step) values.add(value)
  }
  if (values.size === 0) throw new Error(`"${spec}" matches nothing in ${name} field`)
  // 7 is Sunday; normalize onto 0 so day-of-week sets compare directly.
  if (index === 4 && values.has(7)) {
    values.delete(7)
    values.add(0)
  }
  return [...values].sort((a, b) => a - b)
}

/**
 * Parse a five-field cron expression.
 * @param {string} expr - the expression, e.g. `"30 8 * * 1-5"`.
 * @returns {{ fields: number[][] }} matched values per field, ascending.
 * @throws {Error} on any syntax or range error, naming the field.
 */
export function parse(expr) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expr}"`)
  return { fields: FIELDS.map((field, index) => parseField(field, parts[index], index)) }
}

/**
 * The first day at or after the cursor's calendar day that the month and both
 * day fields allow, scanning up to four years out — the horizon a valid
 * February 29th schedule needs to reach its next occurrence.
 * @returns {{ year: number, month: number, day: number }} calendar day
 *   (month 0-based, as in Date), or undefined.
 */
function nextMatchingDay(fields, cursor) {
  const [, , daysOfMonth, months, daysOfWeek] = fields
  const domRestricted = daysOfMonth.length !== 31
  const dowRestricted = daysOfWeek.length !== 7
  const startYear = cursor.getFullYear()
  const startMonth = cursor.getMonth()
  const startDate = cursor.getDate()
  for (let monthOffset = 0; monthOffset <= 48; monthOffset++) {
    const year = startYear + Math.floor((startMonth + monthOffset) / 12)
    const month = (startMonth + monthOffset) % 12
    if (!months.includes(month + 1)) continue
    // Days in this month on this machine's calendar; Date handles leap years.
    const daysCount = new Date(year, month + 1, 0).getDate()
    const firstDay = monthOffset === 0 ? startDate : 1
    for (let day = firstDay; day <= daysCount; day++) {
      const weekday = new Date(year, month, day).getDay()
      const domMatch = daysOfMonth.includes(day)
      const dowMatch = daysOfWeek.includes(weekday)
      const matches = domRestricted && dowRestricted
        ? domMatch || dowMatch
        : domMatch && dowMatch
      if (matches) return { year, month, day }
  }
  }
  return undefined
}

/**
 * The next time at or strictly after `after` that the parsed expression
 * matches, at minute resolution. The result is never `after` itself, so a job
 * that just fired can compute its next occurrence from its own lastRun.
 * @param {{ fields: number[][] }} parsed - result of {@link parse}.
 * @param {Date} after - scan start; the result is >= this moment.
 * @returns {Date | undefined} the next match, or undefined if the expression
 *   cannot fire within four years (an impossible date such as February 30th).
 */
export function nextRun(parsed, after) {
  const [minutes, hours] = parsed.fields
  const cursor = new Date(Math.floor(after.getTime() / 60000) * 60000)
  const limit = cursor.getTime() + (4 * 366 + 31) * 24 * 60 * 60000
  let scan = cursor
  while (scan.getTime() <= limit) {
    const day = nextMatchingDay(parsed.fields, scan)
    if (day === undefined) return undefined
    for (const hour of hours) {
      for (const minute of minutes) {
        // Local constructor, not midnight-plus-offsets: a local wall-clock
        // time that a DST transition removed normalizes forward the way a
        // user expects instead of drifting the whole schedule.
        const candidate = new Date(day.year, day.month, day.day, hour, minute)
        if (candidate.getTime() > cursor.getTime()) return candidate
      }
    }
    scan = new Date(day.year, day.month, day.day + 1)
  }
  return undefined
}

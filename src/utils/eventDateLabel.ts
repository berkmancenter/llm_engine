const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* Boston's timezone. America/New_York follows US Eastern daylight saving on its own, so a fixed
   offset is never hardcoded: the same zone reads UTC-5 in winter and UTC-4 in summer. */
const EASTERN_TIME_ZONE = 'America/New_York'

const easternPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric'
})

/**
 * The calendar year, month (1-12), and day for a moment as seen in Boston (America/New_York). Uses
 * Intl rather than the Date getters so the result is the same wherever the server runs, instead of
 * following the host's own timezone, and so a late-evening UTC time lands on the right Eastern day.
 */
export function easternDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = easternPartsFormatter.formatToParts(date)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day') }
}

/**
 * The Boston (Eastern) calendar date as YYYY-MM-DD: a sortable, unambiguous form for ops output like
 * the backfill report, in the same timezone as everything a reader sees.
 */
export function easternIsoDate(date: Date): string {
  const { year, month, day } = easternDateParts(date)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * A short, stable label for one event: its name plus a compact date, e.g. "Future of Work (Jun 3)".
 * Events in a recurring series share a name, so the date sets most of them apart and reads better
 * than an opaque index. Falls back to the date alone, then to `fallback`, when a name or date is
 * missing. The date is the Boston (Eastern) calendar day, so a late-evening event reads on the day it
 * happened locally rather than rolling to the next UTC day.
 */
export default function eventDateLabel(
  name: string | null | undefined,
  endTime: Date | null | undefined,
  fallback: string
): string {
  let date = ''
  if (endTime) {
    const { month, day } = easternDateParts(endTime)
    date = `${MONTHS[month - 1]} ${day}`
  }
  const trimmedName = name?.trim()
  if (trimmedName && date) return `${trimmedName} (${date})`
  return trimmedName || date || fallback
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A short, stable label for one event: its name plus a compact UTC date, e.g. "Future of Work
 * (Jun 3)". Events in a recurring series share a name, so the date sets most of them apart and
 * reads better than an opaque index. Falls back to the date alone, then to `fallback`, when a
 * name or date is missing. The date is the UTC calendar day, so it is deterministic but can read
 * a day off for a viewer in a far timezone.
 */
export default function eventDateLabel(
  name: string | null | undefined,
  endTime: Date | null | undefined,
  fallback: string
): string {
  const date = endTime ? `${MONTHS[endTime.getUTCMonth()]} ${endTime.getUTCDate()}` : ''
  const trimmedName = name?.trim()
  if (trimmedName && date) return `${trimmedName} (${date})`
  return trimmedName || date || fallback
}

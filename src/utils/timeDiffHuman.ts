export default function timeDiffHuman(targetDate: Date, baseDate: Date = new Date()): string {
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  const diff = targetDate.getTime() - baseDate.getTime()

  type Unit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second'

  const units: [Unit, number][] = [
    ['year', 1000 * 60 * 60 * 24 * 365],
    ['month', 1000 * 60 * 60 * 24 * 30],
    ['week', 1000 * 60 * 60 * 24 * 7],
    ['day', 1000 * 60 * 60 * 24],
    ['hour', 1000 * 60 * 60],
    ['minute', 1000 * 60],
    ['second', 1000]
  ]

  for (const [unit, ms] of units) {
    const amount = Math.round(diff / ms)
    if (Math.abs(amount) >= 1) {
      return rtf.format(amount, unit)
    }
  }
  return 'just now'
}

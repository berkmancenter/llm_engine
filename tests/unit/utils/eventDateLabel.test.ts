import eventDateLabel from '../../../src/utils/eventDateLabel.js'

describe('eventDateLabel', () => {
  // Noon UTC is mid-morning in Boston, so the calendar day is the same in either zone and the
  // assertion stays readable regardless of the runner's own timezone.
  const endTime = new Date('2026-06-03T12:00:00.000Z')

  it('combines the name and a compact Eastern date', () => {
    expect(eventDateLabel('Future of Work', endTime, 'Past event')).toBe('Future of Work (Jun 3)')
  })

  it('renders the date in Boston time, not UTC, across both daylight-saving halves of the year', () => {
    // Summer (EDT, UTC-4): 2am UTC on Jul 1 is 10pm on Jun 30 in Boston.
    expect(eventDateLabel(null, new Date('2026-07-01T02:00:00.000Z'), 'Event')).toBe('Jun 30')
    // Winter (EST, UTC-5): 3am UTC on Jan 15 is 10pm on Jan 14 in Boston.
    expect(eventDateLabel(null, new Date('2026-01-15T03:00:00.000Z'), 'Event')).toBe('Jan 14')
  })

  it('uses the date alone when there is no name', () => {
    expect(eventDateLabel(undefined, endTime, 'Past event')).toBe('Jun 3')
    expect(eventDateLabel(null, endTime, 'Event')).toBe('Jun 3')
  })

  it('uses the name alone when there is no date', () => {
    expect(eventDateLabel('Standup', undefined, 'Past event')).toBe('Standup')
  })

  it('falls back to the given placeholder when both are missing', () => {
    expect(eventDateLabel(undefined, undefined, 'Past event')).toBe('Past event')
    expect(eventDateLabel('   ', null, 'Event')).toBe('Event')
  })

  it('trims surrounding whitespace from the name', () => {
    expect(eventDateLabel('  AI Ethics  ', endTime, 'Event')).toBe('AI Ethics (Jun 3)')
  })
})

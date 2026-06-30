import eventDateLabel from '../../../src/utils/eventDateLabel.js'

describe('eventDateLabel', () => {
  // Noon UTC so the calendar day is unambiguous regardless of the runner's timezone.
  const endTime = new Date('2026-06-03T12:00:00.000Z')

  it('combines the name and a compact UTC date', () => {
    expect(eventDateLabel('Future of Work', endTime, 'Past event')).toBe('Future of Work (Jun 3)')
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

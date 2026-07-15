import { ExtractedFieldsSchema } from '../../../../src/services/eventSetup/eventFieldsSchema.js'

describe('eventFieldsSchema', () => {
  const baseFields = {
    eventName: 'Weekly Sync',
    dateTime: '2026-07-20T15:00:00.000Z',
    duration: 60,
    description: 'A recurring team sync',
    zoomLink: 'https://zoom.us/j/123456789',
    topicName: 'Team Syncs',
    speakers: [{ name: 'Ada Lovelace', bio: 'Mathematician', alternateName: 'Ada' }],
    moderators: [{ name: 'Grace Hopper', bio: 'Computer scientist' }],
    timeZone: 'America/New_York'
  }

  describe('ExtractedFieldsSchema', () => {
    it('parses the current field set', () => {
      const result = ExtractedFieldsSchema.parse(baseFields)

      expect(result).toEqual(baseFields)
    })

    it('parses an empty object, since the LLM omits anything it is unsure of', () => {
      const result = ExtractedFieldsSchema.parse({})

      expect(result).toEqual({})
    })

    it('rejects a field of the wrong type', () => {
      expect(() => ExtractedFieldsSchema.parse({ ...baseFields, duration: '60 minutes' })).toThrow()
    })
  })
})

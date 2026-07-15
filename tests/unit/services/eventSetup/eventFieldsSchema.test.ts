import { ExtractedFieldsSchema, InviteExtractedFieldsSchema } from '../../../../src/services/eventSetup/eventFieldsSchema.js'

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

    it('does not accept matchedTopicId (it belongs to the invite variant)', () => {
      const parsed = ExtractedFieldsSchema.parse({ ...baseFields, matchedTopicId: 'topic-1' })

      expect(parsed).not.toHaveProperty('matchedTopicId')
    })
  })

  describe('InviteExtractedFieldsSchema', () => {
    it('accepts every base field plus a string matchedTopicId', () => {
      const result = InviteExtractedFieldsSchema.parse({ ...baseFields, matchedTopicId: 'topic-1' })

      expect(result).toEqual({ ...baseFields, matchedTopicId: 'topic-1' })
    })

    it('accepts a null matchedTopicId', () => {
      const result = InviteExtractedFieldsSchema.parse({ ...baseFields, matchedTopicId: null })

      expect(result.matchedTopicId).toBeNull()
    })

    it('requires matchedTopicId to be present', () => {
      expect(() => InviteExtractedFieldsSchema.parse(baseFields)).toThrow()
    })
  })
})

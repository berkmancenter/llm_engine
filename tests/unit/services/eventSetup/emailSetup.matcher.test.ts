import { topicPrefixFromSummary, matchTopicByPrefix } from '../../../../src/services/eventSetup/emailSetup.service.js'

/* These exercise the deterministic topic matcher in isolation: no webhook, no database. The candidate
   list is just plain objects with a name, standing in for the topics a sender can see. */
describe('emailSetup topic matcher', () => {
  describe('topicPrefixFromSummary', () => {
    it('returns the trimmed substring before the first colon', () => {
      expect(topicPrefixFromSummary('BKCircle: Jane Doe Presents')).toBe('BKCircle')
    })

    it('splits on the first colon only', () => {
      expect(topicPrefixFromSummary('BKCircle: Part 2: The Sequel')).toBe('BKCircle')
    })

    it('returns null when there is no colon', () => {
      expect(topicPrefixFromSummary('BKCircle Jane Doe Presents')).toBeNull()
    })

    it('returns null when the prefix is empty', () => {
      expect(topicPrefixFromSummary(': orphaned')).toBeNull()
    })

    it('returns null for an undefined summary', () => {
      expect(topicPrefixFromSummary(undefined)).toBeNull()
    })
  })

  describe('matchTopicByPrefix', () => {
    const candidates = [{ name: 'BKCircle' }, { name: 'Team Syncs' }, { name: 'Ethics Seminar' }]

    it('returns the topic whose name equals the summary prefix', () => {
      expect(matchTopicByPrefix('BKCircle: Jane Doe Presents', candidates)).toBe(candidates[0])
    })

    it('matches case-insensitively', () => {
      expect(matchTopicByPrefix('bkcircle: whatever', candidates)).toBe(candidates[0])
    })

    it('ignores surrounding whitespace on both sides', () => {
      const spaced = [{ name: '  Team Syncs  ' }]
      expect(matchTopicByPrefix('team syncs :   notes', spaced)).toBe(spaced[0])
    })

    it('does NOT match a near-miss prefix', () => {
      // "Team Sync" (singular) must not match the "Team Syncs" topic.
      expect(matchTopicByPrefix('Team Sync: standup', candidates)).toBeNull()
    })

    it('returns null when the summary has no colon', () => {
      expect(matchTopicByPrefix('BKCircle standup', candidates)).toBeNull()
    })

    it('returns null when no candidate matches the prefix', () => {
      expect(matchTopicByPrefix('Unknown Topic: hello', candidates)).toBeNull()
    })

    it('returns null for an empty candidate list', () => {
      expect(matchTopicByPrefix('BKCircle: hello', [])).toBeNull()
    })
  })
})

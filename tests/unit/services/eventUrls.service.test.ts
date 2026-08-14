import eventUrls from '../../../src/services/eventUrls.service.js'
import config from '../../../src/config/config.js'

/* A conversation only needs an id and its channels to build links, so these fixtures
   stay minimal rather than standing up a real document. */
const conversationWith = (channels: { name: string; passcode?: string | null }[]) => ({
  _id: '65f0000000000000000000aa',
  conversationType: 'eventAssistant',
  channels
})

/* Mirrors the channel set eventAssistant declares, so a link that leaks one it shouldn't
   carry (moderator into the participant URL) fails here rather than in production. */
const allChannels = [
  { name: 'transcript', passcode: 'tttttttt' },
  { name: 'chat', passcode: 'cccccccc' },
  { name: 'moderator', passcode: 'mmmmmmmm' },
  { name: 'participant', passcode: 'pppppppp' },
  { name: 'image-gen', passcode: 'iiiiiiii' }
]

describe('eventUrls.service', () => {
  describe('participantUrl', () => {
    it('points at the participant path with the conversation id', () => {
      const url = eventUrls.participantUrl(conversationWith(allChannels))

      expect(url).toContain(`${config.appHost}/assistant/?`)
      expect(url).toContain('conversationId=65f0000000000000000000aa')
    })

    it('carries the transcript and chat channels with their passcodes', () => {
      const url = eventUrls.participantUrl(conversationWith(allChannels))

      expect(url).toContain('channel=transcript%2Ctttttttt')
      expect(url).toContain('channel=chat%2Ccccccccc')
    })

    it('never exposes the moderator channel', () => {
      const url = eventUrls.participantUrl(conversationWith(allChannels))

      expect(url).not.toContain('moderator')
    })

    it('omits a channel whose passcode is missing rather than emitting a bare name', () => {
      const url = eventUrls.participantUrl(
        conversationWith([
          { name: 'transcript', passcode: 'tttttttt' },
          { name: 'chat', passcode: null }
        ])
      )

      expect(url).toContain('channel=transcript%2Ctttttttt')
      expect(url).not.toContain('chat')
    })

    it('still builds a usable link when the conversation has no channels at all', () => {
      const url = eventUrls.participantUrl(conversationWith([]))

      expect(url).toBe(`${config.appHost}/assistant/?conversationId=65f0000000000000000000aa`)
    })
  })

  describe('moderatorUrl', () => {
    it('carries the moderator channel and the transcript alongside it', () => {
      const url = eventUrls.moderatorUrl(conversationWith(allChannels))

      expect(url).toContain(`${config.appHost}/moderator/?`)
      expect(url).toContain('channel=moderator%2Cmmmmmmmm')
      expect(url).toContain('channel=transcript%2Ctttttttt')
    })

    it('is undefined without a moderator passcode, since a link missing its token is worse than none', () => {
      const url = eventUrls.moderatorUrl(conversationWith([{ name: 'transcript', passcode: 'tttttttt' }]))

      expect(url).toBeUndefined()
    })
  })

  describe('eventPageUrl', () => {
    it('deep links through login into the admin view for the conversation type', () => {
      const url = eventUrls.eventPageUrl(conversationWith(allChannels))

      expect(url).toBe(`${config.appHost}/login?redirectTo=/admin/eventAssistant/view/65f0000000000000000000aa`)
    })
  })

  describe('configured paths', () => {
    /* The paths are the only client-specific values in this module, so a different
       frontend has to be able to move them without a code change. */
    const originalPaths = { ...config.eventUrlPaths }

    afterEach(() => {
      config.eventUrlPaths.participant = originalPaths.participant
      config.eventUrlPaths.moderator = originalPaths.moderator
    })

    it('honors a configured participant path', () => {
      config.eventUrlPaths.participant = '/join/'

      expect(eventUrls.participantUrl(conversationWith(allChannels))).toContain(`${config.appHost}/join/?`)
    })

    it('honors a configured moderator path', () => {
      config.eventUrlPaths.moderator = '/host/'

      expect(eventUrls.moderatorUrl(conversationWith(allChannels))).toContain(`${config.appHost}/host/?`)
    })
  })
})

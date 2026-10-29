import { isConversationDraft, isPreEventWindowOpen } from '../../../src/services/conversation.service/lifecycle.js'
import { setConversationTypes, resetConversationTypes } from '../../../src/conversations/index.js'
import { ConfigProperty, ConversationType } from '../../../src/types/index.types.js'

/* Minimal conversation type for tests that only exercise property rules; other fields are
   irrelevant to isConversationDraft, so a single cast keeps the injections free of `any`. */
function stubType(name: string, properties: ConfigProperty[]): ConversationType {
  return { name, properties } as unknown as ConversationType
}

/* A scheduled eventAssistant conversation with everything a non-Draft event needs. The
   eventAssistant type declares zoomMeetingUrl as its one required property, so a complete
   fixture carries a valid Zoom link. Individual tests mutate a copy to knock out one field. */
function completeConversation() {
  return {
    name: 'Tech Conference Q&A',
    topic: 'topic-id',
    conversationType: 'eventAssistant',
    scheduledTime: new Date('2030-01-01T10:00:00Z'),
    scheduledEndTime: new Date('2030-01-01T11:00:00Z'),
    properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' }
  }
}

describe('isConversationDraft', () => {
  afterEach(() => {
    resetConversationTypes()
  })

  test('returns false when all required fields are present and valid', () => {
    expect(isConversationDraft(completeConversation())).toBe(false)
  })

  test('returns false for a valid vanity Zoom subdomain', () => {
    const conversation = completeConversation()
    conversation.properties.zoomMeetingUrl = 'https://berkman.zoom.us/j/123456789'
    expect(isConversationDraft(conversation)).toBe(false)
  })

  test('returns true when zoomMeetingUrl is missing', () => {
    const conversation = completeConversation()
    conversation.properties = {} as { zoomMeetingUrl: string }
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns true when zoomMeetingUrl is not a Zoom domain', () => {
    const conversation = completeConversation()
    conversation.properties.zoomMeetingUrl = 'https://evil.com/j/123456789'
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns true when zoomMeetingUrl is not a parseable URL', () => {
    const conversation = completeConversation()
    conversation.properties.zoomMeetingUrl = 'not-a-url'
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns true when zoomMeetingUrl uses userinfo to spoof the host', () => {
    const conversation = completeConversation()
    // Real host here is evil.com; the text before @ is userinfo, not the host.
    conversation.properties.zoomMeetingUrl = 'https://zoom.us@evil.com/j/123456789'
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns true when name is missing', () => {
    const conversation = completeConversation()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).name = undefined
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns true when name is an empty string', () => {
    const conversation = completeConversation()
    conversation.name = ''
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns false when scheduledTime is missing but name and topic are present (instant-start)', () => {
    const conversation = completeConversation()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).scheduledTime = undefined
    expect(isConversationDraft(conversation)).toBe(false)
  })

  test('returns false for an instant-start conversation with no Zoom link or scheduledEndTime', () => {
    const conversation = completeConversation()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).scheduledTime = undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).scheduledEndTime = undefined
    conversation.properties = {} as { zoomMeetingUrl: string }
    expect(isConversationDraft(conversation)).toBe(false)
  })

  test('returns true when scheduledTime and name are both missing', () => {
    const conversation = completeConversation()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).scheduledTime = undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).name = undefined
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns true when scheduledEndTime is missing', () => {
    const conversation = completeConversation()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).scheduledEndTime = undefined
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('returns true when topic is missing', () => {
    const conversation = completeConversation()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).topic = undefined
    expect(isConversationDraft(conversation)).toBe(true)
  })

  /* Required properties come from the conversation type definition, so a scheduled type that
     does not declare a Zoom link (or any other property) is not held Draft for lacking one. */
  test('does not require a Zoom link for a scheduled type that does not declare one', () => {
    setConversationTypes({
      surveyBot: stubType('surveyBot', [{ name: 'surveyId', required: true, type: 'string' }])
    })
    const conversation = {
      name: 'Weekly survey',
      topic: 'topic-id',
      conversationType: 'surveyBot',
      scheduledTime: new Date('2030-01-01T10:00:00Z'),
      scheduledEndTime: new Date('2030-01-01T11:00:00Z'),
      properties: { surveyId: 'abc-123' }
    }
    expect(isConversationDraft(conversation)).toBe(false)
  })

  test('returns true when a property the type marks required is missing', () => {
    setConversationTypes({
      surveyBot: stubType('surveyBot', [{ name: 'surveyId', required: true, type: 'string' }])
    })
    const conversation = {
      name: 'Weekly survey',
      topic: 'topic-id',
      conversationType: 'surveyBot',
      scheduledTime: new Date('2030-01-01T10:00:00Z'),
      scheduledEndTime: new Date('2030-01-01T11:00:00Z'),
      properties: {}
    }
    expect(isConversationDraft(conversation)).toBe(true)
  })

  /* Format validation follows the property's declared format, not its name, so any property
     can carry the Zoom-host rule (or a future format) rather than only zoomMeetingUrl. */
  test('flags a scheduled conversation whose formatted property holds an invalid value', () => {
    setConversationTypes({
      surveyBot: stubType('surveyBot', [{ name: 'meetingLink', required: true, type: 'string', format: 'zoomUrl' }])
    })
    const conversation = {
      name: 'Weekly survey',
      topic: 'topic-id',
      conversationType: 'surveyBot',
      scheduledTime: new Date('2030-01-01T10:00:00Z'),
      scheduledEndTime: new Date('2030-01-01T11:00:00Z'),
      properties: { meetingLink: 'https://evil.com/j/1' }
    }
    expect(isConversationDraft(conversation)).toBe(true)
  })

  test('treats a required property with a declared default as satisfied', () => {
    setConversationTypes({
      surveyBot: stubType('surveyBot', [{ name: 'cadence', required: true, type: 'string', default: 'weekly' }])
    })
    const conversation = {
      name: 'Weekly survey',
      topic: 'topic-id',
      conversationType: 'surveyBot',
      scheduledTime: new Date('2030-01-01T10:00:00Z'),
      scheduledEndTime: new Date('2030-01-01T11:00:00Z'),
      properties: {}
    }
    expect(isConversationDraft(conversation)).toBe(false)
  })

  /* A Zoom-relayed invite's organizer is resolved from Reply-To, which Zoom never verifies (see
     emailSetup.service.ts's resolveOrganizer), so source.pendingOrganizerConfirmation holds the
     conversation Draft independent of every other check — otherwise an attacker who happens to
     guess a real Topic prefix could skip confirmation entirely despite every other field already
     looking complete. Cleared only by organizerConfirmation.service.ts's confirmOrganizer. */
  describe('source.pendingOrganizerConfirmation', () => {
    test('holds an otherwise-complete conversation Draft', () => {
      const conversation = completeConversation() as ReturnType<typeof completeConversation> & {
        source?: Record<string, unknown>
      }
      conversation.source = { pendingOrganizerConfirmation: true }
      expect(isConversationDraft(conversation)).toBe(true)
    })

    test('holds an instant-start conversation Draft too, despite having no scheduledTime at all', () => {
      const conversation = completeConversation() as ReturnType<typeof completeConversation> & {
        source?: Record<string, unknown>
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(conversation as any).scheduledTime = undefined
      conversation.source = { pendingOrganizerConfirmation: true }
      expect(isConversationDraft(conversation)).toBe(true)
    })

    test('does not hold a conversation Draft once cleared (false), only while true', () => {
      const conversation = completeConversation() as ReturnType<typeof completeConversation> & {
        source?: Record<string, unknown>
      }
      conversation.source = { pendingOrganizerConfirmation: false }
      expect(isConversationDraft(conversation)).toBe(false)
    })

    test('is a no-op when absent, so every unrelated conversation is unaffected', () => {
      const conversation = completeConversation() as ReturnType<typeof completeConversation> & {
        source?: Record<string, unknown>
      }
      conversation.source = { inviteUid: 'UID-1' }
      expect(isConversationDraft(conversation)).toBe(false)
    })
  })
})

describe('isPreEventWindowOpen', () => {
  function withinWindow(overrides: Record<string, unknown> = {}) {
    return {
      scheduledTime: new Date(Date.now() + 5 * 60 * 1000),
      preEventMinutes: 15,
      ...overrides
    }
  }

  test('is open once within preEventMinutes of scheduledTime', () => {
    expect(isPreEventWindowOpen(withinWindow())).toBe(true)
  })

  test('is not open before preEventMinutes of scheduledTime', () => {
    expect(isPreEventWindowOpen(withinWindow({ scheduledTime: new Date(Date.now() + 60 * 60 * 1000) }))).toBe(false)
  })

  test('is not open once the conversation has started', () => {
    expect(isPreEventWindowOpen(withinWindow({ startTime: new Date() }))).toBe(false)
  })

  test('is not open for a draft, even if scheduledTime/preEventMinutes would otherwise open it', () => {
    expect(isPreEventWindowOpen(withinWindow({ draft: true }))).toBe(false)
  })

  test('is not open when preEventMinutes is unconfigured', () => {
    expect(isPreEventWindowOpen(withinWindow({ preEventMinutes: undefined }))).toBe(false)
  })

  test('is not open when scheduledTime is unset', () => {
    expect(isPreEventWindowOpen(withinWindow({ scheduledTime: undefined }))).toBe(false)
  })
})

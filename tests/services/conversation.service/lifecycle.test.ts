import { isConversationDraft } from '../../../src/services/conversation.service/lifecycle.js'

/* A conversation with all five required-for-non-Draft fields present and valid. Individual
   tests mutate a copy of this to knock out one field at a time. */
function completeConversation() {
  return {
    name: 'Tech Conference Q&A',
    topic: 'topic-id',
    scheduledTime: new Date('2030-01-01T10:00:00Z'),
    scheduledEndTime: new Date('2030-01-01T11:00:00Z'),
    properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' }
  }
}

describe('isConversationDraft', () => {
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

  test('returns true when scheduledTime is missing', () => {
    const conversation = completeConversation()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(conversation as any).scheduledTime = undefined
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
})

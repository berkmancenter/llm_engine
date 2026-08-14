import { jest } from '@jest/globals'
import { ParsedInvite } from '../../../../src/types/index.types.js'

/* The model call is the only external dependency here, so it is the only thing mocked.
   getModelChat is mocked too, purely so constructing the chat client never needs real
   credentials; its return value is never inspected since getChatPromptResponse is mocked. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetModelChat = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))
jest.unstable_mockModule('../src/agents/helpers/getModelChat.js', () => ({
  getModelChat: mockGetModelChat
}))

const { planConversationFromInvite, planConversationFromEmail } = await import(
  '../../../../src/services/eventSetup/planner.service.js'
)
const { ExtractedFieldsSchema } = await import('../../../../src/services/eventSetup/eventFieldsSchema.js')
const { default: logger } = await import('../../../../src/config/logger.js')

function invite(overrides: Partial<ParsedInvite> = {}): ParsedInvite {
  return {
    uid: 'UID-1',
    summary: 'Team Sync: standup',
    description: 'Weekly team sync, join via Zoom',
    location: 'https://zoom.us/j/123456789',
    ...overrides
  }
}

describe('planConversationFromInvite', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
    mockGetModelChat.mockReset()
    mockGetModelChat.mockResolvedValue({ fake: true })
    jest.spyOn(logger, 'error').mockReturnValue(undefined as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns the fuzzy fields the model extracted', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      zoomLink: 'https://zoom.us/j/123456789',
      speakers: [{ name: 'Jane Doe', bio: '' }],
      description: 'Weekly team sync'
    })

    const result = await planConversationFromInvite({ invite: invite() })

    expect(result).toEqual({
      zoomLink: 'https://zoom.us/j/123456789',
      speakers: [{ name: 'Jane Doe', bio: '' }],
      description: 'Weekly team sync'
    })
  })

  /* The prompt restricts zoomLink to Zoom URLs only (see the "Ignore all other video platforms"
     rule), so a Teams (or other non-Zoom) link is exactly the case where a well-behaved model
     omits zoomLink. This confirms the pipeline preserves that absence rather than inventing a
     fallback value; a missing zoomLink is fine downstream since drafts tolerate it (see
     resolver.ts's allowDraft check and isConversationDraft treating a missing zoomMeetingUrl as
     draft, not an error). */
  it('returns no zoomLink when the invite links to a non-Zoom platform like Teams', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      description: 'Weekly team sync'
    })

    const result = await planConversationFromInvite({
      invite: invite({ location: 'https://teams.microsoft.com/l/meetup-join/abc123' })
    })

    expect(result.zoomLink).toBeUndefined()
  })

  it('returns no zoomLink when the invite has no meeting link at all', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      description: 'Weekly team sync'
    })

    const result = await planConversationFromInvite({ invite: invite({ location: undefined }) })

    expect(result.zoomLink).toBeUndefined()
  })

  it('sends the invite title, body, and location to the model, validated against the shared ExtractedFieldsSchema', async () => {
    mockGetChatPromptResponse.mockResolvedValue({})

    await planConversationFromInvite({
      invite: invite({ summary: 'BKCircle: Jane Presents', description: 'A talk on AI', location: 'Room 101' })
    })

    expect(mockGetChatPromptResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      { summary: 'BKCircle: Jane Presents', description: 'A talk on AI', location: 'Room 101' },
      [],
      ExtractedFieldsSchema
    )
  })

  it('substitutes a placeholder when the invite has no description or location', async () => {
    mockGetChatPromptResponse.mockResolvedValue({})

    await planConversationFromInvite({ invite: invite({ description: undefined, location: undefined }) })

    expect(mockGetChatPromptResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      { summary: 'Team Sync: standup', description: '(none)', location: '(none)' },
      [],
      ExtractedFieldsSchema
    )
  })

  /* Topic matching is deliberately never LLM-driven (see the plan's "Topic matching never uses
     the LLM"), and dateTime/duration are already known exactly from the .ics DTSTART/DTEND. If the
     model returns them anyway, despite the prompt telling it not to, they must not leak through:
     a future caller reading extracted.topicName would silently reintroduce the thing this design
     avoids. */
  it('drops dateTime, duration, topicName, eventName, and timeZone even if the model returns them', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      eventName: 'Team Sync',
      dateTime: '2026-08-01T17:00:00Z',
      duration: 60,
      topicName: 'Team Sync',
      timeZone: 'America/New_York',
      zoomLink: 'https://zoom.us/j/123456789',
      description: 'Weekly sync'
    })

    const result = await planConversationFromInvite({ invite: invite() })

    expect(result).toEqual({
      zoomLink: 'https://zoom.us/j/123456789',
      description: 'Weekly sync'
    })
  })

  it('falls back to an empty result and logs when the model call throws', async () => {
    mockGetChatPromptResponse.mockRejectedValue(new Error('rate limited'))

    const result = await planConversationFromInvite({ invite: invite() })

    expect(result).toEqual({})
    expect(logger.error).toHaveBeenCalled()
  })

  it('falls back to an empty result when the model returns nothing', async () => {
    mockGetChatPromptResponse.mockResolvedValue(undefined)

    const result = await planConversationFromInvite({ invite: invite() })

    expect(result).toEqual({})
  })
})

describe('planConversationFromEmail', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
    mockGetModelChat.mockReset()
    mockGetModelChat.mockResolvedValue({ fake: true })
    jest.spyOn(logger, 'error').mockReturnValue(undefined as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns the fuzzy fields the model extracted', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      zoomLink: 'https://zoom.us/j/123456789',
      speakers: [{ name: 'Jane Doe', bio: '' }],
      description: 'A quick catch-up'
    })

    const result = await planConversationFromEmail({
      subject: 'Quick sync',
      body: 'Join here: https://zoom.us/j/123456789'
    })

    expect(result).toEqual({
      zoomLink: 'https://zoom.us/j/123456789',
      speakers: [{ name: 'Jane Doe', bio: '' }],
      description: 'A quick catch-up'
    })
  })

  /* Naming and Topic resolution for this flow are both deterministic (see emailSetup.service.ts
     and topic.service.ts's findOrCreateEmailTopic), never model-derived, so eventName and
     topicName must not leak through even if the model answers with them anyway. */
  it('drops eventName and topicName even if the model returns them', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      eventName: 'Quick sync',
      topicName: 'Team Sync',
      zoomLink: 'https://zoom.us/j/123456789'
    })

    const result = await planConversationFromEmail({ subject: 'Quick sync', body: 'body text' })

    expect(result).toEqual({
      zoomLink: 'https://zoom.us/j/123456789'
    })
  })

  it('returns no zoomLink when the email has no meeting link at all', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ description: 'Catching up' })

    const result = await planConversationFromEmail({ subject: 'Catch up', body: 'Let us catch up sometime' })

    expect(result.zoomLink).toBeUndefined()
  })

  it('sends the subject and body to the model, validated against the shared ExtractedFieldsSchema', async () => {
    mockGetChatPromptResponse.mockResolvedValue({})

    await planConversationFromEmail({ subject: 'Zoom call', body: 'Here is the link: https://zoom.us/j/123' })

    expect(mockGetChatPromptResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      { subject: 'Zoom call', body: 'Here is the link: https://zoom.us/j/123' },
      [],
      ExtractedFieldsSchema
    )
  })

  it('substitutes a placeholder when the email has no subject or body', async () => {
    mockGetChatPromptResponse.mockResolvedValue({})

    await planConversationFromEmail({ subject: undefined, body: undefined })

    expect(mockGetChatPromptResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      { subject: '(none)', body: '(none)' },
      [],
      ExtractedFieldsSchema
    )
  })

  it('falls back to an empty result and logs when the model call throws', async () => {
    mockGetChatPromptResponse.mockRejectedValue(new Error('rate limited'))

    const result = await planConversationFromEmail({ subject: 'Zoom call', body: 'link' })

    expect(result).toEqual({})
    expect(logger.error).toHaveBeenCalled()
  })

  it('falls back to an empty result when the model returns nothing', async () => {
    mockGetChatPromptResponse.mockResolvedValue(undefined)

    const result = await planConversationFromEmail({ subject: 'Zoom call', body: 'link' })

    expect(result).toEqual({})
  })
})

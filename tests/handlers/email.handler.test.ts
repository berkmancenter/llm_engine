import { jest } from '@jest/globals'
import httpStatus from 'http-status'
import request from 'supertest'
import app from '../../src/app.js'
import config from '../../src/config/config.js'
import logger from '../../src/config/logger.js'
import setupIntTest from '../utils/setupIntTest.js'
import waitFor from '../utils/waitFor.js'
import { insertUsers } from '../fixtures/user.fixture.js'
import { Conversation } from '../../src/models/index.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import transcript from '../../src/agents/helpers/transcript.js'
import plannerService from '../../src/services/eventSetup/planner.service.js'
import emailService from '../../src/services/email.service.js'
import { parseInviteFromPayload } from '../../src/handlers/email.js'
import { AgentMessageActions } from '../../src/types/index.types.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { setAdapterTypes } from '../../src/models/adapter.model.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'

setupIntTest()

// Both wiring flows below enable a default set of feature agents (see resolveFeatures), and the
// on-demand flow starts the conversation immediately, driving the real 'zoom' adapter's start()
// (a live network call to Recall.ai). Stub both registries so this suite never calls a real LLM
// or a real third-party service; see tests/CLAUDE.md's Mocking section for the pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRespond = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([])
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEvaluate = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
  userMessage: '',
  action: AgentMessageActions.REJECT,
  userContributionVisible: false,
  suggestion: ''
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStart = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStop = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIntroduce = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([])

const testAgentTypes = {
  eventAssistant: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    introduce: mockIntroduce,
    name: 'Test Event Assistant',
    description: 'A test agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { minNewMessage: 2 } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  backChannelInsights: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Manual Test Agent',
    description: 'A manually activated test agent with no triggers',
    maxTokens: 2000,
    defaultTriggers: undefined,
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  proactiveGroupAgent: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Proactive Group Test Agent',
    description: 'Test proactive agent with agentConfig',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 60 } },
    priority: 85,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are a mediator agent',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel,
    agentConfig: {
      mediatorMinInterval: 1,
      personality: 'sarcastic-expert'
    }
  },
  jargonFilterAgent: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Jargon Filter Agent',
    description: 'Test jargon filter agent',
    maxTokens: 500,
    defaultTriggers: { periodic: { timerPeriod: 120 } },
    priority: 50,
    llmTemplateVars: { system: [], user: [] },
    defaultLLMTemplates: {
      system: 'You are a jargon filter agent',
      user: 'Analyze this transcript: {transcript}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  voiceAssistant: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Voice Assistant',
    description: 'Test voice assistant agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { channels: ['transcript'] } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are a voice assistant agent',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  moderatorNotifier: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Moderator Notifier',
    description: 'Test moderator notifier agent',
    maxTokens: 500,
    defaultTriggers: { periodic: { timerPeriod: 60 } },
    priority: 50,
    llmTemplateVars: { system: [], user: [] },
    defaultLLMTemplates: {
      system: 'You are a moderator notifier agent',
      user: 'Analyze this transcript: {transcript}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  librarian: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Librarian',
    description: 'Test librarian agent',
    maxTokens: 500,
    defaultTriggers: { periodic: { timerPeriod: 120 } },
    priority: 50,
    llmTemplateVars: { system: [], user: [] },
    defaultLLMTemplates: {
      system: 'You are a librarian agent',
      user: 'Recommend readings for: {transcript}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdapterStart = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdapterStop = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined)
// Real keys, not []: adapter.service.ts's active-meeting-uniqueness check is a no-op otherwise.
const mockGetUniqueKeys = jest.fn<() => string[]>().mockReturnValue(['type', 'config.meetingUrl'])

const testAdapterTypes = {
  zoom: {
    start: mockAdapterStart,
    stop: mockAdapterStop,
    getUniqueKeys: mockGetUniqueKeys
  }
}

const webhookUser = 'email-webhook'
const webhookSecret = 'test-webhook-secret'

/**
 * Build a raw iCalendar (.ics) VEVENT body, the kind Outlook attaches to a meeting invite.
 * Any field passed as null is omitted, so tests can exercise partial invites.
 */
const buildIcs = (
  fields: {
    uid?: string | null
    summary?: string | null
    description?: string | null
    location?: string | null
    dtstart?: string | null
    dtend?: string | null
    organizer?: string | null
  } = {}
): string => {
  const {
    uid = '040000008200E00074C5B7101A82E00800000000ABCDEF01',
    summary = 'Quarterly Strategy Roundtable',
    description = 'Join on Zoom: https://acme.example.com/j/9876543210',
    location = 'https://acme.example.com/j/9876543210',
    dtstart = '20260901T170000Z',
    dtend = '20260901T180000Z',
    organizer = 'CN=Jane Organizer:mailto:jane@example.com'
  } = fields

  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT'
  ]
  if (uid !== null) lines.push(`UID:${uid}`)
  if (summary !== null) lines.push(`SUMMARY:${summary}`)
  if (description !== null) lines.push(`DESCRIPTION:${description}`)
  if (location !== null) lines.push(`LOCATION:${location}`)
  if (dtstart !== null) lines.push(`DTSTART:${dtstart}`)
  if (dtend !== null) lines.push(`DTEND:${dtend}`)
  if (organizer !== null) lines.push(`ORGANIZER;${organizer}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}

/** Wrap an .ics body in an inbound email webhook payload (Postmark's shape) as its base64 .ics attachment. */
const buildInboundEmailPayload = (icsBody: string, attachmentOverrides = {}) => ({
  FromName: 'Jane Organizer',
  From: 'jane@example.com',
  Subject: 'Quarterly Strategy Roundtable',
  MessageID: '73e6d360-66eb-11e1-8e72-a8206ea7d3ea',
  TextBody: 'You are invited.',
  Attachments: [
    {
      Name: 'invite.ics',
      Content: Buffer.from(icsBody, 'utf8').toString('base64'),
      ContentType: 'text/calendar; method=REQUEST; name="invite.ics"',
      ContentLength: icsBody.length,
      ContentID: '',
      ...attachmentOverrides
    }
  ]
})

/** An inbound plain-email webhook payload (Postmark's shape), no .ics attachment. */
const buildOnDemandEmailPayload = (overrides: Record<string, unknown> = {}) => ({
  FromName: 'Jane Organizer',
  From: 'jane@example.com',
  Subject: 'Quick sync',
  MessageID: 'msg-on-demand-1',
  TextBody: 'Join here: https://zoom.us/j/123456789',
  Attachments: [],
  ...overrides
})

describe('POST /v1/webhooks/email', () => {
  let originalUser
  let originalSecret

  beforeAll(() => {
    originalUser = config.emailWebhook.authUser
    originalSecret = config.emailWebhook.authSecret
    config.emailWebhook.authUser = webhookUser
    config.emailWebhook.authSecret = webhookSecret
    setAgentTypes(testAgentTypes)
    setAdapterTypes(testAdapterTypes)
  })

  afterAll(() => {
    config.emailWebhook.authUser = originalUser
    config.emailWebhook.authSecret = originalSecret
    setAgentTypes(defaultAgentTypes)
    setAdapterTypes(defaultAdapterTypes)
  })

  describe('Basic Auth', () => {
    test('accepts a request with valid credentials and responds 200', async () => {
      await request(app)
        .post('/v1/webhooks/email')
        .auth(webhookUser, webhookSecret)
        .send(buildInboundEmailPayload(buildIcs()))
        .expect(httpStatus.OK)
    })

    test('rejects a request with no Authorization header before parsing', async () => {
      await request(app)
        .post('/v1/webhooks/email')
        .send(buildInboundEmailPayload(buildIcs()))
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('rejects a request with the wrong password', async () => {
      await request(app)
        .post('/v1/webhooks/email')
        .auth(webhookUser, 'wrong-secret')
        .send(buildInboundEmailPayload(buildIcs()))
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('rejects a request with the wrong username', async () => {
      await request(app)
        .post('/v1/webhooks/email')
        .auth('impostor', webhookSecret)
        .send(buildInboundEmailPayload(buildIcs()))
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('responds 200 even when the message carries no calendar attachment', async () => {
      const payload = buildInboundEmailPayload(buildIcs())
      payload.Attachments = []
      await request(app).post('/v1/webhooks/email').auth(webhookUser, webhookSecret).send(payload).expect(httpStatus.OK)
    })
  })

  describe('logging', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('logs the invite start and end times as UTC', async () => {
      // The log is this handler's only output, so a timezone mistake is invisible without the times.
      const infoSpy = jest.spyOn(logger, 'info').mockReturnValue(logger)

      await request(app)
        .post('/v1/webhooks/email')
        .auth(webhookUser, webhookSecret)
        .send(buildInboundEmailPayload(buildIcs()))
        .expect(httpStatus.OK)

      const logged = infoSpy.mock.calls.map(([message]) => String(message)).join('\n')
      expect(logged).toContain('2026-09-01T17:00:00.000Z')
      expect(logged).toContain('2026-09-01T18:00:00.000Z')
    })
  })

  describe('parseInviteFromPayload', () => {
    test('extracts the calendar fields from the base64-encoded .ics attachment', () => {
      const invite = parseInviteFromPayload(buildInboundEmailPayload(buildIcs()))

      expect(invite).not.toBeNull()
      expect(invite?.uid).toBe('040000008200E00074C5B7101A82E00800000000ABCDEF01')
      expect(invite?.summary).toBe('Quarterly Strategy Roundtable')
      expect(invite?.description).toBe('Join on Zoom: https://acme.example.com/j/9876543210')
      expect(invite?.location).toBe('https://acme.example.com/j/9876543210')
      expect(invite?.organizer).toBe('jane@example.com')
      expect(invite?.startDate?.toISOString()).toBe('2026-09-01T17:00:00.000Z')
      expect(invite?.endDate?.toISOString()).toBe('2026-09-01T18:00:00.000Z')
    })

    test('resolves a TZID-based DTSTART/DTEND through the embedded VTIMEZONE', () => {
      // Outlook names zones the Windows way ("Eastern Standard Time"), not the IANA way, and
      // defines them in the file. Sept 1 2026 is daylight there (UTC-4), so 13:00 local is 17:00 UTC.
      const ics = [
        'BEGIN:VCALENDAR',
        'PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN',
        'VERSION:2.0',
        'METHOD:REQUEST',
        'BEGIN:VTIMEZONE',
        'TZID:Eastern Standard Time',
        'BEGIN:STANDARD',
        'DTSTART:16011104T020000',
        'TZOFFSETFROM:-0400',
        'TZOFFSETTO:-0500',
        'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:16010311T020000',
        'TZOFFSETFROM:-0500',
        'TZOFFSETTO:-0400',
        'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
        'END:DAYLIGHT',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:040000008200E00074C5B7101A82E00800000000ABCDEF01',
        'SUMMARY:Quarterly Strategy Roundtable',
        'DESCRIPTION:Join on Zoom: https://acme.example.com/j/9876543210',
        'LOCATION:https://acme.example.com/j/9876543210',
        'DTSTART;TZID=Eastern Standard Time:20260901T130000',
        'DTEND;TZID=Eastern Standard Time:20260901T140000',
        'ORGANIZER;CN=Jane Organizer:mailto:jane@example.com',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n')

      const invite = parseInviteFromPayload(buildInboundEmailPayload(ics))

      expect(invite?.startDate?.toISOString()).toBe('2026-09-01T17:00:00.000Z')
      expect(invite?.endDate?.toISOString()).toBe('2026-09-01T18:00:00.000Z')
    })

    test('identifies the .ics attachment by filename when the content type is generic', () => {
      const payload = buildInboundEmailPayload(buildIcs(), {
        Name: 'meeting.ics',
        ContentType: 'application/octet-stream'
      })

      const invite = parseInviteFromPayload(payload)

      expect(invite?.summary).toBe('Quarterly Strategy Roundtable')
    })

    test('returns null when there is no calendar attachment', () => {
      const payload = buildInboundEmailPayload(buildIcs())
      payload.Attachments = [
        {
          Name: 'photo.png',
          Content: Buffer.from('not-a-calendar', 'utf8').toString('base64'),
          ContentType: 'image/png',
          ContentLength: 14,
          ContentID: ''
        }
      ]

      expect(parseInviteFromPayload(payload)).toBeNull()
    })

    test('returns null when the attachments array is missing', () => {
      expect(parseInviteFromPayload({ From: 'jane@example.com' })).toBeNull()
    })
  })

  describe('createConversationFromInvite wiring', () => {
    let originalDomains

    beforeAll(() => {
      originalDomains = config.allowedOrganizerEmailDomains
      config.allowedOrganizerEmailDomains = ['example.com']
    })

    afterAll(() => {
      config.allowedOrganizerEmailDomains = originalDomains
    })

    let sendEventCreatedSpy
    let planConversationFromInviteSpy

    beforeEach(() => {
      jest.spyOn(websocketGateway, 'broadcastNewConversation').mockResolvedValue(undefined as never)
      jest.spyOn(transcript, 'loadTopicMetadataIntoVectorStore').mockResolvedValue(undefined as never)
      jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue(undefined as never)
      // The extraction call is unit-tested on its own (planner.service.test.ts); mocked here so
      // this plumbing test isn't also exercising (or paying for) a real LLM call.
      planConversationFromInviteSpy = jest.spyOn(plannerService, 'planConversationFromInvite').mockResolvedValue({})
      sendEventCreatedSpy = jest.spyOn(emailService, 'sendEventCreatedEmail').mockResolvedValue(undefined as never)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('creates a draft conversation from a valid inbound invite', async () => {
      await insertUsers([
        {
          username: 'jane',
          email: 'jane@example.com',
          password: 'password1',
          role: 'user',
          isEmailVerified: false
        }
      ])

      await request(app)
        .post('/v1/webhooks/email')
        .auth(webhookUser, webhookSecret)
        .send(buildInboundEmailPayload(buildIcs()))
        .expect(httpStatus.OK)

      /* The response comes back before background processing finishes (see handlers/email.ts's
           ack-before-processing comment), so poll for the confirmation email rather than the
           Conversation document: that's the signal createConversationFromInvite is fully done
           (channels, agents, and scheduling all settled), not just that the doc first appeared.
           Racing ahead on the doc alone left background work from this test still running when
           the next test's setupIntTest() beforeEach wiped the database out from under it. */
      await waitFor(() => {
        if (sendEventCreatedSpy.mock.calls.length === 0) throw new Error('not finished yet')
      })

      const conversation = await Conversation.findOne({
        'source.inviteUid': '040000008200E00074C5B7101A82E00800000000ABCDEF01'
      })
      expect(conversation).not.toBeNull()
      expect(conversation!.name).toBe('Quarterly Strategy Roundtable')
    }, 10000)

    test('creates nothing when the sender is outside the allowlisted domain', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockReturnValue(logger)
      const payload = buildInboundEmailPayload(buildIcs())
      payload.From = 'stranger@not-an-org.invalid'

      await request(app).post('/v1/webhooks/email').auth(webhookUser, webhookSecret).send(payload).expect(httpStatus.OK)

      // Poll for the rejection log rather than sleeping a fixed amount: it's the observable proof
      // that the background handling (parsing, then resolveOrganizer's domain check) has run.
      await waitFor(() => {
        const rejected = warnSpy.mock.calls.some(([msg]) => String(msg).includes('stranger@not-an-org.invalid'))
        if (!rejected) throw new Error('rejection warning not logged yet')
      })
      expect(await Conversation.countDocuments()).toBe(0)
    }, 10000)

    test('threads the email TextBody through to the invite extraction as the fill-gap body', async () => {
      await insertUsers([
        {
          username: 'jane',
          email: 'jane@example.com',
          password: 'password1',
          role: 'user',
          isEmailVerified: false
        }
      ])

      await request(app)
        .post('/v1/webhooks/email')
        .auth(webhookUser, webhookSecret)
        .send(buildInboundEmailPayload(buildIcs()))
        .expect(httpStatus.OK)

      await waitFor(() => {
        if (sendEventCreatedSpy.mock.calls.length === 0) throw new Error('not finished yet')
      })

      expect(planConversationFromInviteSpy).toHaveBeenCalledWith(expect.objectContaining({ body: 'You are invited.' }))
    }, 10000)
  })

  describe('createConversationFromEmail wiring', () => {
    let originalDomains

    beforeAll(() => {
      originalDomains = config.allowedOrganizerEmailDomains
      config.allowedOrganizerEmailDomains = ['example.com']
    })

    afterAll(() => {
      config.allowedOrganizerEmailDomains = originalDomains
    })

    let sendOnDemandEventSpy

    beforeEach(() => {
      jest.spyOn(websocketGateway, 'broadcastNewConversation').mockResolvedValue(undefined as never)
      jest.spyOn(transcript, 'loadTopicMetadataIntoVectorStore').mockResolvedValue(undefined as never)
      jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue(undefined as never)
      // The extraction call is unit-tested on its own (planner.service.test.ts); mocked here so
      // this plumbing test isn't also exercising (or paying for) a real LLM call.
      jest.spyOn(plannerService, 'planConversationFromEmail').mockResolvedValue({ zoomLink: 'https://zoom.us/j/123456789' })
      sendOnDemandEventSpy = jest.spyOn(emailService, 'sendOnDemandEventEmail').mockResolvedValue(undefined as never)
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    test('creates an on-demand conversation from a plain email with a Zoom link', async () => {
      await insertUsers([
        {
          username: 'jane',
          email: 'jane@example.com',
          password: 'password1',
          role: 'user',
          isEmailVerified: false
        }
      ])

      await request(app)
        .post('/v1/webhooks/email')
        .auth(webhookUser, webhookSecret)
        .send(buildOnDemandEmailPayload())
        .expect(httpStatus.OK)

      // Same reasoning as the invite-wiring test above: poll for the confirmation email, the
      // signal that background processing (extraction, Topic, conversation creation) is done.
      await waitFor(() => {
        if (sendOnDemandEventSpy.mock.calls.length === 0) throw new Error('not finished yet')
      })

      const conversation = await Conversation.findOne({ 'source.messageId': 'msg-on-demand-1' })
      expect(conversation).not.toBeNull()
      expect(conversation!.name).toBe('Quick sync')
    }, 10000)

    test('names the event from the sender display name when the email has no subject', async () => {
      await insertUsers([
        {
          username: 'jane',
          email: 'jane@example.com',
          password: 'password1',
          role: 'user',
          isEmailVerified: false
        }
      ])

      await request(app)
        .post('/v1/webhooks/email')
        .auth(webhookUser, webhookSecret)
        .send(buildOnDemandEmailPayload({ Subject: '', FromName: 'Jane Organizer' }))
        .expect(httpStatus.OK)

      await waitFor(() => {
        if (sendOnDemandEventSpy.mock.calls.length === 0) throw new Error('not finished yet')
      })

      const conversation = await Conversation.findOne({ 'source.messageId': 'msg-on-demand-1' })
      expect(conversation).not.toBeNull()
      expect(conversation!.name).toMatch(/^Jane Organizer Call \d{1,2}-\d{1,2}-\d{2}$/)
    }, 10000)

    test('creates nothing when the sender is outside the allowlisted domain', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockReturnValue(logger)
      const payload = buildOnDemandEmailPayload({ From: 'stranger@not-an-org.invalid' })

      await request(app).post('/v1/webhooks/email').auth(webhookUser, webhookSecret).send(payload).expect(httpStatus.OK)

      await waitFor(() => {
        const rejected = warnSpy.mock.calls.some(([msg]) => String(msg).includes('stranger@not-an-org.invalid'))
        if (!rejected) throw new Error('rejection warning not logged yet')
      })
      expect(await Conversation.countDocuments()).toBe(0)
    }, 10000)
  })
})

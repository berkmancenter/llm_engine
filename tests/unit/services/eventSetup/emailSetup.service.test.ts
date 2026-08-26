import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import config from '../../../../src/config/config.js'
import logger from '../../../../src/config/logger.js'
import emailService from '../../../../src/services/email.service.js'
import transcript from '../../../../src/agents/helpers/transcript.js'
import websocketGateway from '../../../../src/websockets/websocketGateway.js'
import { Adapter, Conversation, Topic } from '../../../../src/models/index.js'
import { insertUsers } from '../../../fixtures/user.fixture.js'
import plannerService from '../../../../src/services/eventSetup/planner.service.js'
import conversationService from '../../../../src/services/conversation.service/index.js'
import {
  resolveOrganizer,
  resolveTopic,
  createConversationFromInvite,
  createConversationFromEmail
} from '../../../../src/services/eventSetup/emailSetup.service.js'
import { AgentMessageActions, InboundInvite, InboundEmail } from '../../../../src/types/index.types.js'
import { setAgentTypes } from '../../../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../../../src/agents/index.js'
import { setAdapterTypes } from '../../../../src/models/adapter.model.js'
import defaultAdapterTypes from '../../../../src/adapters/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../../src/agents/helpers/getModelChat.js'

setupIntTest()

// Stub the feature agents both flows enable by default, so this suite never calls a real LLM.
// Resolved values matter: the on-demand flow calls agent.introduce synchronously, and this file
// doesn't mock 'agenda', so respond/evaluate can also fire from a real background job.
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

// The on-demand flow starts the conversation immediately, which drives the real 'zoom' adapter's
// start() (a live network call to Recall.ai) unless it's stubbed here too.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdapterStart = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdapterStop = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined)
// Real keys, not []: adapter.service.ts's active-meeting-uniqueness check (which the "never hands
// another organizer" test below depends on) is a no-op when getUniqueKeys returns no keys.
const mockGetUniqueKeys = jest.fn<() => string[]>().mockReturnValue(['type', 'config.meetingUrl'])

const testAdapterTypes = {
  zoom: {
    start: mockAdapterStart,
    stop: mockAdapterStop,
    getUniqueKeys: mockGetUniqueKeys
  }
}

// Set the allowlist explicitly so these tests don't depend on an ambient env var.
const allowedDomain = 'example.edu'
config.allowedOrganizerEmailDomains = [allowedDomain]
const OUTSIDE_DOMAIN = 'not-an-org.invalid'

// createConversation rejects a scheduledTime in the past, so these are relative to now rather than
// fixed calendar dates, which would silently rot the whole suite once the date passed.
const HOUR_MS = 60 * 60 * 1000
const INVITE_START = new Date(Date.now() + 24 * HOUR_MS) // tomorrow
const INVITE_END = new Date(INVITE_START.getTime() + HOUR_MS)

// DTSTART is mandatory in a well-formed .ics VEVENT (RFC 5545), so a real inbound invite always
// has a start date; these defaults keep that realistic instead of exercising the no-scheduledTime
// instant-start path, which createConversationFromInvite never actually takes.
const buildInvite = (
  overrides: Partial<InboundInvite['invite']> = {},
  fromAddress = `organizer@${allowedDomain}`
): InboundInvite => ({
  fromAddress,
  invite: {
    uid: 'UID-DEFAULT',
    summary: 'Some Event: additional info',
    startDate: INVITE_START,
    endDate: INVITE_END,
    ...overrides
  }
})

// createConversation rejects a scheduledTime in the past, so a "future" fixture is relative to
// now, same reasoning as INVITE_START above.
const FUTURE = new Date(Date.now() + 24 * HOUR_MS)

const buildEmail = (overrides: Partial<InboundEmail> = {}, fromAddress = `organizer@${allowedDomain}`): InboundEmail => ({
  fromAddress,
  subject: 'Quick sync',
  body: 'Join here: https://zoom.us/j/123456789',
  messageId: 'MSG-DEFAULT',
  ...overrides
})

const newUser = (email: string) => ({
  _id: new mongoose.Types.ObjectId(),
  username: email.split('@')[0],
  email,
  password: 'password1',
  role: 'participant',
  isEmailVerified: false
})

const insertTopic = (fields: Partial<{ name: string; owner: mongoose.Types.ObjectId; private: boolean }> = {}) =>
  Topic.create({
    name: 'placeholder',
    votingAllowed: false,
    conversationCreationAllowed: true,
    private: false,
    archivable: true,
    ...fields
  })

describe('emailSetup.service', () => {
  let sendSignupSpy
  let sendEventCreatedSpy
  let sendEventCreationFailedSpy
  let sendOnDemandEventSpy
  let sendOnDemandEventFailedSpy
  let loggerWarnSpy
  let loggerErrorSpy
  let planConversationFromInviteSpy
  let planConversationFromEmailSpy

  beforeAll(() => {
    setAgentTypes(testAgentTypes)
    setAdapterTypes(testAdapterTypes)
  })

  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
    setAdapterTypes(defaultAdapterTypes)
  })

  beforeEach(() => {
    jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    sendSignupSpy = jest.spyOn(emailService, 'sendSignupInviteEmail').mockResolvedValue(undefined as never)
    sendEventCreatedSpy = jest.spyOn(emailService, 'sendEventCreatedEmail').mockResolvedValue(undefined as never)
    sendEventCreationFailedSpy = jest
      .spyOn(emailService, 'sendEventCreationFailedEmail')
      .mockResolvedValue(undefined as never)
    sendOnDemandEventSpy = jest.spyOn(emailService, 'sendOnDemandEventEmail').mockResolvedValue(undefined as never)
    sendOnDemandEventFailedSpy = jest
      .spyOn(emailService, 'sendOnDemandEventFailedEmail')
      .mockResolvedValue(undefined as never)
    jest.spyOn(transcript, 'loadTopicMetadataIntoVectorStore').mockResolvedValue(undefined as never)
    jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue(undefined as never)
    jest.spyOn(websocketGateway, 'broadcastNewConversation').mockResolvedValue(undefined as never)
    loggerWarnSpy = jest.spyOn(logger, 'warn').mockReturnValue(undefined as never)
    jest.spyOn(logger, 'info').mockReturnValue(undefined as never)
    loggerErrorSpy = jest.spyOn(logger, 'error').mockReturnValue(undefined as never)
    // The extraction call is unit-tested on its own (planner.service.test.ts); here it is mocked
    // so createConversationFromInvite tests aren't also exercising (or paying for) a real LLM call.
    planConversationFromInviteSpy = jest.spyOn(plannerService, 'planConversationFromInvite').mockResolvedValue({})
    planConversationFromEmailSpy = jest
      .spyOn(plannerService, 'planConversationFromEmail')
      .mockResolvedValue({ zoomLink: 'https://zoom.us/j/123456789' })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('resolveOrganizer', () => {
    it('returns the account matching the envelope From address', async () => {
      const email = `known@${allowedDomain}`
      await insertUsers([newUser(email)])

      const organizer = await resolveOrganizer(email)

      expect(organizer).not.toBeNull()
      expect(organizer!.email).toBe(email)
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('recognizes a known organizer when the envelope From differs only in letter case', async () => {
      const storedEmail = `known@${allowedDomain}`
      await insertUsers([newUser(storedEmail)])

      const organizer = await resolveOrganizer(`Known@${allowedDomain.toUpperCase()}`)

      expect(organizer).not.toBeNull()
      expect(organizer!.email).toBe(storedEmail)
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('sends the signup invite and returns null for an unknown sender inside an allowlisted domain', async () => {
      const email = `newcomer@${allowedDomain}`

      const organizer = await resolveOrganizer(email)

      expect(organizer).toBeNull()
      expect(sendSignupSpy).toHaveBeenCalledWith(email)
    })

    it('sends no email and returns null for an unknown sender outside the allowlist', async () => {
      const email = `stranger@${OUTSIDE_DOMAIN}`

      const organizer = await resolveOrganizer(email)

      expect(organizer).toBeNull()
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('rejects a sender outside the allowlist even when they have an account (domain is a hard gate)', async () => {
      const email = `has-account@${OUTSIDE_DOMAIN}`
      await insertUsers([newUser(email)])

      const organizer = await resolveOrganizer(email)

      expect(organizer).toBeNull()
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('logs a warning when the .ics ORGANIZER differs from the envelope From', async () => {
      const email = `known@${allowedDomain}`
      await insertUsers([newUser(email)])

      await resolveOrganizer(email, `someone-else@${allowedDomain}`)

      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('someone-else'))
    })

    it('does not warn about a mismatch when ORGANIZER equals From', async () => {
      const email = `known@${allowedDomain}`
      await insertUsers([newUser(email)])

      await resolveOrganizer(email, email)

      expect(loggerWarnSpy).not.toHaveBeenCalled()
    })
  })

  describe('resolveTopic', () => {
    it('matches a public Topic by exact prefix regardless of who owns it', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      const [other] = await insertUsers([newUser(`other@${allowedDomain}`)])
      const publicTopic = await insertTopic({ name: 'BKCircle', owner: other._id, private: false })

      const topic = await resolveTopic(buildInvite({ summary: 'BKCircle: Jane Presents' }), organizer)

      expect(topic?.id).toBe(publicTopic.id)
    })

    it('matches despite case and whitespace differences in the prefix', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      const publicTopic = await insertTopic({ name: 'BKCircle', owner: organizer._id, private: false })

      const topic = await resolveTopic(buildInvite({ summary: '  bkcircle :  week 5' }), organizer)

      expect(topic?.id).toBe(publicTopic.id)
    })

    it('returns null on a near-miss prefix, so the draft topic is left blank', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      await insertTopic({ name: 'Team Syncs', owner: organizer._id, private: false })

      const topic = await resolveTopic(buildInvite({ summary: 'Team Sync: standup' }), organizer)

      expect(topic).toBeNull()
    })

    it('returns null when the only exact-prefix match is a Topic the sender cannot access', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      const [other] = await insertUsers([newUser(`other@${allowedDomain}`)])
      // Private topic owned by someone else: outside the sender's candidate set.
      await insertTopic({ name: 'Secret', owner: other._id, private: true })

      const topic = await resolveTopic(buildInvite({ summary: 'Secret: leak' }), organizer)

      expect(topic).toBeNull()
    })

    it('returns null when the SUMMARY has no colon, rather than inventing a Topic', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])

      const topic = await resolveTopic(buildInvite({ summary: 'One Off Meeting' }), organizer)

      expect(topic).toBeNull()
    })

    it('creates no Topic when nothing matches', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])

      await resolveTopic(buildInvite({ summary: 'Nothing Matches: here' }), organizer)

      expect(await Topic.countDocuments()).toBe(0)
    })
  })

  describe('createConversationFromInvite', () => {
    it('creates a draft conversation wiring in the organizer, topic, and extracted fields', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      const topicDoc = await insertTopic({ name: 'BKCircle', owner: organizer._id, private: false })
      planConversationFromInviteSpy.mockResolvedValue({
        zoomLink: 'https://zoom.us/j/123456789',
        speakers: [{ name: 'Jane Doe', bio: '' }],
        moderators: [{ name: 'Mod Person', bio: '' }],
        description: 'Weekly sync'
      })

      const conversation = await createConversationFromInvite(
        buildInvite(
          {
            summary: 'BKCircle: Jane Presents',
            startDate: INVITE_START,
            endDate: INVITE_END
          },
          `org@${allowedDomain}`
        )
      )

      expect(conversation).not.toBeNull()
      expect(conversation!.name).toBe('BKCircle: Jane Presents')
      // createConversation assigns the fetched Topic document directly (not just its id), so on
      // this freshly-created, unrefetched conversation .topic is a real Document; .id is the safe
      // comparison (Mongoose's Document#toString formats the whole document, not a hex string).
      expect((conversation!.topic as unknown as { id: string }).id).toBe(topicDoc.id)
      expect(conversation!.scheduledTime).toEqual(INVITE_START)
      expect(conversation!.scheduledEndTime).toEqual(INVITE_END)
      expect(conversation!.properties!.zoomMeetingUrl).toBe('https://zoom.us/j/123456789')
      expect(conversation!.presenters).toEqual([expect.objectContaining({ name: 'Jane Doe' })])
      expect(conversation!.moderators).toEqual([expect.objectContaining({ name: 'Mod Person' })])
      expect(conversation!.description).toBe('Weekly sync')
      expect(conversation!.source?.inviteUid).toBe('UID-DEFAULT')
      // Matches nextspace's own create-event form, which always tags a new event this way (see
      // EventCreationForm.tsx); without it, an email-created event is invisible to Matomo dimension7.
      expect(conversation!.analyticsRefs?.get('matomo')).toBe('dimension7')

      const persisted = await Conversation.findById(conversation!._id)
      expect(persisted).not.toBeNull()
    })

    /* An invite-created event is always managed through the admin app, so it's a hybrid event by
       definition once it also has a Zoom link. platforms: ['nextspace'] alone doesn't match any
       key in eventAssistant's adapter defs and silently falls back to 'default' (audio-only, no
       dmChannels or chatChannels); ['nextspace', 'zoom'] matches the 'nextspace,zoom' hybrid def,
       which does have a dmChannel for the eventAssistant agent. */
    it('creates the hybrid nextspace + zoom adapter, not the platform-less default fallback', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      planConversationFromInviteSpy.mockResolvedValue({ zoomLink: 'https://zoom.us/j/123456789' })

      const conversation = await createConversationFromInvite(buildInvite({}, `org@${allowedDomain}`))

      expect(conversation!.platforms).toEqual(['nextspace', 'zoom'])
      const adapter = await Adapter.findOne({ conversation: conversation!._id })
      expect(adapter).not.toBeNull()
      expect(adapter!.dmChannels).toHaveLength(1)
    })

    /* Leaving features unspecified resolves to an empty array (see resolver.ts's resolveFeatures),
       which means zero feature agents, not "each feature's own default." A manually-created event
       gets moderatorSupport, qaAssistant, etc. because the create form sends an explicit features
       array; an invite-created event must build that same array itself or it silently ships with
       every feature off. */
    it('enables each feature at its own type-declared default, matching manual event creation', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromInvite(buildInvite({}, `org@${allowedDomain}`))

      expect(conversation!.features).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'moderatorSupport', enabled: true }),
          expect.objectContaining({ name: 'seriesHistory', enabled: false })
        ])
      )
    })

    it('returns null and creates nothing when the sender cannot be resolved to an organizer', async () => {
      const conversation = await createConversationFromInvite(buildInvite({}, `stranger@${OUTSIDE_DOMAIN}`))

      expect(conversation).toBeNull()
      expect(await Conversation.countDocuments()).toBe(0)
      expect(planConversationFromInviteSpy).not.toHaveBeenCalled()
    })

    it('threads the email body through to the invite extraction', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      await createConversationFromInvite({
        ...buildInvite({}, `org@${allowedDomain}`),
        body: 'Bring your laptop, we will demo the new feature.'
      })

      expect(planConversationFromInviteSpy).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Bring your laptop, we will demo the new feature.' })
      )
    })

    it('creates the conversation with a blank topic when nothing matches', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromInvite(
        buildInvite({ summary: 'Nothing Matches: here' }, `org@${allowedDomain}`)
      )

      expect(conversation).not.toBeNull()
      expect(conversation!.topic).toBeFalsy()
    })

    it('returns the existing conversation instead of creating a duplicate when the invite UID was already processed', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      const invite = buildInvite({ uid: 'UID-RETRY' }, `org@${allowedDomain}`)

      const first = await createConversationFromInvite(invite)
      const second = await createConversationFromInvite(invite)

      expect(second!._id.toString()).toBe(first!._id.toString())
      expect(await Conversation.countDocuments()).toBe(1)
      // Proves the dedup check short-circuits before re-running resolution and extraction on a retry.
      expect(planConversationFromInviteSpy).toHaveBeenCalledTimes(1)
    })

    it('creates the conversation without deduping when the invite has no UID, and logs a warning', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromInvite(buildInvite({ uid: undefined }, `org@${allowedDomain}`))

      expect(conversation).not.toBeNull()
      expect(conversation!.source?.inviteUid).toBeUndefined()
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('no UID'))
    })

    it('falls back to a placeholder name when the invite has no title', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromInvite(buildInvite({ summary: undefined }, `org@${allowedDomain}`))

      expect(conversation).not.toBeNull()
      expect(conversation!.name).toBe('Untitled event')
    })

    it('emails the organizer a link to the new event once creation succeeds', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromInvite(buildInvite({}, `org@${allowedDomain}`))

      expect(sendEventCreatedSpy).toHaveBeenCalledWith(
        organizer.email,
        expect.objectContaining({ _id: conversation!._id }),
        expect.anything()
      )
    })

    it('tells the organizer which required fields are missing, when the invite had no zoom link and matched no series', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])

      await createConversationFromInvite(buildInvite({}, `org@${allowedDomain}`))

      expect(sendEventCreatedSpy).toHaveBeenCalledWith(
        organizer.email,
        expect.anything(),
        expect.arrayContaining(['Zoom Meeting URL', 'a series'])
      )
    })

    it('reports nothing missing when the invite matched a series and had a zoom link', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      await insertTopic({ name: 'BKCircle', owner: organizer._id, private: false })
      planConversationFromInviteSpy.mockResolvedValue({ zoomLink: 'https://zoom.us/j/123456789' })

      await createConversationFromInvite(buildInvite({ summary: 'BKCircle: Jane Presents' }, `org@${allowedDomain}`))

      expect(sendEventCreatedSpy).toHaveBeenCalledWith(organizer.email, expect.anything(), [])
    })

    it('sends no confirmation email on a deduped retry, only on the original creation', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      const invite = buildInvite({ uid: 'UID-RETRY-EMAIL' }, `org@${allowedDomain}`)

      await createConversationFromInvite(invite)
      await createConversationFromInvite(invite)

      expect(sendEventCreatedSpy).toHaveBeenCalledTimes(1)
    })

    it('sends no confirmation email when the sender cannot be resolved to an organizer', async () => {
      await createConversationFromInvite(buildInvite({}, `stranger@${OUTSIDE_DOMAIN}`))

      expect(sendEventCreatedSpy).not.toHaveBeenCalled()
    })

    /* There is no retry path available to us here: handlers/email.ts acknowledges the webhook with a
       200 before any processing runs (see the plan's ack-before-processing note), so a thrown error
       here can never surface as a webhook retry. A best-effort email to the organizer, plus a
       server-side log carrying the invite UID for support to grep, is the only notification path. */
    it('logs the error and emails the organizer a generic failure notice, without exposing error detail, when creation throws', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      const thrown = new Error('boom: adapter validation failed')
      jest.spyOn(conversationService, 'createConversationFromType').mockRejectedValueOnce(thrown)

      const conversation = await createConversationFromInvite(buildInvite({ uid: 'UID-FAILURE' }, `org@${allowedDomain}`))

      expect(conversation).toBeNull()
      expect(await Conversation.countDocuments()).toBe(0)
      expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('UID-FAILURE'), thrown)
      expect(sendEventCreationFailedSpy).toHaveBeenCalledWith(organizer.email, 'UID-FAILURE')
      expect(sendEventCreatedSpy).not.toHaveBeenCalled()
    })
  })

  describe('createConversationFromEmail', () => {
    it('creates an instant-start conversation wiring in the organizer, an auto-created Topic, and the extracted zoom link', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      planConversationFromEmailSpy.mockResolvedValue({
        zoomLink: 'https://zoom.us/j/123456789',
        speakers: [{ name: 'Jane Doe', bio: '' }],
        description: 'Weekly sync'
      })

      const conversation = await createConversationFromEmail(buildEmail({}, `org@${allowedDomain}`))

      expect(conversation).not.toBeNull()
      expect(conversation!.name).toBe('Quick sync')
      expect(conversation!.scheduledTime).toBeUndefined()
      // Matches the existing "create and start now" web flow (see isConversationDraft's doc
      // comment): an instant-start conversation never gets an end time, only a scheduled one does.
      expect(conversation!.scheduledEndTime).toBeUndefined()
      expect(conversation!.properties!.zoomMeetingUrl).toBe('https://zoom.us/j/123456789')
      expect(conversation!.presenters).toEqual([expect.objectContaining({ name: 'Jane Doe' })])
      expect(conversation!.description).toBe('Weekly sync')
      expect(conversation!.source?.messageId).toBe('MSG-DEFAULT')
      // Matches nextspace's own create-event form, which always tags a new event this way (see
      // EventCreationForm.tsx); without it, an email-created event is invisible to Matomo dimension7.
      expect(conversation!.analyticsRefs?.get('matomo')).toBe('dimension7')

      const topic = await Topic.findOne({ owner: organizer._id, source: 'email' })
      expect(topic).not.toBeNull()
      // createConversation assigns the fetched Topic document directly (not just its id), same as
      // the invite flow (see createConversationFromInvite's tests above); .id is the safe comparison.
      expect((conversation!.topic as unknown as { id: string }).id).toBe(topic!.id)

      const persisted = await Conversation.findById(conversation!._id)
      expect(persisted).not.toBeNull()
    })

    it('creates a scheduled conversation when the email states a future time, with the stated duration', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      planConversationFromEmailSpy.mockResolvedValue({
        zoomLink: 'https://zoom.us/j/123456789',
        dateTime: FUTURE.toISOString(),
        duration: 45
      })

      const conversation = await createConversationFromEmail(buildEmail({}, `org@${allowedDomain}`))

      expect(conversation!.scheduledTime).toEqual(FUTURE)
      expect(conversation!.scheduledEndTime).toEqual(new Date(FUTURE.getTime() + 45 * 60 * 1000))
    })

    it('defaults the duration to ON_DEMAND_EVENT_DURATION_MINUTES when a scheduled email states none', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      planConversationFromEmailSpy.mockResolvedValue({
        zoomLink: 'https://zoom.us/j/123456789',
        dateTime: FUTURE.toISOString()
      })

      const conversation = await createConversationFromEmail(buildEmail({}, `org@${allowedDomain}`))

      const expectedEnd = FUTURE.getTime() + config.onDemandEventDurationMinutes * 60 * 1000
      expect(conversation!.scheduledEndTime).toEqual(new Date(expectedEnd))
    })

    it('creates no conversation and sends a noZoomLink failure email when the email has no zoom link', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      planConversationFromEmailSpy.mockResolvedValue({})

      const conversation = await createConversationFromEmail(buildEmail({}, `org@${allowedDomain}`))

      expect(conversation).toBeNull()
      expect(await Conversation.countDocuments()).toBe(0)
      expect(sendOnDemandEventFailedSpy).toHaveBeenCalledWith(organizer.email, 'noZoomLink')
    })

    it('creates no conversation and sends an invalidZoomLink failure email when the link is not a Zoom URL', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      planConversationFromEmailSpy.mockResolvedValue({ zoomLink: 'https://teams.microsoft.com/l/meetup-join/abc' })

      const conversation = await createConversationFromEmail(buildEmail({}, `org@${allowedDomain}`))

      expect(conversation).toBeNull()
      expect(await Conversation.countDocuments()).toBe(0)
      expect(sendOnDemandEventFailedSpy).toHaveBeenCalledWith(organizer.email, 'invalidZoomLink')
    })

    it('replies with the existing links instead of creating a duplicate when already in that meeting', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      planConversationFromEmailSpy.mockResolvedValue({ zoomLink: 'https://zoom.us/j/123456789' })
      const first = await createConversationFromEmail(buildEmail({ messageId: 'MSG-A' }, `org@${allowedDomain}`))
      first!.active = true
      await first!.save()
      sendOnDemandEventSpy.mockClear()

      const second = await createConversationFromEmail(buildEmail({ messageId: 'MSG-B' }, `org@${allowedDomain}`))

      expect(second!._id.toString()).toBe(first!._id.toString())
      expect(await Conversation.countDocuments()).toBe(1)
      expect(sendOnDemandEventSpy).toHaveBeenCalledWith(organizer.email, expect.anything(), expect.anything())
    })

    it("never hands another organizer the links to someone else's active meeting on the same Zoom link", async () => {
      const [, second] = await insertUsers([newUser(`org1@${allowedDomain}`), newUser(`org2@${allowedDomain}`)])
      planConversationFromEmailSpy.mockResolvedValue({ zoomLink: 'https://zoom.us/j/123456789' })
      const first = await createConversationFromEmail(buildEmail({ messageId: 'MSG-A' }, `org1@${allowedDomain}`))
      first!.active = true
      await first!.save()
      sendOnDemandEventSpy.mockClear()

      await createConversationFromEmail(buildEmail({ messageId: 'MSG-B' }, `org2@${allowedDomain}`))

      // The only reply a moderator link can travel in is sendOnDemandEventEmail; it must never be
      // sent to org2 for org1's meeting.
      expect(sendOnDemandEventSpy).not.toHaveBeenCalledWith(second.email, expect.anything(), expect.anything())
      expect(sendEventCreationFailedSpy).toHaveBeenCalledWith(second.email, 'MSG-B')
    })

    it('returns the existing conversation instead of creating a duplicate when the message ID was already processed', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      const email = buildEmail({ messageId: 'MSG-RETRY' }, `org@${allowedDomain}`)

      const first = await createConversationFromEmail(email)
      const second = await createConversationFromEmail(email)

      expect(second!._id.toString()).toBe(first!._id.toString())
      expect(await Conversation.countDocuments()).toBe(1)
      // Proves the dedup check short-circuits before re-running resolution and extraction on a retry.
      expect(planConversationFromEmailSpy).toHaveBeenCalledTimes(1)
    })

    it('creates the conversation without deduping when the email has no Message-ID, and logs a warning', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromEmail(buildEmail({ messageId: undefined }, `org@${allowedDomain}`))

      expect(conversation).not.toBeNull()
      expect(conversation!.source?.messageId).toBeUndefined()
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('no Message-ID'))
    })

    it('reuses the same auto-created Topic across two separate emails from the same organizer', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])

      // Distinct zoom links: same link on both emails would hit the active-meeting dedup branch
      // (see above) and return the first conversation again instead of creating a second one.
      planConversationFromEmailSpy.mockResolvedValueOnce({ zoomLink: 'https://zoom.us/j/111111111' })
      planConversationFromEmailSpy.mockResolvedValueOnce({ zoomLink: 'https://zoom.us/j/222222222' })

      const first = await createConversationFromEmail(buildEmail({ messageId: 'MSG-1' }, `org@${allowedDomain}`))
      const second = await createConversationFromEmail(buildEmail({ messageId: 'MSG-2' }, `org@${allowedDomain}`))

      expect(await Topic.countDocuments({ owner: organizer._id, source: 'email' })).toBe(1)
      expect((first!.topic as unknown as { id: string }).id).toBe((second!.topic as unknown as { id: string }).id)
    })

    it('names the event from the subject line when present', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromEmail(
        buildEmail({ subject: 'Design review' }, `org@${allowedDomain}`)
      )

      expect(conversation!.name).toBe('Design review')
    })

    it('names the event from the sender display name and the date when the subject is empty', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      const now = new Date()
      const expectedDate = `${now.getMonth() + 1}-${now.getDate()}-${String(now.getFullYear()).slice(-2)}`

      const conversation = await createConversationFromEmail(
        buildEmail({ subject: undefined, fromName: 'Chelsea Johnson' }, `org@${allowedDomain}`)
      )

      expect(conversation!.name).toBe(`Chelsea Johnson Call ${expectedDate}`)
    })

    it('falls back to organizerLabel when the subject and the sender display name are both empty', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])
      const now = new Date()
      const expectedDate = `${now.getMonth() + 1}-${now.getDate()}-${String(now.getFullYear()).slice(-2)}`

      const conversation = await createConversationFromEmail(
        buildEmail({ subject: undefined, fromName: undefined }, `org@${allowedDomain}`)
      )

      expect(conversation!.name).toBe(`org Call ${expectedDate}`)
    })

    it('returns null and creates nothing when the sender cannot be resolved to an organizer', async () => {
      const conversation = await createConversationFromEmail(buildEmail({}, `stranger@${OUTSIDE_DOMAIN}`))

      expect(conversation).toBeNull()
      expect(await Conversation.countDocuments()).toBe(0)
      expect(planConversationFromEmailSpy).not.toHaveBeenCalled()
    })

    it('sends the signup email and creates nothing for an allowlisted sender with no account', async () => {
      const email = `newcomer@${allowedDomain}`

      const conversation = await createConversationFromEmail(buildEmail({}, email))

      expect(conversation).toBeNull()
      expect(await Conversation.countDocuments()).toBe(0)
      expect(sendSignupSpy).toHaveBeenCalledWith(email)
      expect(sendOnDemandEventSpy).not.toHaveBeenCalled()
    })

    it('emails the organizer the participant, moderator, and event links on success', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromEmail(buildEmail({}, `org@${allowedDomain}`))

      expect(sendOnDemandEventSpy).toHaveBeenCalledWith(
        organizer.email,
        expect.objectContaining({
          eventPageUrl: expect.stringContaining(conversation!._id.toString()),
          moderatorUrl: expect.stringContaining(conversation!._id.toString()),
          participantUrl: expect.stringContaining(conversation!._id.toString())
        }),
        expect.anything()
      )
    })

    it('logs the error and emails the organizer a generic failure notice when creation throws', async () => {
      const [organizer] = await insertUsers([newUser(`org@${allowedDomain}`)])
      const thrown = new Error('boom: adapter validation failed')
      jest.spyOn(conversationService, 'createConversationFromType').mockRejectedValueOnce(thrown)

      const conversation = await createConversationFromEmail(
        buildEmail({ messageId: 'MSG-FAILURE' }, `org@${allowedDomain}`)
      )

      expect(conversation).toBeNull()
      expect(await Conversation.countDocuments()).toBe(0)
      expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('MSG-FAILURE'), thrown)
      expect(sendEventCreationFailedSpy).toHaveBeenCalledWith(organizer.email, 'MSG-FAILURE')
    })
  })
})

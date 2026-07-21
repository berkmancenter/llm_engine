import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import config from '../../../../src/config/config.js'
import logger from '../../../../src/config/logger.js'
import emailService from '../../../../src/services/email.service.js'
import transcript from '../../../../src/agents/helpers/transcript.js'
import websocketGateway from '../../../../src/websockets/websocketGateway.js'
import { Conversation, Topic } from '../../../../src/models/index.js'
import { insertUsers } from '../../../fixtures/user.fixture.js'
import plannerService from '../../../../src/services/eventSetup/planner.service.js'
import {
  resolveOrganizer,
  resolveTopic,
  createConversationFromInvite
} from '../../../../src/services/eventSetup/emailSetup.service.js'
import { InboundInvite } from '../../../../src/types/index.types.js'

setupIntTest()

// Set the allowlist explicitly so these tests don't depend on an ambient env var.
const allowedDomain = 'example.edu'
config.allowedOrganizerEmailDomains = [allowedDomain]
const OUTSIDE_DOMAIN = 'not-an-org.invalid'

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
    startDate: new Date('2026-08-01T17:00:00Z'),
    endDate: new Date('2026-08-01T18:00:00Z'),
    ...overrides
  }
})

const newUser = (email: string) => ({
  _id: new mongoose.Types.ObjectId(),
  username: email.split('@')[0],
  email,
  password: 'password1',
  role: 'user',
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
  let loggerWarnSpy
  let planConversationFromInviteSpy

  beforeEach(() => {
    jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    sendSignupSpy = jest.spyOn(emailService, 'sendSignupInviteEmail').mockResolvedValue(undefined as never)
    jest.spyOn(transcript, 'loadTopicMetadataIntoVectorStore').mockResolvedValue(undefined as never)
    jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue(undefined as never)
    jest.spyOn(websocketGateway, 'broadcastNewConversation').mockResolvedValue(undefined as never)
    loggerWarnSpy = jest.spyOn(logger, 'warn').mockReturnValue(undefined as never)
    jest.spyOn(logger, 'info').mockReturnValue(undefined as never)
    // The extraction call is unit-tested on its own (planner.service.test.ts); here it is mocked
    // so createConversationFromInvite tests aren't also exercising (or paying for) a real LLM call.
    planConversationFromInviteSpy = jest.spyOn(plannerService, 'planConversationFromInvite').mockResolvedValue({})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('resolveOrganizer', () => {
    it('returns the account matching the envelope From address', async () => {
      const email = `known@${allowedDomain}`
      await insertUsers([newUser(email)])

      const organizer = await resolveOrganizer(buildInvite({}, email))

      expect(organizer).not.toBeNull()
      expect(organizer!.email).toBe(email)
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('recognizes a known organizer when the envelope From differs only in letter case', async () => {
      const storedEmail = `known@${allowedDomain}`
      await insertUsers([newUser(storedEmail)])

      const organizer = await resolveOrganizer(buildInvite({}, `Known@${allowedDomain.toUpperCase()}`))

      expect(organizer).not.toBeNull()
      expect(organizer!.email).toBe(storedEmail)
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('sends the signup invite and returns null for an unknown sender inside an allowlisted domain', async () => {
      const email = `newcomer@${allowedDomain}`

      const organizer = await resolveOrganizer(buildInvite({}, email))

      expect(organizer).toBeNull()
      expect(sendSignupSpy).toHaveBeenCalledWith(email)
    })

    it('sends no email and returns null for an unknown sender outside the allowlist', async () => {
      const email = `stranger@${OUTSIDE_DOMAIN}`

      const organizer = await resolveOrganizer(buildInvite({}, email))

      expect(organizer).toBeNull()
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('rejects a sender outside the allowlist even when they have an account (domain is a hard gate)', async () => {
      const email = `has-account@${OUTSIDE_DOMAIN}`
      await insertUsers([newUser(email)])

      const organizer = await resolveOrganizer(buildInvite({}, email))

      expect(organizer).toBeNull()
      expect(sendSignupSpy).not.toHaveBeenCalled()
    })

    it('logs a warning when the .ics ORGANIZER differs from the envelope From', async () => {
      const email = `known@${allowedDomain}`
      await insertUsers([newUser(email)])

      await resolveOrganizer(buildInvite({ organizer: `someone-else@${allowedDomain}` }, email))

      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('someone-else'))
    })

    it('does not warn about a mismatch when ORGANIZER equals From', async () => {
      const email = `known@${allowedDomain}`
      await insertUsers([newUser(email)])

      await resolveOrganizer(buildInvite({ organizer: email }, email))

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
            startDate: new Date('2026-08-01T17:00:00Z'),
            endDate: new Date('2026-08-01T18:00:00Z')
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
      expect(conversation!.scheduledTime).toEqual(new Date('2026-08-01T17:00:00Z'))
      expect(conversation!.scheduledEndTime).toEqual(new Date('2026-08-01T18:00:00Z'))
      expect(conversation!.properties!.zoomMeetingUrl).toBe('https://zoom.us/j/123456789')
      expect(conversation!.presenters).toEqual([expect.objectContaining({ name: 'Jane Doe' })])
      expect(conversation!.moderators).toEqual([expect.objectContaining({ name: 'Mod Person' })])
      expect(conversation!.description).toBe('Weekly sync')
      expect(conversation!.sourceInviteUid).toBe('UID-DEFAULT')

      const persisted = await Conversation.findById(conversation!._id)
      expect(persisted).not.toBeNull()
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
      expect(conversation!.sourceInviteUid).toBeUndefined()
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('no UID'))
    })

    it('falls back to a placeholder name when the invite has no title', async () => {
      await insertUsers([newUser(`org@${allowedDomain}`)])

      const conversation = await createConversationFromInvite(buildInvite({ summary: undefined }, `org@${allowedDomain}`))

      expect(conversation).not.toBeNull()
      expect(conversation!.name).toBe('Untitled event')
    })
  })
})

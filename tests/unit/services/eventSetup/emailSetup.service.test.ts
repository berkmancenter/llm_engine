import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import config from '../../../../src/config/config.js'
import logger from '../../../../src/config/logger.js'
import emailService from '../../../../src/services/email.service.js'
import transcript from '../../../../src/agents/helpers/transcript.js'
import { Topic } from '../../../../src/models/index.js'
import { insertUsers } from '../../../fixtures/user.fixture.js'
import { resolveOrganizer, resolveTopic } from '../../../../src/services/eventSetup/emailSetup.service.js'
import { InboundInvite } from '../../../../src/types/index.types.js'

setupIntTest()

// Set the allowlist explicitly so these tests don't depend on an ambient env var.
const allowedDomain = 'example.edu'
config.allowedOrganizerEmailDomains = [allowedDomain]
const OUTSIDE_DOMAIN = 'not-an-org.invalid'

const buildInvite = (
  overrides: Partial<InboundInvite['invite']> = {},
  fromAddress = `organizer@${allowedDomain}`
): InboundInvite => ({
  fromAddress,
  invite: {
    uid: 'UID-DEFAULT',
    summary: 'Some Event: additional info',
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

describe('emailSetup.service', () => {
  let sendSignupSpy
  let loggerWarnSpy

  beforeEach(() => {
    jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    sendSignupSpy = jest.spyOn(emailService, 'sendSignupInviteEmail').mockResolvedValue(undefined as never)
    jest.spyOn(transcript, 'loadTopicMetadataIntoVectorStore').mockResolvedValue(undefined as never)
    loggerWarnSpy = jest.spyOn(logger, 'warn').mockReturnValue(undefined as never)
    jest.spyOn(logger, 'info').mockReturnValue(undefined as never)
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
    const insertTopic = (fields) =>
      Topic.create({
        name: 'placeholder',
        votingAllowed: false,
        conversationCreationAllowed: true,
        private: false,
        archivable: true,
        ...fields
      })

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
})

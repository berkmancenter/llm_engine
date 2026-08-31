/* eslint-disable no-console */
import mongoose from 'mongoose'
import httpStatus from 'http-status'
import faker from 'faker'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { insertMessages, messageOne } from '../fixtures/message.fixture.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'
import userService, { resolveDisplayName } from '../../src/services/user.service.js'
import { messageService } from '../../src/services/index.js'
import {
  User,
  Channel,
  Conversation,
  RealNameAudit,
  RealNameRegistry,
  ConversationMembership,
  Agent,
  Message
} from '../../src/models/index.js'
import ApiError from '../../src/utils/ApiError.js'
import config from '../../src/config/config.js'
import { AgentMessageActions } from '../../src/types/index.types.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import { conversationOne } from '../fixtures/conversation.fixture.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'

setupIntTest()

jest.setTimeout(30000)

const createVote = () => ({
  _id: new mongoose.Types.ObjectId(),
  owner: new mongoose.Types.ObjectId()
})

const mockEvaluate = jest.fn()

const testAgentTypes = {
  perMessage: {
    evaluate: mockEvaluate,
    start: jest.fn(),
    name: 'Test Per Message Agent',
    description: 'An agent that responds per message after a certain number reached',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { directMessages: true } },
    priority: 1,
    llmTemplateVars: { template: [] },
    defaultLLMTemplates: { template: 'Default template' },
    defaultLLMPlatform,
    defaultLLMModel,
    defaultLLMModelOptions: { prop: 'value' }
  }
}

async function createNamedUser(pseudonym) {
  return User.create({
    _id: new mongoose.Types.ObjectId(),
    username: faker.name.findName(),
    email: faker.internet.email().toLowerCase(),
    password: 'password1',
    role: 'participant',
    isEmailVerified: false,
    pseudonyms: [{ _id: new mongoose.Types.ObjectId(), token: '31c5d2b7d2b0f86b2b4b204', pseudonym, active: 'true' }]
  })
}

// A conversation with a membership record for `email` — real-name registration
// checks the roster (userService.createUser -> ConversationMembership) before creating an entry.
const createConversationWithMembership = async (email: string) => {
  const topic = newPublicTopic()
  await insertTopics([topic])
  const channel = await Channel.create({ name: 'general' })
  const conversation = await Conversation.create({
    name: `conv-${new mongoose.Types.ObjectId()}`,
    slug: `conv-${new mongoose.Types.ObjectId()}`,
    owner: new mongoose.Types.ObjectId(),
    topic: topic._id,
    channels: [channel._id],
    messages: [],
    transcript: { status: 'stopped' }
  })
  await ConversationMembership.create({
    conversation: conversation._id,
    email,
    name: 'Test Member',
    bio: 'A test member bio',
    interests: 'testing, quality assurance'
  })
  return conversation
}

describe('User service methods', () => {
  describe('createUser()', () => {
    test('should create a user with hashed password and pseudonym with participant role', async () => {
      const userBody = {
        username: 'testuser',
        password: 'password123',
        token: 'sometoken',
        pseudonym: 'Bold Aardvark',
        email: 'test@example.com'
      }

      const user = await userService.createUser(userBody)

      expect(user).toBeDefined()
      expect(user.username).toBe(userBody.username)
      expect(user.email).toBe(userBody.email)
      expect(user.password).not.toBe(userBody.password)
      expect(user.pseudonyms).toHaveLength(1)
      expect(user.pseudonyms[0].token).toBe(userBody.token)
      expect(user.pseudonyms[0].pseudonym).toBe(userBody.pseudonym)
      expect(user.pseudonyms[0].active).toBe(true)
      expect(user.role).toBe('participant')
    })

    test('should ignore a role supplied by the caller', async () => {
      const user = await userService.createUser({
        username: 'testuser4',
        token: 'sometoken4',
        pseudonym: 'Daring Dingo',
        role: 'admin'
      })

      expect(user.role).toBe('participant')
    })

    test('should generate and store a fun fact for the initial pseudonym', async () => {
      const user = await userService.createUser({ username: 'u1', token: 't1', pseudonym: 'Bold Aardvark' })
      console.log('createUser fun fact:', user.pseudonyms[0].funFact)
      expect(user.pseudonyms[0].funFact).toBeDefined()
    })

    test('should skip fun fact generation when trulyRandomPseudonyms is enabled', async () => {
      const original = config.trulyRandomPseudonyms
      config.trulyRandomPseudonyms = 'true'
      try {
        const user = await userService.createUser({ username: 'u2', token: 't2', pseudonym: 'Woodpecker_e65ddfe1d20' })
        expect(user.pseudonyms[0].funFact).toBeUndefined()
      } finally {
        config.trulyRandomPseudonyms = original
      }
    })

    test('should create a user without email if not provided', async () => {
      const userBody = {
        username: 'testuser2',
        password: 'password123',
        token: 'sometoken2',
        pseudonym: 'Brave Beaver'
      }

      const user = await userService.createUser(userBody)

      expect(user).toBeDefined()
      expect(user.username).toBe(userBody.username)
      expect(user.email).toBeUndefined()
      expect(user.role).toBe('participant')
    })

    test('should create a user without password if not provided', async () => {
      const userBody = {
        username: 'testuser3',
        token: 'sometoken3',
        pseudonym: 'Calm Cobra'
      }

      const user = await userService.createUser(userBody)

      expect(user).toBeDefined()
      expect(user.username).toBe(userBody.username)
      expect(user.password).toBeUndefined()
      expect(user.role).toBe('participant')
    })

    describe('real names', () => {
      beforeAll(async () => {
        // Uniqueness relies on RealNameRegistry's compound unique index, which is
        // not built automatically by setupIntTest()'s per-test deleteMany wipe.
        await RealNameRegistry.syncIndexes()
      })

      test('creates a real-name entry scoped to the conversation, inactive, uncounted, with no fun fact', async () => {
        const email = 'jane.doe@example.com'
        const conversation = await createConversationWithMembership(email)
        const userBody = {
          username: 'realnametest1',
          token: 'tok-ordinary',
          pseudonym: 'Bold Aardvark',
          email,
          conversationId: conversation._id.toString()
        }

        const user = await userService.createUser(userBody)

        expect(user.pseudonyms).toHaveLength(2)
        const realNameEntry = user.pseudonyms.find((p) => p.isRealName)
        expect(realNameEntry).toBeDefined()
        expect(realNameEntry!.pseudonym).toBe('Test Member')
        expect(realNameEntry!.normalizedPseudonym).toBe('test member')
        expect(realNameEntry!.active).toBe(false)
        expect(realNameEntry!.funFact).toBeUndefined()
        expect(realNameEntry!.conversations).toEqual([conversation._id.toString()])
        // the ordinary pseudonym createUser always creates remains the active one
        expect(user.pseudonyms.find((p) => p.active)!.pseudonym).toBe('Bold Aardvark')
        // bio and interests copied from membership record
        expect(user.bio).toBe('A test member bio')
        expect(user.interests).toBe('testing, quality assurance')

        const audit = await RealNameAudit.findOne({ userId: user._id, action: 'created' })
        expect(audit).not.toBeNull()
        expect(audit!.conversationId.toString()).toBe(conversation._id.toString())
      })

      test('rejects registration when the email is not on the conversation membership roster', async () => {
        const conversation = await createConversationWithMembership('someone.else@example.com')
        const userBody = {
          username: 'realnametest2',
          token: 'tok-ordinary2',
          pseudonym: 'Brave Beaver',
          email: 'not.on.roster@example.com',
          conversationId: conversation._id.toString()
        }

        await expect(userService.createUser(userBody)).rejects.toMatchObject({ statusCode: httpStatus.FORBIDDEN })
        expect(await User.findOne({ username: 'realnametest2' })).toBeNull()
        expect(await RealNameRegistry.findOne({ conversationId: conversation._id })).toBeNull()
        expect(
          await RealNameAudit.findOne({ action: 'membership_rejected', conversationId: conversation._id })
        ).not.toBeNull()
      })

      test('rejects a second real name in the same conversation, but allows it in a different one', async () => {
        const emailA = 'alex.a@example.com'
        const emailB = 'alex.b@example.com'
        const convoA = await createConversationWithMembership(emailA)
        const convoB = await createConversationWithMembership(emailB)
        // Add emailB to convoA with the same name so uniqueness (not membership) is what rejects
        await ConversationMembership.create({ conversation: convoA._id, email: emailB, name: 'Test Member' })

        await userService.createUser({
          username: 'realnametest3a',
          token: 'tok-a',
          pseudonym: 'Calm Cobra',
          email: emailA,
          conversationId: convoA._id.toString()
        })

        // same name (from membership), same conversation -> rejected on uniqueness
        await expect(
          userService.createUser({
            username: 'realnametest3b',
            token: 'tok-b',
            pseudonym: 'Daring Duck',
            email: emailB,
            conversationId: convoA._id.toString()
          })
        ).rejects.toMatchObject({ statusCode: httpStatus.CONFLICT })
        expect(await User.findOne({ username: 'realnametest3b' })).toBeNull()

        // same name, different conversation -> allowed
        const userC = await userService.createUser({
          username: 'realnametest3c',
          token: 'tok-c',
          pseudonym: 'Eager Emu',
          email: emailB,
          conversationId: convoB._id.toString()
        })
        expect(userC.pseudonyms.find((p) => p.isRealName)).toBeDefined()
      })

      test('never calls the LLM fun-fact helper for a real-name entry', async () => {
        const email = 'sam.lee@example.com'
        const conversation = await createConversationWithMembership(email)
        const user = await userService.createUser({
          username: 'realnametest4',
          token: 'tok-ordinary4',
          pseudonym: 'Gentle Giraffe',
          email,
          conversationId: conversation._id.toString()
        })
        const realNameEntry = user.pseudonyms.find((p) => p.isRealName)
        // If generatePseudonymFunFact had been called for the real name, this would
        // eventually be populated (fun facts are only ever missing on failure, which
        // is not the scenario here) — it must stay unset because the code path is
        // never reached for isRealName entries.
        expect(realNameEntry!.funFact).toBeUndefined()
      })
    })
  })

  describe('addPseudonym()', () => {
    test('should generate and store a fun fact for the added pseudonym', async () => {
      const user = await User.create({
        username: 'addtest',
        pseudonyms: [{ token: 'tok1', pseudonym: 'Calm Cobra', active: true }],
        role: 'admin'
      })
      await userService.addPseudonym({ token: 'tok2', pseudonym: 'Brave Beaver' }, { id: user._id })
      const updated = await User.findById(user._id)
      const added = updated!.pseudonyms.find((p) => p.pseudonym === 'Brave Beaver')
      console.log('addPseudonym fun fact:', added!.funFact)
      expect(added!.funFact).toBeDefined()
    })

    test('never creates an isRealName entry, even if the request body tries to set one', async () => {
      const user = await User.create({
        username: 'addtest2',
        pseudonyms: [{ token: 'tok1', pseudonym: 'Calm Cobra', active: true }],
        role: 'admin'
      })
      await userService.addPseudonym(
        { token: 'tok2', pseudonym: 'Brave Beaver', isRealName: true, conversations: ['someConversationId'] },
        { id: user._id }
      )
      const updated = await User.findById(user._id)
      const added = updated!.pseudonyms.find((p) => p.pseudonym === 'Brave Beaver')
      expect(added).toBeDefined()
      expect(added!.isRealName).toBeFalsy()
      expect(added!.conversations).toEqual([])
    })

    test('does not count a real-name entry toward the 5-pseudonym cap', async () => {
      const user = await User.create({
        username: 'addtest3',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          { token: 'tok2', pseudonym: 'Brave Beaver', active: false },
          { token: 'tok3', pseudonym: 'Daring Duck', active: false },
          { token: 'tok4', pseudonym: 'Eager Emu', active: false },
          {
            token: 'tok5',
            pseudonym: 'Real Name',
            active: false,
            isRealName: true,
            conversations: [new mongoose.Types.ObjectId().toString()]
          }
        ],
        role: 'admin'
      })
      // 4 ordinary + 1 real name already exist; a 5th ordinary pseudonym should
      // still be allowed since the real-name entry is exempt from the cap.
      const updated = await userService.addPseudonym({ token: 'tok6', pseudonym: 'Fifth Fox' }, { id: user._id })
      expect(updated!.pseudonyms.find((p) => p.pseudonym === 'Fifth Fox')).toBeDefined()
    })

    test('rejects a 6th ordinary pseudonym once the cap is reached (real name aside)', async () => {
      const user = await User.create({
        username: 'addtest4',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          { token: 'tok2', pseudonym: 'Brave Beaver', active: false },
          { token: 'tok3', pseudonym: 'Daring Duck', active: false },
          { token: 'tok4', pseudonym: 'Eager Emu', active: false },
          { token: 'tok5', pseudonym: 'Fifth Fox', active: false }
        ],
        role: 'admin'
      })
      await expect(userService.addPseudonym({ token: 'tok6', pseudonym: 'Sixth Sloth' }, { id: user._id })).rejects.toThrow(
        ApiError
      )
    })
  })

  describe('activatePseudonym()', () => {
    test('should generate a fun fact when activating a pseudonym that does not have one', async () => {
      const user = await User.create({
        username: 'activatetest',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          { token: 'tok2', pseudonym: 'Brave Beaver', active: false }
        ],
        role: 'admin'
      })
      await userService.activatePseudonym({ token: 'tok2' }, { id: user._id })
      const updated = await User.findById(user._id)
      const activated = updated!.pseudonyms.find((p) => p.token === 'tok2')
      console.log('activatePseudonym fun fact:', activated!.funFact)
      expect(activated!.funFact).toBeDefined()
    })

    test('should not regenerate a fun fact when activating a pseudonym that already has one', async () => {
      const existingFact = 'Fun Fact about your pseudonym: existing fact'
      const user = await User.create({
        username: 'activatetest2',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          { token: 'tok2', pseudonym: 'Brave Beaver', active: false, funFact: existingFact }
        ],
        role: 'admin'
      })
      await userService.activatePseudonym({ token: 'tok2' }, { id: user._id })
      const updated = await User.findById(user._id)
      const activated = updated!.pseudonyms.find((p) => p.token === 'tok2')
      expect(activated!.funFact).toBe(existingFact)
    })

    test('rejects activating a real-name entry and leaves the current active pseudonym unchanged', async () => {
      const user = await User.create({
        username: 'activatetest3',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          {
            token: 'tok2',
            pseudonym: 'Real Name',
            active: false,
            isRealName: true,
            conversations: [new mongoose.Types.ObjectId().toString()]
          }
        ],
        role: 'admin'
      })
      await expect(userService.activatePseudonym({ token: 'tok2' }, { id: user._id })).rejects.toMatchObject({
        statusCode: httpStatus.BAD_REQUEST
      })
      const updated = await User.findById(user._id)
      expect(updated!.pseudonyms.find((p) => p.active)!.pseudonym).toBe('Calm Cobra')
      expect(updated!.pseudonyms.find((p) => p.token === 'tok2')!.active).toBe(false)
      expect(await RealNameAudit.findOne({ userId: user._id, action: 'activate_rejected' })).not.toBeNull()
    })

    test('rejects activating an unknown token', async () => {
      const user = await User.create({
        username: 'activatetest4',
        pseudonyms: [{ token: 'tok1', pseudonym: 'Calm Cobra', active: true }],
        role: 'admin'
      })
      await expect(userService.activatePseudonym({ token: 'no-such-token' }, { id: user._id })).rejects.toMatchObject({
        statusCode: httpStatus.NOT_FOUND
      })
    })
  })

  describe('deletePseudonym()', () => {
    test('hard-deletes an ordinary pseudonym that has no messages against it', async () => {
      const user = await User.create({
        username: 'deletetest1',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          { token: 'tok2', pseudonym: 'Brave Beaver', active: false }
        ],
        role: 'admin'
      })
      const toDelete = user.pseudonyms.find((p) => p.token === 'tok2')!
      await userService.deletePseudonym(toDelete._id, { id: user._id })
      const updated = await User.findById(user._id)
      expect(updated!.pseudonyms.find((p) => p.token === 'tok2')).toBeUndefined()
    })

    test('rejects deleting a real-name entry with no messages against it', async () => {
      const user = await User.create({
        username: 'deletetest2',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          {
            token: 'tok2',
            pseudonym: 'Real Name',
            active: false,
            isRealName: true,
            conversations: [new mongoose.Types.ObjectId().toString()]
          }
        ],
        role: 'admin'
      })
      const realNameEntry = user.pseudonyms.find((p) => p.token === 'tok2')!
      await expect(userService.deletePseudonym(realNameEntry._id, { id: user._id })).rejects.toMatchObject({
        statusCode: httpStatus.BAD_REQUEST
      })
      const updated = await User.findById(user._id)
      expect(updated!.pseudonyms.find((p) => p.token === 'tok2')).toBeDefined()
      expect(await RealNameAudit.findOne({ userId: user._id, action: 'delete_rejected' })).not.toBeNull()
    })

    test('rejects deleting a real-name entry that HAS messages against it (soft-delete branch)', async () => {
      const user = await User.create({
        username: 'deletetest3',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          {
            token: 'tok2',
            pseudonym: 'Real Name',
            active: false,
            isRealName: true,
            conversations: [new mongoose.Types.ObjectId().toString()]
          }
        ],
        role: 'admin'
      })
      const realNameEntry = user.pseudonyms.find((p) => p.token === 'tok2')!
      await insertMessages([{ ...messageOne, pseudonymId: realNameEntry._id, owner: user._id }])
      await expect(userService.deletePseudonym(realNameEntry._id, { id: user._id })).rejects.toMatchObject({
        statusCode: httpStatus.BAD_REQUEST
      })
      const updated = await User.findById(user._id)
      expect(updated!.pseudonyms.find((p) => p.token === 'tok2')!.isDeleted).toBeFalsy()
    })

    test('throws NOT_FOUND for an unknown pseudonymId', async () => {
      const user = await User.create({
        username: 'deletetest4',
        pseudonyms: [{ token: 'tok1', pseudonym: 'Calm Cobra', active: true }],
        role: 'admin'
      })
      await expect(userService.deletePseudonym(new mongoose.Types.ObjectId(), { id: user._id })).rejects.toMatchObject({
        statusCode: httpStatus.NOT_FOUND
      })
    })
  })

  describe('real-name invariants (schema-level)', () => {
    test('refuses to save a user with a real-name pseudonym manually set active, bypassing activatePseudonym', async () => {
      const user = new User({
        username: 'invarianttest1',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          {
            token: 'tok2',
            pseudonym: 'Real Name',
            active: false,
            isRealName: true,
            conversations: [new mongoose.Types.ObjectId().toString()]
          }
        ],
        role: 'admin'
      })
      // Simulate a future code path bypassing activatePseudonym entirely.
      user.pseudonyms[1].active = true
      await expect(user.save()).rejects.toThrow('A real-name pseudonym entry cannot be active.')
    })
  })

  describe('goodReputation()', () => {
    beforeEach(() => {
      // Add five upvotes
      messageOne.upVotes = []
      for (let x = 0; x < 5; x++) {
        messageOne.upVotes.push(createVote())
      }
    })

    test('should return true if user vote score < -5 and account is more than 1 week old', async () => {
      const d = new Date()
      d.setDate(d.getDate() - 8)
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      await insertMessages([messageOne])

      registeredUser.id = registeredUser._id
      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(true)
    })

    test('should return false if user vote score < -5', async () => {
      const d = new Date()
      d.setDate(d.getDate() - 8)
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      messageOne.downVotes = []
      for (let x = 0; x < 11; x++) {
        messageOne.downVotes.push(createVote())
      }
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })

    test('should return false if user account is less than one week old', async () => {
      const d = new Date()
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })

    test('should return false if user account is less than one week old user vote score < -5', async () => {
      const d = new Date()
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      messageOne.downVotes = []
      for (let x = 0; x < 11; x++) {
        messageOne.downVotes.push(createVote())
      }
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })
  })

  describe('resolveDisplayName() — room vs. event identity', () => {
    beforeEach(() => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
    })

    afterEach(() => {
      jest.restoreAllMocks()
    })

    const realNameEntry = (conversationId) => ({
      _id: new mongoose.Types.ObjectId(),
      token: 'real-name-token',
      pseudonym: 'Jane Doe',
      normalizedPseudonym: 'jane doe',
      active: false,
      isRealName: true,
      conversations: [conversationId.toString()]
    })

    const createRoom = async (owner) => {
      const conversationData = {
        ...conversationOne,
        conversationType: 'communityRoom',
        useRealNames: true,
        owner: owner._id
      }
      delete conversationData._id
      return Conversation.create(conversationData)
    }

    const createEvent = async (owner) => {
      const conversationData = { ...conversationOne, owner: owner._id }
      delete conversationData._id
      return Conversation.create(conversationData)
    }

    test('resolves the room to the real-name entry scoped to that conversation', async () => {
      const user = await createNamedUser('Bold Aardvark')
      const room = await createRoom(user)
      user.pseudonyms.push(realNameEntry(room._id))
      await user.save()

      const resolved = resolveDisplayName(user, room)
      expect(resolved.pseudonym).toBe('Jane Doe')
      expect(resolved.isRealName).toBe(true)
    })

    test('throws a permission error for the room when no real-name entry is registered', async () => {
      const user = await createNamedUser('Bold Aardvark')
      const room = await createRoom(user)

      expect(() => resolveDisplayName(user, room)).toThrow('You are not registered for this room.')
    })

    test('resolves a normal event to the active pseudonym, filtering out real names', async () => {
      const user = await createNamedUser('Bold Aardvark')
      const event = await createEvent(user)
      // A real-name entry scoped to a *different* conversation must never leak into
      // an event's name resolution even though it sits in the same pseudonyms array.
      user.pseudonyms.push(realNameEntry(new mongoose.Types.ObjectId()))
      await user.save()

      const resolved = resolveDisplayName(user, event)
      expect(resolved.pseudonym).toBe('Bold Aardvark')
      expect(resolved.isRealName).toBeFalsy()
    })

    // Regression test: the community assistant agent lives inside the room (see
    // conversations/communityRoom.ts), so it posts through this same resolution
    // path. An agent is never a registered room member — it has no real-name entry
    // — so it must resolve to its own configured pseudonym rather than hitting the
    // room's real-name lookup and being rejected as an unregistered member.
    describe('agent posting in the room', () => {
      beforeAll(() => {
        setAgentTypes(testAgentTypes)
      })

      afterAll(() => {
        setAgentTypes(defaultAgentTypes)
      })

      test('resolves an agent posting in the room to its own pseudonym, not a real-name lookup', async () => {
        const owner = await createNamedUser('Room Owner')
        const room = await createRoom(owner)
        const agent = await Agent.create({
          _id: new mongoose.Types.ObjectId(),
          conversation: room,
          agentType: 'perMessage',
          pseudonyms: [
            {
              _id: new mongoose.Types.ObjectId(),
              token: 'agent-token',
              pseudonym: 'Community Bot',
              active: 'true'
            }
          ]
        })

        const resolved = resolveDisplayName(agent, room)
        expect(resolved.pseudonym).toBe('Community Bot')
      })

      test('lets an agent post into the room end to end with no real-name entry on file', async () => {
        const owner = await createNamedUser('Room Owner')
        const room = await createRoom(owner)
        const agent = await Agent.create({
          _id: new mongoose.Types.ObjectId(),
          conversation: room,
          agentType: 'perMessage',
          pseudonyms: [
            {
              _id: new mongoose.Types.ObjectId(),
              token: 'agent-token',
              pseudonym: 'Community Bot',
              active: 'true'
            }
          ]
        })

        const [message] = await messageService.newMessageHandler(
          { conversation: room._id, body: 'welcome!', bodyType: 'text', channels: [], fromAgent: true },
          agent
        )
        expect(message.pseudonym).toBe('Community Bot')
      })
    })

    // Regression test for the two-identities fix: one account, active in an event
    // under a pseudonym and registered for the room under a real name, must be able
    // to post in either without breaking the other, and the real-name entry must
    // never become active. Both orders are asserted since each catches a different
    // regression: room-first catches a real name becoming the account's active name
    // (failure A), event-first catches a fresh real-name registration deactivating
    // the pseudonym already posting in the event (failure B).
    describe('two identities on one account, never logging out', () => {
      const postInto = async (conversation, user, body) =>
        messageService.newMessageHandler({ conversation: conversation._id, body, bodyType: 'text', channels: [] }, user)

      test('room-first: posting in the room does not disturb the event pseudonym', async () => {
        const user = await createNamedUser('Bold Aardvark')
        const room = await createRoom(user)
        const event = await createEvent(user)
        user.pseudonyms.push(realNameEntry(room._id))
        await user.save()

        const [roomMessage] = await postInto(room, user, 'hello room')
        expect(roomMessage.pseudonym).toBe('Jane Doe')

        let refreshed = await User.findById(user._id)
        expect(refreshed!.pseudonyms.find((p) => p.active)!.pseudonym).toBe('Bold Aardvark')
        expect(refreshed!.pseudonyms.find((p) => p.isRealName)!.active).toBe(false)

        const [eventMessage] = await postInto(event, refreshed, 'hello event')
        expect(eventMessage.pseudonym).toBe('Bold Aardvark')

        refreshed = await User.findById(user._id)
        expect(refreshed!.pseudonyms.find((p) => p.active)!.pseudonym).toBe('Bold Aardvark')
        expect(refreshed!.pseudonyms.find((p) => p.isRealName)!.active).toBe(false)
      })

      test('event-first: registering the real name does not disturb the event pseudonym', async () => {
        const user = await createNamedUser('Bold Aardvark')
        const room = await createRoom(user)
        const event = await createEvent(user)

        const [eventMessage] = await postInto(event, user, 'hello event')
        expect(eventMessage.pseudonym).toBe('Bold Aardvark')

        let refreshed = await User.findById(user._id)
        refreshed!.pseudonyms.push(realNameEntry(room._id))
        await refreshed!.save()

        const [roomMessage] = await postInto(room, refreshed!, 'hello room')
        expect(roomMessage.pseudonym).toBe('Jane Doe')

        refreshed = await User.findById(user._id)
        expect(refreshed!.pseudonyms.find((p) => p.active)!.pseudonym).toBe('Bold Aardvark')
        expect(refreshed!.pseudonyms.find((p) => p.isRealName)!.active).toBe(false)

        // Posting in the event a second time still works — registering for the room
        // never locked the event's first-post pin to the wrong identity.
        const [secondEventMessage] = await postInto(event, refreshed, 'still here')
        expect(secondEventMessage.pseudonym).toBe('Bold Aardvark')
      })

      // Regression test for the failure mode  "missing
      // the third [stamping point] means the agent sees the wrong name while the
      // saved message looks correct." Comparing resolveDisplayName's return value to
      // itself can't catch that (it's the same deterministic call twice) — this
      // inspects the actual object handed to agent.evaluate() via a real,
      // agent-evaluated post into the room.
      test('an agent evaluating a room message sees the real name, not the active pseudonym', async () => {
        const user = await createNamedUser('Bold Aardvark')
        const room = await createRoom(user)
        user.pseudonyms.push(realNameEntry(room._id))
        await user.save()

        setAgentTypes(testAgentTypes)
        try {
          const mockAgent = new Agent({ agentType: 'perMessage', conversation: room, active: true })
          await mockAgent.save()
          room.enableAgents = true
          room.agents = [mockAgent]
          await room.save()

          mockEvaluate.mockResolvedValue({
            action: AgentMessageActions.OK,
            userMessage: undefined,
            userContributionVisible: true,
            suggestion: undefined
          })

          const [roomMessage] = await postInto(room, user, 'hello room')

          expect(roomMessage.pseudonym).toBe('Jane Doe')
          expect(mockEvaluate).toHaveBeenCalledTimes(1)
          const evaluatedMessage = mockEvaluate.mock.calls[0][0]
          expect(evaluatedMessage.pseudonym).toBe('Jane Doe')
        } finally {
          setAgentTypes(defaultAgentTypes)
        }
      })
    })

    test('rejects an unregistered human posting into the room end to end, and persists nothing', async () => {
      const user = await createNamedUser('Bold Aardvark')
      const room = await createRoom(user)
      const countBefore = await Message.countDocuments({ conversation: room._id })

      await expect(
        messageService.newMessageHandler({ conversation: room._id, body: 'hi', bodyType: 'text', channels: [] }, user)
      ).rejects.toThrow('You are not registered for this room.')

      const countAfter = await Message.countDocuments({ conversation: room._id })
      expect(countAfter).toBe(countBefore)
    })
  })
})

import mongoose from 'mongoose'
import Conversation from '../../../src/models/conversation.model.js'
import access, { AccessDeniedError } from '../../../src/auth/access.js'

function makeAgent(overrides: Record<string, unknown> = {}) {
  const conversationId = new mongoose.Types.ObjectId()
  return {
    __t: 'Agent',
    _id: new mongoose.Types.ObjectId(),
    conversation: { _id: conversationId },
    capabilities: {
      read: [],
      write: [{ type: 'ownConversation' as const }]
    },
    ...overrides
  }
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    ...overrides
  }
}

describe('access', () => {
  describe('assertCanRead', () => {
    test('user caller passes through for topic scope (not yet centralised)', () => {
      expect(() => access.assertCanRead(makeUser(), { type: 'topic', id: 'topic-1' })).not.toThrow()
    })

    test('agent with matching topic grant passes', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'topic', id: 'topic-1' }], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'topic', id: 'topic-1' })).not.toThrow()
    })

    test('agent with no read grants throws', () => {
      const agent = makeAgent({ capabilities: { read: [], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'topic', id: 'topic-1' })).toThrow(AccessDeniedError)
    })

    test('agent with no capabilities throws', () => {
      const agent = makeAgent({ capabilities: undefined })
      expect(() => access.assertCanRead(agent, { type: 'topic', id: 'topic-1' })).toThrow(AccessDeniedError)
    })

    test('agent with topic grant for a different id throws', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'topic', id: 'topic-2' }], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'topic', id: 'topic-1' })).toThrow(AccessDeniedError)
    })

    test('agent with matching conversation grant passes', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'conversation', id: 'conv-1' }], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1' })).not.toThrow()
    })

    test('agent with conversation grant for a different id throws', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'conversation', id: 'conv-2' }], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1' })).toThrow(AccessDeniedError)
    })

    test('agent with topic grant passes for a conversation scope carrying that topicId', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'topic', id: 'topic-1' }], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1', topicId: 'topic-1' })).not.toThrow()
    })

    test('agent with topic grant throws when conversation scope carries a different topicId', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'topic', id: 'topic-1' }], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1', topicId: 'topic-2' })).toThrow(AccessDeniedError)
    })

    test('agent with topic grant throws when conversation scope has no topicId', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'topic', id: 'topic-1' }], write: [] } })
      expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1' })).toThrow(AccessDeniedError)
    })

    describe('allPublicTopics grant', () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'allPublicTopics' }], write: [] } })

      test('passes for a conversation scope on a public topic', () => {
        expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1', topicIsPrivate: false })).not.toThrow()
      })

      test('passes when topicIsPrivate is not set', () => {
        expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1' })).not.toThrow()
      })

      test('throws for a conversation scope on a private topic', () => {
        expect(() => access.assertCanRead(agent, { type: 'conversation', id: 'conv-1', topicIsPrivate: true })).toThrow(AccessDeniedError)
      })

      test('passes for a public topic scope', () => {
        expect(() => access.assertCanRead(agent, { type: 'topic', id: 'topic-1', topicIsPrivate: false })).not.toThrow()
      })

      test('throws for a private topic scope', () => {
        expect(() => access.assertCanRead(agent, { type: 'topic', id: 'topic-1', topicIsPrivate: true })).toThrow(AccessDeniedError)
      })
    })

    test('agent with multiple grants passes when any match', () => {
      const agent = makeAgent({
        capabilities: {
          read: [{ type: 'topic', id: 'topic-1' }, { type: 'topic', id: 'topic-2' }],
          write: []
        }
      })
      expect(() => access.assertCanRead(agent, { type: 'topic', id: 'topic-2' })).not.toThrow()
    })
  })

  describe('assertCanWrite', () => {
    test('agent with ownConversation grant passes when scope matches its conversation', async () => {
      const agent = makeAgent()
      const conversationId = agent.conversation._id.toString()
      await expect(access.assertCanWrite(agent, { type: 'conversation', id: conversationId })).resolves.toBeUndefined()
    })

    test('agent with ownConversation grant throws when scope is a different conversation', async () => {
      const agent = makeAgent()
      const otherId = new mongoose.Types.ObjectId().toString()
      await expect(access.assertCanWrite(agent, { type: 'conversation', id: otherId })).rejects.toThrow(AccessDeniedError)
    })

    test('agent with no capabilities defaults to ownConversation grant', async () => {
      const agent = makeAgent({ capabilities: undefined })
      const conversationId = agent.conversation._id.toString()
      await expect(access.assertCanWrite(agent, { type: 'conversation', id: conversationId })).resolves.toBeUndefined()
    })

    describe('user caller', () => {
      let findByIdSpy: jest.SpyInstance

      beforeEach(() => {
        findByIdSpy = jest.spyOn(Conversation, 'findById')
      })

      afterEach(() => {
        findByIdSpy.mockRestore()
      })

      test('passes when user owns the conversation', async () => {
        const user = makeUser()
        findByIdSpy.mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ owner: user._id })
          })
        })
        await expect(access.assertCanWrite(user, { type: 'conversation', id: 'conv-1' })).resolves.toBeUndefined()
      })

      test('throws when user does not own the conversation', async () => {
        const user = makeUser()
        findByIdSpy.mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ owner: new mongoose.Types.ObjectId() })
          })
        })
        await expect(access.assertCanWrite(user, { type: 'conversation', id: 'conv-1' })).rejects.toThrow(AccessDeniedError)
      })

      test('throws when conversation is not found', async () => {
        const user = makeUser()
        findByIdSpy.mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(null)
          })
        })
        await expect(access.assertCanWrite(user, { type: 'conversation', id: 'conv-1' })).rejects.toThrow(AccessDeniedError)
      })
    })
  })

  describe('listReadableConversations', () => {
    let findSpy: jest.SpyInstance

    beforeEach(() => {
      findSpy = jest.spyOn(Conversation, 'find').mockReturnValue({ exec: jest.fn().mockResolvedValue([]) } as unknown as ReturnType<typeof Conversation.find>)
    })

    afterEach(() => {
      findSpy.mockRestore()
    })

    test('throws before querying when agent lacks read grant', async () => {
      const agent = makeAgent({ capabilities: { read: [], write: [] } })
      await expect(access.listReadableConversations(agent, { type: 'topic', id: 'topic-1' })).rejects.toThrow(AccessDeniedError)
      expect(findSpy).not.toHaveBeenCalled()
    })

    test('queries by topic when scope is topic', async () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'topic', id: 'topic-1' }], write: [] } })
      await access.listReadableConversations(agent, { type: 'topic', id: 'topic-1' })
      expect(findSpy).toHaveBeenCalledWith({ topic: 'topic-1' })
    })

    test('queries by id when scope is conversation', async () => {
      const agent = makeAgent({ capabilities: { read: [{ type: 'conversation', id: 'conv-1' }], write: [] } })
      await access.listReadableConversations(agent, { type: 'conversation', id: 'conv-1' })
      expect(findSpy).toHaveBeenCalledWith({ _id: 'conv-1' })
    })
  })
})

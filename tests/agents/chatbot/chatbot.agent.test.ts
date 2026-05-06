/* eslint-disable no-console */
import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createUser, createConversation, createPublicTopic, createMessage } from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import { ConversationHistory } from '../../../src/types/index.types.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('chatbot')

const BOT_NAME = 'Berkie'

describe('chatbot agent tests', () => {
  let agent
  let conversation
  let topic
  let user1
  let user2
  let user3

  async function createChatbotConversation() {
    const conv = await createConversation({ name: 'Chatbot Test Conversation' }, user1, topic)
    const testAgent = new Agent({
      agentType: 'chatbot',
      conversation: conv,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { botName: BOT_NAME }
    })
    const channels = await Channel.create([{ name: 'chatbot' }])
    conv.channels.push(...channels)
    await testAgent.save()
    conv.agents.push(testAgent)
    await conv.save()
    await testAgent.start()
    return { conv, testAgent }
  }

  beforeEach(async () => {
    topic = await createPublicTopic()
    user1 = await createUser('Alice')
    user2 = await createUser('Bob')
    user3 = await createUser('Carol')
    const result = await createChatbotConversation()
    conversation = result.conv
    agent = result.testAgent
  })

  function buildHistory(messages): ConversationHistory {
    return {
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(),
      messages
    }
  }

  async function ask(body, user = user1) {
    console.log(`Q (${user.pseudonyms[0].pseudonym}): ${body}`)
    return createMessage(body, user, conversation, ['chatbot'])
  }

  async function respond(history: ConversationHistory, userMessage) {
    const responses = await defaultAgentTypes.chatbot.respond.call(agent, history, userMessage)
    console.log(`A: ${responses[0]?.message}`)
    return responses
  }

  it('responds to a direct @mention with no prior history', async () => {
    const msg = await ask(`@${BOT_NAME} what is the capital of France?`)
    const responses = await respond(buildHistory([]), msg)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    expect(responses[0].message.toLowerCase()).toContain('paris')
  })

  it('responds sensibly with multi-user history containing consecutive user messages', async () => {
    // Simulate a multi-user group chat where multiple users post back-to-back
    // without any agent response in between — this creates consecutive 'user' role
    // messages that previously triggered placeholder injection
    const t = Date.now()
    const history = buildHistory([
      await createMessage(
        'Anyone know a good way to learn TypeScript?',
        user1,
        conversation,
        ['chatbot'],
        new Date(t - 5000)
      ),
      await createMessage('I found the official docs really helpful', user2, conversation, ['chatbot'], new Date(t - 4000)),
      await createMessage(
        'Same, plus the TS playground is great for experimenting',
        user3,
        conversation,
        ['chatbot'],
        new Date(t - 3000)
      ),
      await createMessage('What about books?', user2, conversation, ['chatbot'], new Date(t - 2000)),
      await createMessage(
        'Programming TypeScript by Boris Cherny is solid',
        user1,
        conversation,
        ['chatbot'],
        new Date(t - 1000)
      )
    ])

    const msg = await ask(`@${BOT_NAME} can you summarize the best ways to learn TypeScript?`)
    const responses = await respond(history, msg)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    // Should synthesize the conversation — mention at least one concrete resource
    expect(responses[0].message.toLowerCase()).toMatch(/docs|playground|book|typescript/)
  })

  it('uses prior conversation context when answering a follow-up', async () => {
    // Agent's own prior response should appear as 'assistant' role in history
    const t = Date.now()
    const agentPriorResponse = {
      body: 'The Eiffel Tower is located in Paris, France.',
      bodyType: 'text',
      conversation: conversation._id,
      pseudonym: BOT_NAME,
      pseudonymId: new mongoose.Types.ObjectId(),
      owner: agent._id,
      channels: ['chatbot'],
      fromAgent: true,
      visible: true,
      createdAt: new Date(t - 2000),
      updatedAt: new Date(t - 2000),
      upVotes: [],
      downVotes: [],
      pause: false
    }

    const history = buildHistory([
      await createMessage(`@${BOT_NAME} where is the Eiffel Tower?`, user1, conversation, ['chatbot'], new Date(t - 3000)),
      agentPriorResponse,
      await createMessage('Interesting!', user2, conversation, ['chatbot'], new Date(t - 1000))
    ])

    const msg = await ask(`@${BOT_NAME} how tall is it?`)
    const responses = await respond(history, msg)

    // Should reference the Eiffel Tower from context without needing it re-stated
    expect(responses[0].message.toLowerCase()).toMatch(/\d+\s*(meter|metre|feet|foot|m\b|ft\b)/)
  })

  it('responds when user asks what they missed without a direct @mention', async () => {
    const t = Date.now()
    const history = buildHistory([
      await createMessage('Did you know the moon is about 384,400 km from Earth?', user2, conversation, ['chatbot'], new Date(t - 4000)),
      await createMessage('Wow, that is really far!', user3, conversation, ['chatbot'], new Date(t - 3000)),
      await createMessage('Yes, and it takes light about 1.3 seconds to travel that distance.', user2, conversation, ['chatbot'], new Date(t - 2000))
    ])

    const msg = await ask('what did I miss?', user1)
    const responses = await respond(history, msg)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    expect(responses[0].message.toLowerCase()).toMatch(/moon|km|distance|light/)
  })

  it('responds when user asks who is speaking without a direct @mention', async () => {
    const t = Date.now()
    const history = buildHistory([
      await createMessage('I think React is better than Vue for large projects.', user2, conversation, ['chatbot'], new Date(t - 2000)),
      await createMessage('I disagree, Vue is much simpler to get started with.', user3, conversation, ['chatbot'], new Date(t - 1000))
    ])

    const msg = await ask('who is speaking?', user1)
    const responses = await respond(history, msg)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    expect(responses[0].message.toLowerCase()).toMatch(/bob|carol/)
  })
})

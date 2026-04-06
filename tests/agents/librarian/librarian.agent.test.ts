import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createPublicTopic, createUser, loadForgivenessTranscript } from '../../utils/agentTestHelpers.js'
import { Agent, Channel, Conversation } from '../../../src/models/index.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('librarian')

jest.setTimeout(120000)

describe('librarian agent tests', () => {
  let agent
  let conversation
  let topic
  let user1

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  beforeEach(async () => {
    user1 = await createUser('Testing Tester')
    topic = await createPublicTopic()

    // Create conversation with forgiveness topic
    const conversationConfig = {
      name: 'How forgiveness can create a more just legal system',
      description: 'A discussion about forgiveness and legal reform',
      owner: user1._id,
      topic: topic._id,
      enableAgents: true,
      agents: [],
      messages: [],
      startTime,
      presenters: [
        {
          name: 'Martha Minow',
          bio: 'Harvard Law School professor and expert on legal justice and forgiveness'
        }
      ],
      moderators: []
    }

    conversation = new Conversation(conversationConfig)
    await conversation.save()

    const channels = await Channel.create([{ name: 'transcript' }, { name: 'resources' }])
    conversation.channels.push(...channels)

    agent = new Agent({
      agentType: 'librarian',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel
    })
    await agent.save()

    conversation.agents = [agent]
    await conversation.save()

    // Load the forgiveness transcript
    await loadForgivenessTranscript(conversation, false)

    // Reload conversation to get the messages
    conversation = await Conversation.findById(conversation._id).populate('agents').populate('channels').populate('messages')
  })

  it('generates 3 reading recommendations based on forgiveness discussion', async () => {
    // Set conversation history to include first 10 minutes of transcript
    agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + 600 * 1000), // 10 minutes
      channels: ['transcript']
    }

    // Call the respond method
    const responses = await defaultAgentTypes.librarian.respond.call(agent, {
      start: startTime,
      end: new Date(startTime.getTime() + 600 * 1000),
      messages: conversation.messages
    })
    expect(responses).toHaveLength(1)

    const response = responses[0]

    // Should have a message
    expect(response.message).toBeDefined()

    // Message should be JSON type (structured output)
    expect(response.messageType).toBe('json')

    // Should be visible
    expect(response.visible).toBe(true)

    // Should have channels
    expect(response.channels).toBeDefined()
    expect(Array.isArray(response.channels)).toBe(true)
    expect(response.channels.length).toBeGreaterThan(0)

    // The message body should have recommendations array with 3 items
    const body = response.message as { content: Array<Record<string, unknown>>; type: string }
    expect(body.type).toBe('reading')
    expect(body.content).toBeDefined()
    expect(Array.isArray(body.content)).toBe(true)
    expect(body.content).toHaveLength(3)

    // Each recommendation should have required fields
    body.content.forEach((rec) => {
      expect(rec.title).toBeDefined()
      expect(rec.authors).toBeDefined()
      expect(Array.isArray(rec.authors)).toBe(true)
      expect(rec.relevanceReason).toBeDefined()
    })
  })
})

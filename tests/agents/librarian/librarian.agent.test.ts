import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createPublicTopic, createUser, loadForgivenessTranscript } from '../../utils/agentTestHelpers.js'
import { Agent, Channel, Conversation, Message } from '../../../src/models/index.js'

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

    conversation = new Conversation({
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
    })
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

    await loadForgivenessTranscript(conversation, false)
    // Reload conversation to get the messages
    conversation = await Conversation.findById(conversation._id).populate('agents').populate('channels').populate('messages')
  })

  it('generates 2 reading recommendations and does not repeat recommendations from previous messages', async () => {
    const resourcesChannel = conversation.channels.find((c: { name: string }) => c.name === 'resources')
    // Add a previous recommendation message from the librarian agent
    const previousRecommendations = {
      content: [
        {
          title: 'When Should Law Forgive?',
          authors: ['Martha Minow'],
          year: 2019,
          relevanceReason: 'Direct work by the speaker on forgiveness in legal contexts'
        },
        {
          title: 'Between Vengeance and Forgiveness',
          authors: ['Martha Minow'],
          year: 1998,
          relevanceReason: 'Explores reconciliation after mass violence'
        },
        {
          title: 'Breaking the Cycles of Hatred',
          authors: ['Martha Minow'],
          year: 2002,
          relevanceReason: 'Discusses memory, law, and repair'
        }
      ],
      type: 'reading'
    }

    const prevMessage = new Message({
      conversation: conversation._id,
      channel: resourcesChannel._id,
      pseudonymId: agent.pseudonyms[0]._id,
      pseudonym: agent.name,
      fromAgent: true,
      visible: true,
      body: JSON.stringify(previousRecommendations),
      bodyType: 'json',
      createdAt: new Date(startTime.getTime() + 300 * 1000)
    })
    await prevMessage.save()
    conversation.messages.push(prevMessage)
    await conversation.save()

    conversation = await Conversation.findById(conversation._id).populate('agents').populate('channels').populate('messages')
    agent.conversation = conversation

    const responses = await defaultAgentTypes.librarian.respond.call(agent, {
      start: startTime,
      end: new Date(startTime.getTime() + 600 * 1000),
      messages: conversation.messages.filter((m: { channels?: string[] }) => m.channels?.includes('transcript'))
    })

    expect(responses).toHaveLength(1)
    const body = responses[0].message as { content: Array<{ title: string } & Record<string, unknown>>; type: string }
    expect(body.type).toBe('reading')
    expect(body.content).toHaveLength(2)

    body.content.forEach((rec) => {
      expect(rec.title).toBeDefined()
      expect(rec.authors).toBeDefined()
      expect(Array.isArray(rec.authors)).toBe(true)
      expect(rec.relevanceReason).toBeDefined()
    })

    const titles = body.content.map((rec) => rec.title)
    // Check for uniqueness using a Set
    expect(new Set(titles).size).toBe(titles.length)

    const returnedTitles = body.content.map((rec) => rec.title)
    expect(returnedTitles).not.toContain('When Should Law Forgive?')
    expect(returnedTitles).not.toContain('Between Vengeance and Forgiveness')
    expect(returnedTitles).not.toContain('Breaking the Cycles of Hatred')
  })

  it('returns empty array when transcript is too short', async () => {
    const shortConvo = new Conversation({
      name: 'Short Discussion',
      description: 'A very brief discussion',
      owner: user1._id,
      topic: topic._id,
      enableAgents: true,
      agents: [],
      messages: [],
      startTime,
      presenters: [],
      moderators: []
    })
    await shortConvo.save()

    const channels = await Channel.create([{ name: 'transcript' }, { name: 'resources' }])
    shortConvo.channels.push(...channels)

    const shortAgent = new Agent({
      agentType: 'librarian',
      conversation: shortConvo,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel
    })
    await shortAgent.save()

    shortConvo.agents = [shortAgent]
    await shortConvo.save()

    // Add a very short message (less than minTranscriptLength of 100)
    const shortMessage = new Message({
      conversation: shortConvo._id,
      channel: channels[0]._id,
      pseudonym: 'User',
      pseudonymId: user1.pseudonyms[0]._id,
      fromAgent: false,
      visible: true,
      body: 'Hi there',
      bodyType: 'text',
      createdAt: startTime
    })
    await shortMessage.save()
    shortConvo.messages.push(shortMessage)

    const responses = await defaultAgentTypes.librarian.respond.call(shortAgent, {
      start: startTime,
      end: new Date(startTime.getTime() + 600 * 1000),
      messages: [shortMessage]
    })

    expect(responses).toHaveLength(0)
  })

  it('generates recommendations when no speakers or moderators are defined', async () => {
    // Create conversation without speakers
    let noSpeakersConvo = new Conversation({
      name: 'Discussion about Criminal Justice Reform',
      description: 'A discussion without designated speakers',
      owner: user1._id,
      topic: topic._id,
      enableAgents: true,
      agents: [],
      messages: [],
      startTime,
      presenters: [],
      moderators: []
    })
    await noSpeakersConvo.save()

    const channels = await Channel.create([{ name: 'transcript' }, { name: 'resources' }])
    noSpeakersConvo.channels.push(...channels)

    const noSpeakersAgent = new Agent({
      agentType: 'librarian',
      conversation: noSpeakersConvo,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel
    })
    await noSpeakersAgent.save()

    noSpeakersConvo.agents = [noSpeakersAgent]
    await noSpeakersConvo.save()

    // Load transcript
    await loadForgivenessTranscript(noSpeakersConvo, false)

    // Reload conversation to get the messages
    const reloadedNoSpeakers = await Conversation.findById(noSpeakersConvo._id)
      .populate('agents')
      .populate('channels')
      .populate('messages')
    if (!reloadedNoSpeakers) throw new Error('Failed to reload conversation')
    noSpeakersConvo = reloadedNoSpeakers

    // Call the respond method
    const responses = await defaultAgentTypes.librarian.respond.call(noSpeakersAgent, {
      start: startTime,
      end: new Date(startTime.getTime() + 600 * 1000),
      messages: noSpeakersConvo.messages
    })

    // Should still generate recommendations
    expect(responses).toHaveLength(1)
    const body = responses[0].message as { content: Array<Record<string, unknown>>; type: string }
    expect(body.content).toHaveLength(2)

    // Each recommendation should have required fields
    body.content.forEach((rec) => {
      expect(rec.title).toBeDefined()
      expect(rec.authors).toBeDefined()
      expect(Array.isArray(rec.authors)).toBe(true)
      expect(rec.relevanceReason).toBeDefined()
    })
  })

  it('handles malformed previous recommendations gracefully', async () => {
    const resourcesChannel = conversation.channels.find((c: { name: string }) => c.name === 'resources')

    const malformedMessage = new Message({
      conversation: conversation._id,
      channel: resourcesChannel._id,
      pseudonymId: agent.pseudonyms[0]._id,
      pseudonym: agent.name,
      fromAgent: true,
      visible: true,
      body: '{"content": "not an array", "type": "reading"}',
      bodyType: 'json',
      createdAt: new Date(startTime.getTime() + 300 * 1000)
    })
    await malformedMessage.save()
    conversation.messages.push(malformedMessage)

    // Add another malformed message (invalid JSON altogether)
    const invalidJsonMessage = new Message({
      conversation: conversation._id,
      channel: resourcesChannel._id,
      pseudonymId: agent.pseudonyms[0]._id,
      pseudonym: agent.name,
      fromAgent: true,
      visible: true,
      body: 'invalid json {{{',
      bodyType: 'json',
      createdAt: new Date(startTime.getTime() + 400 * 1000)
    })
    await invalidJsonMessage.save()
    conversation.messages.push(invalidJsonMessage)
    await conversation.save()

    conversation = await Conversation.findById(conversation._id).populate('agents').populate('channels').populate('messages')
    agent.conversation = conversation

    const responses = await defaultAgentTypes.librarian.respond.call(agent, {
      start: startTime,
      end: new Date(startTime.getTime() + 600 * 1000),
      messages: conversation.messages
    })

    expect(responses).toHaveLength(1)
    const body = responses[0].message as { content: Array<Record<string, unknown>>; type: string }
    expect(body.content).toHaveLength(2)
  })
})

/* eslint-disable no-console */
import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createUser,
  createConversation,
  createPublicTopic,
  createMessage,
  loadPartTimeWorkTranscript,
  loadAliensTranscript
} from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import { AgentMessageActions, ConversationHistory } from '../../../src/types/index.types.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'

jest.setTimeout(300000)

const testConfig = setupAgentTest('communityAssistant')

const BOT_NAME = 'Berkie'

describe('communityAssistant agent tests', () => {
  let agent
  let conversation
  let topic
  let user1
  let user2
  let user3

  async function createCommunityAssistantConversation() {
    const conv = await createConversation({ name: 'Community Assistant Test Conversation' }, user1, topic)
    const testAgent = new Agent({
      agentType: 'communityAssistant',
      conversation: conv,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { botName: BOT_NAME }
    })
    const channels = await Channel.create([{ name: 'communityAssistant' }])
    conv.channels.push(...channels)
    await testAgent.save()
    conv.agents.push(testAgent)
    await conv.save()
    await test
    await testAgent.start()
    return { conv, testAgent }
  }

  beforeEach(async () => {
    topic = await createPublicTopic()
    user1 = await createUser('Alice')
    user2 = await createUser('Bob')
    user3 = await createUser('Carol')
    const result = await createCommunityAssistantConversation()
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
    return createMessage(body, user, conversation, ['chat'])
  }

  async function respond(history: ConversationHistory, userMessage) {
    const responses = await defaultAgentTypes.communityAssistant.respond.call(agent, history, userMessage)
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

  it('responds to an event history question intended for the bot without an @mention', async () => {
    const msg = await ask('What did I miss at the last event?')
    const responses = await respond(buildHistory([]), msg)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
  })

  it('responds to a misspelled @mention of the bot name and normalizes spelling in evaluate', async () => {
    const msg = await ask('@Berkei what is the capital of France?')
    const evaluation = await defaultAgentTypes.communityAssistant.evaluate.call(agent, msg)
    expect(evaluation.userMessage.body).toBe(`@${BOT_NAME} what is the capital of France?`)

    const responses = await respond(buildHistory([]), evaluation.userMessage)
    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    expect(responses[0].message.toLowerCase()).toContain('paris')
  })

  it('does not respond to casual conversation not intended for the bot', async () => {
    const msg = await ask('I really liked what the last speaker said about flexible work')
    const responses = await respond(buildHistory([]), msg)
    expect(responses).toHaveLength(0)
  })

  it('responds sensibly with multi-user history containing consecutive user messages', async () => {
    // Simulate a multi-user group chat where multiple users post back-to-back
    // without any agent response in between — this creates consecutive 'user' role
    // messages that previously triggered placeholder injection
    const t = Date.now()
    const history = buildHistory([
      await createMessage('Anyone know a good way to learn TypeScript?', user1, conversation, ['chat'], new Date(t - 5000)),
      await createMessage('I found the official docs really helpful', user2, conversation, ['chat'], new Date(t - 4000)),
      await createMessage(
        'Same, plus the TS playground is great for experimenting',
        user3,
        conversation,
        ['chat'],
        new Date(t - 3000)
      ),
      await createMessage('What about books?', user2, conversation, ['chat'], new Date(t - 2000)),
      await createMessage(
        'Programming TypeScript by Boris Cherny is solid',
        user1,
        conversation,
        ['chat'],
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
      channels: ['chat'],
      fromAgent: true,
      visible: true,
      createdAt: new Date(t - 2000),
      updatedAt: new Date(t - 2000),
      upVotes: [],
      downVotes: [],
      pause: false
    }

    const history = buildHistory([
      await createMessage(`@${BOT_NAME} where is the Eiffel Tower?`, user1, conversation, ['chat'], new Date(t - 3000)),
      agentPriorResponse,
      await createMessage('Interesting!', user2, conversation, ['chat'], new Date(t - 1000))
    ])

    const msg = await ask(`@${BOT_NAME} how tall is it?`)
    const responses = await respond(history, msg)

    // Should reference the Eiffel Tower from context without needing it re-stated
    expect(responses[0].message.toLowerCase()).toMatch(/\d+\s*(meter|metre|feet|foot|m\b|ft\b)/)
  })

  describe('answers event history questions using event history tools', () => {
    let eventTopic
    let partTimeConv
    let aliensConv
    let communityAssistant
    let eventConversation

    beforeEach(async () => {
      // Create a dedicated topic holding the event series
      eventTopic = newPublicTopic()
      await insertTopics([eventTopic])

      // Two past events in that series with realistic dates in the current year
      partTimeConv = await createConversation(
        {
          name: 'Why your company should consider part-time work',
          description: `No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise—instead it's that businesses aren't structuring jobs to attract and retain the widest number of people possible, including those with a limited number of hours to give to a career. 

Speaking about her own experience as a single mother and professional, Jessica delineates how she's grown a seven-figure business in part-time hours with a small team of part-time employees, and how recent research shows that jobs with lower hour requirements improve employee recruitment, retention, and productivity – not the other way around.  A career marketer and graphic designer, Jessica has helped businesses brand and market themselves for almost two decades.

In 2018, she and her sister innovated a new tool for the sewing world – SewTites® Magnetic Sewing Pins™ – and founded a company with the same name.

Since then, Jessica has led the company to a 7-figure annual business – all in part-time hours with a small team of part-time employees.

A single mom of two children with primary custody, she is passionate about finding value in and creating work for people who don’t have the desire or ability to work full-time hours but still want and need to earn a living.`,
          presenters: [{ name: 'Jessica Drain', bio: 'Entrepreneur and advocate for flexible work arrangements' }]
        },
        user1,
        eventTopic,
        new Date('2026-01-15T18:00:00Z')
      )
      aliensConv = await createConversation(
        {
          name: 'Where are all the aliens?',
          description: `The universe is incredibly old, astoundingly vast and populated by trillions of planets -- so where are all the aliens? Astronomer Stephen Webb has an explanation: we're alone in the universe. In a mind-expanding talk, he spells out the remarkable barriers a planet would need to clear in order to host an extraterrestrial civilization -- and makes a case for the beauty of our potential cosmic loneliness. "The silence of the universe is shouting, 'We're the creatures who got lucky,'" Webb says.`,
          presenters: [
            {
              name: 'Stephen Webb',
              bio: 'Stephen Webb is a physicist and author of numerous popular science and math books, as well as academic publications.'
            }
          ]
        },
        user1,
        eventTopic,
        new Date('2026-03-10T18:00:00Z')
      )

      // Load transcripts into both per-conversation and topic-level vector stores
      await loadPartTimeWorkTranscript(partTimeConv, true)
      await loadAliensTranscript(aliensConv, true)

      // Create an communityAssistant agent configured to know about this event series
      eventConversation = await createConversation({ name: 'Community Assistant Test' }, user1, topic)
      communityAssistant = new Agent({
        agentType: 'communityAssistant',
        conversation: eventConversation,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME, topicIds: [eventTopic._id.toString()] }
      })
      const channels = await Channel.create([{ name: 'chat' }])
      eventConversation.channels.push(...channels)
      await communityAssistant.save()
      eventConversation.agents.push(communityAssistant)
      await eventConversation.save()
      await communityAssistant.start()
    })

    async function askCommunityAssistant(body: string) {
      console.log(`Q: ${body}`)
      const msg = await createMessage(body, user1, eventConversation, ['chat'])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(communityAssistant, buildHistory([]), msg)
      console.log(`A: ${responses[0]?.message}`)
      return responses
    }

    it('lists all events since January with one-sentence summaries', async () => {
      const responses = await askCommunityAssistant(
        `@${BOT_NAME} give me a one sentence summary and name of all events since January 2026`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      // Should name both events that exist in the series
      expect(responses[0].message).toContain('Why your company should consider part-time work')
      expect(responses[0].message).toContain('Where are all the aliens?')
    })

    it('identifies a speaker on extraterrestrials and UFOs', async () => {
      const responses = await askCommunityAssistant(
        `@${BOT_NAME} who was the speaker we had that talked about UFOs and aliens?`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message.toLowerCase()).toMatch(/Webb/i)
    })

    it('identifies which events covered part-time work and flexible employment', async () => {
      const responses = await askCommunityAssistant(
        `@${BOT_NAME} which events covered part-time work or flexible employment?`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message).toContain('Why your company should consider part-time work')
      expect(responses[0].message.toLowerCase()).toMatch(/part.time|flexib|work/)
    })

    it('retrieves what a specific presenter said on a specific topic at a specific event', async () => {
      const responses = await askCommunityAssistant(
        `@${BOT_NAME} what did Jessica say about working 40 hours per week at the part-time work event?`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      // Jessica's transcript explicitly challenges the 40-hour full-time norm
      expect(responses[0].message.toLowerCase()).toMatch(/40 hours|fulltime|full.time|framework|hundred years/)
    })
  })

  describe('voice mode (transcript channel)', () => {
    let voiceAgent
    let voiceConversation

    beforeEach(async () => {
      voiceConversation = await createConversation({ name: 'Voice Community Assistant Test' }, user1, topic)
      voiceAgent = new Agent({
        agentType: 'communityAssistant',
        conversation: voiceConversation,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME }
      })
      const channels = await Channel.create([{ name: 'chat' }, { name: 'transcript' }])
      voiceConversation.channels.push(...channels)
      await voiceAgent.save()
      voiceConversation.agents.push(voiceAgent)
      await voiceConversation.save()
      await voiceAgent.start()
    })

    it('evaluate: returns CONTRIBUTE for a transcript message with wake phrase and question', async () => {
      const msg = await createMessage(`hey ${BOT_NAME} what time is it?`, user1, voiceConversation, ['transcript'])
      const result = await defaultAgentTypes.communityAssistant.evaluate.call(voiceAgent, msg)
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('evaluate: returns OK (not CONTRIBUTE) for a transcript message without wake phrase', async () => {
      const msg = await createMessage('just a regular utterance', user1, voiceConversation, ['transcript'])
      const result = await defaultAgentTypes.communityAssistant.evaluate.call(voiceAgent, msg)
      expect(result.action).toBe(AgentMessageActions.OK)
    })

    it('evaluate: returns OK for bare wake phrase (waiting for follow-up)', async () => {
      const msg = await createMessage(`hey ${BOT_NAME}`, user1, voiceConversation, ['transcript'])
      const result = await defaultAgentTypes.communityAssistant.evaluate.call(voiceAgent, msg)
      expect(result.action).toBe(AgentMessageActions.OK)
    })

    it('respond: returns empty when transcript message has no wake phrase', async () => {
      const msg = await createMessage('just talking amongst ourselves', user1, voiceConversation, ['transcript'])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(voiceAgent, buildHistory([]), msg)
      expect(responses).toHaveLength(0)
    })

    it('respond: answers a voice question and outputs to the transcript channel', async () => {
      const msg = await createMessage(`hey ${BOT_NAME} what is the capital of France?`, user1, voiceConversation, [
        'transcript'
      ])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(voiceAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message.toLowerCase()).toContain('paris')
      expect(responses[0].channels.map((c) => c.name)).toContain('transcript')
      expect(responses[0].channels.map((c) => c.name)).not.toContain('chat')
    })

    it('respond: chat messages still output to the chat channel', async () => {
      const msg = await createMessage(`@${BOT_NAME} what is the capital of Germany?`, user1, voiceConversation, ['chat'])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(voiceAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].channels.map((c) => c.name)).toContain('chat')
      expect(responses[0].channels.map((c) => c.name)).not.toContain('transcript')
    })

    it('respond: streams sentence-level message:chunk events on the transcript channel', async () => {
      const broadcastedChunks: Array<{ text: string; done: boolean; channels: string[] }> = []
      const spy = jest
        .spyOn(websocketGateway, 'broadcastMessageChunk')
        .mockImplementation(async (_convId, channels, payload) => {
          broadcastedChunks.push({ text: payload.text, done: payload.done, channels })
        })

      const msg = await createMessage(`hey ${BOT_NAME} what is the capital of France?`, user1, voiceConversation, [
        'transcript'
      ])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(voiceAgent, buildHistory([]), msg)
      spy.mockRestore()

      const sentenceChunks = broadcastedChunks.filter((c) => !c.done)
      const doneMarkers = broadcastedChunks.filter((c) => c.done)

      // At least one sentence should have been streamed before the final marker
      expect(sentenceChunks.length).toBeGreaterThan(0)
      sentenceChunks.forEach((c) => expect(c.channels).toContain('transcript'))

      // Exactly one done marker at the end, with empty text
      expect(doneMarkers).toHaveLength(1)
      expect(doneMarkers[0].text).toBe('')
      expect(doneMarkers[0].channels).toContain('transcript')

      // The assembled streamed text should answer the question
      const assembled = sentenceChunks.map((c) => c.text).join(' ')
      expect(assembled.toLowerCase()).toContain('paris')

      // The full response is also returned for persistence
      expect(responses).toHaveLength(1)
      expect(responses[0].message.toLowerCase()).toContain('paris')
    })
  })

  describe('streaming configuration', () => {
    async function createStreamingAgent(streaming: boolean | undefined) {
      const conv = await createConversation({ name: `Streaming Config Test (${streaming})` }, user1, topic)
      const testAgent = new Agent({
        agentType: 'communityAssistant',
        conversation: conv,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME, streaming }
      })
      const channels = await Channel.create([{ name: 'chat' }])
      conv.channels.push(...channels)
      await testAgent.save()
      conv.agents.push(testAgent)
      await conv.save()
      await testAgent.start()
      return { conv, testAgent }
    }

    it('broadcasts message:chunk events on the chat channel when streaming: true is configured', async () => {
      const { conv, testAgent } = await createStreamingAgent(true)
      const broadcastedChunks: Array<{ text: string; done: boolean; channels: string[] }> = []
      const spy = jest
        .spyOn(websocketGateway, 'broadcastMessageChunk')
        .mockImplementation(async (_convId, channels, payload) => {
          broadcastedChunks.push({ text: payload.text, done: payload.done, channels })
        })

      const msg = await createMessage(`@${BOT_NAME} what is the capital of Japan?`, user1, conv, ['chat'])
      await defaultAgentTypes.communityAssistant.respond.call(testAgent, buildHistory([]), msg)
      spy.mockRestore()

      const sentenceChunks = broadcastedChunks.filter((c) => !c.done)
      const doneMarkers = broadcastedChunks.filter((c) => c.done)

      expect(sentenceChunks.length).toBeGreaterThan(0)
      sentenceChunks.forEach((c) => expect(c.channels).toContain('chat'))
      expect(doneMarkers).toHaveLength(1)
      expect(doneMarkers[0].channels).toContain('chat')
    })

    it('does not broadcast message:chunk events for chat input when streaming is not configured', async () => {
      const { conv, testAgent } = await createStreamingAgent(undefined)
      const spy = jest.spyOn(websocketGateway, 'broadcastMessageChunk').mockImplementation(async () => {})

      const msg = await createMessage(`@${BOT_NAME} what is the capital of Japan?`, user1, conv, ['chat'])
      await defaultAgentTypes.communityAssistant.respond.call(testAgent, buildHistory([]), msg)
      spy.mockRestore()

      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('tool configuration', () => {
    async function createAgentWithTools(tools: string[]) {
      const conv = await createConversation({ name: `Tool Config Test (${tools.join(',')})` }, user1, topic)
      const testAgent = new Agent({
        agentType: 'communityAssistant',
        conversation: conv,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME, tools }
      })
      const channels = await Channel.create([{ name: 'chat' }])
      conv.channels.push(...channels)
      await testAgent.save()
      conv.agents.push(testAgent)
      await conv.save()
      await testAgent.start()
      return { conv, testAgent }
    }

    it('answers a factual question using web_search when configured with only web_search', async () => {
      const { conv, testAgent } = await createAgentWithTools(['web_search'])
      const msg = await createMessage(`@${BOT_NAME} what is the capital of Japan?`, user1, conv, ['chat'])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(testAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].message.toLowerCase()).toContain('tokyo')
    })

    it('responds without error when configured with no tools', async () => {
      const { conv, testAgent } = await createAgentWithTools([])
      const msg = await createMessage(`@${BOT_NAME} what is two plus two?`, user1, conv, ['chat'])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(testAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
    })
  })

  describe('onConversationEvent / notifications configuration', () => {
    let stoppedConversation
    let notifyAgent
    let notifyConversation

    beforeEach(async () => {
      stoppedConversation = await createConversation({ name: 'Past Event' }, user1, topic)

      // Agent with event_ended notification enabled
      notifyConversation = await createConversation({ name: 'Notify Agent Conversation' }, user1, topic)
      notifyAgent = new Agent({
        agentType: 'communityAssistant',
        conversation: notifyConversation,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME, notifications: ['event_ended'] }
      })
      const channels = await Channel.create([{ name: 'chat' }])
      notifyConversation.channels.push(...channels)
      await notifyAgent.save()
      notifyConversation.agents.push(notifyAgent)
      await notifyConversation.save()
      await notifyAgent.start()
    })

    it('returns empty for non-conversationStopped event types regardless of notifications config', async () => {
      const responses = await defaultAgentTypes.communityAssistant.onConversationEvent.call(notifyAgent, {
        type: 'unknownEvent',
        conversationId: stoppedConversation._id.toString()
      })
      expect(responses).toHaveLength(0)
    })

    it('returns empty when notifications does not include event_ended, even with a summary', async () => {
      await stoppedConversation.updateOne({ summary: 'Key takeaways from the event.' })

      // agent (from outer beforeEach) has no notifications configured
      const responses = await defaultAgentTypes.communityAssistant.onConversationEvent.call(agent, {
        type: 'conversationStopped',
        conversationId: stoppedConversation._id.toString()
      })
      expect(responses).toHaveLength(0)
    })

    it('returns empty when event_ended is enabled but the conversation has no summary', async () => {
      const responses = await defaultAgentTypes.communityAssistant.onConversationEvent.call(notifyAgent, {
        type: 'conversationStopped',
        conversationId: stoppedConversation._id.toString()
      })
      expect(responses).toHaveLength(0)
    })

    it('posts a summary message when event_ended is enabled and the conversation has a summary', async () => {
      await stoppedConversation.updateOne({ summary: 'Key takeaways from the event.' })

      const responses = await defaultAgentTypes.communityAssistant.onConversationEvent.call(notifyAgent, {
        type: 'conversationStopped',
        conversationId: stoppedConversation._id.toString()
      })

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toContain('Past Event')
      expect(responses[0].message).toContain('Key takeaways from the event.')
    })

    it('posts to the chat channel when one exists', async () => {
      await stoppedConversation.updateOne({ summary: 'A summary.' })

      const responses = await defaultAgentTypes.communityAssistant.onConversationEvent.call(notifyAgent, {
        type: 'conversationStopped',
        conversationId: stoppedConversation._id.toString()
      })

      expect(responses[0].channels).toHaveLength(1)
      expect(responses[0].channels[0].name).toBe('chat')
    })
  })

  describe('DM support', () => {
    let dmAgent
    let dmConversation
    let dmChannel

    beforeEach(async () => {
      dmConversation = await createConversation({ name: 'DM Community Assistant Test' }, user1, topic)
      dmAgent = new Agent({
        agentType: 'communityAssistant',
        conversation: dmConversation,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME }
      })
      const [chatChannel, direct] = await Channel.create([
        { name: 'chat' },
        { name: `dm-${user1._id}-${dmAgent._id}`, direct: true, participants: [user1._id, dmAgent._id] }
      ])
      dmChannel = direct
      dmConversation.channels.push(chatChannel, dmChannel)
      await dmAgent.save()
      dmConversation.agents.push(dmAgent)
      await dmConversation.save()
      await dmAgent.start()
    })

    it('responds to a DM message without requiring an @mention', async () => {
      const msg = await createMessage('what is the capital of Spain?', user1, dmConversation, [dmChannel.name])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(dmAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message.toLowerCase()).toContain('madrid')
    })

    it('responds to casual DM conversation that would not trigger bot intent in a public channel', async () => {
      const msg = await createMessage('hey, how are you doing today?', user1, dmConversation, [dmChannel.name])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(dmAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
    })

    it('directs the DM response back to the DM channel', async () => {
      const msg = await createMessage('what is 2 + 2?', user1, dmConversation, [dmChannel.name])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(dmAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      const responseChannelNames = responses[0].channels.map((c) => c.name)
      expect(responseChannelNames).toContain(dmChannel.name)
      expect(responseChannelNames).not.toContain('chat')
    })

    it('does not respond to casual chat-channel conversation not directed at the bot', async () => {
      const msg = await createMessage('I had a great time at the last event', user1, dmConversation, ['chat'])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(dmAgent, buildHistory([]), msg)

      expect(responses).toHaveLength(0)
    })
  })

  describe('uses all public topics when topicIds is not configured', () => {
    let eventTopic
    let partTimeConv
    let aliensConv
    let communityAssistantNoTopicIds
    let eventConversation

    beforeEach(async () => {
      // Create a public topic — not passed to agentConfig, should be auto-discovered
      eventTopic = newPublicTopic()
      await insertTopics([eventTopic])

      partTimeConv = await createConversation(
        {
          name: 'Why your company should consider part-time work',
          description: 'Talk by Jessica Drain about building a seven-figure business with part-time employees.',
          presenters: [{ name: 'Jessica Drain', bio: 'Entrepreneur and advocate for flexible work arrangements' }]
        },
        user1,
        eventTopic,
        new Date('2026-01-15T18:00:00Z')
      )
      aliensConv = await createConversation(
        {
          name: 'Where are all the aliens?',
          description: 'Astronomer Stephen Webb makes the case that we may be alone in the universe.',
          presenters: [{ name: 'Stephen Webb', bio: 'Physicist and popular science author.' }]
        },
        user1,
        eventTopic,
        new Date('2026-03-10T18:00:00Z')
      )

      await loadPartTimeWorkTranscript(partTimeConv, true)
      await loadAliensTranscript(aliensConv, true)

      // Agent created with NO topicIds — should fall back to all public topics
      eventConversation = await createConversation({ name: 'Community Assistant No TopicIds Test' }, user1, topic)
      communityAssistantNoTopicIds = new Agent({
        agentType: 'communityAssistant',
        conversation: eventConversation,
        llmPlatform: testConfig.llmPlatform,
        llmModel: testConfig.llmModel,
        agentConfig: { botName: BOT_NAME }
      })
      const channels = await Channel.create([{ name: 'chat' }])
      eventConversation.channels.push(...channels)
      await communityAssistantNoTopicIds.save()
      eventConversation.agents.push(communityAssistantNoTopicIds)
      await eventConversation.save()
      await communityAssistantNoTopicIds.start()
    })

    async function askNoTopicIds(body: string) {
      console.log(`Q: ${body}`)
      const msg = await createMessage(body, user1, eventConversation, ['chat'])
      const responses = await defaultAgentTypes.communityAssistant.respond.call(
        communityAssistantNoTopicIds,
        buildHistory([]),
        msg
      )
      console.log(`A: ${responses[0]?.message}`)
      return responses
    }

    it('lists events from auto-discovered public topics', async () => {
      const responses = await askNoTopicIds(
        `@${BOT_NAME} give me a one sentence summary and name of all events since January 2026`
      )

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message).toContain('Why your company should consider part-time work')
      expect(responses[0].message).toContain('Where are all the aliens?')
    })

    it('answers a speaker question using auto-discovered topics', async () => {
      const responses = await askNoTopicIds(`@${BOT_NAME} who was the speaker that talked about aliens?`)

      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].message.toLowerCase()).toMatch(/webb/i)
    })
  })
})

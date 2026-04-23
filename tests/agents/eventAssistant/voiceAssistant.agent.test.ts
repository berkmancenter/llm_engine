/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  createMessage,
  createConversation
} from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'

import { AgentMessageActions } from '../../../src/types/index.types.js'
import { QuestionClassification } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('voiceAssistant')
const testTimeout = 120000

async function createVoiceAssistantConversation(conversationObj, owner, topic, startTime, llmPlatform?, llmModel?) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({
    agentType: 'voiceAssistant',
    conversation,
    llmPlatform,
    llmModel
  })
  const channels = await Channel.create([{ name: 'transcript' }, { name: 'chat' }])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}

describe('voice assistant CI tests', () => {
  let agent
  let conversation
  let topic
  let user1

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  beforeEach(async () => {
    user1 = await createUser('Boring Badger')
    topic = await createPublicTopic()
    conversation = await createVoiceAssistantConversation(
      {
        name: 'Why your company should consider part-time work',
        description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise.`,
        presenters: [{ name: 'Jessica Drain', bio: 'A career marketer and graphic designer.' }],
        moderators: [{ name: 'Joe Moderator', bio: 'An experienced event moderator.' }]
      },
      user1,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await loadPartTimeWorkTranscript(conversation, true)
  })

  // EVALUATE TESTS

  it('contributes to transcript messages from other users', async () => {
    const msg = await createMessage(`hey ${agent.agentConfig.botName} what is going on?`, user1, conversation, [
      'transcript'
    ])
    const evaluation = await defaultAgentTypes.voiceAssistant.evaluate.call(agent, msg)
    expect(evaluation.action).toEqual(AgentMessageActions.CONTRIBUTE)
  })

  // RESPOND TESTS - TRIGGER DETECTION

  it('returns empty when no hey trigger is present', async () => {
    const msg = await createMessage('part-time work is interesting', user1, conversation, ['transcript'])
    agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + 313 * 1000),
      count: 10,
      channels: ['transcript']
    }
    const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
    expect(responses).toHaveLength(0)
  })

  it('returns empty for a bare hey trigger with no question, waiting for next message', async () => {
    const msg = await createMessage(`hey ${agent.agentConfig.botName}`, user1, conversation, ['transcript'])
    agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + 313 * 1000),
      count: 10,
      channels: ['transcript']
    }
    const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
    expect(responses).toHaveLength(0)
  })

  it(
    'answers an inline question on the transcript channel',
    async () => {
      const msg = await createMessage(`hey ${agent.agentConfig.botName} what is this talk about?`, user1, conversation, [
        'transcript'
      ])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      expect(responses[0].message.text).toBeDefined()
      console.log(`A: ${responses[0].message.text}`)
      expect([
        QuestionClassification.ON_TOPIC_ANSWER,
        QuestionClassification.ON_TOPIC_ASK_SPEAKER,
        QuestionClassification.CATCHUP
      ]).toContain(responses[0].classification)
    },
    testTimeout
  )

  it(
    'answers a deferred question when the previous transcript message was a bare hey trigger',
    async () => {
      const prevMsg = await createMessage(`hey ${agent.agentConfig.botName}`, user1, conversation, ['transcript'])
      const currMsg = await createMessage('what did Jessica say about flexible work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 622 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [prevMsg] }, currMsg)
      expect(responses).toHaveLength(1)
      expect(responses[0].message.text).toBeDefined()
      console.log(`A (deferred): ${responses[0].message.text}`)
      expect([
        QuestionClassification.ON_TOPIC_ANSWER,
        QuestionClassification.ON_TOPIC_ASK_SPEAKER,
        QuestionClassification.CATCHUP
      ]).toContain(responses[0].classification)
    },
    testTimeout
  )

  it('does not treat current message as deferred question when previous hey trigger had inline question text', async () => {
    const prevMsg = await createMessage(`hey ${agent.agentConfig.botName} what is part-time work?`, user1, conversation, [
      'transcript'
    ])
    const currMsg = await createMessage('tell me more', user1, conversation, ['transcript'])
    agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + 313 * 1000),
      count: 10,
      channels: ['transcript']
    }
    // prev had an inline question, so current should not be treated as deferred
    const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [prevMsg] }, currMsg)
    expect(responses).toHaveLength(0)
  })

  it(
    'capitalizes the first letter of an inline question extracted after the hey trigger',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey Berkie what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      expect(responses[0].message.source).toBe('voice')
      expect(responses[0].message.sourceMessage).toBe('What is part-time work?')
    },
    testTimeout
  )

  // FUZZY MATCHING TESTS - HEY TRIGGER POSITION

  it(
    'matches hey trigger anywhere in the message, not just at the start',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('so hey Berkie what is this talk about?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (mid-message trigger): ${responses[0].message.text}`)
    },
    testTimeout
  )

  it('only uses words after the hey trigger as the question, not the preamble before it', async () => {
    agent.agentConfig.botName = 'Berkie'
    // Bare "hey Berkie" in the middle — preamble before it should be ignored, no question after = wait for next
    const msg = await createMessage('okay so hey Berkie', user1, conversation, ['transcript'])
    agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + 313 * 1000),
      count: 10,
      channels: ['transcript']
    }
    const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
    expect(responses).toHaveLength(0)
  })

  // FUZZY MATCHING TESTS - BOT NAME VARIATIONS (fuzzball scores vs 'Berkie')

  it(
    'fuzzy matches hey with punctuation variations (hey, Berkie,)',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey, Berkie, what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (punctuation): ${responses[0].message.text}`)
    },
    testTimeout
  )

  it(
    'fuzzy matches "Burkie" (score ~83, passes nameMatchThreshold)',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey Burkie what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (Burkie): ${responses[0].message.text}`)
    },
    testTimeout
  )

  it(
    'fuzzy matches "Birkie" (score ~83, passes nameMatchThreshold)',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey Birkie what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (Birkie): ${responses[0].message.text}`)
    },
    testTimeout
  )

  it(
    'fuzzy matches "Berkee" (score ~83, passes nameMatchThreshold)',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey Berkee what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (Berkee): ${responses[0].message.text}`)
    },
    testTimeout
  )

  it(
    'fuzzy matches "Berkye" (score ~83, passes nameMatchThreshold)',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey Berkye what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (Berkye): ${responses[0].message.text}`)
    },
    testTimeout
  )

  it(
    'fuzzy matches "Berk" (score ~80, passes nameMatchThreshold)',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey Berk what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (Berk): ${responses[0].message.text}`)
    },
    testTimeout
  )

  it(
    'fuzzy matches "Berky" (score ~73, passes nameMatchThreshold of 70)',
    async () => {
      agent.agentConfig.botName = 'Berkie'
      const msg = await createMessage('hey Berky what is part-time work?', user1, conversation, ['transcript'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 313 * 1000),
        count: 10,
        channels: ['transcript']
      }
      const responses = await defaultAgentTypes.voiceAssistant.respond.call(agent, { messages: [] }, msg)
      expect(responses).toHaveLength(1)
      console.log(`A (Berky): ${responses[0].message.text}`)
    },
    testTimeout
  )
})

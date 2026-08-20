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
import { Agent, Channel, Message } from '../../../src/models/index.js'

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

})

describe('voiceAssistant parseOutput', () => {
  function makeVoiceMessage(text: string, sourceMessage: string, sourcePseudonym?: string) {
    return new Message({
      body: { text, source: 'voice', sourceMessage, ...(sourcePseudonym ? { sourcePseudonym } : {}) },
      bodyType: 'json',
      fromAgent: true,
      pseudonym: 'Voice Assistant'
    })
  }

  it('prefixes response with 🔊 and the question in quotes', () => {
    const msg = makeVoiceMessage('Part-time work is fewer hours.', 'What is part-time work?')
    const result = defaultAgentTypes.voiceAssistant.parseOutput(msg)
    expect(result.bodyType).toBe('text')
    expect(result.body).toBe('🔊 "What is part-time work?"\nPart-time work is fewer hours.')
  })

  it('truncates questions longer than 40 chars with ellipsis', () => {
    const longQuestion = 'What exactly does the speaker mean when they talk about flexible working arrangements?'
    const msg = makeVoiceMessage('They mean employees can choose their hours.', longQuestion)
    const result = defaultAgentTypes.voiceAssistant.parseOutput(msg)
    expect(result.body).toBe('🔊 "What exactly does the speaker mean when ..."\nThey mean employees can choose their hours.')
  })

  it('does not add ellipsis when question is exactly 40 chars', () => {
    const fortyChars = 'A'.repeat(40)
    const msg = makeVoiceMessage('Answer.', fortyChars)
    const result = defaultAgentTypes.voiceAssistant.parseOutput(msg)
    expect(result.body).toBe(`🔊 "${fortyChars}"\nAnswer.`)
  })

  it('returns non-voice json messages unchanged', () => {
    const msg = new Message({ body: { text: 'Some response', type: 'on_topic_answer' }, bodyType: 'json', fromAgent: true })
    const result = defaultAgentTypes.voiceAssistant.parseOutput(msg)
    expect(result).toBe(msg)
  })

  it('returns text messages unchanged', () => {
    const msg = new Message({ body: 'Plain text response', bodyType: 'text', fromAgent: true })
    const result = defaultAgentTypes.voiceAssistant.parseOutput(msg)
    expect(result).toBe(msg)
  })
})

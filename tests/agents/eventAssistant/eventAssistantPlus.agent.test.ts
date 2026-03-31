/* eslint-disable no-console */
import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createDirectMessage,
  createUser,
  loadPartTimeWorkTranscript,
  createPublicTopic,
  createEventAssistantPlusConversation,
  createMessage
} from '../../utils/agentTestHelpers.js'
import Channel from '../../../src/models/channel.model.js'
import Message from '../../../src/models/message.model.js'
import { AgentMessageActions } from '../../../src/types/index.types.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('eventAssistantPlus')

const submitToModeratorQuestion = {
  text: 'Would you like to submit this question anonymously to the moderator for Q&A?',
  type: 'moderator_offered'
}

const testTimeout = 120000

describe(`event assistant plus tests`, () => {
  let agent
  let conversation
  let user1
  let topic
  const startTime = new Date(Date.now() - 15 * 60 * 1000) // The whole event started 15 minutes ago

  async function validateResponse(responses, channel = `direct-agents-${user1._id}`) {
    expect(responses).not.toHaveLength(0)
    expect(responses[0].message).toBeDefined()
    const messageForLog = responses[0].messageType === 'json' ? responses[0].message.text : responses[0].message
    console.log(`A: ${messageForLog}`)
    expect(responses[0].channels).toHaveLength(1)
    expect(responses[0].channels[0].name).toEqual(channel)
  }

  beforeEach(async () => {
    user1 = await createUser('Cautious Cat')

    topic = await createPublicTopic()
    conversation = await createEventAssistantPlusConversation(
      {
        name: 'Test Event',
        description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise—instead it's that businesses aren't structuring jobs to attract and retain the widest number of people possible, including those with a limited number of hours to give to a career. 
Speaking about her own experience as a single mother and professional, Jessica delineates how she's grown a seven-figure business in part-time hours with a small team of part-time employees, and how recent research shows that jobs with lower hour requirements improve employee recruitment, retention, and productivity – not the other way around.`,
        presenters: [
          {
            name: 'Jessica Drain',
            bio: `A career marketer and graphic designer, Jessica has helped businesses brand and market themselves for almost two decades. In 2018, she and her sister innovated a new tool for the sewing world – SewTites® Magnetic Sewing Pins™ – and founded a company with the same name. 
Since then, Jessica has led the company to a 7-figure annual business – all in part-time hours with a small team of part-time employees. A single mom of two children with primary custody, she is passionate about finding value in and creating work for people who don’t have the desire or ability to work full-time hours but still want and need to earn a living.`
          }
        ],
        moderators: [{ name: 'Joe Moderator', bio: 'An experienced event moderator who moderates all day long.' }]
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

  async function createQuestion(body) {
    console.log(`Q: ${body}`)
    const msg = await createDirectMessage(body, user1, conversation)
    return msg
  }

  describe('classification-based submitToModerator prompting', () => {
    // ON_TOPIC_ANSWER - Should NOT ask to submit
    it(
      'does not ask to submit for simple acknowledgments (ON_TOPIC_ANSWER)',
      async () => {
        const msg = await createQuestion('Thanks for this presentation')

        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should only have 1 response, no moderator question
        expect(responses).toHaveLength(1)
        expect(responses[0].messageType).toEqual('json')
        expect(responses[0].message.text).not.toEqual(submitToModeratorQuestion.text)
      },
      testTimeout
    )

    it(
      'does not ask to submit for recap questions (ON_TOPIC_ANSWER)',
      async () => {
        const msg = await createQuestion('What did the speaker say about part-time work?')
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should only have 1 response, no moderator question
        expect(responses).toHaveLength(1)
        expect(responses[0].messageType).toEqual('json')
        expect(responses[0].message.text).not.toEqual(submitToModeratorQuestion.text)
      },
      testTimeout
    )

    it(
      'does not ask to submit when helping draft questions (ON_TOPIC_ANSWER)',
      async () => {
        const msg = await createQuestion('Can you help me write a question about workplace flexibility?')
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should only have 1 response, no moderator question
        expect(responses).toHaveLength(1)
        expect(responses[0].messageType).toEqual('json')
        expect(responses[0].message.text).not.toEqual(submitToModeratorQuestion.text)
      },
      testTimeout
    )

    // ON_TOPIC_ASK_SPEAKER - Should ask to submit
    it(
      'asks to submit for statistical questions beyond presentation (ON_TOPIC_ASK_SPEAKER)',
      async () => {
        const msg = await createQuestion('What percentage of U.S. workers are part-time?')
        msg._id = new mongoose.Types.ObjectId()
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({
          ...submitToModeratorQuestion,
          message: msg._id.toString().toString()
        })
        expect(responses[1].parent).toBeUndefined()
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    it(
      'asks to submit for resource requests (ON_TOPIC_ASK_SPEAKER)',
      async () => {
        const msg = await createQuestion('Where can I learn more about workplace flexibility?')
        msg._id = new mongoose.Types.ObjectId()
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({ ...submitToModeratorQuestion, message: msg._id.toString() })
        expect(responses[1].parent).toBeUndefined()
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    it(
      'asks to submit for substantive negative feedback (ON_TOPIC_ASK_SPEAKER)',
      async () => {
        const msg = await createQuestion('This talk is boring')
        msg._id = new mongoose.Types.ObjectId()

        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({ ...submitToModeratorQuestion, message: msg._id.toString() })
        expect(responses[1].parent).toBeUndefined()
        expect(responses[1].replyFormat).toMatchObject({
          type: 'singleChoice',
          options: [
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' }
          ]
        })
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    it(
      'asks to submit for disagreement/criticism (ON_TOPIC_ASK_SPEAKER)',
      async () => {
        const msg = await createQuestion('I disagree that part-time work solves the hiring problem')
        msg._id = new mongoose.Types.ObjectId()
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({ ...submitToModeratorQuestion, message: msg._id.toString() })
        expect(responses[1].parent).toBeUndefined()
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    it(
      'asks to submit for opinion/advice requests (ON_TOPIC_ASK_SPEAKER)',
      async () => {
        const msg = await createQuestion('What is her advice for those who want to switch to part-time work?')
        msg._id = new mongoose.Types.ObjectId()
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({ ...submitToModeratorQuestion, message: msg._id.toString() })
        expect(responses[1].parent).toBeUndefined()
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    it(
      'asks to submit for implementation questions (ON_TOPIC_ASK_SPEAKER)',
      async () => {
        const msg = await createQuestion('How would Jessica recommend implementing this at a startup?')
        msg._id = new mongoose.Types.ObjectId()
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({ ...submitToModeratorQuestion, message: msg._id.toString() })
        expect(responses[1].parent).toBeUndefined()
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    it(
      'asks to submit for hypothetical questions (ON_TOPIC_ASK_SPEAKER)',
      async () => {
        const msg = await createQuestion('What if an employee abuses the flexibility?')
        msg._id = new mongoose.Types.ObjectId()
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({ ...submitToModeratorQuestion, message: msg._id.toString() })
        expect(responses[1].parent).toBeUndefined()
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    // OFF_TOPIC - Should NOT ask to submit
    it(
      'does not ask to submit for off-topic questions',
      async () => {
        const msg = await createQuestion('What is the weather like today?')
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should only have 1 response (off-topic message), no moderator question
        expect(responses).toHaveLength(1)
        expect(responses[0].message.text).not.toEqual(submitToModeratorQuestion.text)
      },
      testTimeout
    )

    // CATCHUP - Should NOT ask to submit
    it(
      'does not ask to submit for catchup questions',
      async () => {
        const msg = await createQuestion('What did I miss?')
        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
        await validateResponse(responses)

        // Should only have 1 response (summary), no moderator question
        expect(responses).toHaveLength(1)
        expect(responses[0].message.text).not.toEqual(submitToModeratorQuestion.text)
      },
      testTimeout
    )
  })

  describe('submit to moderator functionality', () => {
    it('should submit to moderator when user responds with yes', async () => {
      const questionMsg = await createQuestion('What is the meaning of life?')
      const savedQuestion = await Message.create(questionMsg)

      const affirmativeMsg = await createQuestion('yes')
      const conversationHistory = {
        messages: [
          savedQuestion,
          { body: "I don't have enough information.", fromAgent: true },
          { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
        ]
      }

      const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, affirmativeMsg)

      await validateResponse(responses)
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toMatchObject({
        text: 'Your message has been submitted to the moderator.',
        type: 'moderator_submitted',
        message: savedQuestion._id.toString()
      })
      expect(responses[0].parent).toBeUndefined()

      const updatedMessage = await Message.findById(savedQuestion._id)
      expect(updatedMessage!.channels).toContain('participant')
    })

    it('should decline submission when user responds with no', async () => {
      const questionMsg = await createQuestion('What is the meaning of life?')
      const savedQuestion = await Message.create(questionMsg)

      const negativeMsg = await createQuestion('no')
      const conversationHistory = {
        messages: [
          savedQuestion,
          { body: "I don't have enough information.", fromAgent: true },
          { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, fromAgent: true, bodyType: 'json' }
        ]
      }

      const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, negativeMsg)

      await validateResponse(responses)
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toMatchObject({
        type: 'moderator_declined',
        text: "OK, I won't submit it. Feel free to ask me anything else!",
        message: savedQuestion._id.toString()
      })
      expect(responses[0].parent).toBeUndefined()

      const updatedMessage = await Message.findById(savedQuestion._id)
      expect(updatedMessage!.channels).not.toContain('participant')
    })

    it('should submit to moderator for various affirmative responses', async () => {
      const affirmativeVariants = [
        'yes',
        'yeah',
        'yep',
        'yup',
        'sure',
        'okay',
        'ok',
        'absolutely',
        'definitely',
        'yes please',
        'sure thing'
      ]

      for (const variant of affirmativeVariants) {
        const questionMsg = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(questionMsg)

        const affirmativeMsg = await createQuestion(variant)
        const conversationHistory = {
          messages: [
            savedQuestion,
            { body: "I don't have enough information.", fromAgent: true },
            { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, affirmativeMsg)

        await validateResponse(responses)
        expect(responses).toHaveLength(1)
        expect(responses[0].message).toMatchObject({
          text: 'Your message has been submitted to the moderator.',
          type: 'moderator_submitted',
          message: savedQuestion._id.toString()
        })
        expect(responses[0].parent).toBeUndefined()
      }
    })

    it('should decline submission for various negative responses', async () => {
      const negativeVariants = ['no', 'nope', 'nah', 'no thanks', "don't", 'never mind']

      for (const variant of negativeVariants) {
        const questionMsg = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(questionMsg)

        const negativeMsg = await createQuestion(variant)
        const conversationHistory = {
          messages: [
            savedQuestion,
            { body: "I don't have enough information.", fromAgent: true },
            { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, negativeMsg)

        await validateResponse(responses)
        expect(responses).toHaveLength(1)
        expect(responses[0].message).toMatchObject({
          text: "OK, I won't submit it. Feel free to ask me anything else!",
          type: 'moderator_declined',
          message: savedQuestion._id.toString()
        })
        expect(responses[0].parent).toBeUndefined()
      }
    })

    it('should process new question when user ignores submit prompt', async () => {
      const questionMsg = await createQuestion('What is the meaning of life?')
      const savedQuestion = await Message.create(questionMsg)

      const newQuestion = await createQuestion("What was the speaker's main point?")
      const conversationHistory = {
        messages: [
          savedQuestion,
          { body: "I don't have enough information.", fromAgent: true },
          { body: submitToModeratorQuestion, bodyType: 'json', fromAgent: true }
        ]
      }

      const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, newQuestion)

      await validateResponse(responses)
      // New question should be processed normally, not treated as yes/no response
      expect(responses.length).toBeGreaterThan(0)
      expect(responses[0].messageType).toBe('json')
      expect(responses[0].message.text).toBeDefined()

      const updatedMessage = await Message.findById(savedQuestion._id)
      expect(updatedMessage!.channels).not.toContain('participant')
    })

    it('should handle /mod command in evaluate', async () => {
      const modMsg = await createQuestion('/mod This is urgent')

      const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, modMsg)

      expect(evaluation.userMessage.body).toEqual({ command: 'mod', text: 'This is urgent' })
      expect(evaluation.userMessage.bodyType).toBe('json')
      expect(evaluation.userMessage.channels).toContain('participant')
      expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('should return moderator submission message for participant channel messages', async () => {
      const participantMsg = await createQuestion('Question from user')
      participantMsg._id = new mongoose.Types.ObjectId()
      participantMsg.channels = [`direct-agents-${user1._id}`, 'participant']

      const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, participantMsg)

      await validateResponse(responses)
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toMatchObject({
        type: 'moderator_submitted',
        text: 'Your message has been submitted to the moderator.',
        message: participantMsg._id.toString()
      })
      expect(responses[0].parent).toBeUndefined()
    })

    it('should parse backchannel messages to string', async () => {
      const agentMsg = new Message({
        body: submitToModeratorQuestion,
        bodyType: 'json',
        conversation: conversation._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        pseudonymId: agent.pseudonyms[0]._id
      })

      const translatedMsg = await defaultAgentTypes.eventAssistantPlus.parseOutput(agentMsg)
      expect(translatedMsg).toMatchObject({
        ...agentMsg.toObject(),
        body: submitToModeratorQuestion.text,
        bodyType: 'text'
      })
    })

    it('should parse regular messages as string', async () => {
      const agentMsg = new Message({
        body: 'A response to your thoughtful question',
        bodyType: 'text',
        conversation: conversation._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        pseudonymId: agent.pseudonyms[0]._id
      })

      const translatedMsg = await defaultAgentTypes.eventAssistantPlus.parseOutput(agentMsg)
      expect(translatedMsg).toMatchObject(agentMsg)
    })

    it(
      'should propagate parent thread when original message has a parent',
      async () => {
        const parentMessageId = new mongoose.Types.ObjectId()
        const questionMsg = await createQuestion('What percentage of U.S. workers are part-time?')
        questionMsg._id = new mongoose.Types.ObjectId()
        questionMsg.parentMessage = parentMessageId

        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, questionMsg)
        await validateResponse(responses)

        // Should have 2 responses: the answer and the moderator question
        expect(responses).toHaveLength(2)
        expect(responses[1].message).toMatchObject({
          ...submitToModeratorQuestion,
          message: questionMsg._id.toString()
        })
        // The moderator question should inherit the parent from the original message
        expect(responses[1].parent).toBe(parentMessageId)
        expect(responses[1].visible).toBe(true)
      },
      testTimeout
    )

    it('should propagate parent thread when submitting to moderator', async () => {
      const parentMessageId = new mongoose.Types.ObjectId()
      const questionMsg = await createQuestion('What is the meaning of life?')
      questionMsg.parentMessage = parentMessageId
      const savedQuestion = await Message.create(questionMsg)

      const affirmativeMsg = await createQuestion('yes')
      affirmativeMsg.parentMessage = parentMessageId
      const conversationHistory = {
        messages: [
          savedQuestion,
          { body: "I don't have enough information.", fromAgent: true },
          { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
        ]
      }

      const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, affirmativeMsg)

      await validateResponse(responses)
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toMatchObject({
        text: 'Your message has been submitted to the moderator.',
        type: 'moderator_submitted',
        message: savedQuestion._id.toString()
      })
      // The submit confirmation should inherit the parent from the affirmative message
      expect(responses[0].parent).toBe(parentMessageId)
    })

    it('should propagate parent thread when declining moderator submission', async () => {
      const parentMessageId = new mongoose.Types.ObjectId()
      const questionMsg = await createQuestion('What is the meaning of life?')
      questionMsg.parentMessage = parentMessageId
      const savedQuestion = await Message.create(questionMsg)

      const negativeMsg = await createQuestion('no')
      negativeMsg.parentMessage = parentMessageId
      const conversationHistory = {
        messages: [
          savedQuestion,
          { body: "I don't have enough information.", fromAgent: true },
          { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
        ]
      }

      const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, negativeMsg)

      await validateResponse(responses)
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toMatchObject({
        text: "OK, I won't submit it. Feel free to ask me anything else!",
        type: 'moderator_declined',
        message: savedQuestion._id.toString()
      })
      // The decline confirmation should inherit the parent from the negative message
      expect(responses[0].parent).toBe(parentMessageId)
    })
  })

  describe('evaluate function', () => {
    it(
      'does not modify message without /mod command',
      async () => {
        const msg = await createQuestion('Regular question')
        const originalChannels = [...msg.channels!]

        const result = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)

        expect(result.action).toEqual(AgentMessageActions.CONTRIBUTE)
        expect(result.userContributionVisible).toBe(true)
        expect(result.userMessage.channels).toEqual(originalChannels)
        expect(result.userMessage.channels).not.toContain('participant')
        expect(result.userMessage.body).toEqual('Regular question')
      },
      testTimeout
    )

    it(
      'initializes channels array if undefined when using /mod',
      async () => {
        const msg = await createQuestion('/mod Question')
        msg.channels = undefined

        const result = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)

        expect(result.userMessage.channels).toBeDefined()
        expect(result.userMessage.channels).toContain('participant')
      },
      testTimeout
    )
  })

  describe('chat support', () => {
    it('responds to an @<botName> message on the chat channel', async () => {
      const user2 = await createUser('Sleepy Salamander')
      const msg1 = await createMessage('What is up in this chat?', user2, conversation, ['chat'])
      const msg = await createMessage(`@${agent.agentConfig.botName} Hey, what did I miss?`, user1, conversation, ['chat'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 829 * 1000),
        count: 100,
        directMessages: true,
        channels: ['chat']
      }
      const evaluation = await defaultAgentTypes.eventAssistant.evaluate.call(agent, msg)
      expect(evaluation.action).toEqual(AgentMessageActions.CONTRIBUTE)
      const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [msg1] }, msg)
      await validateResponse(responses, 'chat')

      // Test with mention in the middle of the message
      const msg2 = await createMessage(`Hey @${agent.agentConfig.botName}, what did I miss?`, user1, conversation, ['chat'])
      const evaluation2 = await defaultAgentTypes.eventAssistant.evaluate.call(agent, msg2)
      expect(evaluation2.action).toEqual(AgentMessageActions.CONTRIBUTE)
      const responses2 = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [msg1] }, msg2)
      await validateResponse(responses2, 'chat')
    })

    it('does not respond to a regular message on the chat channel', async () => {
      const msg = await createMessage('@Sleepy Salamander Hey, what did I miss?', user1, conversation, ['chat'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 829 * 1000),
        count: 100,
        directMessages: true,
        channels: ['chat']
      }
      const evaluation = await defaultAgentTypes.eventAssistant.evaluate.call(agent, msg)
      expect(evaluation.action).toEqual(AgentMessageActions.OK)
    })
  })

  describe('mind map command', () => {
    it(
      'generates a mind map from the transcript',
      async () => {
        const msg = await createQuestion('/mindmap create a mind map of the talk')

        const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)

        agent.conversationHistorySettings = {
          endTime: new Date(startTime.getTime() + 954 * 1000),
          count: 100,
          directMessages: true,
          channels: ['chat']
        }

        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(
          agent,
          { messages: [] },
          evaluation.userMessage
        )

        await validateResponse(responses)
        expect(responses).toHaveLength(1)
        expect(responses[0].message).toBeDefined()
        expect(typeof responses[0].message).toBe('string')

        // Should contain markmap markdown in code block
        expect(responses[0].message).toMatch(/```/)

        // Should contain hierarchical markdown structure (## or ###)
        expect(responses[0].message).toMatch(/##/)

        // Should NOT contain Katex (since we removed it from the prompt)
        expect(responses[0].message).not.toMatch(/\$.*\$/)

        // Should NOT contain JavaScript code blocks (since we removed the example)
        expect(responses[0].message).not.toMatch(/```js/)
        expect(responses[0].message).not.toMatch(/console\.log/)

        // Should have context and topic metadata
        expect(responses[0].context).toBeDefined()
        expect(responses[0].topic).toBe('Test Event')

        console.log('Mind map response:', responses[0].message)
      },
      testTimeout
    )

    it(
      'includes relevant content from the transcript in the mind map',
      async () => {
        const msg = await createQuestion('/mindmap')

        agent.conversationHistorySettings = {
          endTime: new Date(startTime.getTime() + 954 * 1000),
          count: 100,
          directMessages: true,
          channels: ['chat']
        }
        const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)

        const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(
          agent,
          { messages: [] },
          evaluation.userMessage
        )

        await validateResponse(responses)

        // The mind map should reference key topics from the part-time work transcript
        const responseText = responses[0].message.toLowerCase()
        expect(responseText).toMatch(/part.?time|work|employee|business|hour/i)
      },
      testTimeout
    )

    it(
      'handles /mindmap command with various casings',
      async () => {
        const variants = ['/mindmap', '/MINDMAP', '/MindMap', '/mindMAP']

        for (const variant of variants) {
          const msg = await createQuestion(`${variant} please`)

          agent.conversationHistorySettings = {
            endTime: new Date(startTime.getTime() + 954 * 1000),
            count: 100,
            directMessages: true,
            channels: ['chat']
          }
          const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)
          const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(
            agent,
            { messages: [] },
            evaluation.userMessage
          )

          await validateResponse(responses)
          expect(responses).toHaveLength(1)
          expect(responses[0].message).toMatch(/```/)
        }
      },
      testTimeout
    )
  })

  it(
    'introduces itself on new DM channels',
    async () => {
      const [directChannel] = await Channel.create([
        { name: 'direct-new-user', direct: true, participants: [user1._id, agent._id] }
      ])
      const msgs = await agent.introduce(directChannel)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].bodyType).toBe('json')
      expect(msgs[0].body.type).toBe('intro')
      // Should contain the rendered bot name (template vars resolved)
      expect(msgs[0].body.text).toContain(agent.agentConfig.botName)
      expect(msgs[0].body.text).not.toContain('{{agentConfig.botName}}')
      // Should contain a fun fact about the pseudonym
      expect(msgs[0].body.text).toMatch(/fun fact about your pseudonym:/i)
      // Should mention the pseudonym
      expect(msgs[0].body.text.toLowerCase()).toMatch(/cat/)
      expect(msgs[0].channels).toHaveLength(1)
      expect(msgs[0].channels[0]).toEqual(directChannel)
      expect(msgs[0].visible).toBe(true)
    },
    testTimeout
  )

  it(
    'does not introduce itself on non-direct or chat channels',
    async () => {
      const [channel] = await Channel.create([{ name: 'public-channel' }])
      const msgs = await agent.introduce(channel)
      expect(msgs).toHaveLength(0)
    },
    testTimeout
  )

  it('introduces itself on chat channels', async () => {
    const [chatChannel] = await Channel.create([{ name: 'chat' }])
    const msgs = await agent.introduce(chatChannel)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].bodyType).toBe('json')
    expect(msgs[0].body.type).toBe('intro')
    // chatIntroMessage is a template — verify the bot name was rendered into it
    expect(msgs[0].body.text).toContain(`@${agent.agentConfig.botName}`)
    expect(msgs[0].body.text).not.toContain('{{agentConfig.botName}}')
    expect(msgs[0].channels).toHaveLength(1)
    expect(msgs[0].channels[0]).toEqual(chatChannel)
  })

  it('renders template vars in chatIntroMessage using agent data', async () => {
    agent.agentConfig = {
      ...agent.agentConfig,
      chatIntroMessage: 'Welcome to {{conversation.name}}!'
    }
    const [chatChannel] = await Channel.create([{ name: 'chat' }])
    const msgs = await agent.introduce(chatChannel)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].bodyType).toBe('json')
    expect(msgs[0].body.type).toBe('intro')
    expect(msgs[0].body.text).toEqual(`Welcome to ${conversation.name}!`)
  })

  // DYNAMIC BOT NAME TESTS

  describe('dynamic botName support', () => {
    it('responds to chat mention using the configured botName', async () => {
      const customBotName = 'MyCustomBot'
      agent.agentConfig = { ...agent.agentConfig, botName: customBotName }

      const msg = await createMessage(`@${customBotName} what did I miss?`, user1, conversation, ['chat'])
      const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)
      expect(evaluation.action).toEqual(AgentMessageActions.CONTRIBUTE)
    })

    it('does not respond to a chat mention of a different name when botName is customized', async () => {
      const customBotName = 'MyCustomBot'
      agent.agentConfig = { ...agent.agentConfig, botName: customBotName }

      // Message mentions the old hardcoded name, not the configured botName
      const msg = await createMessage('@Event Assistant what did I miss?', user1, conversation, ['chat'])
      const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)
      expect(evaluation.action).toEqual(AgentMessageActions.OK)
    })

    it('strips custom botName from chat message body before processing', async () => {
      const customBotName = 'MyCustomBot'
      agent.agentConfig = { ...agent.agentConfig, botName: customBotName }

      const originalBody = `@${customBotName} what did I miss?`
      const msg = await createMessage(originalBody, user1, conversation, ['chat'])

      // Simulate what respond() does — botName mention should be stripped
      const modifiedBody = (msg.body as string).trim().replaceAll(`@${agent.agentConfig.botName}`, '').trim()
      expect(modifiedBody).toBe('what did I miss?')
      expect(modifiedBody).not.toContain(customBotName)
    })

    it('responds to case-insensitive chat mentions of botName', async () => {
      const customBotName = 'MyCustomBot'
      agent.agentConfig = { ...agent.agentConfig, botName: customBotName }

      // Test lowercase mention
      const msgLower = await createMessage('@mycustombot what did I miss?', user1, conversation, ['chat'])
      const evalLower = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msgLower)
      expect(evalLower.action).toEqual(AgentMessageActions.CONTRIBUTE)

      // Test uppercase mention
      const msgUpper = await createMessage('@MYCUSTOMBOT what did I miss?', user1, conversation, ['chat'])
      const evalUpper = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msgUpper)
      expect(evalUpper.action).toEqual(AgentMessageActions.CONTRIBUTE)

      // Test mixed case mention
      const msgMixed = await createMessage('@mYcUsToMbOt what did I miss?', user1, conversation, ['chat'])
      const evalMixed = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msgMixed)
      expect(evalMixed.action).toEqual(AgentMessageActions.CONTRIBUTE)
    })

    it('strips case-insensitive botName mentions from chat message body', async () => {
      const customBotName = 'MyCustomBot'
      agent.agentConfig = { ...agent.agentConfig, botName: customBotName }

      // Test lowercase mention stripping
      const msgLower = await createMessage('@mycustombot what did I miss?', user1, conversation, ['chat'])
      agent.conversationHistorySettings = {
        endTime: new Date(startTime.getTime() + 829 * 1000),
        count: 100,
        directMessages: true,
        channels: ['chat']
      }
      const responsesLower = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msgLower)
      expect(responsesLower).toHaveLength(1)
      // The internal processing should have stripped the mention regardless of case

      // Test uppercase mention stripping
      const msgUpper = await createMessage('@MYCUSTOMBOT hey there', user1, conversation, ['chat'])
      const responsesUpper = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msgUpper)
      expect(responsesUpper).toHaveLength(1)
      // Should successfully process without the @MYCUSTOMBOT mention
    })

    it('includes custom botName in rendered DM intro message', async () => {
      const customBotName = 'MyCustomBot'
      agent.agentConfig = { ...agent.agentConfig, botName: customBotName }

      const [directChannel] = await Channel.create([
        { name: 'direct-custom-bot-plus', direct: true, participants: [user1._id, agent._id] }
      ])
      const msgs = await agent.introduce(directChannel)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].bodyType).toBe('json')
      expect(msgs[0].body.type).toBe('intro')
      expect(msgs[0].body.text).toContain(customBotName)
      expect(msgs[0].body.text).not.toContain('{{agentConfig.botName}}')
    })

    it('includes custom botName in rendered chat intro message', async () => {
      const customBotName = 'MyCustomBot'
      agent.agentConfig = { ...agent.agentConfig, botName: customBotName }

      // Channel name must be 'chat' to match the introduce() logic
      const [chatChannel] = await Channel.create([{ name: 'chat' }])
      const msgs = await agent.introduce(chatChannel)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].bodyType).toBe('json')
      expect(msgs[0].body.type).toBe('intro')
      expect(msgs[0].body.text).toContain(`@${customBotName}`)
      expect(msgs[0].body.text).not.toContain('{{agentConfig.botName}}')
    })
  })

  it(
    'includes a fun fact about the user pseudonym in DM intro',
    async () => {
      // Create a user with a clear "adjective noun" pseudonym
      const testUser = await createUser('Curious Elephant')
      const [directChannel] = await Channel.create([
        { name: 'direct-test-pseudonym', direct: true, participants: [testUser._id, agent._id] }
      ])
      const msgs = await agent.introduce(directChannel)

      expect(msgs).toHaveLength(1)
      expect(msgs[0].bodyType).toBe('json')
      expect(msgs[0].body.type).toBe('intro')
      const introMessage = msgs[0].body.text

      // Should contain the rendered bot name (template vars resolved)
      expect(introMessage).toContain(agent.agentConfig.botName)
      expect(introMessage).not.toContain('{{agentConfig.botName}}')

      // Should have the fun fact header
      expect(introMessage).toMatch(/fun fact about your pseudonym:/i)

      // Should mention "elephant" (the noun part) in the fun fact
      expect(introMessage.toLowerCase()).toContain('elephant')

      // The fun fact should be factual about elephants
      // We can't predict exact LLM output, but it should be substantive (more than just the header)
      const funFactPart = introMessage.split(/fun fact about your pseudonym:/i)[1]
      expect(funFactPart.length).toBeGreaterThan(20) // Should be at least 1-2 sentences
    },
    testTimeout
  )
})

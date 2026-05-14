/* eslint-disable no-console */
import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createDirectMessage,
  createUser,
  loadPartTimeWorkTranscript,
  createPublicTopic,
  createEventAssistantWithModSupportConversation
} from '../../utils/agentTestHelpers.js'
import Message from '../../../src/models/message.model.js'
import Channel from '../../../src/models/channel.model.js'
import { AgentMessageActions } from '../../../src/types/index.types.js'
import Agent from '../../../src/models/user.model/agent.model/index.js'
import { QuestionClassification } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('eventAssistant')

const submitToModeratorQuestion = {
  text: 'Would you like to submit this question anonymously to the moderator for Q&A?',
  type: 'moderator_offered'
}

const testTimeout = 120000

describe('eventAssistant moderator support tests', () => {
  let agent
  let conversation
  let user1
  let topic
  const startTime = new Date(Date.now() - 15 * 60 * 1000)

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
    conversation = await createEventAssistantWithModSupportConversation(
      {
        name: 'Test Event',
        description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise—instead it's that businesses aren't structuring jobs to attract and retain the widest number of people possible, including those with a limited number of hours to give to a career.
Speaking about her own experience as a single mother and professional, Jessica delineates how she's grown a seven-figure business in part-time hours with a small team of part-time employees, and how recent research shows that jobs with lower hour requirements improve employee recruitment, retention, and productivity – not the other way around.`,
        presenters: [
          {
            name: 'Jessica Drain',
            bio: `A career marketer and graphic designer, Jessica has helped businesses brand and market themselves for almost two decades. In 2018, she and her sister innovated a new tool for the sewing world – SewTites® Magnetic Sewing Pins™ – and founded a company with the same name.
Since then, Jessica has led the company to a 7-figure annual business – all in part-time hours with a small team of part-time employees. A single mom of two children with primary custody, she is passionate about finding value in and creating work for people who don't have the desire or ability to work full-time hours but still want and need to earn a living.`
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
    ;[agent] = conversation.agents
    await loadPartTimeWorkTranscript(conversation, true)
  })

  async function createQuestion(body) {
    console.log(`Q: ${body}`)
    return createDirectMessage(body, user1, conversation)
  }

  describe('moderator offer on on_topic_ask_speaker questions', () => {
    it(
      'offers to submit to moderator for a speaker-directed question',
      async () => {
        const questionMsg = await createQuestion(
          'What does Jessica think is the biggest misconception businesses have about part-time employees?'
        )
        const savedQuestion = await Message.create(questionMsg)

        const responses = await defaultAgentTypes.eventAssistant.respond.call(
          agent,
          { messages: [] },
          savedQuestion.toObject()
        )

        const offer = responses.find((r) => r.message?.type === 'moderator_offered')
        if (responses[0].classification === QuestionClassification.ON_TOPIC_ASK_SPEAKER) {
          expect(offer).toBeDefined()
          expect(offer!.message).toMatchObject({
            ...submitToModeratorQuestion,
            message: savedQuestion._id.toString()
          })
          expect(offer!.replyFormat).toMatchObject({
            type: 'singleChoice',
            options: [
              { value: 'no', label: 'No' },
              { value: 'yes', label: 'Yes' }
            ]
          })
          expect(offer!.visible).toBe(true)
        }
      },
      testTimeout
    )
  })

  describe('submit to moderator functionality', () => {
    it(
      'should submit to moderator when user responds with yes',
      async () => {
        const questionMsg = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(questionMsg)

        const affirmativeMsg = await createQuestion('yes')
        const conversationHistory = {
          messages: [
            savedQuestion,
            { body: "I don't have enough information.", bodyType: 'text', fromAgent: true },
            { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, conversationHistory, affirmativeMsg)

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
      },
      testTimeout
    )

    it(
      'should decline submission when user responds with no',
      async () => {
        const questionMsg = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(questionMsg)

        const negativeMsg = await createQuestion('no')
        const conversationHistory = {
          messages: [
            savedQuestion,
            { body: "I don't have enough information.", bodyType: 'text', fromAgent: true },
            { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, conversationHistory, negativeMsg)

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
      },
      testTimeout
    )

    it(
      'should submit to moderator for various affirmative responses',
      async () => {
        const affirmativeVariants = ['yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'absolutely', 'definitely']

        for (const variant of affirmativeVariants) {
          const questionMsg = await createQuestion('What is the meaning of life?')
          const savedQuestion = await Message.create(questionMsg)
          const affirmativeMsg = await createQuestion(variant)
          const conversationHistory = {
            messages: [
              savedQuestion,
              { body: "I don't have enough information.", bodyType: 'text', fromAgent: true },
              { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
            ]
          }

          const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, conversationHistory, affirmativeMsg)
          await validateResponse(responses)
          expect(responses).toHaveLength(1)
          expect(responses[0].message).toMatchObject({
            text: 'Your message has been submitted to the moderator.',
            type: 'moderator_submitted',
            message: savedQuestion._id.toString()
          })
        }
      },
      testTimeout
    )

    it(
      'should decline submission for various negative responses',
      async () => {
        const negativeVariants = ['no', 'nope', 'nah', 'no thanks', "don't", 'never mind']

        for (const variant of negativeVariants) {
          const questionMsg = await createQuestion('What is the meaning of life?')
          const savedQuestion = await Message.create(questionMsg)
          const negativeMsg = await createQuestion(variant)
          const conversationHistory = {
            messages: [
              savedQuestion,
              { body: "I don't have enough information.", bodyType: 'text', fromAgent: true },
              { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
            ]
          }

          const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, conversationHistory, negativeMsg)
          await validateResponse(responses)
          expect(responses).toHaveLength(1)
          expect(responses[0].message).toMatchObject({
            type: 'moderator_declined',
            text: "OK, I won't submit it. Feel free to ask me anything else!",
            message: savedQuestion._id.toString()
          })
        }
      },
      testTimeout
    )

    it(
      'falls through to answer question when user ignores submit prompt',
      async () => {
        const questionMsg = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(questionMsg)

        const newQuestion = await createQuestion("What was the speaker's main point?")
        const savedNewQuestion = await Message.create(newQuestion)
        const conversationHistory = {
          messages: [
            savedQuestion,
            { body: "I don't have enough information.", bodyType: 'text', fromAgent: true },
            {
              body: {
                message: savedQuestion._id.toString(),
                text: submitToModeratorQuestion.text,
                type: 'moderator_offered'
              },
              bodyType: 'json',
              fromAgent: true
            }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(
          agent,
          conversationHistory,
          savedNewQuestion.toObject()
        )

        // Should have answered the new question, not returned empty
        expect(responses.length).toBeGreaterThan(0)
        expect(responses[0].message?.type).not.toBe('moderator_declined')
        expect(responses[0].message?.type).not.toBe('moderator_submitted')

        const updatedMessage = await Message.findById(savedQuestion._id)
        expect(updatedMessage!.channels).not.toContain('participant')
      },
      testTimeout
    )

    it(
      'should propagate parent thread when submitting to moderator',
      async () => {
        const parentMessageId = new mongoose.Types.ObjectId()
        const questionMsg = await createQuestion('What is the meaning of life?')
        questionMsg.parentMessage = parentMessageId
        const savedQuestion = await Message.create(questionMsg)

        const affirmativeMsg = await createQuestion('yes')
        affirmativeMsg.parentMessage = parentMessageId
        const conversationHistory = {
          messages: [
            savedQuestion,
            { body: "I don't have enough information.", bodyType: 'text', fromAgent: true },
            { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, conversationHistory, affirmativeMsg)

        expect(responses).toHaveLength(1)
        expect(responses[0].message).toMatchObject({
          text: 'Your message has been submitted to the moderator.',
          type: 'moderator_submitted',
          message: savedQuestion._id.toString()
        })
        expect(responses[0].parent).toBe(parentMessageId)
      },
      testTimeout
    )

    it(
      'should propagate parent thread when declining moderator submission',
      async () => {
        const parentMessageId = new mongoose.Types.ObjectId()
        const questionMsg = await createQuestion('What is the meaning of life?')
        questionMsg.parentMessage = parentMessageId
        const savedQuestion = await Message.create(questionMsg)

        const negativeMsg = await createQuestion('no')
        negativeMsg.parentMessage = parentMessageId
        const conversationHistory = {
          messages: [
            savedQuestion,
            { body: "I don't have enough information.", bodyType: 'text', fromAgent: true },
            { body: { ...submitToModeratorQuestion, message: savedQuestion._id }, bodyType: 'json', fromAgent: true }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, conversationHistory, negativeMsg)

        expect(responses).toHaveLength(1)
        expect(responses[0].message).toMatchObject({
          type: 'moderator_declined',
          text: "OK, I won't submit it. Feel free to ask me anything else!",
          message: savedQuestion._id.toString()
        })
        expect(responses[0].parent).toBe(parentMessageId)
      },
      testTimeout
    )
  })

  describe('moderator history filtering', () => {
    it(
      'LLM does not spontaneously offer moderator submission when prior moderator_offered messages are in history',
      async () => {
        const priorQuestion = await createQuestion('What percentage of U.S. workers are part-time?')
        const savedPriorQuestion = await Message.create(priorQuestion)

        const newQuestion = await createQuestion("What was Jessica's main argument?")
        const savedNewQuestion = await Message.create(newQuestion)

        const conversationHistory = {
          messages: [
            savedPriorQuestion,
            {
              body: 'According to the transcript, approximately 20% of workers are part-time.',
              bodyType: 'text',
              fromAgent: true
            },
            {
              body: { ...submitToModeratorQuestion, message: savedPriorQuestion._id.toString() },
              bodyType: 'json',
              fromAgent: true
            }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(
          agent,
          conversationHistory,
          savedNewQuestion.toObject()
        )

        expect(responses.length).toBeGreaterThan(0)
        const answerText = responses[0].message?.text ?? responses[0].message
        expect(answerText).not.toMatch(/submit.*moderator|moderator.*Q&A|anonymously/i)
      },
      testTimeout
    )

    it(
      'LLM answers normally when history contains a full moderator offer/accept exchange',
      async () => {
        const priorQuestion = await createQuestion('What percentage of U.S. workers are part-time?')
        const savedPriorQuestion = await Message.create(priorQuestion)

        const newQuestion = await createQuestion("What was Jessica's main argument?")
        const savedNewQuestion = await Message.create(newQuestion)

        const conversationHistory = {
          messages: [
            savedPriorQuestion,
            {
              body: 'According to the transcript, approximately 20% of workers are part-time.',
              bodyType: 'text',
              fromAgent: true
            },
            {
              body: { ...submitToModeratorQuestion, message: savedPriorQuestion._id.toString() },
              bodyType: 'json',
              fromAgent: true
            },
            { body: 'yes', bodyType: 'text', fromAgent: false },
            {
              body: {
                type: 'moderator_submitted',
                text: 'Your message has been submitted to the moderator.',
                message: savedPriorQuestion._id.toString()
              },
              bodyType: 'json',
              fromAgent: true
            }
          ]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(
          agent,
          conversationHistory,
          savedNewQuestion.toObject()
        )

        expect(responses.length).toBeGreaterThan(0)
        const answerText = responses[0].message?.text ?? responses[0].message
        expect(answerText).not.toMatch(/submit.*moderator|moderator.*Q&A|anonymously/i)
        // Should be a substantive answer, not empty or an error
        expect(typeof answerText).toBe('string')
        expect((answerText as string).length).toBeGreaterThan(10)
      },
      testTimeout
    )
  })

  describe('/mod command', () => {
    it(
      'should handle /mod command in evaluate',
      async () => {
        const modMsg = await createQuestion('/mod This is urgent')

        const evaluation = await defaultAgentTypes.eventAssistant.evaluate.call(agent, modMsg)

        expect(evaluation.userMessage.body).toEqual({ command: 'mod', text: 'This is urgent' })
        expect(evaluation.userMessage.bodyType).toBe('json')
        expect(evaluation.userMessage.channels).toContain('participant')
        expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
      },
      testTimeout
    )

    it(
      'should return moderator submission message for participant channel messages',
      async () => {
        const participantMsg = await createQuestion('Question from user')
        participantMsg._id = new mongoose.Types.ObjectId()
        participantMsg.channels = [`direct-agents-${user1._id}`, 'participant']

        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, participantMsg)

        await validateResponse(responses)
        expect(responses).toHaveLength(1)
        expect(responses[0].message).toMatchObject({
          type: 'moderator_submitted',
          text: 'Your message has been submitted to the moderator.',
          message: participantMsg._id.toString()
        })
        expect(responses[0].parent).toBeUndefined()
      },
      testTimeout
    )
  })

  describe('moderatorSupport disabled', () => {
    let agentWithoutModSupport

    beforeEach(() => {
      // Clone the agent but without moderatorSupport config
      agentWithoutModSupport = new Agent({
        agentType: 'eventAssistant',
        conversation,
        llmPlatform: agent.llmPlatform,
        llmModel: agent.llmModel,
        agentConfig: { moderatorSupport: undefined }
      })
      agentWithoutModSupport.save()

      agentWithoutModSupport.conversation = conversation
    })

    it(
      'does not route /mod command to participant channel when moderatorSupport is disabled',
      async () => {
        const modMsg = await createQuestion('/mod This is urgent')
        const originalChannels = [...(modMsg.channels || [])]

        const evaluation = await defaultAgentTypes.eventAssistant.evaluate.call(agentWithoutModSupport, modMsg)

        expect(evaluation.userMessage.channels).toEqual(originalChannels)
        expect(evaluation.userMessage.channels).not.toContain('participant')
      },
      testTimeout
    )

    it(
      'does not submit to moderator for participant channel messages when moderatorSupport is disabled',
      async () => {
        const participantMsg = await createQuestion('Question from user')
        participantMsg.channels = [`direct-agents-${user1._id}`, 'participant']

        const responses = await defaultAgentTypes.eventAssistant.respond.call(
          agentWithoutModSupport,
          { messages: [] },
          participantMsg
        )

        // No moderator_submitted response — falls through to normal answer
        const submitted = responses.find((r) => r.message?.type === 'moderator_submitted')
        expect(submitted).toBeUndefined()
      },
      testTimeout
    )
  })

  describe('introduce with zoom adapter', () => {
    it('appends /mod hint to zoom DM intro when moderatorSupport is enabled', async () => {
      const [directChannel] = await Channel.create([
        { name: 'direct-zoom-mod', direct: true, participants: [user1._id, agent._id] }
      ])
      const msgs = await agent.introduce(directChannel, 'zoom')
      expect(msgs).toHaveLength(1)
      expect(msgs[0].bodyType).toBe('json')
      expect(msgs[0].body.type).toBe('intro')
      expect(msgs[0].body.text).toContain('/mod')
      expect(msgs[0].body.text).toContain('moderator')
    })

    it('does not include fun fact in zoom DM intro', async () => {
      const [directChannel] = await Channel.create([
        { name: 'direct-zoom-mod-nofact', direct: true, participants: [user1._id, agent._id] }
      ])
      const msgs = await agent.introduce(directChannel, 'zoom')
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body.text).not.toMatch(/fun fact about your pseudonym:/i)
    })
  })

  describe('parseOutput', () => {
    it('transforms moderator JSON messages into plain text', async () => {
      const agentMsg = new Message({
        body: submitToModeratorQuestion,
        bodyType: 'json',
        conversation: conversation._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        pseudonymId: agent.pseudonyms[0]._id
      })

      const translatedMsg = await defaultAgentTypes.eventAssistant.parseOutput(agentMsg)
      expect(translatedMsg).toMatchObject({
        ...agentMsg.toObject(),
        body: submitToModeratorQuestion.text,
        bodyType: 'text'
      })
    })

    it('passes text messages through unchanged', async () => {
      const agentMsg = new Message({
        body: 'A response to your thoughtful question',
        bodyType: 'text',
        conversation: conversation._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        pseudonymId: agent.pseudonyms[0]._id
      })

      const translatedMsg = await defaultAgentTypes.eventAssistant.parseOutput(agentMsg)
      expect(translatedMsg).toMatchObject(agentMsg)
    })
  })
})

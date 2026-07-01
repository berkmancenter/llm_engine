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

  describe('moderator suggested flag', () => {
    it(
      'suggests submitting to moderator for ask speaker classification',
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

        expect(responses.length).toBeGreaterThan(0)
        expect(responses[0].classification).toBeDefined()
        const offer = responses.find((r) => r.message?.type === 'moderator_offered')
        expect(offer).toBeUndefined()
        // moderatorSuggested flag set on message body when classification warrants it
        if (responses[0].classification === QuestionClassification.ON_TOPIC_ASK_SPEAKER) {
          expect(responses[0].message.moderatorSuggested).toBe(true)
          expect(responses[0].message.message).toBe(savedQuestion._id.toString())
        }
      },
      testTimeout
    )

    it(
      'does not set moderatorSuggested when moderatorSupport is disabled',
      async () => {
        const agentWithoutModSupport = new Agent({
          agentType: 'eventAssistant',
          conversation,
          llmPlatform: agent.llmPlatform,
          llmModel: agent.llmModel,
          agentConfig: { moderatorSupport: undefined }
        })
        await agentWithoutModSupport.save()
        agentWithoutModSupport.conversation = conversation

        const questionMsg = await createQuestion(
          'What does Jessica think is the biggest misconception businesses have about part-time employees?'
        )
        const savedQuestion = await Message.create(questionMsg)

        const responses = await defaultAgentTypes.eventAssistant.respond.call(
          agentWithoutModSupport,
          { messages: [] },
          savedQuestion.toObject()
        )

        expect(responses.length).toBeGreaterThan(0)
        expect(responses[0].message.moderatorSuggested).toBeUndefined()
      },
      testTimeout
    )
  })

  describe('moderator history filtering', () => {
    it(
      '/mod command messages and moderator_submitted replies are filtered from LLM history so they do not appear as unanswered questions',
      async () => {
        const modQuestion = await createQuestion('/mod What is the return on investment for part-time staffing?')
        modQuestion.bodyType = 'json'
        modQuestion.body = { command: 'mod', text: 'What is the return on investment for part-time staffing?' }
        const savedModQuestion = await Message.create(modQuestion)

        const followUp = await createQuestion("What was Jessica's main argument?")
        const savedFollowUp = await Message.create(followUp)

        const moderatorSubmittedReply = {
          body: {
            type: 'moderator_submitted',
            text: 'Your message has been submitted to the moderator.',
            message: savedModQuestion._id.toString()
          },
          bodyType: 'json',
          fromAgent: true
        }

        const conversationHistory = {
          messages: [savedModQuestion, moderatorSubmittedReply]
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(
          agent,
          conversationHistory,
          savedFollowUp.toObject()
        )

        // Should answer only the follow-up — not attempt to also answer the /mod question
        expect(responses.length).toBeGreaterThan(0)
        const answerText = responses[0].message?.text ?? responses[0].message
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

  describe('/escalate command', () => {
    it(
      'should handle /escalate command in evaluate',
      async () => {
        const originalQuestion = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(originalQuestion)

        const escalateMsg = await createQuestion(`/escalate ${savedQuestion._id}`)

        const evaluation = await defaultAgentTypes.eventAssistant.evaluate.call(agent, escalateMsg)

        expect(evaluation.userMessage.body).toEqual({ command: 'escalate', text: savedQuestion._id.toString() })
        expect(evaluation.userMessage.bodyType).toBe('json')
        expect(evaluation.action).toBe(AgentMessageActions.CONTRIBUTE)
      },
      testTimeout
    )

    it(
      'should add participant channel to original message and return moderator submission response',
      async () => {
        const originalQuestion = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(originalQuestion)

        const escalateMsg = await createQuestion(`/escalate ${savedQuestion._id}`)
        const savedEscalate = await Message.create(escalateMsg)
        const parsedEscalate = {
          ...savedEscalate.toObject(),
          body: { command: 'escalate', text: savedQuestion._id.toString() },
          bodyType: 'json'
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, parsedEscalate)

        await validateResponse(responses)
        expect(responses).toHaveLength(1)
        expect(responses[0].message).toMatchObject({
          type: 'moderator_submitted',
          text: 'Your message has been submitted to the moderator.',
          message: savedQuestion._id.toString()
        })

        const updatedQuestion = await Message.findById(savedQuestion._id)
        expect(updatedQuestion!.channels).toContain('participant')
      },
      testTimeout
    )

    it(
      'should return empty response when original message cannot be found',
      async () => {
        const nonExistentId = new mongoose.Types.ObjectId()
        const escalateMsg = await createQuestion(`/escalate ${nonExistentId}`)
        const savedEscalate = await Message.create(escalateMsg)
        const parsedEscalate = {
          ...savedEscalate.toObject(),
          body: { command: 'escalate', text: nonExistentId.toString() },
          bodyType: 'json'
        }

        const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, parsedEscalate)

        expect(responses).toHaveLength(0)
      },
      testTimeout
    )

    it(
      'does not add participant channel twice if already escalated',
      async () => {
        const originalQuestion = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(originalQuestion)
        savedQuestion.channels = [...(savedQuestion.channels ?? []), 'participant']
        await savedQuestion.save()

        const escalateMsg = await createQuestion(`/escalate ${savedQuestion._id}`)
        const savedEscalate = await Message.create(escalateMsg)
        const parsedEscalate = {
          ...savedEscalate.toObject(),
          body: { command: 'escalate', text: savedQuestion._id.toString() },
          bodyType: 'json'
        }

        await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, parsedEscalate)

        const updatedQuestion = await Message.findById(savedQuestion._id)
        const participantCount = (updatedQuestion!.channels ?? []).filter((c) => c === 'participant').length
        expect(participantCount).toBe(1)
      },
      testTimeout
    )

    it(
      'does not route /escalate command when moderatorSupport is disabled',
      async () => {
        const agentWithoutModSupport = new Agent({
          agentType: 'eventAssistant',
          conversation,
          llmPlatform: agent.llmPlatform,
          llmModel: agent.llmModel,
          agentConfig: { moderatorSupport: undefined }
        })
        await agentWithoutModSupport.save()
        agentWithoutModSupport.conversation = conversation

        const originalQuestion = await createQuestion('What is the meaning of life?')
        const savedQuestion = await Message.create(originalQuestion)

        const escalateMsg = await createQuestion(`/escalate ${savedQuestion._id}`)
        const evaluation = await defaultAgentTypes.eventAssistant.evaluate.call(agentWithoutModSupport, escalateMsg)

        // /escalate is not in the active commands when moderatorSupport is disabled,
        // so the message body should be unparsed plain text
        expect(evaluation.userMessage.bodyType).not.toBe('json')

        const updatedQuestion = await Message.findById(savedQuestion._id)
        expect(updatedQuestion!.channels).not.toContain('participant')
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
      expect(msgs[0].messageType).toBe('json')
      expect(msgs[0].message.type).toBe('intro')
      expect(msgs[0].message.text).toContain('/mod')
      expect(msgs[0].message.text).toContain('moderator')
    })

    it('does not include fun fact in zoom DM intro', async () => {
      const [directChannel] = await Channel.create([
        { name: 'direct-zoom-mod-nofact', direct: true, participants: [user1._id, agent._id] }
      ])
      const msgs = await agent.introduce(directChannel, 'zoom')
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message.text).not.toMatch(/fun fact about your pseudonym:/i)
    })
  })

  describe('parseOutput', () => {
    it('transforms moderator_submitted JSON message into plain text', async () => {
      const agentMsg = new Message({
        body: { type: 'moderator_submitted', text: 'Your message has been submitted to the moderator.' },
        bodyType: 'json',
        conversation: conversation._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        pseudonymId: agent.pseudonyms[0]._id
      })

      const translatedMsg = await defaultAgentTypes.eventAssistant.parseOutput(agentMsg)
      expect(translatedMsg).toMatchObject({
        ...agentMsg.toObject(),
        body: 'Your message has been submitted to the moderator.',
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

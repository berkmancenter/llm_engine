/* eslint-disable no-console */
import * as ls from 'langsmith/jest'
import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createDirectMessage,
  createUser,
  loadPartTimeWorkTranscript,
  createPublicTopic,
  createEventAssistantPlusConversation
} from '../../utils/agentTestHelpers.js'
import Channel from '../../../src/models/channel.model.js'
import Message from '../../../src/models/message.model.js'
import { AgentMessageActions } from '../../../src/types/index.types.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('eventAssistantPlus')

const submitToModeratorQuestion = {
  text: 'Would you like to submit this question anonymously to the moderator for Q&A?',
  type: 'backchannel'
}

const testTimeout = 120000

ls.describe(
  `event assistant plus tests`,
  () => {
    let agent
    let conversation
    let user1
    let topic
    const startTime = new Date(Date.now() - 15 * 60 * 1000) // The whole event started 15 minutes ago

    async function validateResponse(responses) {
      expect(responses).not.toHaveLength(0)
      expect(responses[0].message).toBeDefined()
      console.log(`A: ${responses[0].message}`)
      expect(responses[0].channels).toHaveLength(1)
      expect(responses[0].channels[0].name).toEqual(`direct-agents-${user1._id}`)
    }

    beforeEach(async () => {
      user1 = await createUser('John Hancock')

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
          expect(responses[0].messageType).not.toEqual('json')
          expect(responses[0].message).not.toEqual(submitToModeratorQuestion.text)
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
          expect(responses[0].messageType).not.toEqual('json')
          expect(responses[0].message).not.toEqual(submitToModeratorQuestion.text)
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
          expect(responses[0].messageType).not.toEqual('json')
          expect(responses[0].message).not.toEqual(submitToModeratorQuestion.text)
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
          expect(responses[0].messageType).not.toEqual('json')
          expect(responses[0].message).not.toEqual(submitToModeratorQuestion.text)
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
          expect(responses[0].messageType).not.toEqual('json')
          expect(responses[0].message).not.toEqual(submitToModeratorQuestion.text)
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
          type: 'backchannel',
          message: savedQuestion._id.toString()
        })

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
          type: 'backchannel',
          text: "OK, I won't submit it. Feel free to ask me anything else!",
          message: savedQuestion._id.toString()
        })

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

          const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(
            agent,
            conversationHistory,
            affirmativeMsg
          )

          await validateResponse(responses)
          expect(responses).toHaveLength(1)
          expect(responses[0].message).toMatchObject({
            text: 'Your message has been submitted to the moderator.',
            type: 'backchannel',
            message: savedQuestion._id.toString()
          })
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
            type: 'backchannel',
            message: savedQuestion._id.toString()
          })
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
        expect(responses[0].messageType).not.toBe('json')

        const updatedMessage = await Message.findById(savedQuestion._id)
        expect(updatedMessage!.channels).not.toContain('participant')
      })

      it('should handle /mod command in evaluate', async () => {
        const modMsg = await createQuestion('/mod This is urgent')

        const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, modMsg)

        expect(evaluation.userMessage.body).toBe('This is urgent')
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
          type: 'backchannel',
          text: 'Your message has been submitted to the moderator.',
          message: participantMsg._id.toString()
        })
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

    it(
      'introduces itself on new DM channels',
      async () => {
        const [directChannel] = await Channel.create([
          { name: 'direct-new-user', direct: true, participants: [user1._id, agent._id] }
        ])
        const msgs = await agent.introduce(directChannel)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].body).toEqual(agent.agentConfig.introMessage)
        expect(msgs[0].channels).toHaveLength(1)
        expect(msgs[0].channels[0]).toEqual(directChannel)
        expect(msgs[0].visible).toBe(true)
      },
      testTimeout
    )

    it(
      'does not introduce itself on non-direct channels',
      async () => {
        const [channel] = await Channel.create([{ name: 'public-channel' }])
        const msgs = await agent.introduce(channel)
        expect(msgs).toHaveLength(0)
      },
      testTimeout
    )
  },
  { metadata: testConfig }
)

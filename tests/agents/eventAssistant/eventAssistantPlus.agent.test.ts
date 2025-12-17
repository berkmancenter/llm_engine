/* eslint-disable no-console */
import * as ls from 'langsmith/jest'
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

const submitToModeratorQuestion = 'Would you like to submit this question anonymously to the moderator for Q&A?'
const submitToModeratorReply = 'Your message has been submitted to the moderator.'

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

    beforeAll(async () => {
      user1 = await createUser('John Hancock')

      topic = await createPublicTopic()
      conversation = await createEventAssistantPlusConversation(
        { name: 'Test Event' },
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

    describe('submit to moderator functionality', () => {
      it(
        'asks if user wants to submit on-topic question to moderator',
        async () => {
          const msg = await createQuestion('What did the speaker say about part-time work?')

          const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)

          // Should have 2 responses: the answer and the moderator question
          await validateResponse(responses)
          expect(responses).toHaveLength(2)
          expect(responses[1].message).toEqual(submitToModeratorQuestion)
        },
        testTimeout
      )

      it(
        'does not ask about submitting for off-topic questions',
        async () => {
          const msg = await createQuestion('What is the weather like today?')

          const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, { messages: [] }, msg)
          await validateResponse(responses)

          // Should only have 1 response: the "cannot answer" message
          expect(responses).toHaveLength(1)
        },
        testTimeout
      )

      it(
        'submits question to moderator when user responds affirmatively',
        async () => {
          // First, ask a question
          const questionMsg = await createQuestion('What did the speaker say about flexibility?')
          const savedQuestion = await Message.create(questionMsg)

          // Now respond with affirmative
          const affirmativeMsg = await createQuestion('yes')
          const conversationHistory = {
            messages: [savedQuestion, { body: 'Here is an answer' }, { body: submitToModeratorQuestion }]
          }

          const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(
            agent,
            conversationHistory,
            affirmativeMsg
          )

          // Should have 1 response confirming submission
          expect(responses).toHaveLength(1)
          expect(responses[0][0].message).toEqual(submitToModeratorReply)

          // Verify the original question was updated with 'participant' channel
          const updatedQuestion = await Message.findById(savedQuestion._id)
          expect(updatedQuestion!.channels).toContain('participant')
        },
        testTimeout
      )

      it(
        'handles various affirmative responses',
        async () => {
          const affirmativeResponses = [
            'yes',
            'yeah',
            'yep',
            'yup',
            'sure',
            'okay',
            'ok',
            'absolutely',
            'definitely',
            'certainly',
            'affirmative',
            'correct',
            'right',
            'indeed',
            'of course',
            'you bet',
            'sounds good'
          ]

          for (const affirmative of affirmativeResponses) {
            // Setup: ask a question first
            const questionMsg = await createQuestion('What was discussed about hiring?')
            const savedQuestion = await Message.create(questionMsg)

            // Test affirmative response
            const affirmativeMsg = await createQuestion(affirmative)
            const conversationHistory = {
              messages: [savedQuestion, { body: 'Here is an answer' }, { body: submitToModeratorQuestion }]
            }

            const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(
              agent,
              conversationHistory,
              affirmativeMsg
            )

            expect(responses).toHaveLength(1)
            expect(responses[0][0].message).toEqual(submitToModeratorReply)
          }
        },
        testTimeout
      )

      it(
        'does not submit when user responds negatively',
        async () => {
          // Setup: ask a question first
          const questionMsg = await createQuestion('Tell me about the speaker')
          const savedQuestion = await Message.create(questionMsg)

          // Respond negatively
          const negativeMsg = await createQuestion('no')
          const conversationHistory = {
            messages: [savedQuestion, { body: 'Here is an answer' }, { body: submitToModeratorQuestion }]
          }

          const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(agent, conversationHistory, negativeMsg)

          // Should return empty array (no response)
          expect(responses).toHaveLength(0)

          // Verify the original question was NOT updated
          const updatedQuestion = await Message.findById(savedQuestion._id)
          expect(updatedQuestion!.channels).not.toContain('participant')
        },
        testTimeout
      )

      it(
        'submits question immediately when using /mod command',
        async () => {
          const msg = await createQuestion('/mod What are the benefits of part-time work?')

          // First, evaluate should add 'participant' channel
          const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)
          expect(evaluation.userMessage.channels).toHaveLength(2)
          expect(evaluation.userMessage.channels).toContain('participant')
          expect(evaluation.userMessage.body).toEqual('What are the benefits of part-time work?')
          expect(evaluation.action).toEqual(AgentMessageActions.CONTRIBUTE)
          expect(evaluation.userContributionVisible).toBe(true)

          // Then respond should confirm submission
          const responses = await defaultAgentTypes.eventAssistantPlus.respond.call(
            agent,
            { messages: [] },
            evaluation.userMessage
          )

          expect(responses).toHaveLength(1)
          expect(responses[0][0].message).toEqual(submitToModeratorReply)
        },
        testTimeout
      )

      it(
        'handles /mod command with various cases and whitespace',
        async () => {
          const commands = [
            '/mod question here',
            '/MOD question here',
            '/Mod question here',
            '  /mod question here',
            '/mod   question here'
          ]

          for (const command of commands) {
            const msg = await createQuestion(command)
            const evaluation = await defaultAgentTypes.eventAssistantPlus.evaluate.call(agent, msg)
            expect(evaluation.userMessage.channels).toContain('participant')
          }
        },
        testTimeout
      )
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

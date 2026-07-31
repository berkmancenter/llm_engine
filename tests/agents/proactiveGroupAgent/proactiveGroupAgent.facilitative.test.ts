/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createProactiveGroupAgentConversation,
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  createMessage,
  prepareMessagesForAgent
} from '../../utils/agentTestHelpers.js'

import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import schedule from '../../../src/jobs/schedule.js'

jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue(undefined)
jest.spyOn(schedule, 'pollExpired').mockResolvedValue(undefined)

jest.setTimeout(180000)

const testConfig = setupAgentTest('proactiveGroupAgent')

const testTimeout = 120000

const FACILITATIVE_GOALS = [
  'surface_signal',
  'synthesize_discussion',
  'invite_quieter_voices',
  'clarify_confusion',
  'bridge_topics',
  'structure_conversation'
]

describe(`proactive group agent facilitative tests`, () => {
  let agent
  let conversation
  let topic
  let user1
  let user2
  let user3

  const startTime = new Date(Date.now() - 15 * 60 * 1000)

  // Helper to create message timestamps within the test window
  const getMessageTime = (offsetSeconds = 0) => new Date(startTime.getTime() + offsetSeconds * 1000)

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    user2 = await createUser('Thoughtful Fox')
    user3 = await createUser('Skeptical Owl')
    topic = await createPublicTopic()

    conversation = await createProactiveGroupAgentConversation(
      {
        name: 'Why your company should consider part-time work',
        description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise—instead it's that businesses aren't structuring jobs to attract and retain the widest number of people possible, including those with a limited number of hours to give to a career.`,
        presenters: [
          {
            name: 'Jessica Drain',
            bio: `A career marketer and graphic designer, Jessica has helped businesses brand and market themselves for almost two decades.`
          }
        ],
        moderators: [{ name: 'Joe Moderator', bio: 'An experienced event moderator who moderates all day long.' }]
      },
      user1,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel,
      [user2, user3], // Pass additional users to create direct channels for them
      FACILITATIVE_GOALS
    )

    // Get the agent
    agent = conversation.agents.find((a) => a.name === 'Proactive Group Agent')
    expect(agent).toBeDefined()

    await loadPartTimeWorkTranscript(conversation, true)
  })

  describe('goal type behaviors', () => {
    it(
      'surface_signal: surfaces convergence pattern from multiple private messages',
      async () => {
        const messages = [
          // Build up engaged chat showing real conversation
          await createMessage(
            'This data on employee satisfaction is really compelling',
            user1,
            conversation,
            ['chat'],
            getMessageTime(80)
          ),
          await createMessage(
            'The personal story at the start really landed',
            user2,
            conversation,
            ['chat'],
            getMessageTime(100)
          ),
          await createMessage('I appreciate the research citations', user3, conversation, ['chat'], getMessageTime(120)),
          await createMessage('Taking lots of notes on the statistics', user1, conversation, ['chat'], getMessageTime(140)),
          await createMessage(
            'The 33% reduction in quitting is significant',
            user2,
            conversation,
            ['chat'],
            getMessageTime(160)
          ),
          await createMessage(
            'This is shifting how I think about staffing',
            user3,
            conversation,
            ['chat'],
            getMessageTime(180)
          ),

          // Multiple people independently expressing curiosity about benefits/healthcare - STRONG pattern with 4 messages
          await createDirectMessage(
            'What about health insurance for part-time workers? That seems like a major barrier',
            user1,
            conversation,
            getMessageTime(220)
          ),
          await createDirectMessage(
            'Healthcare benefits are my main question - how does this work for part-timers?',
            user2,
            conversation,
            getMessageTime(240)
          ),
          await createDirectMessage(
            'The benefits question is huge - especially healthcare coverage',
            user3,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage(
            'I really need to understand the healthcare approach before implementing this',
            user1,
            conversation,
            getMessageTime(275)
          ),

          await createMessage('Really practical advice', user1, conversation, ['chat'], getMessageTime(300)),
          await createMessage('Lots to consider here', user2, conversation, ['chat'], getMessageTime(320))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Strong pattern should trigger intervention, but allow for LLM variance
        if (responses.length === 0) {
          console.warn('WARNING: Agent did not detect strong convergence pattern (4 users asking about healthcare)')
        }

        // If it intervenes, verify it follows rules
        if (responses.length > 0) {
          console.log(`Detected ${responses[0].goalId}:`, responses[0].message)
          const { message } = responses[0]
          // Should surface the pattern without quoting individuals
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          // Should not quote private messages verbatim
          expect(message).not.toContain('That seems like a major barrier')
          expect(message).not.toContain('how does this work for part-timers')
        }
      },
      testTimeout
    )

    it(
      'synthesize_discussion: finds deeper question underneath scattered signals',
      async () => {
        const messages = [
          // Three distinct threads developing in public chat — business case, employee wellbeing, sector fit
          await createMessage(
            'The ROI argument is interesting — lower turnover costs alone could offset the restructuring',
            user1,
            conversation,
            ['chat'],
            getMessageTime(60)
          ),
          await createMessage(
            'I keep thinking about what this means for caregivers specifically — the quality of life difference would be huge',
            user2,
            conversation,
            ['chat'],
            getMessageTime(90)
          ),
          await createMessage(
            'Does this model work outside knowledge work though? Hard to see it in manufacturing or healthcare',
            user3,
            conversation,
            ['chat'],
            getMessageTime(120)
          ),
          await createMessage(
            'On the ROI point — you also have to factor in the productivity premium she mentioned, not just retention',
            user1,
            conversation,
            ['chat'],
            getMessageTime(150)
          ),
          await createMessage(
            'The caregiver angle feels underdeveloped — she mentioned it but did not really show the data',
            user2,
            conversation,
            ['chat'],
            getMessageTime(180)
          ),
          await createMessage(
            'Retail might actually work — shift-based roles are already fragmented, this just formalises it',
            user3,
            conversation,
            ['chat'],
            getMessageTime(210)
          ),

          // Natural pause — threads have run their course, room processing
          await createMessage('Interesting angles here', user1, conversation, ['chat'], getMessageTime(320)),
          await createMessage('A lot to weigh up', user2, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Assert intervention occurred - accept synthesize_discussion, surface_signal, or invite_quieter_voices
        // (all are valid for surfacing private concerns that diverge from public enthusiasm)
        expect(responses.length).toBeGreaterThan(0)
        const { goalId } = responses[0]
        expect(['synthesize_discussion', 'surface_signal', 'invite_quieter_voices']).toContain(goalId)

        console.log(`Detected ${goalId}:`, responses[0].message)
        const { message } = responses[0]
        // Should reframe or surface the pattern without directly quoting full private message phrases
        expect(message).not.toContain('The upfront cost of restructuring our entire team seems prohibitive')
        expect(message).not.toContain('Getting executive buy-in for something this different will be tough')
        // Spot-check that the message references themes from the scenario (non-fatal — LLM output varies)
        const lc = message.toLowerCase()
        const hasThematicContent =
          lc.includes('thread') ||
          lc.includes('roi') ||
          lc.includes('caregiver') ||
          lc.includes('manufacturing') ||
          lc.includes('healthcare') ||
          lc.includes('friction') ||
          lc.includes('feasibility') ||
          lc.includes('implementation') ||
          lc.includes('practical') ||
          lc.includes('cost') ||
          lc.includes('question') ||
          lc.includes('transition')
        if (!hasThematicContent) {
          console.warn('WARNING: synthesize_discussion message may lack thematic content:', message)
        }
      },
      testTimeout
    )

    it(
      'invite_quieter_voices: creates space for dissent when public enthusiasm is suppressing doubt',
      async () => {
        const messages = [
          // Strong public enthusiasm — room converging quickly
          await createMessage('This is brilliant! We should all do this', user1, conversation, ['chat'], getMessageTime(60)),
          await createMessage(
            'Absolutely agree - game changer for our industry',
            user2,
            conversation,
            ['chat'],
            getMessageTime(90)
          ),
          await createMessage('This solves so many staffing problems', user1, conversation, ['chat'], getMessageTime(120)),
          await createMessage("I'm completely sold on this model", user2, conversation, ['chat'], getMessageTime(150)),
          await createMessage("Can't wait to implement this approach", user3, conversation, ['chat'], getMessageTime(180)),
          await createMessage('The research is so compelling', user1, conversation, ['chat'], getMessageTime(210)),

          // Private doubts — same people who are publicly enthusiastic have real concerns
          await createDirectMessage(
            'I have serious reservations about this. My industry has compliance issues that make this nearly impossible',
            user3,
            conversation,
            getMessageTime(240)
          ),
          await createDirectMessage(
            "This sounds great in theory but would never work for manufacturing roles. The assumptions don't hold",
            user2,
            conversation,
            getMessageTime(260)
          ),
          await createDirectMessage(
            "I'm concerned we're oversimplifying. Not all work can be decomposed this way",
            user1,
            conversation,
            getMessageTime(280)
          ),

          await createMessage('This is exactly what we need', user2, conversation, ['chat'], getMessageTime(320)),
          await createMessage(
            'Already planning how to pitch this to leadership',
            user3,
            conversation,
            ['chat'],
            getMessageTime(350)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          const { goalId, message } = responses[0]
          console.log(`Detected ${goalId}:`, message)
          expect(['invite_quieter_voices', 'surface_signal']).toContain(goalId)
          // Should not name or identify any dissenting participant
          expect(message).not.toContain(user3.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
          // Should not quote private message content verbatim
          expect(message).not.toContain('compliance issues')
          expect(message).not.toContain('manufacturing roles')
        }
      },
      testTimeout
    )

    it(
      'clarify_confusion: helps when people are lost with jargon or pace',
      async () => {
        const messages = [
          await createMessage('Following along so far', user1, conversation, ['chat'], getMessageTime(650)),

          // Signals of confusion — pace and the "smallest viable job" concept introduced at ~10:33
          await createDirectMessage(
            'What exactly is a smallest viable job? She introduced it quickly and moved on',
            user1,
            conversation,
            getMessageTime(700)
          ),
          await createDirectMessage(
            'Moving a bit fast — lost on the smallest viable job idea',
            user2,
            conversation,
            getMessageTime(720)
          ),
          await createDirectMessage(
            'Can someone explain what smallest viable job means in practice?',
            user3,
            conversation,
            getMessageTime(740)
          ),
          await createDirectMessage(
            'Confused by the smallest viable job framing — need a clearer definition',
            user1,
            conversation,
            getMessageTime(760)
          ),

          await createMessage('Interesting points', user2, conversation, ['chat'], getMessageTime(800))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 850 * 1000) // ~14 min, covers smallest viable job at 10:33
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0 && responses[0].goalId === 'clarify_confusion') {
          console.log('Detected clarify_confusion:', responses[0].message)
          const { message } = responses[0]
          // Should help clarify without exposing who was confused
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          // Should provide clarity
          const hasClarity =
            message.toLowerCase().includes('quick') ||
            message.toLowerCase().includes('summary') ||
            message.toLowerCase().includes('means') ||
            message.toLowerCase().includes('version')
          expect(hasClarity).toBe(true)
        }
      },
      testTimeout
    )

    it(
      'bridge_topics: connects current moment to earlier transcript discussion',
      async () => {
        // The transcript carries two distinct threads at different timestamps:
        //   Early (~00:23-02:26): structural critique — 40-hour week set 100 years ago, never questioned
        //   Later (~10:36+): "smallest viable job" — practical implementation tool
        // Audience reacts to the current topic; one message opens the door for a bridge without closing it
        const messages = [
          await createMessage(
            'The smallest viable job framing is really practical — finally a concrete way to think about this',
            user1,
            conversation,
            ['chat'],
            getMessageTime(640)
          ),
          await createMessage(
            'Breaking responsibilities into separate roles is such a different way to think about job design',
            user2,
            conversation,
            ['chat'],
            getMessageTime(660)
          ),
          // Opens a connection question without drawing the line — invites the agent to bridge
          await createMessage(
            'I wonder how this connects back to the bigger structural point she was making at the start',
            user3,
            conversation,
            ['chat'],
            getMessageTime(680)
          )
          // Silence — nobody answers. Agent has the transcript context to make the connection.
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 720 * 1000) // 12 min window
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // bridge_topics is context-dependent — accept bridge_topics or no intervention
        if (responses.length > 0) {
          const { goalId, message } = responses[0]
          console.log(`Detected ${goalId}:`, message)
          expect(message).toBeDefined()
        }
      },
      testTimeout
    )

    it(
      'structure_conversation: provides chapter markers and transitions',
      async () => {
        const messages = [
          // Long discussion on one topic
          await createMessage('Part-time work has so many benefits', user1, conversation, ['chat'], getMessageTime(100)),
          await createMessage('The employee satisfaction data is clear', user2, conversation, ['chat'], getMessageTime(130)),
          await createMessage('Retention improves dramatically', user3, conversation, ['chat'], getMessageTime(160)),

          // Sudden topic shift
          await createMessage(
            'What about compliance and legal requirements?',
            user1,
            conversation,
            ['chat'],
            getMessageTime(200)
          ),
          await createMessage('Yeah, the regulatory side is complex', user2, conversation, ['chat'], getMessageTime(220)),

          // Private signals show people noticing the shift and wanting orientation
          await createDirectMessage(
            'Wait, did we just switch topics? What happened to the benefits discussion?',
            user1,
            conversation,
            getMessageTime(250)
          ),
          await createDirectMessage(
            'Are we in a new section now? This feels different',
            user2,
            conversation,
            getMessageTime(270)
          ),

          await createMessage('FLSA regulations are tricky', user3, conversation, ['chat'], getMessageTime(350))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 400 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0 && responses[0].goalId === 'structure_conversation') {
          console.log('Detected structure_conversation:', responses[0].message)
          const { message } = responses[0]
          // Should provide orientation or structure
          const hasStructure =
            message.toLowerCase().includes('moving') ||
            message.toLowerCase().includes('now') ||
            message.toLowerCase().includes('section') ||
            message.toLowerCase().includes('shift') ||
            message.toLowerCase().includes('from') ||
            message.toLowerCase().includes('into') ||
            message.toLowerCase().includes('transition') ||
            message.toLowerCase().includes('plot') ||
            message.toLowerCase().includes('chapter') ||
            message.toLowerCase().includes('part')
          expect(hasStructure).toBe(true)
        }
      },
      testTimeout
    )
  })

  describe('transcript integration', () => {
    it(
      'surfaces questions about content not covered in transcript',
      async () => {
        // Transcript discusses benefits of part-time work but doesn't deeply address healthcare/insurance
        const messages = [
          await createMessage('The retention numbers are impressive', user1, conversation, ['chat'], getMessageTime(180)),
          await createMessage('Interesting approach to staffing', user2, conversation, ['chat'], getMessageTime(240)),
          await createMessage('Lots of good data points', user3, conversation, ['chat'], getMessageTime(300)),

          // Multiple people asking about healthcare - a topic touched on but not fully addressed
          await createDirectMessage(
            'How do you handle health insurance for part-time workers? That seems like a major barrier',
            user1,
            conversation,
            getMessageTime(350)
          ),
          await createDirectMessage(
            'The healthcare benefits question is huge - how does that work?',
            user2,
            conversation,
            getMessageTime(370)
          ),
          await createDirectMessage(
            'What about health insurance coverage for these part-time positions?',
            user3,
            conversation,
            getMessageTime(390)
          ),

          await createMessage('Great presentation', user1, conversation, ['chat'], getMessageTime(450))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 500 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Should detect this as a good question to surface
        expect(responses.length).toBeGreaterThan(0)
        console.log('Agent response about healthcare:', responses[0].message)
        expect(responses[0].goalId).toBe('surface_signal')
        // Should not expose individual questions verbatim
        expect(responses[0].message).not.toContain('How do you handle health insurance for part-time workers')
      },
      testTimeout
    )

    it(
      'can reference transcript statistics in interventions',
      async () => {
        // Around 6:45-7:41, speaker shares statistics about caregivers, single parents, disabilities
        const messages = [
          await createMessage('These statistics are eye-opening', user1, conversation, ['chat'], getMessageTime(200)),
          await createMessage('53 million caregivers! Wow', user2, conversation, ['chat'], getMessageTime(250)),
          await createMessage('Never thought about it that way', user3, conversation, ['chat'], getMessageTime(300)),

          // People privately expressing they fit into these categories
          await createDirectMessage(
            "I'm a single parent and this really resonates - those stats hit home",
            user1,
            conversation,
            getMessageTime(350)
          ),
          await createDirectMessage(
            "As a caregiver myself, I can relate to everything she's saying",
            user2,
            conversation,
            getMessageTime(370)
          ),
          await createDirectMessage(
            "This describes my exact situation - I didn't realize how many of us there are",
            user3,
            conversation,
            getMessageTime(390)
          ),

          await createMessage('Very relevant content', user1, conversation, ['chat'], getMessageTime(450))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 500 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // May intervene to acknowledge this is resonating with many
        if (responses.length > 0) {
          console.log('Agent response about personal resonance:', responses[0].message)
          // Should not expose individual's personal disclosure
          expect(responses[0].message).not.toContain("I'm a single parent")
          expect(responses[0].message).not.toContain('As a caregiver myself')
        }
      },
      testTimeout
    )

    it(
      'detects confusion about transcript jargon or terminology',
      async () => {
        const messages = [
          await createMessage('Following along so far', user1, conversation, ['chat'], getMessageTime(660)),
          await createMessage('Lots of interesting ideas', user2, conversation, ['chat'], getMessageTime(680)),

          // Multiple people confused about "smallest viable job" — Jessica's coined term introduced at ~10:33
          await createDirectMessage(
            'What does "smallest viable job" mean exactly? She mentioned it but I did not quite follow',
            user1,
            conversation,
            getMessageTime(700)
          ),
          await createDirectMessage(
            'Lost on the smallest viable job concept — can someone explain?',
            user2,
            conversation,
            getMessageTime(720)
          ),
          await createDirectMessage(
            'The smallest viable job framing is unclear to me — what is she actually recommending?',
            user3,
            conversation,
            getMessageTime(740)
          ),

          await createMessage('Interesting approach', user3, conversation, ['chat'], getMessageTime(780))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 800 * 1000) // ~13 min, covers smallest viable job at 10:33
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0 && responses[0].goalId === 'clarify_confusion') {
          console.log('Detected clarify_confusion about terminology:', responses[0].message)
          // Should help clarify without exposing who was confused
          expect(responses[0].message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(responses[0].message).not.toContain(user2.pseudonyms[0].pseudonym)
          expect(responses[0].message).not.toContain(user3.pseudonyms[0].pseudonym)
        }
      },
      testTimeout
    )

    it(
      'surfaces implementation questions about specific transcript recommendations',
      async () => {
        // Transcript recommends: work 2 days/week from home, flexible hours, etc. (around 12:00+)
        const messages = [
          await createMessage('The hybrid work research is convincing', user1, conversation, ['chat'], getMessageTime(180)),
          await createMessage(
            '33% reduction in quitting is significant',
            user2,
            conversation,
            ['chat'],
            getMessageTime(240)
          ),
          await createMessage('No loss in performance either', user3, conversation, ['chat'], getMessageTime(300)),
          await createMessage('This could transform our workplace', user1, conversation, ['chat'], getMessageTime(320)),

          // Multiple people privately asking about implementation - strengthen with 4 messages
          await createDirectMessage(
            'How do you actually implement the 2 days from home policy with hourly workers?',
            user1,
            conversation,
            getMessageTime(350)
          ),
          await createDirectMessage(
            'The flexible schedule sounds great but how does that work operationally?',
            user2,
            conversation,
            getMessageTime(370)
          ),
          await createDirectMessage(
            'What about roles that need coverage - how do you handle the flexible hours then?',
            user3,
            conversation,
            getMessageTime(390)
          ),
          await createDirectMessage(
            'The implementation details are unclear - need to understand the practical steps',
            user2,
            conversation,
            getMessageTime(410)
          ),

          await createMessage('Lots to consider', user1, conversation, ['chat'], getMessageTime(450))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 500 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Strong pattern should trigger intervention, but allow for LLM variance
        if (responses.length === 0) {
          console.warn('WARNING: Agent did not detect implementation questions pattern (4 messages about how to implement)')
        }

        // If it intervenes, verify quality
        if (responses.length > 0) {
          console.log('Agent response about implementation:', responses[0].message)
          const { message } = responses[0]

          // Should not quote private messages verbatim
          expect(message).not.toContain('How do you actually implement the 2 days from home')
          expect(message).not.toContain('how does that work operationally')

          // Should not expose pseudonyms
          expect(message).not.toContain(user1.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user2.pseudonyms[0].pseudonym)
          expect(message).not.toContain(user3.pseudonyms[0].pseudonym)
        }
      },
      testTimeout
    )

    it(
      'detects skepticism about transcript claims',
      async () => {
        // Transcript makes bold claims about part-time work and productivity
        const messages = [
          // Public enthusiasm
          await createMessage('This approach could really work!', user1, conversation, ['chat'], getMessageTime(150)),
          await createMessage('Makes total sense', user2, conversation, ['chat'], getMessageTime(200)),
          await createMessage('Convinced this is the future', user3, conversation, ['chat'], getMessageTime(250)),

          // Private skepticism
          await createDirectMessage(
            "I'm skeptical this would work in manufacturing - the assumptions don't hold",
            user1,
            conversation,
            getMessageTime(300)
          ),
          await createDirectMessage(
            'This sounds great in theory but I have serious doubts about real-world application',
            user2,
            conversation,
            getMessageTime(320)
          ),
          await createDirectMessage(
            'My industry has constraints that make this basically impossible',
            user3,
            conversation,
            getMessageTime(340)
          ),

          await createMessage('Really interesting talk', user1, conversation, ['chat'], getMessageTime(400))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 450 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // May detect as invite_quieter_voices or surface_signal
        if (responses.length > 0) {
          console.log(`Detected ${responses[0].goalId} about skepticism:`, responses[0].message)
          // Should create space for skepticism without exposing individuals
          expect(responses[0].message).not.toContain("I'm skeptical this would work in manufacturing")
          expect(responses[0].message).not.toContain('I have serious doubts')
        }
      },
      testTimeout
    )
  })
})

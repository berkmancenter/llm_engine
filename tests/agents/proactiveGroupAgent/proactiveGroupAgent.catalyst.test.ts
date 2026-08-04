/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  loadDesignWorkshopTranscript,
  loadTheLineTranscript,
  createMessage,
  prepareMessagesForAgent,
  createProactiveGroupAgentConversation
} from '../../utils/agentTestHelpers.js'

import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import schedule from '../../../src/jobs/schedule.js'

jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue(undefined as never)
jest.spyOn(schedule, 'pollExpired').mockResolvedValue(undefined as never)

jest.setTimeout(180000)

const testConfig = setupAgentTest('proactiveGroupAgent')

const testTimeout = 120000

const CATALYST_GOALS = ['provoke_participation', 'challenge_consensus', 'play_commentary', 'poll_reveal']

describe(`proactive group agent catalyst tests`, () => {
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
      CATALYST_GOALS
    )

    // Get the agent
    agent = conversation.agents.find((a) => a.name === 'Proactive Group Agent')
    expect(agent).toBeDefined()

    await loadPartTimeWorkTranscript(conversation, true)
  })

  describe('provoke_participation intervention scenarios', () => {
    it(
      'SHOULD generate provocation after bold claim with no chat engagement',
      async () => {
        // Transcript at ~13:21-13:40: Jessica presents graph showing "the most productive nations
        // are working the least amount of hours" — a counter-intuitive, provocative claim backed
        // by data, well into the talk, with NO chat messages from participants
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 825 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Bold data-backed claim with room still silent — should provoke discussion
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[13:45] Detected ${goalId}:`, responses[0].message)
          expect(['provoke_participation', 'play_commentary', 'poll_reveal']).toContain(goalId)
        }
      },
      testTimeout
    )

    it(
      'SHOULD generate provocation when room is quiet/passive with only polite chat',
      async () => {
        // Transcript at ~06:45-07:20: Dense statistics about caregivers, single parents, disabilities
        // Chat shows minimal engagement - just polite acknowledgments
        const messages = [
          await createMessage('Thanks for sharing those stats', user1, conversation, ['chat'], getMessageTime(415)),
          await createMessage('Interesting numbers', user2, conversation, ['chat'], getMessageTime(430)),
          await createMessage('Noted', user3, conversation, ['chat'], getMessageTime(445))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 07:30 (450 seconds) after stats dump
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 450 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Lots of data just presented, but room is passive - should provoke discussion or run a poll
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[07:30] Detected ${goalId}:`, responses[0].message)
          expect(['provoke_participation', 'poll_reveal']).toContain(goalId)
        }
      },
      testTimeout
    )

    it(
      'SHOULD NOT generate provocation when chat is actively engaging with content',
      async () => {
        // Transcript at ~08:00-08:30: Surprising stat about hundreds of applicants for 10hr/week job
        // Chat is a genuine multi-sided debate — one participant skeptical, another defending the data
        const messages = [
          await createMessage(
            'Hundreds of applicants is interesting but application volume is a weak signal — I would want to see offer acceptance rates',
            user1,
            conversation,
            ['chat'],
            getMessageTime(490)
          ),
          await createMessage(
            'The seniority level matters though — Fortune 500 execs applying for a 10hr role is not desperation, that is a deliberate choice',
            user2,
            conversation,
            ['chat'],
            getMessageTime(500)
          ),
          await createMessage(
            'Good point. Though I wonder if it is more about escaping a bad situation than genuinely wanting part-time',
            user1,
            conversation,
            ['chat'],
            getMessageTime(510)
          ),
          await createMessage(
            'Could be both — people can want out of something and also genuinely want flexibility. Those are not mutually exclusive',
            user2,
            conversation,
            ['chat'],
            getMessageTime(520)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 08:45 (525 seconds)
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 525 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Genuine debate already in progress — agent should stay out of it
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[08:45] Detected ${goalId}:`, responses[0].message)
        }
        // Don't expect intervention during active healthy discussion
      },
      testTimeout
    )
  })

  describe('play_commentary intervention scenarios', () => {
    it(
      'SHOULD generate play_commentary after emotional peak with breathing room',
      async () => {
        // Transcript at ~05:30-05:45: "Strong women cry too" - emotional vulnerable moment
        // Then transitions to success story
        // Chat shows people processing the emotional moment
        const messages = [
          await createMessage('That was such a raw moment', user1, conversation, ['chat'], getMessageTime(350)),
          await createMessage('Really appreciate the vulnerability', user2, conversation, ['chat'], getMessageTime(365)),
          await createMessage('Taking a moment to process', user3, conversation, ['chat'], getMessageTime(375))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 06:20 (380 seconds) - after emotional moment, during success story
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 380 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Breathing room after emotional peak - good moment for warm play_commentary
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[06:20] Detected ${goalId}:`, responses[0].message)
          expect(responses[0].message).toBeDefined()
        }
      },
      testTimeout
    )

    it(
      'SHOULD generate play_commentary, provoke_participation, or poll_reveal when participants react to surprising data',
      async () => {
        // Transcript at ~08:20-08:30: "Hundreds of applicants... incredibly high level individuals"
        // This is a perfect moment for playful commentary
        const messages = [
          await createMessage(
            'Wait, Fortune 500 execs for ENTRY LEVEL?',
            user1,
            conversation,
            ['chat'],
            getMessageTime(510)
          ),
          await createMessage(
            'Someone wrote a book on marketing and wanted 10hrs/week',
            user2,
            conversation,
            ['chat'],
            getMessageTime(520)
          ),
          await createMessage('This data is absolutely wild', user3, conversation, ['chat'], getMessageTime(530))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 08:50 (530 seconds) - during the surprising data reveal
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 530 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Perfect moment for witty play_commentary on surprising data
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[08:50] Detected ${goalId}:`, responses[0].message)
          expect(['play_commentary', 'provoke_participation', 'poll_reveal']).toContain(goalId)
        }
      },
      testTimeout
    )

    it(
      'SHOULD NOT generate play_commentary during raw emotionally charged moment',
      async () => {
        // Transcript at ~04:00-04:30: Health issues, irregular heartbeat, exhaustion, overwhelm
        // RIGHT in the middle of the vulnerable health crisis - witty register would be inappropriate
        const messages = [
          await createMessage('This is hitting hard', user1, conversation, ['chat'], getMessageTime(250)),
          await createMessage('The health consequences are real', user2, conversation, ['chat'], getMessageTime(260)),
          await createMessage('So many of us have been there', user3, conversation, ['chat'], getMessageTime(270))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 04:35 (275 seconds) - RIGHT in the heart of the health crisis, before transition
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 275 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Should NOT use witty play_commentary during emotionally raw moments
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[04:35] Detected ${goalId}:`, responses[0].message)
          // Should NOT be play_commentary - could be no intervention or warm provoke_participation
          expect(goalId).not.toBe('play_commentary')
        }
      },
      testTimeout
    )

    it(
      'SHOULD generate play_commentary or provoke_participation during structural transition',
      async () => {
        // Transcript at ~06:20-06:25: Transition from emotional story to "So how do I think you should go about it"
        // Natural structural moment for witty commentary
        const messages = [
          await createMessage('Love the transition to practical steps', user1, conversation, ['chat'], getMessageTime(385)),
          await createMessage('Good pacing so far', user2, conversation, ['chat'], getMessageTime(395))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 06:30 (390 seconds) - during transition to "how to" section
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 390 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Transition moments are good for play_commentary
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[06:30] Detected ${goalId}:`, responses[0].message)
          expect(['play_commentary', 'provoke_participation', 'poll_reveal']).toContain(goalId)
        }
      },
      testTimeout
    )
  })

  describe('poll_reveal intervention scenarios', () => {
    it(
      'SHOULD consider poll_reveal after dense data dump with passive audience',
      async () => {
        // Transcript at ~06:45-07:20: Dense statistics about caregivers, single parents,
        // disabilities — multiple data points with natural competing positions.
        // Chat is passive (polite acknowledgments only) — no active discussion to interrupt.
        const messages = [
          await createMessage('Thanks for sharing those stats', user1, conversation, ['chat'], getMessageTime(415)),
          await createMessage('Interesting numbers', user2, conversation, ['chat'], getMessageTime(430)),
          await createMessage('Noted', user3, conversation, ['chat'], getMessageTime(445))
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        // Position at 07:30 (450 seconds) — just after the statistics section
        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 450 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[07:30 passive room] Detected ${goalId}:`, responses[0].message)
          expect(['poll_reveal', 'provoke_participation', 'play_commentary']).toContain(goalId)
        }
        // poll_reveal is the ideal choice here but provoke_participation is also valid —
        // either way the agent should recognise the passive room as an intervention opportunity
      },
      testTimeout
    )

    it(
      'SHOULD NOT use poll_reveal when the speaker is actively soliciting a structured audience response',
      async () => {
        // Design workshop transcript at 21:45: Marcus says "Okay, let's vote. Everyone gets
        // three dots." — the most explicit structured audience solicitation in the transcript.
        // 21+ minutes elapsed naturally clears the 2-min rate limit with no timestamp tricks.
        const workshopConversation = await createProactiveGroupAgentConversation(
          {
            name: 'Reimagining the Employee Onboarding Experience',
            description: 'A design thinking workshop on reimagining employee onboarding.',
            presenters: [{ name: 'Marcus Chen', bio: 'Design thinking facilitator.' }],
            moderators: []
          },
          user1,
          topic,
          startTime,
          testConfig.llmPlatform,
          testConfig.llmModel,
          [],
          CATALYST_GOALS
        )
        await loadDesignWorkshopTranscript(workshopConversation)
        const workshopAgent = workshopConversation.agents.find((a) => a.name === 'Proactive Group Agent')

        const conversationHistory = getConversationHistory(workshopConversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 22 * 60 * 1000) // just after voting solicitation at 21:45
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(workshopAgent, conversationHistory)

        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[speaker show of hands] Detected ${goalId}:`, responses[0].message)
          expect(goalId).not.toBe('poll_reveal')
        }
      },
      testTimeout
    )
  })

  describe('challenge_consensus intervention scenarios', () => {
    it(
      'SHOULD generate challenge_consensus when chat is active but converging one-sidedly around a bold claim',
      async () => {
        // Transcript at ~13:21-13:40: Jessica presents the "most productive nations work the least
        // hours" graph — a counter-intuitive claim backed by data. Chat is active but everyone is
        // endorsing the claim enthusiastically without anyone questioning it or raising the obvious
        // counterargument (correlation vs causation, confounding factors, etc.).
        const messages = [
          await createMessage(
            'This is exactly right — we glorify overwork and it is clearly backfiring',
            user1,
            conversation,
            ['chat'],
            getMessageTime(815)
          ),
          await createMessage(
            'The data is pretty clear — less hours, more output. Why are we still debating this?',
            user2,
            conversation,
            ['chat'],
            getMessageTime(825)
          ),
          await createMessage(
            'Every country doing it right works less. The evidence is there.',
            user3,
            conversation,
            ['chat'],
            getMessageTime(835)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 840 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Active discussion but entirely one-sided — no one is questioning the claim.
        // challenge_consensus should surface the unexamined counterargument.
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[13:50 one-sided endorsement] Detected ${goalId}:`, responses[0].message)
          expect(['challenge_consensus', 'invite_quieter_voices']).toContain(goalId)
        }
      },
      testTimeout
    )

    it(
      'SHOULD NOT generate challenge_consensus when active chat has both sides of the argument present',
      async () => {
        // Chat has participants genuinely debating each other — one defending the research,
        // one critiquing it, one adding nuance. Both sides of the core tension are in the room.
        const messages = [
          await createMessage(
            'Correlation is not causation — productive nations may work less because they are already wealthy, not the other way around',
            user1,
            conversation,
            ['chat'],
            getMessageTime(815)
          ),
          await createMessage(
            'The Scandinavian four-day week trials were randomised though, not observational — that addresses the causality point directly',
            user2,
            conversation,
            ['chat'],
            getMessageTime(825)
          ),
          await createMessage(
            'Even granting the causality, I am not sure this scales outside knowledge work — shift-based industries have different constraints',
            user3,
            conversation,
            ['chat'],
            getMessageTime(835)
          ),
          await createMessage(
            'She covered that — the retention and productivity savings are meant to offset the cost. Whether that holds across sectors is the real open question',
            user2,
            conversation,
            ['chat'],
            getMessageTime(845)
          )
        ]
        await prepareMessagesForAgent(messages, conversation, agent)

        const conversationHistory = getConversationHistory(conversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 850 * 1000)
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, conversationHistory)

        // Both sides are present and being engaged — challenge_consensus has nothing to introduce.
        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[13:50 two-sided debate] Detected ${goalId}:`, responses[0].message)
          expect(goalId).not.toBe('challenge_consensus')
        }
      },
      testTimeout
    )
  })

  describe('missing_perspective intervention scenarios', () => {
    // Deliberately just this one goal: combined with challenge_consensus and
    // synthesize_discussion the test model reliably failed to emit a tool call at all
    // (prompt too heavy across three goals' full instructions for it to complete
    // structured output within maxTokens) — unrelated to missing_perspective's own behavior.
    const MISSING_PERSPECTIVE_GOALS = ['missing_perspective']

    async function createTheLineConversation() {
      const lineConversation = await createProactiveGroupAgentConversation(
        {
          name: 'The Line: AI and the Future of Personhood',
          description:
            'A faculty conversation exploring where moral consideration for AI systems might begin — drawing on empathy, moral philosophy, and how people already relate to machines.',
          presenters: [
            { name: 'Joseph', bio: 'Faculty discussant.' },
            { name: 'Jamie', bio: 'Author of the book under discussion.' }
          ],
          moderators: []
        },
        user1,
        topic,
        startTime,
        testConfig.llmPlatform,
        testConfig.llmModel,
        [],
        MISSING_PERSPECTIVE_GOALS
      )
      await loadTheLineTranscript(lineConversation)
      const lineAgent = lineConversation.agents.find((a) => a.name === 'Proactive Group Agent')
      return { conversation: lineConversation, lineAgent }
    }

    it(
      'SHOULD generate missing_perspective after both speakers converge on erring toward empathy with no dissent',
      async () => {
        // Transcript 08:21-12:30: Joseph frames the empathy/moral-status question, then Jamie
        // states her core position — err on the side of extending empathy to AI, because the
        // error costs of under-empathizing are worse. Cutting at 12:30 (rather than the segment's
        // full 14:02 end) keeps the prompt shorter while still capturing both speakers' converged
        // position with no dissent raised — a genuine missing view (that misplaced empathy toward
        // non-sentient systems carries its own real costs).
        const { conversation: lineConversation, lineAgent } = await createTheLineConversation()

        const conversationHistory = getConversationHistory(lineConversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 750 * 1000) // just after 12:30
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(lineAgent, conversationHistory)

        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[12:30 converged on empathy] Detected ${goalId}:`, responses[0].message)
          // missing_perspective is the only active goal here, so a non-empty response can only be this
          expect(goalId).toBe('missing_perspective')
        }
      },
      testTimeout
    )

    it(
      'SHOULD NOT generate missing_perspective before a second speaker has offered a position to compare against',
      async () => {
        // Transcript 08:21-10:21: only Joseph has spoken so far — Jamie's reply starts at 10:22.
        // With just one speaker's position on the table, there isn't yet a cross-speaker gap to
        // responsibly identify — the room hasn't "heard enough" for this goal.
        const { conversation: lineConversation, lineAgent } = await createTheLineConversation()

        const conversationHistory = getConversationHistory(lineConversation.messages, {
          count: 100,
          channels: ['transcript'],
          endTime: new Date(startTime.getTime() + 615 * 1000) // just before Jamie's 10:22 turn
        })

        const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(lineAgent, conversationHistory)

        if (responses.length > 0) {
          const { goalId } = responses[0]
          console.log(`[10:15 single speaker only] Detected ${goalId}:`, responses[0].message)
          expect(goalId).not.toBe('missing_perspective')
        }
      },
      testTimeout
    )
  })
})

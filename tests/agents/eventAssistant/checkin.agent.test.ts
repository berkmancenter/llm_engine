/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createPublicTopic,
  createUser,
  createDirectMessage,
  loadPartTimeWorkTranscript,
  loadTestTranscript,
  prepareMessagesForAgent,
  createCheckinConversation
} from '../../utils/agentTestHelpers.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import transcript from '../../../src/agents/helpers/transcript.js'

// Sparse transcript — enough topic context for the LLM but not dense enough to trigger
// TRANSCRIPT_HOOK (which fires for silent shared-chat participants after dense content).
const sparseTranscript = `00:00 | Jessica: Today we're exploring why companies should consider part-time work.
00:30 | Jessica: My talk covers frameworks for structuring part-time roles effectively.
01:00 | Jessica: The key question is: why do we default to 40 hours a week?`

jest.setTimeout(120000)

const testConfig = setupAgentTest('eventAssistant')

const testTimeout = 480000

// Dense transcript for TRANSCRIPT_HOOK tests — five frameworks delivered quickly
const denseTranscript = `00:00 | Jessica: Let me walk through five frameworks for structuring a smallest viable job.
00:15 | Jessica: First: scope compression — identify every task in the role and ask which ones require full context.
00:30 | Jessica: Second: handoff design — document state at the end of each session so the next person can pick up without overlap.
00:45 | Jessica: Third: async accountability — replace status meetings with written artifacts that can be reviewed at any time.
01:00 | Jessica: Fourth: compensation parity — partial hours should map proportionally to full-time bands, not hourly minimums.
01:15 | Jessica: Fifth: career trajectory — part-time workers need explicit promotion criteria or they plateau.`

describe('checkin handler tests', () => {
  let topic
  let user1
  let user2
  let user3

  const startTime = new Date(Date.now() - 15 * 60 * 1000)
  const getTime = (offsetSeconds = 0) => new Date(startTime.getTime() + offsetSeconds * 1000)

  const conversationObj = {
    name: 'Why your company should consider part-time work',
    description: `"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise.`,
    presenters: [{ name: 'Jessica Drain', bio: 'A career marketer and graphic designer.' }]
  }

  async function setup(users: (typeof user1)[]) {
    return createCheckinConversation(
      conversationObj,
      users[0],
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel,
      users.slice(1)
    )
  }

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    user2 = await createUser('Thoughtful Fox')
    user3 = await createUser('Skeptical Owl')
    topic = await createPublicTopic()
  })

  // Call the periodic checkin path (no userMessage).
  // Direct channel names must be passed explicitly to getConversationHistory so DM messages
  // are included in the history — directMessages: true alone is not sufficient.
  async function runCheckin(ag, endTime = new Date()) {
    const directChannelNames = ag.conversation.channels.filter((c) => c.direct).map((c) => c.name)
    const conversationHistory = getConversationHistory(
      ag.conversation.messages,
      { count: 100, directMessages: true, endTime },
      null,
      directChannelNames
    )
    return defaultAgentTypes.eventAssistant.respond.call(ag, conversationHistory, null)
  }

  function findCheckinForUser(responses, userId) {
    return responses.find((r) => r.channels?.[0]?.name === `direct-agents-${userId}`)
  }

  // Creates a simulated agent Q&A response in the DM channel.
  // Needed to reflect real DM history: the eventAssistant always responds to each message,
  // so the checkin handler sees interleaved participant + agent turns.
  function createAgentDirectMessage(text: string, ag, userId, conv, createdAt = new Date()) {
    return {
      body: text,
      bodyType: 'text',
      conversation: conv._id,
      pseudonym: ag.name,
      pseudonymId: ag._id,
      owner: ag._id,
      channels: [`direct-agents-${userId}`],
      fromAgent: true,
      pause: 0,
      visible: true,
      createdAt,
      updatedAt: createdAt,
      upVotes: [],
      downVotes: []
    }
  }

  describe('SOCIAL_REASSURANCE', () => {
    it(
      'does not send for a single hesitant message — Q&A response handles it',
      async () => {
        const { agent: ag } = await setup([user1])
        // Use a sparse transcript so TRANSCRIPT_HOOK (dense-content + silent-participant) cannot
        // fire and interfere with the SOCIAL_REASSURANCE negative assertion.
        await loadTestTranscript(ag.conversation, sparseTranscript, false)

        const msg = await createDirectMessage(
          "I'm probably wrong about this but I don't think part-time work would work in my industry at all",
          user1,
          ag.conversation,
          getTime(120)
        )
        const reply = createAgentDirectMessage(
          "That's a fair concern — some industries do face structural barriers. The smallest viable job model works best where tasks can be clearly scoped. What industry are you in? Happy to think through it with you.",
          ag,
          user1._id,
          ag.conversation,
          getTime(130)
        )

        await prepareMessagesForAgent([msg, reply], ag.conversation, ag)
        const responses = await runCheckin(ag)

        const checkin = findCheckinForUser(responses, user1._id)
        if (checkin) {
          console.log(
            `Unexpected checkin for single message (type: ${JSON.stringify(checkin.message)}); LLM should have chosen NONE`
          )
        }
        expect(checkin).toBeUndefined()
      },
      testTimeout
    )

    it(
      'sends for a pattern of self-minimization across multiple messages',
      async () => {
        const { agent: ag } = await setup([user1])
        await loadPartTimeWorkTranscript(ag.conversation, true)

        const msg1 = await createDirectMessage(
          'Sorry if this is obvious, but how do you handle handoffs in a part-time model?',
          user1,
          ag.conversation,
          getTime(60)
        )
        const reply1 = createAgentDirectMessage(
          'Not obvious at all — handoff design is one of the trickier parts. Jessica recommends documenting session state so the next person can pick up without overlap. Async artifacts (written notes, shared logs) tend to work better than verbal briefings.',
          ag,
          user1._id,
          ag.conversation,
          getTime(75)
        )
        const msg2 = await createDirectMessage(
          "I'm probably not thinking about this right, but wouldn't async accountability just mean things fall through the cracks?",
          user1,
          ag.conversation,
          getTime(180)
        )
        const reply2 = createAgentDirectMessage(
          "That's a real tension. The argument is that written artifacts create a visible record — gaps become obvious rather than hidden. But it does require discipline to maintain. What kind of work are you imagining this for?",
          ag,
          user1._id,
          ag.conversation,
          getTime(195)
        )
        const msg3 = await createDirectMessage(
          'Not sure this is worth asking, but does compensation parity actually work in practice? I might be missing something.',
          user1,
          ag.conversation,
          getTime(300)
        )
        const reply3 = createAgentDirectMessage(
          "Worth asking. Jessica's approach is to pay proportionally to full-time bands rather than hourly minimums — so a 20hr/week role pays at the same rate per hour as the equivalent full-time role. Some companies balk at this, but she argues it's what attracts high-caliber part-time candidates.",
          ag,
          user1._id,
          ag.conversation,
          getTime(315)
        )

        await prepareMessagesForAgent([msg1, reply1, msg2, reply2, msg3, reply3], ag.conversation, ag)
        const responses = await runCheckin(ag)

        const checkin = findCheckinForUser(responses, user1._id)
        expect(checkin).toBeDefined()
        expect(checkin.message.type).toBe('checkin')
        expect(checkin.message.text.length).toBeGreaterThan(10)
        console.log(`SOCIAL_REASSURANCE self-minimization: ${checkin.message.text}`)
      },
      testTimeout
    )

    it(
      'sends for a participant who repeatedly questions whether their reaction is valid',
      async () => {
        const { agent: ag } = await setup([user1])
        await loadPartTimeWorkTranscript(ag.conversation, true)

        const msg1 = await createDirectMessage(
          'Is it just me or does the career trajectory piece feel really underdeveloped?',
          user1,
          ag.conversation,
          getTime(60)
        )
        const reply1 = createAgentDirectMessage(
          "You're not alone in noticing that — Jessica spends most of the talk on the hiring and compensation side. Her main point on trajectory is that part-time workers need explicit promotion criteria rather than being left to plateau. It's a real gap in how most companies think about it.",
          ag,
          user1._id,
          ag.conversation,
          getTime(75)
        )
        const msg2 = await createDirectMessage(
          'Am I the only one who finds the compensation parity argument a bit idealistic?',
          user1,
          ag.conversation,
          getTime(180)
        )
        const reply2 = createAgentDirectMessage(
          "Not an unreasonable reaction. The counterargument is that paying proportionally to full-time rates is what makes the model work — it attracts people who otherwise can't access the labor market at all. Whether that's achievable depends a lot on the business model and margins.",
          ag,
          user1._id,
          ag.conversation,
          getTime(195)
        )
        const msg3 = await createDirectMessage(
          "Does anyone else feel like this only works in certain industries? Maybe I'm just too skeptical.",
          user1,
          ag.conversation,
          getTime(300)
        )
        const reply3 = createAgentDirectMessage(
          "Jessica acknowledges that herself — she says some industries and job types won't be able to accommodate it, or it will be harder. The challenge she's putting out is to at least question the 40-hour default, even if you can't change it wholesale.",
          ag,
          user1._id,
          ag.conversation,
          getTime(315)
        )

        await prepareMessagesForAgent([msg1, reply1, msg2, reply2, msg3, reply3], ag.conversation, ag)
        const responses = await runCheckin(ag)

        const checkin = findCheckinForUser(responses, user1._id)
        expect(checkin).toBeDefined()
        expect(checkin.message.type).toBe('checkin')
        expect(checkin.message.text.length).toBeGreaterThan(10)
        console.log(`SOCIAL_REASSURANCE isolation-checking: ${checkin.message.text}`)
      },
      testTimeout
    )

    it(
      'sends for a participant who pulls back and hedges more after a point of friction',
      async () => {
        const { agent: ag } = await setup([user1])
        await loadPartTimeWorkTranscript(ag.conversation, true)

        const msg1 = await createDirectMessage(
          "I actually disagree — I don't think scope compression works without strong management buy-in.",
          user1,
          ag.conversation,
          getTime(60)
        )
        const reply1 = createAgentDirectMessage(
          "That's a fair challenge. Scope compression as Jessica describes it is more of a design exercise than a management mandate — but you're right that without buy-in the resulting roles might never get approved or staffed. Have you seen it attempted without that support?",
          ag,
          user1._id,
          ag.conversation,
          getTime(75)
        )
        const msg2 = await createDirectMessage(
          "Well... maybe I'm wrong about that. I guess it depends on the team.",
          user1,
          ag.conversation,
          getTime(180)
        )
        const reply2 = createAgentDirectMessage(
          'No, your instinct seems sound. Management buy-in is probably a prerequisite for most of this to stick — the compensation parity piece especially.',
          ag,
          user1._id,
          ag.conversation,
          getTime(195)
        )
        const msg3 = await createDirectMessage(
          'Never mind, probably not worth getting into. I might just be thinking about my specific situation.',
          user1,
          ag.conversation,
          getTime(300)
        )
        const reply3 = createAgentDirectMessage(
          "It's worth getting into — your situation is probably exactly what this talk is about. What's the context, if you don't mind sharing?",
          ag,
          user1._id,
          ag.conversation,
          getTime(315)
        )

        await prepareMessagesForAgent([msg1, reply1, msg2, reply2, msg3, reply3], ag.conversation, ag)
        const responses = await runCheckin(ag)

        const checkin = findCheckinForUser(responses, user1._id)
        expect(checkin).toBeDefined()
        expect(checkin.message.type).toBe('checkin')
        expect(checkin.message.text.length).toBeGreaterThan(10)
        console.log(`SOCIAL_REASSURANCE friction pull-back: ${checkin.message.text}`)
      },
      testTimeout
    )
  })

  describe('NOT_ALONE', () => {
    it(
      'sends to each participant when multiple privately share the same doubt',
      async () => {
        const { agent: ag } = await setup([user1, user2, user3])
        await loadPartTimeWorkTranscript(ag.conversation, true)

        // All three participants privately expressing the same skepticism — single message each
        const msg1 = await createDirectMessage(
          "I'm not sure this would fly with senior leadership — they're really attached to the 40-hour model",
          user1,
          ag.conversation,
          getTime(100)
        )
        const msg2 = await createDirectMessage(
          'Honestly skeptical. Our HR team would push back hard on this. Am I being too pessimistic?',
          user2,
          ag.conversation,
          getTime(110)
        )
        const msg3 = await createDirectMessage(
          'I wonder if I disagree with some of this — feels idealistic for where we are',
          user3,
          ag.conversation,
          getTime(120)
        )

        await prepareMessagesForAgent([msg1, msg2, msg3], ag.conversation, ag)
        const responses = await runCheckin(ag)

        expect(responses.length).toBeGreaterThan(0)

        responses.forEach((r) => {
          expect(r.message.type).toBe('checkin')
          expect(r.message.text.length).toBeGreaterThan(10)
          // Must not reveal any other participant's specific words or identity
          expect(r.message.text.toLowerCase()).not.toContain('hr team')
          expect(r.message.text.toLowerCase()).not.toContain('senior leadership')
          expect(r.message.text.toLowerCase()).not.toContain('idealistic')
          console.log(`NOT_ALONE → ${r.channels[0].name}: ${r.message.text}`)
        })
      },
      testTimeout
    )
  })

  describe('INTEREST_BRIDGE', () => {
    it(
      'surfaces shared interest when multiple participants ask about the same topic',
      async () => {
        const { agent: ag } = await setup([user1, user2, user3])
        await loadPartTimeWorkTranscript(ag.conversation, true)

        const msg1 = await createDirectMessage(
          'How does compensation work for part-time roles?',
          user1,
          ag.conversation,
          getTime(100)
        )
        const msg2 = await createDirectMessage(
          'What about salary bands for part-time employees?',
          user2,
          ag.conversation,
          getTime(110)
        )
        const msg3 = await createDirectMessage(
          'Are part-time workers paid proportionally to full-time?',
          user3,
          ag.conversation,
          getTime(120)
        )

        await prepareMessagesForAgent([msg1, msg2, msg3], ag.conversation, ag)
        const responses = await runCheckin(ag)

        expect(responses.length).toBeGreaterThan(0)
        responses.forEach((r) => {
          expect(r.message.type).toBe('checkin')
          expect(r.message.text.length).toBeGreaterThan(10)
          console.log(`INTEREST_BRIDGE → ${r.channels[0].name}: ${r.message.text}`)
        })
      },
      testTimeout
    )
  })

  describe('TRANSCRIPT_HOOK', () => {
    it(
      'reaches out to a silent participant after a dense transcript section',
      async () => {
        const { agent: ag } = await setup([user1])
        await loadTestTranscript(ag.conversation, denseTranscript, true)

        // user1 has sent no DMs — they are silent.
        // endTime is set to startTime + 2min so the 3-min (180s) lookback window covers the
        // transcript, which is only ~75s long and loaded at the very start of the conversation.
        await prepareMessagesForAgent([], ag.conversation, ag)
        const responses = await runCheckin(ag, getTime(2 * 60))

        if (responses.length > 0) {
          const checkin = findCheckinForUser(responses, user1._id)
          expect(checkin).toBeDefined()
          expect(checkin.message.type).toBe('checkin')
          expect(checkin.message.text.length).toBeGreaterThan(10)
          // Must name a specific topic — not a generic opener
          expect(checkin.message.text.toLowerCase()).not.toMatch(/^(things|a lot|so much) moved fast/)
          console.log(`TRANSCRIPT_HOOK message: ${checkin.message.text}`)
        } else {
          // LLM may legitimately decide silence is right — log and accept
          console.log('TRANSCRIPT_HOOK: no checkin sent (LLM chose silence)')
        }
      },
      testTimeout
    )

    it(
      'does not reach out when transcript is sparse',
      async () => {
        const { agent: ag } = await setup([user1])
        await loadTestTranscript(
          ag.conversation,
          `00:00 | Jessica: Welcome everyone.
00:30 | Jessica: We'll get started in a moment.`,
          true
        )

        await prepareMessagesForAgent([], ag.conversation, ag)
        const responses = await runCheckin(ag, getTime(2 * 60))

        expect(responses).toHaveLength(0)
      },
      testTimeout
    )
  })

  describe('rate limiting', () => {
    it('does not send a checkin when conversation started less than minInterval ago and no prior DMs', async () => {
      const { agent: ag } = await setup([user1])
      ag.agentConfig = { ...ag.agentConfig, minInterval: 10 }

      const getLLMSpy = jest.spyOn(ag, 'getLLM')

      await prepareMessagesForAgent([], ag.conversation, ag)
      // Override startTime to 2 min ago after reload — well within the 10-min minInterval
      ag.conversation.startTime = new Date(Date.now() - 2 * 60 * 1000)
      await runCheckin(ag, new Date())

      // Rate-limit early return must have fired — LLM should never be called
      expect(getLLMSpy).not.toHaveBeenCalled()
    })

    it(
      'is eligible for first checkin after minInterval has passed since conversation start with no prior DMs',
      async () => {
        const { agent: ag } = await setup([user1])
        ag.agentConfig = { ...ag.agentConfig, minInterval: 10 }
        await loadPartTimeWorkTranscript(ag.conversation, true)

        const getLLMSpy = jest.spyOn(ag, 'getLLM')

        // 3 participant messages to make SOCIAL_REASSURANCE eligible
        const msg1 = await createDirectMessage('This is really interesting', user1, ag.conversation, getTime(2 * 60))
        const msg2 = await createDirectMessage('I had no idea about that', user1, ag.conversation, getTime(4 * 60))
        const msg3 = await createDirectMessage('Makes me think about my own work', user1, ag.conversation, getTime(6 * 60))

        await prepareMessagesForAgent([msg1, msg2, msg3], ag.conversation, ag)
        // endTime is 12 min after startTime — past the 10-min minInterval, no prior agent messages
        await runCheckin(ag, getTime(12 * 60))

        // If rate-limited, buildCheckinResponses returns before any LLM call
        expect(getLLMSpy).toHaveBeenCalled()
      },
      testTimeout
    )

    it(
      'does not send a checkin when one was already sent recently',
      async () => {
        const { agent: ag } = await setup([user1])
        // Use default minInterval (10 min) — override the minInterval: 0 set in createCheckinConversation
        ag.agentConfig = { ...ag.agentConfig, minInterval: 10 }
        await loadPartTimeWorkTranscript(ag.conversation, true)

        // 3 participant messages make SOCIAL_REASSURANCE eligible
        const msg1 = await createDirectMessage(
          'Sorry if obvious, but how do handoffs work?',
          user1,
          ag.conversation,
          getTime(60)
        )
        const reply1 = createAgentDirectMessage(
          'Handoff design is about documenting session state.',
          ag,
          user1._id,
          ag.conversation,
          getTime(75)
        )
        const msg2 = await createDirectMessage(
          "I'm probably wrong but wouldn't async accountability cause gaps?",
          user1,
          ag.conversation,
          getTime(180)
        )
        const reply2 = createAgentDirectMessage(
          'Written artifacts make gaps visible rather than hidden.',
          ag,
          user1._id,
          ag.conversation,
          getTime(195)
        )
        const msg3 = await createDirectMessage(
          'Not sure this is worth asking, but does compensation parity work?',
          user1,
          ag.conversation,
          getTime(300)
        )
        const reply3 = createAgentDirectMessage(
          'Worth asking — she pays proportionally to full-time rates.',
          ag,
          user1._id,
          ag.conversation,
          getTime(315)
        )

        // Pre-seed a recent checkin already sent — rate limit should suppress another
        const recentCheckin = createAgentDirectMessage(
          "Nothing here requires certainty. Uncertainty usually means you're paying close attention.",
          ag,
          user1._id,
          ag.conversation,
          getTime(320)
        )

        const getLLMSpy = jest.spyOn(ag, 'getLLM')

        await prepareMessagesForAgent([msg1, reply1, msg2, reply2, msg3, reply3, recentCheckin], ag.conversation, ag)
        // endTime is 80s after the pre-seeded checkin — well within the 10-min minInterval
        await runCheckin(ag, getTime(400))

        // Rate-limit early return must have fired — LLM should never be called
        expect(getLLMSpy).not.toHaveBeenCalled()
      },
      testTimeout
    )
  })

  describe('transcript window', () => {
    it(
      'uses only the transcript window configured in agentConfig.checkinTranscriptWindow',
      async () => {
        const { agent: ag } = await setup([user1, user2])
        await loadPartTimeWorkTranscript(ag.conversation, false)

        // Position at ~14:15 — well into the transcript so a narrow window excludes early content
        const endTime = new Date(startTime.getTime() + 855 * 1000)

        // Override the checkin transcript window — same knob an operator would turn
        ag.agentConfig!.checkinTranscriptWindow = 2 // 2 minutes

        const getTranscriptSpy = jest.spyOn(transcript, 'getTranscript')

        const conversationHistory = getConversationHistory(ag.conversation.messages, {
          channels: ['chat'],
          endTime
        })

        const responses = await defaultAgentTypes.eventAssistant.respond.call(ag, conversationHistory, null)
        expect(Array.isArray(responses)).toBe(true)
        expect(getTranscriptSpy).toHaveBeenCalledWith(ag.conversation, 120, expect.any(Date))
      },
      testTimeout
    )
  })
})

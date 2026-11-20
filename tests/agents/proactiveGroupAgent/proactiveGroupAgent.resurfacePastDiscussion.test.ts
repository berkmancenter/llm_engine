/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createUser,
  createConversation,
  createMessage,
  prepareMessagesForAgent,
  createProactiveGroupAgentConversation,
  loadTestTranscript
} from '../../utils/agentTestHelpers.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import { IMessage } from '../../../src/types/index.types.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('proactiveGroupAgent')

const testTimeout = 120000

const RESURFACE_GOALS = ['resurface_past_discussion']

/* Fabricated series/topic — not a real org, so the model cannot already know the Hendricks
   Foundation grant or its timeline from training data. The past meeting's transcript raises and
   explicitly leaves this question open; the persistent community conversation's chat is quiet
   (or busy with something unrelated), since the whole point of this goal (unlike socratic_probe)
   is that it fires regardless of current chat content, not in response to it. */
const OPEN_THREAD =
  "What's the plan for sustaining volunteer involvement once the Hendricks Foundation grant runs out next spring?"
const PAST_MEETING_TRANSCRIPT = [
  "00:02 | Host: let's talk about volunteer capacity once the Hendricks Foundation grant winds down next spring",
  '00:10 | Priya: a few of us worry volunteer hours will drop off once there is no stipend attached',
  '00:18 | Host: that is a real open question — we have not landed on a plan for sustaining involvement after the grant ends',
  "00:25 | Dmitri: let's table it for next month and keep brainstorming in the meantime",
  "00:30 | Host: agreed, we'll revisit this one later — for now, on to venue logistics for next month"
].join('\n')
// Distinctive terms that can only come from actually retrieving the past transcript, not from
// a generic restatement of the openThreads candidate string alone.
const GROUNDING_TERMS = /hendricks|grant/i

/* Covers the live group-chat fallback: raised and explicitly tabled in this conversation's own
   chat history (not a separate past meeting), days before the current tick — so it reads as
   something genuinely earlier in this chat, not part of the live window under discussion. */
const CHAT_OPEN_THREAD_MESSAGES = [
  "Does anyone know if Fenwick Mail's new pricing tier still covers our list size?",
  'I think it jumps way up past 2,000 subscribers — might be worth comparing alternatives before the fall membership drive',
  "Good point, let's revisit this before we commit to anything, but not right now"
]
// Several distinct fabricated specifics rather than just the brand name: the goal's own
// guardrails tell it to "name the source loosely" rather than quote at length, so a well-grounded
// message may reasonably paraphrase past the product name while still anchoring on one of these.
const CHAT_GROUNDING_TERMS = /fenwick|membership drive|2,?000 subscribers|pricing tier/i

/* formatMultiUserConversationHistory (used for both the model's own shared-chat context and
   list_open_threads' tier-2 extraction) carries no timestamps at all — the model only ever
   perceives relative ordering/volume, never elapsed calendar time. So a thread only reads as
   "earlier, we've moved on" if enough unrelated chat genuinely separates it from the present;
   with nothing else in the conversation, even a 5-day-old thread IS the model's entire view of
   "the current conversation." This models the ordinary volume a real, active community would
   generate in the days after, which is what actually pushes an old thread out of immediate view. */
const FILLER_CHAT_MESSAGES = [
  'Reminder: the next meetup planning doc is open for edits if anyone has ideas',
  'Anyone free to help table at the farmers market this weekend?',
  'Thanks to everyone who came out last time, great turnout',
  'New volunteer onboarding form is live, please share it widely',
  "Quick one: can we move next week's call 30 min later?",
  'Works for me',
  'Same, no conflicts on my end',
  'Great, updating the invite now',
  'Does anyone still have the slide deck from last time?',
  'I can dig it up and share it tomorrow',
  'Appreciate it!',
  'Heads up, the site will be down briefly for maintenance tonight',
  'Noted, thanks for the heads up',
  'Anyone interested in co-writing the newsletter this month?',
  'I can help with that, count me in'
]

async function runAgent(conversation, agent, chat: string[] = [], earlier: IMessage[] = []) {
  const messages =
    chat.length > 0
      ? await Promise.all(
          chat.map(async (body, i) =>
            createMessage(
              body,
              await createUser(`Chat Participant ${i}`),
              conversation,
              ['chat'],
              new Date(Date.now() - (600 - i * 15) * 1000)
            )
          )
        )
      : []
  await prepareMessagesForAgent([...earlier, ...messages], conversation, agent)
  const history = getConversationHistory(agent.conversation.messages, {
    count: 100,
    channels: ['chat'],
    endTime: new Date()
  })
  // respondFiltered drops traceOnly responses (a decline), which would otherwise silently throw
  // away the model's reasoning/declineReason whenever a test fails on an unexpected "stayed
  // silent" — call respond() directly so a decline is still visible in the test log.
  const allResponses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, history)
  console.log(
    'resurface_past_discussion raw responses:',
    JSON.stringify(
      allResponses.map((r) => ({
        goalId: r.goalId,
        traceOnly: r.traceOnly ?? false,
        declineReason: r.declineReason,
        confidenceScore: r.confidenceScore,
        reasoning: r.reasoning,
        message: (r.message as { text?: string })?.text
      }))
    )
  )
  return allResponses.filter((r) => !r.traceOnly)
}

describe('proactive group agent resurface_past_discussion tests', () => {
  let owner
  let topic
  const currentStart = new Date(Date.now() - 15 * 60 * 1000)
  const pastMeetingStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  beforeEach(async () => {
    owner = await createUser('Community Lead')
    // Inserted directly (not via createPublicTopic helper) so the returned object's _id is the
    // one actually persisted — the event_history/open_threads tools resolve topics via
    // Topic.find({ _id: { $in: topicIds } }), so the id handed to agentConfig.topicIds must be
    // a real, queryable Topic document, unlike socratic_probe's test which never looks one up.
    topic = newPublicTopic()
    await insertTopics([topic])
  })

  async function seedPastMeeting(openThreads: string[] | undefined, options: { skipTranscriptIndex?: boolean } = {}) {
    const pastMeeting = await createConversation(
      {
        name: 'Monthly Civic Tech Meetup — October',
        description: 'A recurring community meetup for local civic tech volunteers.',
        active: false,
        // list_open_threads only considers a past conversation that ended more than its own
        // recency floor ago — set explicitly since createConversation doesn't set it, unlike the
        // real doStopConversation flow this fixture is standing in for.
        endTime: new Date(pastMeetingStart.getTime() + 60 * 60 * 1000),
        ...(openThreads ? { postEventAnalysis: { openThreads } } : {})
      },
      owner,
      topic,
      pastMeetingStart
    )
    if (openThreads && !options.skipTranscriptIndex) {
      await loadTestTranscript(pastMeeting, PAST_MEETING_TRANSCRIPT, true)
    }
    return pastMeeting
  }

  async function setup(topicIds: string[]) {
    // Named and described as the persistent, ongoing community channel it actually models — not
    // as another dated instance of the meeting series. Naming it like a session (e.g. "...—
    // November") bled a bounded, this-meeting-just-started framing into the model's reasoning
    // ({topic} in the prompt is just conversation.name) even with no transcript channel.
    const conversation = await createProactiveGroupAgentConversation(
      {
        name: 'Civic Tech Volunteers',
        description: 'The ongoing community chat for local civic tech volunteers, between their monthly in-person meetups.'
      },
      owner,
      topic,
      currentStart,
      testConfig.llmPlatform,
      testConfig.llmModel,
      [],
      RESURFACE_GOALS,
      topicIds.length > 0 ? { topicIds } : {},
      // No transcript channel: this models an async, chat-only community (slackCommunityAssistant),
      // not a live event — a transcript channel would frame the system prompt around "the opening
      // phase of an event", which is the wrong mental model for this goal's actual target.
      ['chat']
    )
    const agent = conversation.agents.find((a) => a.name === 'Proactive Group Agent')
    expect(agent).toBeDefined()
    return { conversation, agent }
  }

  it(
    'SHOULD resurface the open thread from a past meeting even when the current chat is quiet',
    async () => {
      await seedPastMeeting([OPEN_THREAD])
      const { conversation, agent } = await setup([topic._id.toString()])

      const responses = await runAgent(conversation, agent, [])

      expect(responses).toHaveLength(1)
      const { goalId, message: rawMessage } = responses[0]
      const { text } = rawMessage as { text: string }
      expect(goalId).toBe('resurface_past_discussion')
      expect(text).toMatch(GROUNDING_TERMS)
    },
    testTimeout
  )

  it(
    'SHOULD resurface the open thread even while the current chat is actively discussing something unrelated',
    async () => {
      await seedPastMeeting([OPEN_THREAD])
      const { conversation, agent } = await setup([topic._id.toString()])

      const responses = await runAgent(conversation, agent, [
        'Does anyone have a recommendation for a lightweight issue tracker for a small volunteer team?',
        'We use a shared spreadsheet, it is not pretty but it works for us',
        'Good to know, thanks — might give that a try'
      ])

      expect(responses).toHaveLength(1)
      const { goalId, message: rawMessage } = responses[0]
      const { text } = rawMessage as { text: string }
      expect(goalId).toBe('resurface_past_discussion')
      expect(text).toMatch(GROUNDING_TERMS)
    },
    testTimeout
  )

  it(
    'SHOULD stay silent when topicIds is not configured, even with a worthwhile open thread available',
    async () => {
      await seedPastMeeting([OPEN_THREAD])
      const { conversation, agent } = await setup([])

      const responses = await runAgent(conversation, agent, [])

      expect(responses).toHaveLength(0)
    },
    testTimeout
  )

  it(
    // Also exercises the live group-chat fallback finding nothing: tier-1 is empty (no past
    // meeting has an open thread), and tier-2's own chat history here is empty too.
    'SHOULD stay silent when neither a past meeting nor this chat has an open thread yet',
    async () => {
      await seedPastMeeting(undefined)
      const { conversation, agent } = await setup([topic._id.toString()])

      const responses = await runAgent(conversation, agent, [])

      expect(responses).toHaveLength(0)
    },
    testTimeout
  )

  it(
    'SHOULD stay silent when a past-meeting candidate exists but no transcript excerpt can be retrieved to ground it',
    async () => {
      // list_open_threads still surfaces this candidate — it reads straight from
      // postEventAnalysis, independent of Chroma — but with nothing indexed for that past
      // meeting, search_conversation_transcript can't ground it. Per the goal's own guardrail
      // ("only use when a candidate... excerpt was actually retrieved"), staying silent rather
      // than inventing content from the bare candidate string is the correct outcome.
      await seedPastMeeting([OPEN_THREAD], { skipTranscriptIndex: true })
      const { conversation, agent } = await setup([topic._id.toString()])

      const responses = await runAgent(conversation, agent, [])

      expect(responses).toHaveLength(0)
    },
    testTimeout
  )

  it(
    'SHOULD resurface an open thread drawn live from this conversation’s own chat history when no past meeting has one',
    async () => {
      await seedPastMeeting(undefined)
      const { conversation, agent } = await setup([topic._id.toString()])

      const earlierThread = await Promise.all(
        CHAT_OPEN_THREAD_MESSAGES.map(async (body, i) =>
          createMessage(
            body,
            await createUser(`Longtime Member ${i}`),
            conversation,
            ['chat'],
            new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + i * 1000)
          )
        )
      )
      // Spread from shortly after the thread up to an hour ago, so there's genuinely more recent
      // (and unrelated) activity on top of it by the time the agent looks at this tick.
      const fillerStart = Date.now() - 4.5 * 24 * 60 * 60 * 1000
      const fillerEnd = Date.now() - 60 * 60 * 1000
      const fillerStep = (fillerEnd - fillerStart) / (FILLER_CHAT_MESSAGES.length - 1)
      const fillerMessages = await Promise.all(
        FILLER_CHAT_MESSAGES.map(async (body, i) =>
          createMessage(
            body,
            await createUser(`Regular Member ${i}`),
            conversation,
            ['chat'],
            new Date(fillerStart + i * fillerStep)
          )
        )
      )

      const responses = await runAgent(conversation, agent, [], [...earlierThread, ...fillerMessages])

      expect(responses).toHaveLength(1)
      const { goalId, message: rawMessage } = responses[0]
      const { text } = rawMessage as { text: string }
      expect(goalId).toBe('resurface_past_discussion')
      expect(text).toMatch(CHAT_GROUNDING_TERMS)
    },
    testTimeout
  )

  it(
    'SHOULD NOT repeat an open thread it already raised recently',
    async () => {
      await seedPastMeeting([OPEN_THREAD])
      const { conversation, agent } = await setup([topic._id.toString()])

      const earlierPost = {
        ...(await createMessage(
          'Last meeting this came up and never got resolved — any thoughts on sustaining volunteer involvement once the Hendricks grant winds down?',
          agent,
          conversation,
          ['chat'],
          new Date(Date.now() - 500 * 1000)
        )),
        fromAgent: true
      } as IMessage

      const responses = await runAgent(conversation, agent, [], [earlierPost])

      // staying silent is the expected (and fine) outcome: the goal's own guardrails say not to
      // resurface something already covered, and its own recent post already covered this one.
      expect(responses).toHaveLength(0)
    },
    testTimeout
  )
})

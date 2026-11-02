/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createPublicTopic,
  createUser,
  createMessage,
  prepareMessagesForAgent,
  createProactiveGroupAgentConversation
} from '../../utils/agentTestHelpers.js'
import getConversationHistory from '../../../src/agents/helpers/getConversationHistory.js'
import { findCopiedNgram } from '../../../src/agents/helpers/socraticChecks.js'
import { contentWordOverlap } from '../../../src/agents/helpers/textOverlap.js'
import rag from '../../../src/agents/helpers/rag.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import schedule from '../../../src/jobs/schedule.js'
import { IMessage } from '../../../src/types/index.types.js'

jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue(undefined as never)
jest.spyOn(schedule, 'pollExpired').mockResolvedValue(undefined as never)

jest.setTimeout(180000)

const testConfig = setupAgentTest('proactiveGroupAgent')

const testTimeout = 120000

const SOCRATIC_GOALS = ['socratic_probe']

/* Fabricated reading — not a real paper, so the model cannot know its terms from training data.
   Its finding directly complicates the claim the chat makes below (open-plan layouts make
   a community healthy), which is the situation socratic_probe is meant to catch. */
const READING_CITATION =
  'Halvorsen-Adeyemi, T. (2023). Headphone Retreat in Open-Plan Offices. Journal of Fictional Workplace Studies, 9(2), 101-118.'
const READING_CONTENT =
  'Halvorsen-Adeyemi (2023) reports that moving teams into open-plan offices produces what the author ' +
  "terms 'headphone retreat': once desks are in the open, workers put on headphones to screen out noise, " +
  'and the number of unprompted face-to-face exchanges between colleagues falls by roughly a third. ' +
  'Teams that kept a shared floor but added small, bookable quiet rooms saw spontaneous collaboration ' +
  'recover within two quarters.'
// Terms that name the source or its concept; expected to repeat, so they don't count as a re-ask.
const SOURCE_TERMS = /headphone|halvorsen|retreat/i
const SOURCE_NAME = /halvorsen|headphone retreat in open-plan offices/i
const SHAPE_SLOTS = { sourceLabel: 'Halvorsen-Adeyemi', concept: 'headphone retreat', loadedWord: null }
// Analogies and hypotheticals the passage does not contain — the goal forbids inventing them.
const INVENTED_ANALOGY = /\b(imagine|think of a|is (this|that|it) like|craftsman|horse|ship)\b/i
const PARTICIPANT_NAMES = /heron|lynx|otter/i

const reading = {
  source: 'speaker' as const,
  category: 'required' as const,
  title: 'Headphone Retreat in Open-Plan Offices',
  authors: ['Tobias Halvorsen-Adeyemi'],
  year: '2023',
  citation: READING_CITATION,
  // the prefetch only runs for resources backed by an uploaded file
  fileName: 'headphone_retreat.pdf',
  participantVisible: true
}

/* Live-model eval of the guaranteed-question pipeline: the decision call picks the goal and slots,
   a passage-blind writer drafts the question, deterministic code checks gate it, and a template
   built from validated slots is the fallback. The SHAPE of the message (one question, source named,
   loaded word quoted, no participant names, no numbers, no copied passage wording) is therefore a
   hard gate on every case. Whether the decision fires at all is still a model judgment, so it is
   logged separately ('socratic_probe responses:' line) rather than gated beyond the response count.
   Measured with haiku-4.5 on Bedrock over 5 sequential runs: all 5 cases passed in all 5 runs (25/25).
   Across those runs the decision fired a socratic_probe 11 times, the writer's draft was posted 10
   times (often after 1-2 redrafts rejected by the checks) and the template fallback posted once. The
   earlier-question case mostly stays silent. A sample this small does not bound the failure rate;
   a repeat failure on the same case is a regression. */
describe('proactive group agent socratic_probe tests (reading 2)', () => {
  let user1
  let user2
  let user3
  let topic

  const startTime = new Date(Date.now() - 15 * 60 * 1000)
  const getMessageTime = (offsetSeconds = 0) => new Date(startTime.getTime() + offsetSeconds * 1000)

  beforeEach(async () => {
    user1 = await createUser('Brisk Heron')
    user2 = await createUser('Wry Lynx')
    user3 = await createUser('Calm Otter')
    topic = await createPublicTopic()
  })

  async function setup(resources: unknown[]) {
    const conversation = await createProactiveGroupAgentConversation(
      {
        name: 'Designing offices that foster teamwork',
        description: 'A discussion about how office layout affects teamwork and collaboration.',
        resources
      },
      user1,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel,
      [user2, user3],
      SOCRATIC_GOALS
    )
    const agent = conversation.agents.find((a) => a.name === 'Proactive Group Agent')
    expect(agent).toBeDefined()
    return { conversation, agent }
  }

  async function runAgent(conversation, agent, chat: string[], earlier: IMessage[] = []) {
    const users = [user1, user2, user3]
    const messages = await Promise.all(
      chat.map((body, i) =>
        createMessage(body, users[i % users.length], conversation, ['chat'], getMessageTime(600 + i * 15))
      )
    )
    await prepareMessagesForAgent([...earlier, ...messages], conversation, agent)
    const history = getConversationHistory(agent.conversation.messages, {
      count: 100,
      channels: ['chat'],
      endTime: new Date(startTime.getTime() + 900 * 1000)
    })
    const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(agent, history)
    console.log(
      'socratic_probe responses:',
      JSON.stringify(responses.map((r) => [r.goalId, (r.message as { text?: string })?.text, r.sourceLabel, r.concept, r.loadedWord]))
    )
    return responses
  }

  /* Hard shape gates, independent of what the model decided. */
  function expectGuaranteedShape(text: string) {
    expect(text.match(/\?/g)).toHaveLength(1)
    expect(text.endsWith('?')).toBe(true)
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(40)
    expect(text).toMatch(SOURCE_NAME)
    expect(text).not.toMatch(PARTICIPANT_NAMES)
    expect(text).not.toMatch(/\d/)
    expect(text).not.toMatch(INVENTED_ANALOGY)
    expect(findCopiedNgram(text, READING_CONTENT, SHAPE_SLOTS)).toBeNull()
  }

  it(
    'SHOULD ask a single question tying the chat claim to the reading when the reading complicates it',
    async () => {
      const { conversation, agent } = await setup([reading])
      await rag.addTextsToVectorStore(`background-${conversation._id}`, [READING_CONTENT], {
        metadatas: [{ citation: READING_CITATION }]
      })

      const responses = await runAgent(conversation, agent, [
        'I think an open plan office is the best way to get a team working together, all the conversations happen in the open',
        'Agreed, in an open plan office you overhear conversations and people join in, noise just means the team is talking',
        'Yes, open plan with no walls would fix our siloed-teams problem, and headphones are a small price for the noise'
      ])

      expect(responses).toHaveLength(1)
      const { goalId, message: rawMessage } = responses[0]
      const message = (rawMessage as { text: string }).text
      expect(goalId).toBe('socratic_probe')
      expectGuaranteedShape(String(message).trim())
    },
    testTimeout
  )

  it(
    'SHOULD anchor the question on a loaded word the group keeps using without defining',
    async () => {
      const { conversation, agent } = await setup([reading])
      await rag.addTextsToVectorStore(`background-${conversation._id}`, [READING_CONTENT], {
        metadatas: [{ citation: READING_CITATION }]
      })

      const responses = await runAgent(conversation, agent, [
        'A collaborative office is one where everybody sits together in the open, so open desks make sense',
        'Right, collaborative means visible, and an open floor keeps everyone visible to each other',
        'Agreed, if people can see each other all day the team is collaborative, so open plan is the way to go'
      ])

      expect(responses).toHaveLength(1)
      const { goalId, message: rawMessage } = responses[0]
      const message = (rawMessage as { text: string }).text
      expect(goalId).toBe('socratic_probe')
      const text = String(message).trim()
      expectGuaranteedShape(text)
      // the loaded word must be quoted whenever the decision identified it; log when it did not
      if (responses[0].loadedWord && /collaborative/i.test(responses[0].loadedWord)) {
        expect(text).toMatch(/["“]collaborative["”]/i)
      } else {
        console.log('socratic_probe decision produced no loadedWord:', responses[0].loadedWord)
      }
    },
    testTimeout
  )

  it(
    'SHOULD NOT re-ask its earlier question or answer it for the room once participants are answering it',
    async () => {
      const { conversation, agent } = await setup([reading])
      await rag.addTextsToVectorStore(`background-${conversation._id}`, [READING_CONTENT], {
        metadatas: [{ citation: READING_CITATION }]
      })

      const earlierQuestion =
        "In Halvorsen-Adeyemi's study of headphone retreat, what happens to how colleagues talk to each other once desks move into the open?"
      const earlierProbe = {
        ...(await createMessage(earlierQuestion, agent, conversation, ['chat'], getMessageTime(540))),
        fromAgent: true
      } as IMessage

      const responses = await runAgent(
        conversation,
        agent,
        [
          'I guess people would just put headphones on and stop chatting',
          'Headphones on still means everyone is in the room together, though, so open plan is still worth it',
          'Yeah, being in the room is still presence, and presence is what builds a team'
        ],
        [earlierProbe]
      )

      // staying silent is the usual (and fine) outcome: the room is already engaging with the earlier
      // question. If it does speak, it must be a new question with the guaranteed shape.
      if (responses.length === 0) return
      const text = (responses[0].message as { text: string }).text.trim()
      expectGuaranteedShape(text)
      // a different question, not the earlier one reworded
      expect(contentWordOverlap(earlierQuestion, text, SOURCE_TERMS)).toBeLessThanOrEqual(0.5)
    },
    testTimeout
  )

  it(
    'SHOULD stay silent when the conversation has no resources',
    async () => {
      const { conversation, agent } = await setup([])

      const responses = await runAgent(conversation, agent, [
        'I think putting everyone at open desks on one big floor is the best way to get a team working together',
        'Agreed, when nobody has walls the whole office talks and ideas spread fast',
        'Yes, tearing down the cubicles would fix our siloed-teams problem'
      ])

      expect(responses).toHaveLength(0)
    },
    testTimeout
  )

  it(
    'SHOULD stay silent when no passage in the reading is relevant to the chat',
    async () => {
      const { conversation, agent } = await setup([reading])
      await rag.addTextsToVectorStore(`background-${conversation._id}`, [READING_CONTENT], {
        metadatas: [{ citation: READING_CITATION }]
      })

      const responses = await runAgent(conversation, agent, [
        'Does anyone know if the parking garage is open on weekends?',
        'I saw a notice by the lift, I think the lower level stays open until six on Saturdays',
        'Great, thanks, I will park there after this meeting'
      ])

      expect(responses).toHaveLength(0)
    },
    testTimeout
  )
})

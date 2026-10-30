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
   Its finding directly complicates the claim the chat makes below (mandatory posting quotas keep
   a community healthy), which is the situation socratic_probe is meant to catch. */
const READING_CITATION =
  'Okonkwo-Reyes, M. (2024). Quota Crowding in Volunteer Forums. Journal of Fictional Platform Studies, 12(3), 44-61.'
const READING_CONTENT =
  'Okonkwo-Reyes (2024) reports that mandatory posting quotas in volunteer forums produce what she ' +
  "terms 'quota crowding': once members must post a minimum number of times per week, the share of " +
  'substantive replies falls by roughly a third, because members satisfy the quota with short, low-effort ' +
  'posts. Communities that dropped quotas and instead recognized thoughtful contributions saw ' +
  'participation recover within two quarters.'
const READING_KEY_TERMS = /quota|okonkwo|crowding/i
// Analogies and hypotheticals the passage does not contain — the goal forbids inventing them.
const INVENTED_ANALOGY = /\b(imagine|think of a|is (this|that|it) like|craftsman|horse|ship)\b/i
const PARTICIPANT_NAMES = /badger|fox|owl/i

const reading = {
  source: 'speaker' as const,
  category: 'required' as const,
  title: 'Quota Crowding in Volunteer Forums',
  authors: ['Mira Okonkwo-Reyes'],
  year: '2024',
  citation: READING_CITATION,
  // the prefetch only runs for resources backed by an uploaded file
  fileName: 'quota_crowding.pdf',
  participantVisible: true
}

/* Live-model eval: each case is nondeterministic. Measured with haiku-4.5 on Bedrock over 20 runs per
   case: question tied to the reading 16/20 (misses restate the finding or mention "substantive
   replies"), loaded word quoted 14/20 (misses still ask a grounded question without the word), earlier
   question not re-asked or answered for the room 14/20 (mostly by staying silent; misses counter the
   room with the reading's finding), both stay-silent cases 20/20. An earlier 5/5 per case was
   optimistic. Expect the occasional red run; a repeat failure on the same case is a regression. */
describe('proactive group agent socratic_probe tests', () => {
  let user1
  let user2
  let user3
  let topic

  const startTime = new Date(Date.now() - 15 * 60 * 1000)
  const getMessageTime = (offsetSeconds = 0) => new Date(startTime.getTime() + offsetSeconds * 1000)

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    user2 = await createUser('Thoughtful Fox')
    user3 = await createUser('Skeptical Owl')
    topic = await createPublicTopic()
  })

  async function setup(resources: unknown[]) {
    const conversation = await createProactiveGroupAgentConversation(
      {
        name: 'Keeping online communities healthy',
        description: 'A discussion about what keeps volunteer-run online communities active and healthy.',
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
    console.log('socratic_probe responses:', JSON.stringify(responses.map((r) => [r.goalId, r.message])))
    return responses
  }

  it(
    'SHOULD ask a single question tying the chat claim to the reading when the reading complicates it',
    async () => {
      const { conversation, agent } = await setup([reading])
      await rag.addTextsToVectorStore(`background-${conversation._id}`, [READING_CONTENT], {
        metadatas: [{ citation: READING_CITATION }]
      })

      const responses = await runAgent(conversation, agent, [
        'I think requiring everyone to post at least three times a week is the best way to keep a community healthy',
        'Agreed, posting quotas keep people accountable and the forum stays busy',
        'Yes, a minimum number of posts per member would fix our quiet-forum problem'
      ])

      expect(responses).toHaveLength(1)
      const { goalId, message } = responses[0]
      expect(goalId).toBe('socratic_probe')
      const text = String(message).trim()
      // exactly one question, and it is the final sentence
      expect(text.match(/\?/g)).toHaveLength(1)
      expect(text.endsWith('?')).toBe(true)
      // question-first: whatever precedes the final sentence is at most one short clause, so the
      // message cannot restate the reading's finding as a statement before asking
      const sentences = text.split(/(?<=[.!?])\s+/)
      const lead = sentences.slice(0, -1).join(' ')
      expect(sentences.length).toBeLessThanOrEqual(2)
      expect(lead.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(25)
      // does not report the reading's finding (the numbers/outcome) - it only asks
      expect(text).not.toMatch(/third|two quarters|recover|low-effort|substantive replies/i)
      // grounded in the passage
      expect(text).toMatch(READING_KEY_TERMS)
      expect(text.split(/\s+/).length).toBeLessThanOrEqual(60)
      // no analogy or hypothetical the passage itself doesn't contain
      expect(text).not.toMatch(INVENTED_ANALOGY)
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
        'A healthy forum is one where every member posts every week, so a posting quota makes sense',
        'Right, healthy means busy, and a minimum number of posts per week keeps it busy',
        'Agreed, if the post count goes up the community is healthy, so the quota is the way to go'
      ])

      expect(responses).toHaveLength(1)
      const { goalId, message } = responses[0]
      expect(goalId).toBe('socratic_probe')
      const text = String(message).trim()
      expect(text).toMatch(/healthy/i)
      expect(text).toMatch(READING_KEY_TERMS)
      expect(text.match(/\?/g)).toHaveLength(1)
      // quotes the word, never who said it
      expect(text).not.toMatch(PARTICIPANT_NAMES)
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
        "In Okonkwo-Reyes's study of quota crowding, what happens to the kind of posts people write once posting is required?"
      const earlierProbe = {
        ...(await createMessage(earlierQuestion, agent, conversation, ['chat'], getMessageTime(540))),
        fromAgent: true
      } as IMessage

      const responses = await runAgent(
        conversation,
        agent,
        [
          'I guess people would just post short filler to hit the number',
          'Filler posts still make the forum look alive, though, so the quota is still worth it',
          'Yeah, filler is still activity, and activity is what keeps people coming back'
        ],
        [earlierProbe]
      )

      // staying silent is the usual (and fine) outcome: the room is already engaging with the earlier
      // question. If it does speak, it must be a new question about their answers, not the finding.
      if (responses.length === 0) return
      const text = String(responses[0].message).trim()
      // content words only: naming the same source again is expected, so its terms don't count
      const words = (s: string) =>
        new Set(
          (s.toLowerCase().match(/[a-z'-]{4,}/g) ?? []).filter(
            (w) => !READING_KEY_TERMS.test(w) && !/^(study|reading|what|does|would|when|that|this)$/.test(w)
          )
        )
      const earlierWords = words(earlierQuestion)
      const newWords = words(text)
      const shared = [...earlierWords].filter((w) => newWords.has(w)).length
      // a different question, not the earlier one reworded
      expect(shared / earlierWords.size).toBeLessThanOrEqual(0.5)
      // builds on what the room answered
      expect(text).toMatch(/filler|short|alive|activity|number/i)
      // still one question, and still never hands over the reading's finding
      expect(text.match(/\?/g)).toHaveLength(1)
      expect(text).not.toMatch(/third|two quarters|recover|low-effort|substantive replies/i)
    },
    testTimeout
  )

  it(
    'SHOULD stay silent when the conversation has no resources',
    async () => {
      const { conversation, agent } = await setup([])

      const responses = await runAgent(conversation, agent, [
        'I think requiring everyone to post at least three times a week is the best way to keep a community healthy',
        'Agreed, posting quotas keep people accountable and the forum stays busy',
        'Yes, a minimum number of posts per member would fix our quiet-forum problem'
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
        'Does anyone know if the venue has vegetarian lunch options today?',
        'I saw a sign near the registration desk, I think there is a sandwich bar on the second floor',
        'Great, thanks, I will head over after this session'
      ])

      expect(responses).toHaveLength(0)
    },
    testTimeout
  )
})

/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createUser, createPublicTopic, createConversation, createMessage } from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import rag from '../../../src/agents/helpers/rag.js'
import { ConversationHistory } from '../../../src/types/index.types.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('communityAssistant')

const BOT_NAME = 'Berkie'
const testTimeout = 120000

/* Fabricated reading — not a real paper, so a grounded reply can only come from retrieval. */
const READING_CITATION =
  'Okonkwo-Reyes, M. (2024). Quota Crowding in Volunteer Forums. Journal of Fictional Platform Studies, 12(3), 44-61.'
const READING_CONTENT =
  'Okonkwo-Reyes (2024) reports that mandatory posting quotas in volunteer forums produce what she ' +
  "terms 'quota crowding': once members must post a minimum number of times per week, the share of " +
  'substantive replies falls by roughly a third, because members satisfy the quota with short, low-effort ' +
  'posts. Communities that dropped quotas and instead recognized thoughtful contributions saw ' +
  'participation recover within two quarters.'
const reading = {
  source: 'speaker' as const,
  category: 'required' as const,
  title: 'Quota Crowding in Volunteer Forums',
  authors: ['Mira Okonkwo-Reyes'],
  year: '2024',
  citation: READING_CITATION
}

function buildHistory(messages): ConversationHistory {
  return {
    start: new Date(Date.now() - 60 * 60 * 1000),
    end: new Date(),
    messages
  }
}

/* Live-model eval: each case is nondeterministic. Measured with haiku-4.5 on Bedrock over 15 runs per
   case: agree-with-a-claim 100%, "what does the reading say" 100%, straight answer 100%, follow-up on
   an answer ~75% (misses open with an acknowledgement instead of a question, or drop the reading),
   "I don't know" ~60% (misses restate the reading's finding or skip the question). Expect the
   occasional red run, mostly in the last two cases; a repeat failure on the same case is a
   regression. */
describe('communityAssistant socratic personality', () => {
  let agent
  let conversation
  let user1

  beforeEach(async () => {
    user1 = await createUser('Curious Badger')
    const topic = await createPublicTopic()

    conversation = await createConversation(
      { name: 'Community Assistant Socratic Personality Test', resources: [reading] },
      user1,
      topic
    )
    const testAgent = new Agent({
      agentType: 'communityAssistant',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { botName: BOT_NAME, personality: 'socratic' }
    })
    const channels = await Channel.create([{ name: 'chat' }])
    conversation.channels.push(...channels)
    await testAgent.save()
    conversation.agents.push(testAgent)
    await conversation.save()
    await testAgent.start()
    agent = testAgent

    await rag.addTextsToVectorStore(`background-${conversation._id}`, [READING_CONTENT], {
      metadatas: [{ citation: READING_CITATION }]
    })
  })

  /* The reading's own key terms. The prompt never names this (fictional) reading, so a reply can only
     use them by retrieving it or by citing the room's resource list. */
  const READING_TERMS = /okonkwo|crowding/i

  function splitSentences(reply: string): string[] {
    return reply.trim().split(/(?<=[.!?])\s+/)
  }

  /* True when the first sentence-ending mark in the reply is a "?" — robust to a question that runs
     straight into a dash or quote ("...or volume?—Okonkwo-Reyes's study...") without whitespace. */
  function opensWithQuestion(reply: string): boolean {
    return /^[^.!?]*\?/.test(reply.trim())
  }

  async function ask(body: string, earlier: unknown[] = []): Promise<string> {
    console.log(`Q: ${body}`)
    const msg = await createMessage(body, user1, conversation, ['chat'])
    const responses = await defaultAgentTypes.communityAssistant.respond.call(agent, buildHistory(earlier), msg)
    console.log(`A: ${responses[0]?.message}`)
    expect(responses).toHaveLength(1)
    return String(responses[0].message)
  }

  /* An earlier exchange in the chat: the person's claim, then the bot's question about it. */
  async function earlierExchange() {
    const claim = await createMessage(
      `@${BOT_NAME} I think mandatory posting quotas are the best way to keep a forum active.`,
      user1,
      conversation,
      ['chat'],
      new Date(Date.now() - 2 * 60 * 1000)
    )
    const question = {
      ...(await createMessage(
        "What do you think a posting quota does to the kind of posts people write, in Okonkwo-Reyes's study of quota crowding?",
        user1,
        conversation,
        ['chat'],
        new Date(Date.now() - 60 * 1000)
      )),
      fromAgent: true,
      pseudonym: BOT_NAME
    }
    return [claim, question]
  }

  it(
    'leads with a question grounded in the seeded reading when asked to agree with a claim',
    async () => {
      const reply = await ask(
        `@${BOT_NAME} I think mandatory posting quotas are the best way to keep a forum active. Don't you agree?`
      )
      expect(opensWithQuestion(reply)).toBe(true)
      expect(reply).toMatch(READING_TERMS)
    },
    testTimeout
  )

  it(
    'leads with a question, not a summary, when asked what the reading says (search_resources path)',
    async () => {
      const reply = await ask(`@${BOT_NAME} What does the reading say about posting quotas?`)
      expect(opensWithQuestion(reply)).toBe(true)
      expect(reply).toMatch(READING_TERMS)
    },
    testTimeout
  )

  it(
    'gives a brief answer first, then a testing question, when explicitly asked for a straight answer',
    async () => {
      const reply = await ask(
        `@${BOT_NAME} Just give me a straight answer: do posting quotas improve forum participation, yes or no?`
      )
      const sentences = splitSentences(reply)
      // answer first: the opening sentence is a statement, not a deflecting question
      expect(opensWithQuestion(reply)).toBe(false)
      // brief: answer + question (+ at most one more sentence), never a lecture
      expect(sentences.length).toBeLessThanOrEqual(3)
      // then a question that brings the reading in
      expect(sentences.slice(1).some((s) => s.includes('?'))).toBe(true)
      expect(reply).toMatch(READING_TERMS)
    },
    testTimeout
  )

  it(
    'follows up on an answer to its earlier question by probing a key word the person just used',
    async () => {
      const reply = await ask(
        `@${BOT_NAME} I think a quota keeps people accountable: if you have to show up, you're accountable to the group.`,
        await earlierExchange()
      )
      expect(opensWithQuestion(reply)).toBe(true)
      // stays on the person's own key idea (accountable / accountability, or their "show up" phrasing)
      expect(reply).toMatch(/accountab|show(ing)? up/i)
      // brings the reading in by name, or at least points at it
      expect(reply).toMatch(/okonkwo|crowding|\b(study|reading|paper|research)\b/i)
    },
    testTimeout
  )

  it(
    'treats "I don\'t know" as progress: asks a smaller question instead of supplying the reading\'s finding',
    async () => {
      const reply = await ask(`@${BOT_NAME} honestly, I don't know`, await earlierExchange())
      expect(opensWithQuestion(reply)).toBe(true)
      // never fills the gap with the reading's findings
      expect(reply).not.toMatch(/third|two quarters|recover|low-effort|substantive replies/i)
    },
    testTimeout
  )
})

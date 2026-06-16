import setupAgentTest from '../../utils/setupAgentTest.js'
import createAgentPoll from '../../../src/agents/helpers/agentPoll.js'
import { Agent } from '../../../src/models/index.js'
import Conversation from '../../../src/models/conversation.model.js'
import { Poll, PollChoice } from '../../../src/models/poll.model/index.js'
import { registeredUser, insertUsers } from '../../fixtures/user.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { publicTopic, conversationAgentsEnabled } from '../../fixtures/conversation.fixture.js'
import { setAgentTypes } from '../../../src/models/user.model/agent.model/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import schedule from '../../../src/jobs/schedule.js'
import WHEN_RESULTS_VISIBLE from '../../../src/models/poll.model/constants.js'

jest.setTimeout(60000)

const testAgentTypes = {
  pollAgent: {
    respond: jest.fn(),
    evaluate: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    name: 'Test Poll Agent',
    description: 'Minimal agent for testing poll creation',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 60 } },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: {},
    defaultLLMPlatform,
    defaultLLMModel
  }
}

setupAgentTest()

beforeAll(() => {
  setAgentTypes(testAgentTypes)
})

beforeEach(async () => {
  jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue(undefined as never)
  jest.spyOn(schedule, 'pollExpired').mockResolvedValue(undefined as never)
  await insertUsers([registeredUser])
  await insertTopics([publicTopic])
  await new Conversation(conversationAgentsEnabled).save()
})

afterEach(() => {
  jest.restoreAllMocks()
})

async function makeAgent() {
  const agent = new Agent({
    agentType: 'pollAgent',
    conversation: conversationAgentsEnabled._id,
    active: true
  })
  await agent.save()
  return agent
}

const POLL_REVEAL_CONFIG = {
  multiSelect: false,
  allowNewChoices: false,
  choicesVisible: true,
  responseCountsVisible: true,
  responsesVisible: true,
  responsesVisibleToNonParticipants: true,
  onlyOwnChoicesVisible: false,
  whenResultsVisible: WHEN_RESULTS_VISIBLE.ALWAYS
}

// Matches the structure of interventionAnalysis.context produced by runInterventionAnalysis:
// the rendered user prompt (transcript, chat history, RAG chunks) — no system prompt.
//
// Scenario: ~8 minutes in, Jessica has been presenting hiring statistics and a personal
// success story. The room has mostly been quiet — one participant reacted to the surprising
// hiring numbers. The agent decides POLL_REVEAL based on its own analysis, not because
// the context makes the poll topic obvious. The retrieved chunks reflect what little chat
// existed (a question about hiring), not any hint of poll-worthy options — because the RAG
// search happens before intervention type is known.
const MOCK_CONTEXT = `## Event Topic:
Why your company should consider part-time work

## Recent Transcript (last 10 minutes):
06:45 | Jessica: consider these statistics caregivers one in five us adults identifies as a caregiver six out of 10 of them report cutting work hours taking leaves of absence or receiving performance warnings as a result
07:04 | Jessica: and again that's 53 million people single parents like I said I'm one of them comprise 25 to 30% of us households with children under 18
07:18 | Jessica: people with disabilities account for over 44 million people in the United States and we cannot forget those who are primary parents in two parent households
07:52 | Jessica: a couple of years ago when I put together the job description for a marketing coordinator I came up with about 10 hours per week
08:05 | Jessica: my sister and I discussed increasing the role to 20 hours per week but we thought who in the heck would want to work only 10 hours per week
08:22 | Jessica: we were absolutely shocked we had hundreds of applicants from all over the country from incredibly high level individuals
08:38 | Jessica: this was a position we felt was entry level but we had applicants working as key Marketing Executives for Fortune 500 companies apply

## Retrieved Relevant Context from Transcript:
07:52 | Jessica: a couple of years ago when I put together the job description for a marketing coordinator I came up with about 10 hours per week
08:22 | Jessica: we were absolutely shocked we had hundreds of applicants from all over the country

## Private Messages (Direct Messages):
No private messages.

## Shared Chat History:
Curious Badger: hundreds of applicants for a 10 hour/week job? that's surprising

## Your Recent Posts:
None`

describe('createAgentPoll', () => {
  test('creates a poll in the database and returns pollId and intro text', async () => {
    const agent = await makeAgent()

    // focus and context mirror what executePollReveal passes:
    // focus = interventionAnalysis.detectedPattern (the first LLM's interpretation)
    // context = interventionAnalysis.context (rendered system + user prompt seen by first LLM)
    const result = await createAgentPoll.call(
      agent,
      'Room quiet during statistics-heavy section — good moment to surface where participants stand on part-time hiring',
      MOCK_CONTEXT,
      POLL_REVEAL_CONFIG
    )

    expect(result).not.toBeNull()
    expect(result).toHaveProperty('pollId')
    expect(result).toHaveProperty('text')
    expect(typeof result!.text).toBe('string')
    expect(result!.text.length).toBeGreaterThan(0)
    expect(result.type).toBe('poll')

    const poll = await Poll.findById(result!.pollId)
    expect(poll).not.toBeNull()
    expect(poll!.title).toBeTruthy()

    expect(poll!.multiSelect).toBe(POLL_REVEAL_CONFIG.multiSelect)
    expect(poll!.choicesVisible).toBe(POLL_REVEAL_CONFIG.choicesVisible)
    expect(poll!.responseCountsVisible).toBe(POLL_REVEAL_CONFIG.responseCountsVisible)
    expect(poll!.responsesVisible).toBe(POLL_REVEAL_CONFIG.responsesVisible)
    expect(poll!.responsesVisibleToNonParticipants).toBe(POLL_REVEAL_CONFIG.responsesVisibleToNonParticipants)
    expect(poll!.onlyOwnChoicesVisible).toBe(POLL_REVEAL_CONFIG.onlyOwnChoicesVisible)
    expect(poll!.whenResultsVisible).toBe(POLL_REVEAL_CONFIG.whenResultsVisible)

    const choices = await PollChoice.find({ poll: result!.pollId })
    expect(choices.length).toBeGreaterThanOrEqual(2)
    expect(choices.length).toBeLessThanOrEqual(5)
    for (const choice of choices) {
      expect(typeof choice.text).toBe('string')
      expect(choice.text.length).toBeGreaterThan(0)
    }
  })

  test('accepts optional instructions and still creates a valid poll', async () => {
    const agent = await makeAgent()

    const result = await createAgentPoll.call(
      agent,
      'Room quiet during statistics-heavy section — good moment to surface where participants stand on part-time hiring',
      MOCK_CONTEXT,
      POLL_REVEAL_CONFIG,
      'Create a poll where results are shown immediately as votes come in. Craft choices where the live distribution will itself be interesting to watch.'
    )

    expect(result).not.toBeNull()
    expect(result!.type).toBe('poll')
    expect(result!.pollId).toBeTruthy()
    const poll = await Poll.findById(result!.pollId)
    expect(poll).not.toBeNull()
    const choices = await PollChoice.find({ poll: result!.pollId })
    expect(choices.length).toBeGreaterThanOrEqual(2)
  })
})

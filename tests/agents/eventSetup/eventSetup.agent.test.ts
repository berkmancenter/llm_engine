import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { createUser, createConversation, createPublicTopic, createMessage } from '../../utils/agentTestHelpers.js'
import { Agent, Channel } from '../../../src/models/index.js'
import { AgentMessageActions, ConversationHistory } from '../../../src/types/index.types.js'
import {
  getNextRound,
  lookupTopicByName,
  buildConfirmationPrompt,
  buildCalendarLink,
  buildEventLinks
} from '../../../src/agents/eventSetup/fieldCollection.js'
import { insertTopics, newPublicTopic, newPrivateTopic } from '../../fixtures/topic.fixture.js'

jest.setTimeout(30000)

const testConfig = setupAgentTest('eventSetup')

// Single-word name on purpose: the fuzzy mention helpers in intentChecks.ts
// compare word-by-word, so a multi-token name like 'Event Setup Bot' wouldn't
// match.
const BOT_NAME = 'Eventbot'

describe('eventSetup agent tests', () => {
  let agent
  let conversation
  let topic
  let user1

  async function createEventSetupConversation() {
    const conv = await createConversation({ name: 'Event Setup Test Conversation' }, user1, topic)
    const testAgent = new Agent({
      agentType: 'eventSetup',
      conversation: conv,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { botName: BOT_NAME }
    })
    const channels = await Channel.create([{ name: 'setup' }])
    conv.channels.push(...channels)
    await testAgent.save()
    conv.agents.push(testAgent)
    await conv.save()
    await testAgent.start()
    return { conv, testAgent }
  }

  beforeEach(async () => {
    topic = await createPublicTopic()
    user1 = await createUser('Alice')
    const result = await createEventSetupConversation()
    conversation = result.conv
    agent = result.testAgent
  })

  function buildHistory(messages): ConversationHistory {
    return {
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(),
      messages
    }
  }

  async function evaluate(body, user = user1) {
    const msg = await createMessage(body, user, conversation, ['setup'])
    return defaultAgentTypes.eventSetup.evaluate.call(agent, msg)
  }

  describe('evaluate()', () => {
    it('returns CONTRIBUTE when message contains "setup"', async () => {
      const result = await evaluate('I want to setup a new event')
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns CONTRIBUTE when message contains "create event" or "create an event"', async () => {
      const withoutArticle = await evaluate('Can you create event for next Thursday?')
      expect(withoutArticle.action).toBe(AgentMessageActions.CONTRIBUTE)

      const withArticle = await evaluate('Can you create an event for next Thursday?')
      expect(withArticle.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns CONTRIBUTE when message contains "new event"', async () => {
      const result = await evaluate('Let us kick off a new event about AI')
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns CONTRIBUTE when message is a direct @mention', async () => {
      const result = await evaluate(`@${BOT_NAME} can you help me?`)
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns CONTRIBUTE when bot name is misspelled (fuzzy match)', async () => {
      const result = await evaluate('@Evntbat please help')
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('normalizes a misspelled bot mention in the returned userMessage body', async () => {
      const result = await evaluate('@Evntbat please help')
      expect(result.userMessage.body).toContain(`@${BOT_NAME}`)
    })

    it('returns CONTRIBUTE when message is a thread reply (mid-flow continuation)', async () => {
      const msg = await createMessage('It is at 3pm tomorrow', user1, conversation, ['setup'])
      msg.parentMessage = new mongoose.Types.ObjectId()
      const result = await defaultAgentTypes.eventSetup.evaluate.call(agent, msg)
      expect(result.action).toBe(AgentMessageActions.CONTRIBUTE)
    })

    it('returns OK when message has no setup intent', async () => {
      const result = await evaluate('Good morning everyone!')
      expect(result.action).toBe(AgentMessageActions.OK)
    })
  })

  describe('respond()', () => {
    it('routes the response to the setup channel', async () => {
      const msg = await createMessage('setup a new event', user1, conversation, ['setup'])
      const history = buildHistory([])
      const responses = await defaultAgentTypes.eventSetup.respond.call(agent, history, msg)

      const channelNames = responses[0].channels.map((c) => c.name)
      expect(channelNames).toContain('setup')
    })

    it('threads its reply under the organizer message (parent = root id)', async () => {
      const msg = await createMessage('I want to set up a new event', user1, conversation, ['setup'])
      msg._id = new mongoose.Types.ObjectId()
      const responses = await defaultAgentTypes.eventSetup.respond.call(agent, buildHistory([]), msg)
      expect(responses[0].parent?.toString()).toBe(msg._id.toString())
    })

    it('prompts for round 1 fields (name, date/time, duration) when nothing has been provided', async () => {
      const msg = await createMessage('I want to set up an event', user1, conversation, ['setup'])
      const responses = await defaultAgentTypes.eventSetup.respond.call(agent, buildHistory([]), msg)

      expect(responses).toHaveLength(1)
      const body = (responses[0].message as string).toLowerCase()
      expect(body).toContain('name')
      expect(body).toMatch(/date|time/)
      expect(body).toMatch(/duration|minutes/)
    })
  })

  describe('getNextRound() logic', () => {
    it('returns round1 when nothing has been collected', () => {
      expect(getNextRound({})).toBe('round1')
    })

    it('returns round1 until name + dateTime + duration are all present', () => {
      expect(getNextRound({ eventName: 'X', dateTime: '2026-06-01T12:00:00Z' })).toBe('round1')
      expect(getNextRound({ eventName: 'X', duration: 30 })).toBe('round1')
    })

    it('returns round2 once round 1 is complete', () => {
      expect(getNextRound({ eventName: 'X', dateTime: '2026-06-01T12:00:00Z', duration: 30 })).toBe('round2')
    })

    it('stays on round2 until hasResources is answered', () => {
      expect(
        getNextRound({
          eventName: 'X',
          dateTime: '2026-06-01T12:00:00Z',
          duration: 30,
          description: 'a talk',
          zoomLink: 'https://zoom.us/j/abc'
        })
      ).toBe('round2')
    })

    it('returns round3 once round 2 is complete', () => {
      expect(
        getNextRound({
          eventName: 'X',
          dateTime: '2026-06-01T12:00:00Z',
          duration: 30,
          description: 'a talk',
          zoomLink: 'https://zoom.us/j/abc',
          hasResources: false
        })
      ).toBe('round3')
    })

    it('returns round4 when topic is set but speakers are not (and not skipped)', () => {
      expect(
        getNextRound({
          eventName: 'X',
          dateTime: '2026-06-01T12:00:00Z',
          duration: 30,
          description: 'a talk',
          zoomLink: 'https://zoom.us/j/abc',
          hasResources: false,
          topicName: 'AI'
        })
      ).toBe('round4')
    })

    it('skips round4 if skipSpeakers is true', () => {
      expect(
        getNextRound({
          eventName: 'X',
          dateTime: '2026-06-01T12:00:00Z',
          duration: 30,
          description: 'a talk',
          zoomLink: 'https://zoom.us/j/abc',
          hasResources: false,
          topicName: 'AI',
          skipSpeakers: true
        })
      ).toBe('round5')
    })

    it('returns confirmation when every field is set but the organizer has not confirmed', () => {
      expect(
        getNextRound({
          eventName: 'X',
          dateTime: '2026-06-01T12:00:00Z',
          duration: 30,
          description: 'a talk',
          zoomLink: 'https://zoom.us/j/abc',
          hasResources: false,
          topicName: 'AI',
          skipSpeakers: true,
          skipModerators: true
        })
      ).toBe('confirmation')
    })

    it('returns complete only once confirmed is true', () => {
      expect(
        getNextRound({
          eventName: 'X',
          dateTime: '2026-06-01T12:00:00Z',
          duration: 30,
          description: 'a talk',
          zoomLink: 'https://zoom.us/j/abc',
          hasResources: false,
          topicName: 'AI',
          skipSpeakers: true,
          skipModerators: true,
          confirmed: true
        })
      ).toBe('complete')
    })
  })

  describe('buildConfirmationPrompt()', () => {
    const fullFields = {
      eventName: 'Founders Q&A',
      dateTime: '2026-05-22T20:00:00Z',
      duration: 45,
      description: 'Casual fundraising chat.',
      zoomLink: 'https://zoom.us/j/abc',
      topicName: 'Spring Demo Day',
      speakers: [{ name: 'Maya Chen', bio: 'Founder of Stratoship', alternateName: 'Mei Chen' }],
      moderators: [{ name: 'Priya Raman', bio: 'Northwind Capital' }]
    }

    it('shows a speaker alternate name alongside their primary name when present', () => {
      const prompt = buildConfirmationPrompt(fullFields)
      expect(prompt).toContain('Mei Chen')
    })

    it('formats dateTime as a human-readable string with the default timezone (Eastern)', () => {
      // 2026-05-22T20:00:00Z is 4:00 PM EDT in America/New_York.
      const prompt = buildConfirmationPrompt(fullFields)
      expect(prompt).toMatch(/May 22, 2026 at 4:00 PM EDT/)
    })

    it('honors a timezone extracted from the organizer message', () => {
      // Same instant, displayed in Pacific time.
      const prompt = buildConfirmationPrompt({ ...fullFields, timeZone: 'America/Los_Angeles' })
      expect(prompt).toMatch(/May 22, 2026 at 1:00 PM PDT/)
    })

    it('uses the resolved canonical topic name when one is provided', () => {
      const prompt = buildConfirmationPrompt(
        { ...fullFields, topicName: 'Setup Test' },
        { resolvedTopicName: 'EventSetupTest' }
      )
      expect(prompt).toContain('EventSetupTest')
      expect(prompt).not.toMatch(/Topic: Setup Test\b/)
    })

    it('shows a warning when the topic could not be matched', () => {
      const prompt = buildConfirmationPrompt(
        { ...fullFields, topicName: 'Made Up Topic' },
        { topicWarning: 'I could not find this topic in Nextspace.' }
      )
      expect(prompt).toContain('Made Up Topic')
      expect(prompt).toContain('I could not find this topic in Nextspace.')
    })

    it('includes every collected field in the summary', () => {
      const prompt = buildConfirmationPrompt(fullFields)
      expect(prompt).toContain('Founders Q&A')
      expect(prompt).toContain('45')
      expect(prompt).toContain('Casual fundraising chat.')
      expect(prompt).toContain('https://zoom.us/j/abc')
      expect(prompt).toContain('Spring Demo Day')
      expect(prompt).toContain('Maya Chen')
      expect(prompt).toContain('Priya Raman')
    })

    it('asks the organizer to reply confirm', () => {
      const prompt = buildConfirmationPrompt(fullFields)
      expect(prompt.toLowerCase()).toContain('confirm')
    })

    it('shows "none" when speakers were skipped', () => {
      const prompt = buildConfirmationPrompt({ ...fullFields, speakers: [], skipSpeakers: true })
      expect(prompt.toLowerCase()).toMatch(/speakers?:?\s*none/i)
    })
  })

  describe('buildCalendarLink()', () => {
    let savedBaseUrl: string | undefined
    beforeEach(() => {
      savedBaseUrl = process.env.CALENDAR_DEEPLINK_BASE_URL
      delete process.env.CALENDAR_DEEPLINK_BASE_URL
    })
    afterEach(() => {
      if (savedBaseUrl === undefined) delete process.env.CALENDAR_DEEPLINK_BASE_URL
      else process.env.CALENDAR_DEEPLINK_BASE_URL = savedBaseUrl
    })

    it('returns an empty string when CALENDAR_DEEPLINK_BASE_URL is not set', () => {
      const url = buildCalendarLink({
        name: 'Founders Q&A',
        zoomLink: 'https://zoom.us/j/abc',
        dateTime: '2026-05-22T20:00:00Z',
        duration: 45
      })
      expect(url).toBe('')
    })

    it('builds a deep link with subject, start, end, body, and location when the base URL is configured', () => {
      process.env.CALENDAR_DEEPLINK_BASE_URL = 'https://calendar.example.com/compose'
      const url = buildCalendarLink({
        name: 'Founders Q&A',
        description: 'A talk',
        zoomLink: 'https://zoom.us/j/abc',
        dateTime: '2026-05-22T20:00:00Z',
        duration: 45
      })
      expect(url).toContain('https://calendar.example.com/compose')
      expect(url).toContain('subject=Founders%20Q%26A')
      expect(url).toContain('startdt=2026-05-22T20%3A00%3A00.000Z')
      expect(url).toContain('enddt=2026-05-22T20%3A45%3A00.000Z')
      expect(url).toContain('location=https%3A%2F%2Fzoom.us%2Fj%2Fabc')
    })
  })

  describe('buildEventLinks()', () => {
    const stubConversation = {
      id: 'CONV123',
      slug: 'founders-qa',
      channels: [
        { name: 'transcript', passcode: 'tr-pc' },
        { name: 'chat', passcode: 'ch-pc' },
        { name: 'moderator', passcode: 'mod-pc' },
        { name: 'resources', passcode: 'res-pc' }
      ]
    }

    afterEach(() => {
      delete process.env.EVENT_PARTICIPANT_URL_TEMPLATE
      delete process.env.EVENT_MODERATOR_URL_TEMPLATE
    })

    it('renders the nextspace-style default participant url with all optional channels filled in', () => {
      const links = buildEventLinks(stubConversation, 'https://app.example.com')
      expect(links.participantUrl).toBe(
        'https://app.example.com/assistant/?conversationId=CONV123&channel=transcript,tr-pc&channel=chat,ch-pc&channel=resources,res-pc'
      )
    })

    it('renders the nextspace-style default moderator url with the moderator passcode', () => {
      const links = buildEventLinks(stubConversation, 'https://app.example.com')
      expect(links.moderatorUrl).toBe(
        'https://app.example.com/moderator/?conversationId=CONV123&channel=moderator,mod-pc&channel=transcript,tr-pc'
      )
    })

    it('drops optional bracket segments when a referenced passcode is missing', () => {
      const noChat = {
        ...stubConversation,
        channels: stubConversation.channels.filter((c) => c.name !== 'chat')
      }
      const links = buildEventLinks(noChat, 'https://app.example.com')
      expect(links.participantUrl).not.toContain('chat,')
      expect(links.participantUrl).toContain('transcript,tr-pc')
      expect(links.participantUrl).toContain('resources,res-pc')
    })

    it('omits the resources channel segment when includeResources is false', () => {
      const links = buildEventLinks(stubConversation, 'https://app.example.com', {
        includeResources: false
      })
      expect(links.participantUrl).not.toContain('resources,')
      expect(links.participantUrl).toContain('transcript,tr-pc')
      expect(links.participantUrl).toContain('chat,ch-pc')
    })

    it('returns an empty moderatorUrl when the moderator channel has no passcode', () => {
      const noMod = {
        ...stubConversation,
        channels: stubConversation.channels.filter((c) => c.name !== 'moderator')
      }
      const links = buildEventLinks(noMod, 'https://app.example.com')
      expect(links.moderatorUrl).toBe('')
    })

    it('still emits a moderator link when the channel has a passcode regardless of moderator profiles', () => {
      // The bot promised a moderator link whenever the event type supports
      // it; collecting moderator profiles is independent.
      const links = buildEventLinks(stubConversation, 'https://app.example.com')
      expect(links.moderatorUrl).toContain('channel=moderator,mod-pc')
    })

    it('honors EVENT_PARTICIPANT_URL_TEMPLATE when set', () => {
      process.env.EVENT_PARTICIPANT_URL_TEMPLATE = '{host}/join/{slug}?cid={conversationId}'
      const links = buildEventLinks(stubConversation, 'https://other.example.com')
      expect(links.participantUrl).toBe('https://other.example.com/join/founders-qa?cid=CONV123')
    })
  })

  describe('lookupTopicByName()', () => {
    beforeEach(async () => {
      // Seed a deliberate mix of topic name styles plus a private decoy.
      await insertTopics([
        { ...newPublicTopic(), name: 'EventSetupTest', slug: 'eventsetuptest' },
        { ...newPublicTopic(), name: 'Climate Tech', slug: 'climate-tech' },
        { ...newPrivateTopic(), name: 'Private Secret Stuff', slug: 'private-secret-stuff' }
      ])
    })

    it('finds an exact name match', async () => {
      const result = await lookupTopicByName('EventSetupTest')
      expect(result.match?.name).toBe('EventSetupTest')
    })

    it('matches a camelCase topic when the query has spaces (Event Setup Test → EventSetupTest)', async () => {
      const result = await lookupTopicByName('Event Setup Test')
      expect(result.match?.name).toBe('EventSetupTest')
    })

    it('is case-insensitive', async () => {
      const result = await lookupTopicByName('event setup test')
      expect(result.match?.name).toBe('EventSetupTest')
    })

    it('ignores hyphens and underscores when comparing', async () => {
      const result = await lookupTopicByName('event-setup_test')
      expect(result.match?.name).toBe('EventSetupTest')
    })

    it('matches a partial substring (LLM dropped the "Event" prefix)', async () => {
      const result = await lookupTopicByName('Setup Test')
      expect(result.match?.name).toBe('EventSetupTest')
    })

    it('returns null match when nothing matches', async () => {
      const result = await lookupTopicByName('Totally Made Up Topic')
      expect(result.match).toBeNull()
      expect(result.options).toEqual([])
    })

    it('excludes private topics from results', async () => {
      const result = await lookupTopicByName('Private Secret Stuff')
      expect(result.match).toBeNull()
    })

    it('returns null match and empty options when the needle normalizes to empty', async () => {
      const result = await lookupTopicByName('   ')
      expect(result.match).toBeNull()
      expect(result.options).toEqual([])
    })
  })
})

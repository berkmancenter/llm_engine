import faker from 'faker'
import mongoose from 'mongoose'
import { Conversation, Agent, Channel, ConversationMembership } from '../../../src/models/index.js'
import { insertUsers } from '../../fixtures/user.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import setupAgentTest from '../../utils/setupAgentTest.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('communityAssistant')

describe('communityAssistant — periodicMemberIntros', () => {
  let agent
  let conversation
  let user1

  async function createUser(pseudonym) {
    return {
      _id: new mongoose.Types.ObjectId(),
      username: faker.internet.userName(),
      email: faker.internet.email().toLowerCase(),
      password: 'password1',
      role: 'participant',
      isEmailVerified: false,
      pseudonyms: [
        {
          _id: new mongoose.Types.ObjectId(),
          token: '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd35',
          pseudonym,
          active: 'true'
        }
      ]
    }
  }

  async function createMembership(overrides: Record<string, unknown> = {}) {
    return ConversationMembership.create({
      conversation: conversation._id,
      email: faker.internet.email().toLowerCase(),
      name: faker.name.findName(),
      status: 'active',
      introduced: false,
      ...overrides
    })
  }

  beforeEach(async () => {
    user1 = await createUser('Test User')
    await insertUsers([user1])
    await insertTopics([publicTopic])

    const [chatChannel] = await Channel.create([{ name: 'chat' }])
    conversation = new Conversation({
      name: 'Community Intro Test',
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: [],
      channels: [chatChannel._id]
    })
    await conversation.save()

    agent = new Agent({
      agentType: 'communityAssistant',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      agentConfig: { periodicMemberIntros: true }
    })
    await agent.save()
    await agent.start()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('returns [] when periodicMemberIntros is disabled', async () => {
    await createMembership({ name: 'Alice', bio: 'researcher' })
    agent.agentConfig.periodicMemberIntros = false

    const responses = await agent.respond()
    expect(responses).toEqual([])
  })

  it('returns [] when no unintroduced members exist', async () => {
    await createMembership({ introduced: true })

    const responses = await agent.respond()
    expect(responses).toEqual([])
  })

  it('returns [] when only one unintroduced member exists', async () => {
    await createMembership({ name: 'Solo Member', bio: 'researcher' })

    const responses = await agent.respond()
    expect(responses).toEqual([])
  })

  it('generates a memberGroupIntro message for unintroduced members', async () => {
    await createMembership({ name: 'Alice Researcher', bio: 'AI ethics researcher', interests: 'fairness in ML' })
    await createMembership({ name: 'Bob Engineer', bio: 'software engineer', interests: 'distributed systems' })

    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(responses[0].visible).toBe(true)
    expect(responses[0].messageType).toBe('text')
    expect(responses[0].responseKind).toBe('memberGroupIntro')
    expect(responses[0].message).toBeTruthy()
    expect(responses[0].renderData.text).toBeTruthy()
    expect(responses[0].channels.some((c) => c.name === 'chat')).toBe(true)
  })

  it('marks introduced members as introduced: true in the database', async () => {
    const m1 = await createMembership({ name: 'Alice', bio: 'designer' })
    const m2 = await createMembership({ name: 'Bob', bio: 'developer' })

    await agent.respond()

    const updated1 = await ConversationMembership.findById(m1._id).lean()
    const updated2 = await ConversationMembership.findById(m2._id).lean()
    expect(updated1?.introduced).toBe(true)
    expect(updated2?.introduced).toBe(true)
  })

  it('does not re-introduce members already marked introduced', async () => {
    await createMembership({ name: 'Alice', bio: 'already introduced', introduced: true })
    const m2 = await createMembership({ name: 'Bob', bio: 'new member' })
    const m3 = await createMembership({ name: 'Carol', bio: 'also new' })

    const responses = await agent.respond()

    // Bob and Carol should be introduced; Alice should not be re-introduced
    expect(responses).toHaveLength(1)
    const updated2 = await ConversationMembership.findById(m2._id).lean()
    const updated3 = await ConversationMembership.findById(m3._id).lean()
    expect(updated2?.introduced).toBe(true)
    expect(updated3?.introduced).toBe(true)
    expect(responses[0].message).not.toContain('already introduced')
  })

  it('caps the batch at 5 members when more than 5 are unintroduced', async () => {
    await Promise.all(Array.from({ length: 7 }, (_, i) => createMembership({ name: `Member ${i}`, bio: `bio ${i}` })))

    await agent.respond()

    const introduced = await ConversationMembership.find({ conversation: conversation._id, introduced: true }).lean()
    expect(introduced).toHaveLength(5)
  })

  it('uses externalIds.slack as the identifier when present', async () => {
    await createMembership({
      name: 'Alice Example',
      bio: 'researcher',
      externalIds: { slack: 'U123SLACKID' }
    })
    await createMembership({ name: 'Bob Partner', bio: 'engineer' })

    const responses = await agent.respond()

    expect(responses[0].message).toContain('U123SLACKID')
  })

  it('falls back to name when no externalId is present', async () => {
    await createMembership({ name: 'Charlie Nohandle', bio: 'community organizer' })
    await createMembership({ name: 'Dana Partner', bio: 'researcher' })

    const responses = await agent.respond()

    expect(responses[0].message).toContain('Charlie Nohandle')
  })

  describe('output quality — rich member data', () => {
    /* These tests print the LLM's output so you can visually inspect the quality of
       grouping, commonality detection, and mention formatting. Assertions are minimal —
       the point is the console output, not pass/fail. */

    it('identifies a shared thread across diverse-seeming members', async () => {
      await createMembership({
        name: 'Priya Mehta',
        bio: 'Pediatric nurse practitioner at a community health clinic. Spent three years with Doctors Without Borders in South Sudan.',
        interests: 'global health equity, medical education, trail running'
      })
      await createMembership({
        name: 'Marcus Webb',
        bio: 'Former public school teacher turned education policy researcher. Currently at a DC think tank focused on rural school funding.',
        interests: 'education equity, documentary film, long-distance cycling'
      })
      await createMembership({
        name: 'Soo-Jin Park',
        bio: 'UX researcher at a civic tech nonprofit. Previously built tools for humanitarian aid logistics.',
        interests: 'participatory design, Korean cinema, ultramarathons'
      })

      const responses = await agent.respond()

      console.log('\n[output quality] diverse-seeming members:\n', responses[0]?.message) // eslint-disable-line no-console

      expect(responses).toHaveLength(1)
      expect(responses[0].message.length).toBeGreaterThan(100)
    })

    it('handles members with minimal bio/interests gracefully', async () => {
      await createMembership({ name: 'James Okafor', bio: 'engineer', interests: '' })
      await createMembership({ name: 'Fatima Al-Rashid', bio: '', interests: 'startups' })
      await createMembership({ name: 'Leo Tanaka', bio: '', interests: '' })

      const responses = await agent.respond()
      console.log('\n[output quality] sparse member data:\n', responses[0]?.message) // eslint-disable-line no-console

      expect(responses).toHaveLength(1)
      expect(responses[0].message.length).toBeGreaterThan(50)
    })

    it('handles a full batch of 5 richly described members', async () => {
      await createMembership({
        name: 'Dana Reyes',
        bio: 'Climate scientist studying permafrost methane emissions. Spent two field seasons in Siberia.',
        interests: 'science communication, improv comedy, sourdough baking'
      })
      await createMembership({
        name: 'Kwame Asante',
        bio: 'Architect specializing in passive-house design and net-zero retrofits for affordable housing.',
        interests: 'urban food forests, Afrobeat, chess'
      })
      await createMembership({
        name: 'Yuki Tanaka',
        bio: 'Food systems researcher looking at how cities can shorten supply chains. Former restaurant chef.',
        interests: 'fermentation, urban agriculture, jazz piano'
      })
      await createMembership({
        name: 'Nadia Osei',
        bio: 'Civil engineer turned community organizer, focused on green infrastructure in flood-prone neighborhoods.',
        interests: 'community land trusts, spoken word poetry, cycling'
      })
      await createMembership({
        name: 'Tomás Vega',
        bio: 'Energy policy analyst at a state public utilities commission. Previously worked on rural electrification in Latin America.',
        interests: 'cooperative economics, cumbia, hiking'
      })

      const responses = await agent.respond()
      console.log('\n[output quality] full batch of 5:\n', responses[0]?.message) // eslint-disable-line no-console

      expect(responses).toHaveLength(1)
      expect(responses[0].message.length).toBeGreaterThan(150)
    })

    it('uses slack ID as handle and weaves it naturally into the message', async () => {
      await createMembership({
        name: 'Rosa Lindqvist',
        bio: 'Labor organizer and legal aid attorney. Co-founded a worker center for gig economy drivers.',
        interests: 'tenants rights, Scandinavian crime fiction, distance swimming',
        externalIds: { slack: 'U04KPNMABCD' }
      })
      await createMembership({
        name: 'Darius Finch',
        bio: 'Investigative journalist covering corporate accountability and wage theft. Pulitzer finalist 2022.',
        interests: 'public records law, jazz history, Brazilian jiu-jitsu',
        externalIds: { slack: 'U07MQRXYZ12' }
      })

      const responses = await agent.respond()
      console.log('\n[output quality] slack IDs as handles:\n', responses[0]?.message) // eslint-disable-line no-console

      expect(responses[0].message).toContain('U04KPNMABCD')
      expect(responses[0].message).toContain('U07MQRXYZ12')
    })
  })
})

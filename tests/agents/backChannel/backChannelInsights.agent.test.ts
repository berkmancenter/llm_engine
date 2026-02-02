/* eslint-disable no-console */
import loadTranscript from '../../utils/transcriptUtils.js'
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createBackChannelConversation,
  createParticipantMessage,
  createPublicTopic,
  createUser,
  loadAliensTranscript
} from '../../utils/agentTestHelpers.js'
import { Channel, Message } from '../../../src/models/index.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('backChannelInsights')

describe('back channel agent CI tests', () => {
  let agent
  let conversation
  let user1
  let user2
  let user3
  let user4
  let topic
  const pseudoMap = {}

  async function createTestUser(pseudonym) {
    const user = await createUser(pseudonym)
    pseudoMap[pseudonym] = user
    return user
  }

  async function validateResponse(responses) {
    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBeDefined()
    expect(responses[0].channels).toHaveLength(1)
    expect(responses[0].channels[0].name).toEqual('moderator')
    for (const insight of responses[0].message.insights) {
      console.log(`Insight: ${insight.value}`)
    }
  }

  const startDate = new Date(Date.now())
  beforeEach(async () => {
    user1 = await createTestUser('Boring Badger')
    user2 = await createTestUser('Shady Lawyer')
    user3 = await createTestUser('Hungry Hippo')
    user4 = await createTestUser('Sad Llama')
    await createTestUser('Sleepy Sloth')
    await createTestUser('Happy Panda')
    topic = await createPublicTopic()
  })

  it('surfaces standalone questions and not insights from an individual user with transcript', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Where are all the aliens?' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await loadAliensTranscript(conversation)
    const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
    const messages = await Promise.all(
      [
        {
          user: 'Boring Badger',
          comment:
            "You mentioned seeing a 'featureless silver disc' as a child, but later dismissed it as a likely misperception. If even your own vivid memory could be explained by cognitive error, why should we take any UFO sighting as evidence worth discussing at all?",
          timestamp: new Date(startDate.getTime() + 1 * 60 * 1000)
        },
        {
          user: 'Boring Badger',
          comment:
            "You suggest that an advanced civilization could colonize the galaxy 'before breakfast' using self-replicating probes. But isn't this just speculation stacked on speculation? How do we distinguish between science fiction and serious scientific reasoning here?",
          timestamp: new Date(startDate.getTime() + 90 * 1000)
        },
        {
          user: 'Boring Badger',
          comment:
            "If we *should* see signs of alien activity, as you said, isn't it just as valid to conclude that their absence is strong evidence that intelligent alien life doesn't exist—rather than puzzling over why we don't see them?",
          timestamp: new Date(startDate.getTime() + 2 * 60 * 1000)
        },
        {
          user: 'Boring Badger',
          comment:
            "You propose that advanced civilizations would build megastructures or send messages. But isn't that anthropocentric? Why assume alien intelligence would behave in any way that's observable or even comprehensible to us?",
          timestamp: new Date(startDate.getTime() + 150 * 1000)
        },
        {
          user: 'Boring Badger',
          comment:
            "You cite Frank Drake's failure to detect signals as a mystery. But doesn't this just support the null hypothesis? If decades of searching yield nothing, isn't the simplest explanation that there's nothing to find?",
          timestamp: new Date(startDate.getTime() + 3 * 60 * 1000)
        }
      ].map((question) =>
        createParticipantMessage(
          pseudoMap[question.user],
          { text: question.comment, preset: false },
          conversation,
          question.timestamp
        )
      )
    )

    const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
      start: startDate,
      end: endTime,
      messages
    })

    await validateResponse(responses)
    const { insights } = responses[0].message
    expect(insights.some((insight) => insight.type === 'insight')).toBeFalsy()
  }, 120000)

  it('surfaces standalone questions phrased as statements from an individual user with transcript', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Where are all the aliens?' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await loadAliensTranscript(conversation)
    const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
    const messages = await Promise.all(
      [
        {
          user: 'Boring Badger',
          timestamp: 32,
          comment:
            "I'm curious how the speaker's childhood UFO experience influenced his scientific approach to this question."
        },
        {
          user: 'Boring Badger',
          timestamp: 65,
          comment:
            "I wonder if we're looking for the wrong kind of evidence because we're anthropomorphizing alien behavior."
        },
        {
          user: 'Boring Badger',
          timestamp: 189,
          comment:
            'It would be valuable to know whether there are observational biases in how we search for alien technosignatures.'
        },
        {
          user: 'Boring Badger',
          timestamp: 97,
          comment: 'It would be helpful to know what specific signals SETI is looking for beyond radio transmissions.'
        },
        {
          user: 'Boring Badger',
          timestamp: 103,
          comment:
            "I'm wondering if there are alternative explanations for the silence that don't involve extinction events."
        },
        {
          user: 'Boring Badger',
          timestamp: 193,
          comment:
            "I'm interested in understanding how the Drake Equation parameters have been updated with recent exoplanet discoveries."
        },
        {
          user: 'Boring Badger',
          timestamp: 131,
          comment:
            'It would be interesting to know how the timeline changes if we factor in the time needed for complex life to evolve.'
        },
        {
          user: 'Boring Badger',
          timestamp: 193,
          comment: 'It would be fascinating to learn whether quantum communication might make alien signals invisible to us.'
        },
        {
          user: 'Boring Badger',
          timestamp: 156,
          comment:
            "I'm curious about whether self-replicating probes would actually be detectable by our current astronomical instruments."
        },
        {
          user: 'Boring Badger',
          timestamp: 167,
          comment: "I'd love to understand why civilizations might choose not to engage in galaxy-wide colonization."
        }
      ].map((question) =>
        createParticipantMessage(
          pseudoMap[question.user],
          { text: question.comment, preset: false },
          conversation,
          new Date(startDate.getTime() + question.timestamp * 1000)
        )
      )
    )

    const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
      start: startDate,
      end: endTime,
      messages
    })

    await validateResponse(responses)
    const { insights } = responses[0].message
    expect(insights.some((insight) => insight.type === 'insight')).toBeFalsy()
  }, 120000)

  it('surfaces standalone questions from an individual user without transcript', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Bluesky & Open Social Media Tech' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
    const messages = await Promise.all(
      [
        {
          user: 'Boring Badger',
          comment:
            'What challenges does BlueSky face in ensuring content moderation while maintaining decentralization and free expression?',
          timestamp: new Date(startDate.getTime() + 1 * 60 * 1000)
        },
        {
          user: 'Boring Badger',
          comment:
            'Can open social media tech realistically compete with entrenched platforms like X (formerly Twitter), Facebook, or Instagram?',
          timestamp: new Date(startDate.getTime() + 90 * 1000)
        },
        {
          user: 'Boring Badger',
          comment: 'What role does interoperability play in open social media platforms and how far along are we?',
          timestamp: new Date(startDate.getTime() + 2 * 60 * 1000)
        },
        {
          user: 'Boring Badger',
          comment:
            'What incentives exist for developers or small platforms to build on top of open social protocols like AT Protocol?',
          timestamp: new Date(startDate.getTime() + 150 * 1000)
        }
      ].map((question) =>
        createParticipantMessage(
          pseudoMap[question.user],
          { text: question.comment, preset: false },
          conversation,
          question.timestamp
        )
      )
    )

    const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
      start: startDate,
      end: endTime,
      messages
    })

    await validateResponse(responses)
    const { insights } = responses[0].message
    expect(insights.some((insight) => insight.type === 'insight')).toBeFalsy()
  }, 120000)

  it('it adds context from the transcript to its insights and correctly parses insights to string', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Should We Ban Plastic Water Bottles?' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    const talkTranscript = `1:05 - Host: Thank you.
1:07 - Host: The environmental damage caused by plastic water bottles is staggering.
1:10 - Host: They're made from fossil fuels,
1:12 - Host: transported with fossil fuels,
1:24 - Host: and they never truly go away.
1:27 - Host: We've produced 8 million tons of plastic globally,
1:31 - Host: and it doesn't biodegrade—
1:33 - Host: it just breaks into microplastics that pollute our oceans and are consumed by marine life.
2:10 - Host: 8 million tons of plastic enters the ocean each year.
2:14 - Host: This contributes to ecosystem collapse and even affects human health.
2:18 - Host: Plastic water bottles are one of the most unnecessary forms of pollution because we already have alternatives like reusable bottles and clean tap water in many places.
2:22 - Host: Banning them is a critical step toward reducing our carbon footprint
2:26 - Host:  and protecting the planet.`
    await loadTranscript(talkTranscript, conversation, ['transcript'], '-', startDate)
    const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
    const messages = await Promise.all(
      [
        {
          user: 'Boring Badger',
          comment: 'OMG! That much!?!?',
          timestamp: new Date(startDate.getTime() + 132 * 1000)
        },
        {
          user: 'Shady Lawyer',
          comment: 'I had no idea it was that much',
          timestamp: new Date(startDate.getTime() + 134 * 1000)
        },
        {
          user: 'Hungry Hippo',
          comment: "That's a crazy amount!",
          timestamp: new Date(startDate.getTime() + 135 * 1000)
        }
      ].map((question) =>
        createParticipantMessage(
          pseudoMap[question.user],
          { text: question.comment, preset: false },
          conversation,
          question.timestamp
        )
      )
    )

    const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
      start: startDate,
      end: endTime,
      messages
    })

    await validateResponse(responses)
    const { insights } = responses[0].message
    // should be all insight, no standalone question
    expect(insights.some((insight) => insight.type === 'question')).toBeFalsy()

    const agentMsg = new Message({
      body: responses[0].message,
      bodyType: 'json',
      conversation: conversation._id,
      pseudonym: agent.pseudonyms[0].pseudonym,
      pseudonymId: agent.pseudonyms[0]._id,
      channels: ['moderator'],
      fromAgent: true,
      pause: false,
      visible: true,
      upVotes: [],
      downVotes: []
    })
    const translatedMsg = await defaultAgentTypes.backChannelInsights.parseOutput(agentMsg)
    expect(translatedMsg.body).toEqual(expect.stringContaining('MODERATOR REPORT'))
    expect(translatedMsg.bodyType).toEqual('text')
  }, 120000)

  it('it generates multiple insights', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Where are all the aliens?' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await loadAliensTranscript(conversation)

    const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
    const messages = await Promise.all(
      [
        {
          user: 'Boring Badger',
          comment: 'This makes me wonder why we never see flying saucers anymore.',
          timestamp: new Date(startDate.getTime() + 73 * 1000)
        },
        {
          user: 'Shady Lawyer',
          comment: "Good question — why don't we see life in the cosmos?",
          timestamp: new Date(startDate.getTime() + 77 * 1000)
        },
        {
          user: 'Hungry Hippo',
          comment: 'Yeah, the absence of sightings is puzzling.',
          timestamp: new Date(startDate.getTime() + 80 * 1000)
        },
        {
          user: 'Sad Llama',
          comment: 'The idea of galaxy-colonizing probes is fascinating.',
          timestamp: new Date(startDate.getTime() + 153 * 1000)
        },
        {
          user: 'Sleepy Sloth',
          comment: 'Self-replicating probes colonizing galaxies — love that concept.',
          timestamp: new Date(startDate.getTime() + 162 * 1000)
        },
        {
          user: 'Happy Panda',
          comment: 'Probes could reach every star system — mind-blowing.',
          timestamp: new Date(startDate.getTime() + 175 * 1000)
        }
      ].map((question) =>
        createParticipantMessage(
          pseudoMap[question.user],
          { text: question.comment, preset: false },
          conversation,
          question.timestamp
        )
      )
    )

    const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
      start: startDate,
      end: endTime,
      messages
    })

    await validateResponse(responses)
    const { insights } = responses[0].message
    // should be some insights, not just standalone questions
    expect(insights.some((insight) => insight.type === 'insight')).toBeTruthy()
  }, 120000)

  it('does not respond if no messages are found', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Best Movie Ever' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await agent.evaluate()
    const responses = await agent.respond()
    expect(responses).toHaveLength(0)
  })

  it('does not respond if only preset messages are found', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Best Movie Ever' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await createParticipantMessage(
      user1,
      {
        text: "Let's move on",
        preset: true
      },
      conversation
    )
    await createParticipantMessage(
      user2,
      {
        text: "Let's move on",
        preset: true
      },
      conversation
    )
    await createParticipantMessage(
      user3,
      {
        text: "I'm confused",
        preset: true
      },
      conversation
    )

    await agent.evaluate()
    const responses = await agent.respond()
    expect(responses).toHaveLength(0)
  })

  it('does not respond if only non-substantive messages are found', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Best Movie Ever' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await createParticipantMessage(
      user1,
      {
        text: 'Hi'
      },
      conversation
    )
    await createParticipantMessage(
      user2,
      {
        text: 'Testing'
      },
      conversation
    )
    await createParticipantMessage(
      user3,
      {
        text: 'This is Billy'
      },
      conversation
    )
    await createParticipantMessage(
      user4,
      {
        text: "I'm glad we don't have class tomorrow"
      },
      conversation
    )

    await agent.evaluate()
    const responses = await agent.respond()
    expect(responses).toHaveLength(0)
  })

  it('introduces itself on new DM channels', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Should Plastic Water Bottles Be Banned?' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    const [directChannel] = await Channel.create([
      { name: 'direct-jh-agents', direct: true, participants: [user1._id, agent._id] }
    ])
    const msgs = await agent.introduce(directChannel)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].body).toEqual(agent.agentConfig.introMessage)
    expect(msgs[0].channels).toHaveLength(1)
    expect(msgs[0].channels[0]).toEqual(directChannel)
  })

  it('does not introduce itself on non-direct channels', async () => {
    conversation = await createBackChannelConversation(
      { name: 'Should Plastic Water Bottles Be Banned?' },
      user1,
      topic,
      startDate,
      testConfig.llmPlatform,
      testConfig.llmModel
    )
    const [testAgent] = conversation.agents
    agent = testAgent
    await agent.save()
    const [channel] = await Channel.create([{ name: 'testchannel' }])
    const msgs = await agent.introduce(channel)
    expect(msgs).toHaveLength(0)
  })
})

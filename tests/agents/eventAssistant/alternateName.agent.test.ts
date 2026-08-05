/* eslint-disable no-console */
import setupAgentTest from '../../utils/setupAgentTest.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createEventAssistantConversation,
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadTestTranscript
} from '../../utils/agentTestHelpers.js'

jest.setTimeout(180000)

const testConfig = setupAgentTest('eventAssistant')

/*
 * Transcript that refers to the speaker by nickname throughout.
 * Simulates what Recall.ai produces when it picks up the nickname
 * from the room rather than the canonical roster name.
 */
const nicknameTranscript = `
00:10 | JZ: Thanks for having me. I've been thinking a lot about how the internet was designed without identity in mind.
01:00 | JZ: The original architects assumed good faith. That assumption doesn't hold anymore.
02:00 | JZ: What we need now is a renegotiation of the social contract between platforms and users.
03:00 | JZ: I'd argue the most important thing we can do is make default settings privacy-preserving, not privacy-invasive.
`

describe('alternate name enforcement', () => {
  let agent
  let conversation
  let topic
  let user1

  const startTime = new Date(Date.now() - 10 * 60 * 1000)

  beforeEach(async () => {
    topic = await createPublicTopic()
    user1 = await createUser('curious-attendee')

    conversation = await createEventAssistantConversation(
      {
        name: 'The Future of the Internet',
        description: 'A talk on internet governance and digital rights.',
        presenters: [
          {
            name: 'Jonathan Zittrain',
            alternateName: 'JZ',
            bio: 'Professor at Harvard Law School, co-founder of the Berkman Klein Center.'
          }
        ]
      },
      user1,
      topic,
      startTime,
      testConfig.llmPlatform,
      testConfig.llmModel
    )

    const [testAgent] = conversation.agents
    agent = testAgent

    await loadTestTranscript(conversation, nicknameTranscript, true)
  })

  async function ask(body: string) {
    console.log(`Q: ${body}`)
    const msg = await createDirectMessage(body, user1, conversation)
    const responses = await defaultAgentTypes.eventAssistant.respond.call(agent, { messages: [] }, msg)
    const { text } = responses[0].message as Record<string, string>
    console.log(`A: ${text}`)
    return text
  }

  it('uses canonical name when asked about the speaker by nickname', async () => {
    const response = await ask('What did JZ say about platform defaults?')
    expect(response).not.toContain('JZ')
  })

  it('uses canonical name when asked a generic event question that mentions the speaker', async () => {
    const response = await ask('What is this event about?')
    expect(response).not.toContain('JZ')
    expect(response).not.toContain('Jay-Z')
  })

  it('does not use misspelling or alternate name when asked about the speaker by a misspelling', async () => {
    const response = await ask('What did Jonny Zittren say about social contracts?')
    expect(response).not.toContain('Jonny')
    expect(response).not.toContain('Zittren')
    expect(response).not.toContain('JZ')
  })
})

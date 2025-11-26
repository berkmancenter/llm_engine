import faker from 'faker'
import mongoose from 'mongoose'
import { Message, Conversation, Agent, Channel } from '../../../../src/models/index.js'
import { insertUsers } from '../../../fixtures/user.fixture.js'
import { publicTopic } from '../../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../../fixtures/topic.fixture.js'
import setupAgentTest from '../../../utils/setupAgentTest.js'

jest.setTimeout(60000)

const testConfig = setupAgentTest('generic')
describe('generic agent tests', () => {
  let agent
  let conversation
  let user1
  let user2
  let user3

  async function createUser(pseudonym) {
    return {
      _id: new mongoose.Types.ObjectId(),
      username: faker.name.findName(),
      email: faker.internet.email().toLowerCase(),
      password: 'password1',
      role: 'user',
      isEmailVerified: false,
      pseudonyms: [
        {
          _id: new mongoose.Types.ObjectId(),
          token: '31c5d2b7d2b0f86b2b4b204',
          pseudonym,
          active: 'true'
        }
      ]
    }
  }

  async function addMessageToConversation(msgObj, user) {
    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: msgObj.body,
      bodyType: msgObj.bodyType,
      conversation: msgObj.conversation,
      owner: user._id,
      pseudonymId: user.pseudonyms[0]._id,
      pseudonym: user.pseudonyms[0].pseudonym,
      channels: msgObj.channels
    })
    await msg.save()
    await conversation.populate('messages')
  }

  async function createMessage(user, body, bodyType = 'text') {
    const msg = {
      body,
      bodyType,
      conversation: conversation._id,
      pseudonym: user.pseudonyms[0].pseudonym,
      channels: ['primary']
    }
    await addMessageToConversation(msg, user)
  }

  async function createConversation(name, agentProperties = {}) {
    const channels = await Channel.create([{ name: 'primary' }, { name: 'secondary' }])
    const conversationConfig = {
      name,
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: [],
      channels
    }
    conversation = new Conversation(conversationConfig)
    await conversation.save()

    agent = new Agent({
      agentType: 'generic',
      conversation,
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      ...agentProperties
    })
    await agent.save()
    await agent.initialize()
    await agent.start()
  }

  beforeEach(async () => {
    user1 = await createUser('Curious Cat')
    user2 = await createUser('Wise Owl')
    user3 = await createUser('Clever Fox')

    await insertUsers([user1, user2, user3])
    await insertTopics([publicTopic])
  })

  it('saves name and description to the DB with default values', async () => {
    await createConversation('Test Conversation')

    const savedAgent = await Agent.findById(agent._id)
    expect(savedAgent!.agentType).toEqual('generic')
    expect(savedAgent!.name).toEqual('Generic Agent')
    expect(savedAgent!.description).toEqual('An generic agent type, meant to be customized by a user')
  })

  it('name and description can be overriden in the DB', async () => {
    await createConversation('Test Conversation', { name: 'Customized Agent', description: 'A customized agent' })

    const savedAgent = await Agent.findById(agent._id)
    expect(savedAgent!.agentType).toEqual('generic')
    expect(savedAgent!.name).toEqual('Customized Agent')
    expect(savedAgent!.description).toEqual('A customized agent')
  })

  it('outputs messaging that it needs to be configured when using the default template', async () => {
    await createConversation('Test Conversation')
    await createMessage(user1, 'Hello, can you help me?')

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(responses[0].body).toEqual('I am an un-configured Generic Agent. Please configure me.')
    expect(responses[0].bodyType).toBe('text')
  })

  it('defaults to action CONTRIBUTE and outputs appropriate responses', async () => {
    const customTemplate = `No matter what you are asked about, you always respond to the person by name asking them if they'd like a hot fudge sundae.

    Reference materials:
    * Topic: {topic}
    * Conversation History: {convHistory}

    Answer:`

    await createConversation('Test Conversation', { llmTemplates: { main: customTemplate } })
    await createMessage(user1, 'Tell me about the fall of the Roman empire.')

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(typeof responses[0].body).toBe('string')
    expect(responses[0].bodyType).toBe('text')
    expect(responses[0].body).toContain('hot fudge sundae')
    expect(responses[0].body).toContain('Curious Cat')
  })

  it('uses provided model options', async () => {
    const customTemplate = `No matter what you are asked about, you always respond with a compliment starting with the precise, unchanging text "Your compliment of the day" and reference their user name.

    Reference materials:
    * Topic: {topic}
    * Conversation History: {convHistory}

    Answer:`

    await createConversation('Compliment Conversation', {
      llmTemplates: { main: customTemplate },
      llmPlatform: 'openai',
      llmModel: 'gpt-4',
      llmModelOptions: { temperature: 1.2 }
    })
    await createMessage(user1, 'Hi!')

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(typeof responses[0].body).toBe('string')
    expect(responses[0].bodyType).toBe('text')
    expect(responses[0].body).toContain('compliment of the day')
    expect(responses[0].body).toContain('Curious Cat')

    const llm = await agent.getLLM()
    expect(llm.model).toBe('gpt-4')
    expect(llm.temperature).toBe(1.2)
  })

  it('handles non-CONTRIBUTE actions by returning empty array', async () => {
    const customTemplate = `You choose action OK and respond with message "No response"

    Reference materials:
    * Topic: {topic}
    * Conversation History: {convHistory}

    Answer:`

    await createConversation('Test Conversation', { llmTemplates: { main: customTemplate } })
    await createMessage(user1, 'Hello, can you help me?')

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(0)
  })

  it('can output structured data with a user specified outputSchema', async () => {
    const customTemplate = `You are a weather information oracle.
    Please guess the current temperature in Fahrenheit and condition.

    The agent outputs these properties:
    * explanation: A short explanation of what was done
    * message: A JSON object with properties temperature (number) and condition (string)
    * visible: true
    * channels: ["main"]
    * action: 2 (CONTRIBUTE)

    Reference materials:
    * Topic: {topic}
    * Conversation History: {convHistory}

    Answer:`

    await createConversation('Weather Conversation', { llmTemplates: { main: customTemplate } })
    await createMessage(user1, 'What is the weather?')

    // Configure the agent with a schema
    await agent.deepPatch({
      agentConfig: {
        outputSchema: {
          type: 'object',
          properties: {
            temperature: { type: 'number' },
            condition: { type: 'string' }
          }
        }
      }
    })
    await agent.save()

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(typeof responses[0].body).toBe('object')
    expect(responses[0].bodyType).toBe('json')
    expect(responses[0].body).toHaveProperty('temperature')
    expect(typeof responses[0].body.temperature).toBe('number')
    expect(responses[0].body).toHaveProperty('condition')
    expect(typeof responses[0].body.condition).toBe('string')
  })

  it('can output complex structured data with arrays', async () => {
    const customTemplate = `You are a restaurant recommendation system.
    Please provide a list of 3 restaurant recommendations with details.

    The agent outputs these properties:
    * explanation: A short explanation of what was done
    * message: A JSON object with properties:
      - recommendations: an array of restaurant objects, each with:
        - name: string
        - cuisine: string
        - rating: number (1-5)
        - specialDishes: array of strings
        - priceRange: string
      - searchLocation: string
      - totalResults: number
    * visible: true
    * channels: ["primary"]
    * action: 2 (CONTRIBUTE)

    Reference materials:
    * Topic: {topic}
    * Conversation History: {convHistory}

    Answer:`

    await createConversation('Restaurant Conversation', { llmTemplates: { main: customTemplate } })
    await createMessage(user1, 'What are some good restaurants nearby?')

    // Configure the agent with a complex schema
    await agent.deepPatch({
      agentConfig: {
        outputSchema: {
          type: 'object',
          properties: {
            recommendations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  cuisine: { type: 'string' },
                  rating: { type: 'number' },
                  specialDishes: {
                    type: 'array',
                    items: { type: 'string' }
                  },
                  priceRange: { type: 'string' }
                }
              }
            },
            searchLocation: { type: 'string' },
            totalResults: { type: 'number' }
          }
        }
      }
    })
    await agent.save()

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(typeof responses[0].body).toBe('object')
    expect(responses[0].bodyType).toBe('json')

    // Check top-level properties
    expect(responses[0].body).toHaveProperty('recommendations')
    expect(Array.isArray(responses[0].body.recommendations)).toBe(true)
    expect(responses[0].body.recommendations.length).toBeGreaterThan(0)
    expect(responses[0].body).toHaveProperty('searchLocation')
    expect(typeof responses[0].body.searchLocation).toBe('string')
    expect(responses[0].body).toHaveProperty('totalResults')
    expect(typeof responses[0].body.totalResults).toBe('number')

    // Check restaurant object structure
    const firstRestaurant = responses[0].body.recommendations[0]
    expect(firstRestaurant).toHaveProperty('name')
    expect(typeof firstRestaurant.name).toBe('string')
    expect(firstRestaurant).toHaveProperty('cuisine')
    expect(typeof firstRestaurant.cuisine).toBe('string')
    expect(firstRestaurant).toHaveProperty('rating')
    expect(typeof firstRestaurant.rating).toBe('number')
    expect(firstRestaurant).toHaveProperty('specialDishes')
    expect(Array.isArray(firstRestaurant.specialDishes)).toBe(true)
    expect(firstRestaurant).toHaveProperty('priceRange')
    expect(typeof firstRestaurant.priceRange).toBe('string')
  })

  it('can set visible: false for invisible messages', async () => {
    const customTemplate = `You are a silent assistant.

    The agent outputs these properties:
    * explanation: A short explanation of what was done
    * message: The output as a string
    * visible: false
    * channels: ["primary"]
    * action: 2 (CONTRIBUTE)

    Reference materials:
    * Topic: {topic}
    * Conversation History: {convHistory}

    Answer:`

    await createConversation('Silent Conversation', { llmTemplates: { main: customTemplate } })
    await createMessage(user1, 'Can you work silently?')

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(responses[0].visible).toBe(false)
  })

  it('can send messages to specific channels', async () => {
    const customTemplate = `You are a channel-specific assistant.

    The agent outputs these properties:
    * explanation: A short explanation of what was done
    * message: The output as a string
    * visible: true
    * channels: ["secondary"]
    * action: 2 (CONTRIBUTE)

    Reference materials:
    * Topic: {topic}
    * Conversation History: {convHistory}

    Answer:`

    await createConversation('Channel Conversation', { llmTemplates: { main: customTemplate } })
    await createMessage(user1, 'Send to secondary channel')

    await agent.evaluate()
    const responses = await agent.respond()

    expect(responses).toHaveLength(1)
    expect(responses[0].channels).toHaveLength(1)
    expect(responses[0].channels[0].name).toBe('secondary')
  })
})

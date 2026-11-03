import eventAssistant from '../../../src/agents/eventAssistant/eventAssistant.js'

function makeAgent(conversationOverrides: Record<string, unknown> = {}) {
  return {
    agentConfig: { botName: 'Berkie' },
    conversation: {
      scheduledTime: new Date(Date.now() + 5 * 60 * 1000),
      preEventMinutes: 15,
      draft: false,
      ...conversationOverrides
    }
  }
}

describe('eventAssistant.evaluate retags stale pregame messages', () => {
  test('retags a pregame message to chat once the preEvent window has closed', async () => {
    const agent = makeAgent({ startTime: new Date() })
    const userMessage = { body: 'hello', channels: ['pregame'] }

    const result = await eventAssistant.evaluate.call(agent, userMessage)

    expect(result.userMessage.channels).toEqual(['chat'])
  })

  test('leaves a pregame message alone while the preEvent window is still open', async () => {
    const agent = makeAgent()
    const userMessage = { body: 'hello', channels: ['pregame'] }

    const result = await eventAssistant.evaluate.call(agent, userMessage)

    expect(result.userMessage.channels).toEqual(['pregame'])
  })

  test('does not touch a chat message', async () => {
    const agent = makeAgent({ startTime: new Date() })
    const userMessage = { body: 'hello', channels: ['chat'] }

    const result = await eventAssistant.evaluate.call(agent, userMessage)

    expect(result.userMessage.channels).toEqual(['chat'])
  })

  test('preserves other channels alongside the retagged one', async () => {
    const agent = makeAgent({ startTime: new Date() })
    const userMessage = { body: 'hello', channels: ['pregame', 'image-gen'] }

    const result = await eventAssistant.evaluate.call(agent, userMessage)

    expect(result.userMessage.channels).toEqual(['chat', 'image-gen'])
  })
})

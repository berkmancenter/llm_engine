import renderAgentTemplate from '../../../src/agents/helpers/renderAgentTemplate.js'

describe('renderAgentTemplate', () => {
  const agentData = {
    name: 'Event Assistant',
    conversation: {
      name: 'My Test Event',
      description: 'A really cool event'
    },
    agentConfig: {
      someValue: 'configured-value'
    }
  }

  it('returns a plain string unchanged', () => {
    const result = renderAgentTemplate('Hello, world!', agentData as Record<string, unknown>)
    expect(result).toBe('Hello, world!')
  })

  it('interpolates a top-level agent property', () => {
    const result = renderAgentTemplate('Hi, I am {{name}}.', agentData as Record<string, unknown>)
    expect(result).toBe('Hi, I am Event Assistant.')
  })

  it('interpolates a nested property via dot notation', () => {
    const result = renderAgentTemplate(
      "Welcome to {{conversation.name}}!",
      agentData as Record<string, unknown>
    )
    expect(result).toBe('Welcome to My Test Event!')
  })

  it('interpolates multiple template variables', () => {
    const result = renderAgentTemplate(
      "I'm {{name}} and I'm here for {{conversation.name}}.",
      agentData as Record<string, unknown>
    )
    expect(result).toBe("I'm Event Assistant and I'm here for My Test Event.")
  })

  it('interpolates a deeply nested agentConfig property', () => {
    const result = renderAgentTemplate(
      'Config value: {{agentConfig.someValue}}',
      agentData as Record<string, unknown>
    )
    expect(result).toBe('Config value: configured-value')
  })

  it('renders an empty string for a missing template variable', () => {
    const result = renderAgentTemplate('Value: {{nonExistent}}', agentData as Record<string, unknown>)
    expect(result).toBe('Value: ')
  })

  it('does not escape HTML entities in the rendered output', () => {
    const agentWithSpecialChars = {
      ...agentData,
      conversation: { name: 'Event & Workshop', description: '' }
    }
    const result = renderAgentTemplate(
      'Welcome to {{conversation.name}}!',
      agentWithSpecialChars as Record<string, unknown>
    )
    expect(result).toBe('Welcome to Event & Workshop!')
  })

  it('handles an empty template string', () => {
    const result = renderAgentTemplate('', agentData as Record<string, unknown>)
    expect(result).toBe('')
  })

  it('handles template with no variables (returns string as-is)', () => {
    const template = "Hey! I'm the NextSpace Event Assistant. Ask me about what's happening."
    const result = renderAgentTemplate(template, agentData as Record<string, unknown>)
    expect(result).toBe(template)
  })
})

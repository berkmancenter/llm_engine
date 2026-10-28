import resolveConversationType from '../../src/conversations/resolver.js'
import { getConversationType } from '../../src/conversations/index.js'
import { availablePersonalities } from '../../src/agents/helpers/agentPersonality.js'

describe('communityRoom personality property', () => {
  const type = getConversationType('communityRoom')!

  const resolveAgentConfig = (properties: Record<string, unknown>) =>
    resolveConversationType({ properties }, type).agentTypes.find((a) => a.name === 'communityAssistant')

  it('maps personality into the communityAssistant agentConfig', () => {
    expect(resolveAgentConfig({ personality: 'socratic' })?.properties).toMatchObject({
      agentConfig: { personality: 'socratic' }
    })
  })

  it('leaves personality unset when the property is absent', () => {
    expect(
      (resolveAgentConfig({})?.properties?.agentConfig as { personality?: string } | undefined)?.personality
    ).toBeUndefined()
  })

  it('offers every available personality and rejects unknown ones', () => {
    const prop = type.properties.find((p) => p.name === 'personality')!
    expect(prop.required).toBe(false)
    expect(prop.options).toEqual(availablePersonalities.map((p) => p.name))
    expect(() => resolveAgentConfig({ personality: 'not-a-personality' })).toThrow(/Invalid value for 'personality'/)
  })
})

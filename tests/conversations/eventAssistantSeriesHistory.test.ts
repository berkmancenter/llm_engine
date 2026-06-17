import resolveConversationType from '../../src/conversations/resolver.js'
import eventAssistantType from '../../src/conversations/eventAssistant.js'

describe('eventAssistant seriesHistory feature wiring', () => {
  test('defines a seriesHistory feature that is organizer-controlled and default OFF', () => {
    const feature = eventAssistantType.features?.find((f) => f.name === 'seriesHistory')
    expect(feature).toBeDefined()
    expect(feature!.default).toBe(false)
    expect(feature!.userControlled).toBe(false)
    expect(feature!.category).toBe('assistant')
  })

  test('wires seriesHistory into the eventAssistant agentConfig via $ref', () => {
    const agent = eventAssistantType.agents?.find((a) => a.name === 'eventAssistant')
    expect(agent?.properties).toEqual(expect.arrayContaining([{ $ref: 'seriesHistory', as: 'agentConfig.seriesHistory' }]))
  })

  test('resolves agentConfig.seriesHistory=false when the feature is not requested (default OFF)', () => {
    const result = resolveConversationType(
      { properties: { zoomMeetingUrl: 'https://zoom.us/j/123' }, features: [] },
      eventAssistantType
    )
    const agent = result.agentTypes.find((a) => a.name === 'eventAssistant')
    expect(agent?.properties).toMatchObject({ agentConfig: { seriesHistory: false } })
  })

  test('resolves agentConfig.seriesHistory=true when the feature is enabled', () => {
    const result = resolveConversationType(
      { properties: { zoomMeetingUrl: 'https://zoom.us/j/123' }, features: [{ name: 'seriesHistory' }] },
      eventAssistantType
    )
    const agent = result.agentTypes.find((a) => a.name === 'eventAssistant')
    expect(agent?.properties).toMatchObject({ agentConfig: { seriesHistory: true } })
  })
})

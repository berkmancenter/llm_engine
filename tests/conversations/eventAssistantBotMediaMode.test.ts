import resolveConversationType from '../../src/conversations/resolver.js'
import eventAssistantType from '../../src/conversations/eventAssistant.js'

/* botMediaMode is resolved entirely within eventAssistant.ts's own adapters config now —
   zoom.ts just trusts whatever value lands here (see src/adapters/zoom.ts's deployMeetingBot).
   These tests exercise the actual handlebars-templated resolution, the same mechanism
   eventAssistantSeriesHistory.test.ts uses for seriesHistory. voiceDestination is voiceOutput's
   own sub-property (same pattern as the librarian feature's recommendationsPerInterval), not
   a separate top-level property — it only ever matters when voiceOutput is itself enabled. */
describe('eventAssistant botMediaMode wiring', () => {
  const zoomMeetingUrl = 'https://zoom.us/j/123'

  function resolve(platforms: string[], voiceOutput: { enabled: boolean; voiceDestination?: 'presentation' | 'zoom' }) {
    const result = resolveConversationType(
      {
        platforms,
        properties: { zoomMeetingUrl },
        features: [
          {
            name: 'voiceOutput',
            enabled: voiceOutput.enabled,
            // voiceDestination's value is the whole chosen option object (see eventAssistant.ts's
            // definition) — label is display-only, so these tests only need to set name.
            ...(voiceOutput.voiceDestination && { config: { voiceDestination: { name: voiceOutput.voiceDestination } } })
          }
        ]
      },
      eventAssistantType
    )
    return (result.adapters[0] as { config: { botMediaMode?: string } }).config.botMediaMode
  }

  test('Zoom-only: resolves to "voice" when voiceOutput is on', () => {
    expect(resolve(['zoom'], { enabled: true })).toBe('voice')
  })

  test('Zoom-only: resolves to "silent" when voiceOutput is off', () => {
    expect(resolve(['zoom'], { enabled: false })).toBe('silent')
  })

  test('Zoom-only: voiceDestination has no effect — there is no other venue to defer to', () => {
    expect(resolve(['zoom'], { enabled: true, voiceDestination: 'presentation' })).toBe('voice')
  })

  test('Zoom + NextSpace: defaults to "silent" when voiceOutput is on but voiceDestination is unset (NextSpace speaks)', () => {
    expect(resolve(['zoom', 'nextspace'], { enabled: true })).toBe('silent')
  })

  test('Zoom + NextSpace: "silent" when voiceDestination is explicitly "presentation"', () => {
    expect(resolve(['zoom', 'nextspace'], { enabled: true, voiceDestination: 'presentation' })).toBe('silent')
  })

  test('Zoom + NextSpace: "voice" when the organizer explicitly chose voiceDestination "zoom"', () => {
    expect(resolve(['zoom', 'nextspace'], { enabled: true, voiceDestination: 'zoom' })).toBe('voice')
  })

  test('Zoom + NextSpace: voiceDestination "zoom" cannot promote to "voice" if voiceOutput itself is off', () => {
    expect(resolve(['zoom', 'nextspace'], { enabled: false, voiceDestination: 'zoom' })).toBe('silent')
  })

  test('unmatched platform combo (falls through to the default adapter block): defaults to "silent" when voiceDestination is unset', () => {
    expect(resolve(['some-other-platform'], { enabled: true })).toBe('silent')
  })

  test('unmatched platform combo (falls through to the default adapter block): "voice" when the organizer chose voiceDestination "zoom"', () => {
    expect(resolve(['some-other-platform'], { enabled: true, voiceDestination: 'zoom' })).toBe('voice')
  })
})

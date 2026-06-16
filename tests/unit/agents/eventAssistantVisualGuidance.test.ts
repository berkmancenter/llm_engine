import { buildVisualGuidance } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

describe('buildVisualGuidance', () => {
  describe('both variants', () => {
    test.each([
      ['autoVisualActive=true', true],
      ['autoVisualActive=false', false]
    ])('never tells the user it cannot create visuals (%s)', (_label, autoVisualActive) => {
      const guidance = buildVisualGuidance(autoVisualActive)
      // Core requirement: the answer model must never deny the capability.
      expect(guidance).toMatch(/Never tell the user you are unable to create images/i)
      expect(guidance).toMatch(/do not deny the capability/i)
      // Always mentions the visual modalities so the model recognizes such requests.
      expect(guidance).toMatch(/images, diagrams, charts/i)
    })
  })

  describe('when auto-visual is active (/visual command or visualResponse preference on)', () => {
    const guidance = buildVisualGuidance(true)

    test('explains visuals are generated automatically by a separate step', () => {
      expect(guidance).toMatch(/generates them automatically through a separate step/i)
    })

    test('does NOT point the user to the /visual command (one is already queued)', () => {
      expect(guidance).not.toMatch(/\/visual command/i)
    })
  })

  describe('when auto-visual is off (no /visual command and preference off)', () => {
    const guidance = buildVisualGuidance(false)

    test('points the user to the /visual command to get one generated', () => {
      expect(guidance).toMatch(/\/visual command/i)
    })

    test('does NOT claim a visual is being generated automatically', () => {
      expect(guidance).not.toMatch(/automatically/i)
    })
  })

  test('the two variants produce different guidance', () => {
    expect(buildVisualGuidance(true)).not.toBe(buildVisualGuidance(false))
  })
})

import conversationTypes from '../../src/conversations/index.js'
import { FeatureConfig } from '../../src/types/index.types.js'

const VALID_CATEGORIES = ['assistant', 'group-chat', 'transcript', 'resources'] as const

const allFeatures: Array<{ typeName: string; feature: FeatureConfig }> = Object.values(conversationTypes).flatMap((ct) =>
  (ct.features ?? []).map((f) => ({ typeName: ct.name, feature: f }))
)

describe('ConversationType feature definitions', () => {
  test('at least one conversation type has features defined', () => {
    expect(allFeatures.length).toBeGreaterThan(0)
  })

  describe.each(allFeatures)('$typeName / $feature.name', ({ feature }) => {
    test('has a valid category', () => {
      expect(VALID_CATEGORIES).toContain(feature.category)
    })

    test('slashCommand is a non-empty string without a leading slash, if set', () => {
      if (feature.slashCommand !== undefined) {
        expect(typeof feature.slashCommand).toBe('string')
        expect(feature.slashCommand.length).toBeGreaterThan(0)
        expect(feature.slashCommand.startsWith('/')).toBe(false)
      }
    })

    test('prerequisite is a non-empty string if set', () => {
      if (feature.prerequisite !== undefined) {
        expect(typeof feature.prerequisite).toBe('string')
        expect(feature.prerequisite.length).toBeGreaterThan(0)
      }
    })

    test('has a boolean userControlled field', () => {
      expect(typeof feature.userControlled).toBe('boolean')
    })
  })
})

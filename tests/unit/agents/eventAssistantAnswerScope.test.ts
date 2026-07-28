import { buildLLMTemplates } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

describe('buildLLMTemplates answerScope', () => {
  describe('companyContextOnly', () => {
    const scoped = buildLLMTemplates(undefined, [], 'companyContextOnly')
    const scopedWithTools = buildLLMTemplates(undefined, ['web_search'], 'companyContextOnly')

    test('semanticSystem restricts to provided context only', () => {
      expect(scoped.semanticSystem).toMatch(/Only use information from the provided context/)
      expect(scoped.semanticSystem).toMatch(/Do not draw on general knowledge or external sources/)
    })

    test('semanticSystem tells model to say so clearly when context is missing', () => {
      expect(scoped.semanticSystem).toMatch(/say so clearly/)
      expect(scoped.semanticSystem).toMatch(/do not fill gaps with general knowledge/)
    })

    test('semanticSystem does not fall back to general knowledge', () => {
      expect(scoped.semanticSystem).not.toMatch(/use your general knowledge to provide a helpful response/)
      expect(scoped.semanticSystem).not.toMatch(/Suggest specific resources/)
    })

    test('scope restriction takes precedence over tools', () => {
      expect(scopedWithTools.semanticSystem).toMatch(/Only use information from the provided context/)
      expect(scopedWithTools.semanticSystem).not.toMatch(/Use your available tools.*to find the answer/)
    })
  })

  describe('helpUserUnderstandTheLecture', () => {
    const scoped = buildLLMTemplates(undefined, [], 'helpUserUnderstandTheLecture')

    test('semanticSystem anchors general knowledge to lecture content', () => {
      expect(scoped.semanticSystem).toMatch(/grounded in what the speaker is teaching|grounded in what is being taught/)
    })

    test('semanticSystem helpfulness line keeps answers lecture-grounded', () => {
      expect(scoped.semanticSystem).toMatch(/use general knowledge to explain concepts from the lecture/)
    })

    test('semanticSystem does not restrict to context-only', () => {
      expect(scoped.semanticSystem).not.toMatch(/Only use information from the provided context/)
    })

    test('semanticSystem still allows general knowledge resources (does not restrict to context-only)', () => {
      expect(scoped.semanticSystem).toMatch(/Suggest specific resources/)
    })
  })

  describe('default / open scope', () => {
    const noScope = buildLLMTemplates()
    const openScope = buildLLMTemplates(undefined, [], 'open')

    test('falls back to general knowledge with source transparency', () => {
      expect(noScope.semanticSystem).toMatch(/use your general knowledge to provide a helpful response/)
      expect(noScope.semanticSystem).toMatch(/According to general industry data|Research typically shows/)
    })

    test('open scope behaves the same as no scope', () => {
      expect(openScope.semanticSystem).toMatch(/use your general knowledge to provide a helpful response/)
    })

    test('suggests specific resources when no tools', () => {
      expect(noScope.semanticSystem).toMatch(/Suggest specific resources/)
    })
  })

  describe('scope does not affect classification prompt', () => {
    test('semanticClassificationSystem is identical across scopes', () => {
      const none = buildLLMTemplates().semanticClassificationSystem
      const restricted = buildLLMTemplates(undefined, [], 'companyContextOnly').semanticClassificationSystem
      const lecture = buildLLMTemplates(undefined, [], 'helpUserUnderstandTheLecture').semanticClassificationSystem
      expect(restricted).toEqual(none)
      expect(lecture).toEqual(none)
    })
  })
})

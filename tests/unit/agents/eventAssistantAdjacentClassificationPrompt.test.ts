import { eventAssistantLLMTemplates } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

describe('event assistant adjacent-vs-off-topic classification prompt', () => {
  test('semanticClassificationSystem includes adjacent subtopic exception', () => {
    const sys = eventAssistantLLMTemplates.semanticClassificationSystem

    expect(sys).toMatch(/adjacent subtopics/i)
    expect(sys).toMatch(/updated time windows|last month/i)
    expect(sys).toMatch(/bias towards ON_TOPIC_ANSWER/i)
    expect(sys).toMatch(/Do NOT use OFF_TOPIC for adjacent subtopics/i)
  })

  test('semanticClassificationSystem includes top-level Context-reference check pre-check', () => {
    const sys = eventAssistantLLMTemplates.semanticClassificationSystem

    expect(sys).toMatch(/Context-reference check/i)
    expect(sys).toMatch(/apply before choosing OFF_TOPIC/i)
    expect(sys).toMatch(/conceivably add to or extend the ongoing discussion/i)
    expect(sys).toMatch(/Recent conversation.*part of the ongoing discussion/i)
    expect(sys).toMatch(/Worked example/i)
  })

  test('semanticClassificationSystem keeps OFF_TOPIC for unrelated subjects', () => {
    const sys = eventAssistantLLMTemplates.semanticClassificationSystem

    expect(sys).toMatch(/OFF_TOPIC/i)
    expect(sys).toMatch(/Must be completely unrelated subject matter/i)
  })

  test('semanticClassificationSystem includes conversation-thread continuation for recent participant/speaker threads', () => {
    const sys = eventAssistantLLMTemplates.semanticClassificationSystem

    expect(sys).toMatch(/Conversation-thread continuation/i)
    expect(sys).toMatch(/prior chat messages/i)
    expect(sys).toMatch(/continue that same thread/i)
  })

  test('user template includes recentChat for thread-aware prompting', () => {
    const { user } = eventAssistantLLMTemplates
    expect(user).toMatch(/Recent conversation/i)
    expect(user).toMatch(/\{recentChat\}/)
  })
})


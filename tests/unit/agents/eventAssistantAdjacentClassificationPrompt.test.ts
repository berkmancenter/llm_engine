import { eventAssistantLLMTemplates, buildLLMTemplates } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'

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

  test('user template includes event topic, context, and question', () => {
    const { user } = eventAssistantLLMTemplates
    expect(user).toMatch(/\{topic\}/)
    expect(user).toMatch(/\{context\}/)
    expect(user).toMatch(/\{question\}/)
  })
})

describe('event assistant tool-aware classification prompt', () => {
  const withTools = buildLLMTemplates(null, undefined, ['web_search'])
  const withoutTools = buildLLMTemplates(null)

  describe('without tools (original behavior)', () => {
    test('biases toward ON_TOPIC_ASK_SPEAKER by default', () => {
      const sys = withoutTools.semanticClassificationSystem
      expect(sys).toMatch(/Default assumption:.*Almost all questions.*should go to the speaker.*ON_TOPIC_ASK_SPEAKER/i)
      expect(sys).toMatch(/bias towards ON_TOPIC_ASK_SPEAKER/i)
    })

    test('ON_TOPIC_ASK_SPEAKER is the default for topic-related questions', () => {
      const sys = withoutTools.semanticClassificationSystem
      expect(sys).toMatch(/DEFAULT for topic-related questions/i)
    })

    test('ON_TOPIC_ANSWER is narrow — requires authoritative answer from context', () => {
      const sys = withoutTools.semanticClassificationSystem
      expect(sys).toMatch(/Can be answered authoritatively and exhaustively WITHOUT speaker input/i)
    })
  })

  describe('with tools (tool-aware behavior)', () => {
    test('biases toward ON_TOPIC_ANSWER by default', () => {
      const sys = withTools.semanticClassificationSystem
      expect(sys).toMatch(/bias towards ON_TOPIC_ANSWER/i)
      expect(sys).not.toMatch(/Almost all questions.*should go to the speaker/i)
    })

    test('mentions the assistant has context, knowledge, and web search', () => {
      const sys = withTools.semanticClassificationSystem
      expect(sys).toMatch(/event context.*knowledge base.*web search/i)
    })

    test('ON_TOPIC_ASK_SPEAKER is restricted to personal input and specialized expertise', () => {
      const sys = withTools.semanticClassificationSystem
      expect(sys).toMatch(/PERSONAL input or SPECIALIZED EXPERTISE/i)
      expect(sys).toMatch(/personal opinions, predictions, or subjective takes/i)
      expect(sys).toMatch(/personal experience or decisions/i)
      expect(sys).toMatch(/specialized, insider, or cutting-edge knowledge/i)
    })

    test('ON_TOPIC_ASK_SPEAKER excludes well-established and searchable facts', () => {
      const sys = withTools.semanticClassificationSystem
      expect(sys).toMatch(/well-established concepts.*do NOT use this.*ON_TOPIC_ANSWER/i)
      expect(sys).toMatch(/factual, definitional, or generally knowable.*do NOT use this/i)
      expect(sys).toMatch(/found via web search.*do NOT use this/i)
    })

    test('ON_TOPIC_ANSWER is the default for on-topic questions', () => {
      const sys = withTools.semanticClassificationSystem
      expect(sys).toMatch(/DEFAULT for on-topic questions/i)
    })

    test('ON_TOPIC_ANSWER covers general knowledge, factual, and researchable questions', () => {
      const sys = withTools.semanticClassificationSystem
      expect(sys).toMatch(/factual, definitional, or explanatory question/i)
      expect(sys).toMatch(/Questions answerable from general knowledge alone/i)
      expect(sys).toMatch(/Any researchable question/i)
    })
  })

  describe('shared safeguards in both variants', () => {
    test.each([
      ['without tools', withoutTools],
      ['with tools', withTools]
    ])('%s retains OFF_TOPIC safeguards', (_label, templates) => {
      const sys = templates.semanticClassificationSystem
      expect(sys).toMatch(/Context-reference check/i)
      expect(sys).toMatch(/Must be completely unrelated subject matter/i)
      expect(sys).toMatch(/Conversation-thread continuation/i)
      expect(sys).toMatch(/Do NOT use OFF_TOPIC for adjacent subtopics/i)
    })

    test.each([
      ['without tools', withoutTools],
      ['with tools', withTools]
    ])('%s includes CATCHUP and UNANSWERABLE classifications', (_label, templates) => {
      const sys = templates.semanticClassificationSystem
      expect(sys).toMatch(/CATCHUP.*General event summary requests/i)
      expect(sys).toMatch(/UNANSWERABLE.*Extremely rare/i)
    })

    test.each([
      ['without tools', withoutTools],
      ['with tools', withTools]
    ])('%s includes output format instruction', (_label, templates) => {
      const sys = templates.semanticClassificationSystem
      expect(sys).toMatch(/Return ONLY a single string/i)
      expect(sys).toMatch(/CATCHUP, ON_TOPIC_ASK_SPEAKER, ON_TOPIC_ANSWER, OFF_TOPIC, UNANSWERABLE/)
    })
  })
})


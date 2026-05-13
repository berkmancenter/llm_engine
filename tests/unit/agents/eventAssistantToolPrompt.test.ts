import {
  buildEventAssistantToolSystemPrompt,
  EVENT_ASSISTANT_TOOL_USAGE_RULES,
  EVENT_ASSISTANT_TOOL_USER_MANDATE
} from '../../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'
import { eventAssistantLLMTemplates } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'
import { webSearchTool } from '../../../src/agents/tools/webSearch.js'

describe('event assistant tool system prompt', () => {
  test('EVENT_ASSISTANT_TOOL_USAGE_RULES anchors Context and conversation history', () => {
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/recent transcript|retrieved chunks/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/conversation history/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/Do NOT call.*web_search/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/explicitly or unambiguously/i)
  })

  test('EVENT_ASSISTANT_TOOL_USAGE_RULES tells the LLM to use tools instead of suggesting sources', () => {
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/use tools instead of suggesting sources/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/run the search and synthesize/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/Do NOT tell the user/i)
  })

  test('EVENT_ASSISTANT_TOOL_USAGE_RULES defaults to web_search when uncertain or beyond cutoff', () => {
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/search first when not certain/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/MUST call.*web_search/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/training cutoff|after your cutoff/i)
    expect(EVENT_ASSISTANT_TOOL_USAGE_RULES).toMatch(/prefer running.*web_search|redundant search/i)
  })

  test('EVENT_ASSISTANT_TOOL_USER_MANDATE reinforces search-before-guess for the user turn', () => {
    expect(EVENT_ASSISTANT_TOOL_USER_MANDATE).toMatch(/Tool policy \(mandatory\)/i)
    expect(EVENT_ASSISTANT_TOOL_USER_MANDATE).toMatch(/must.*call.*web_search/i)
    expect(EVENT_ASSISTANT_TOOL_USER_MANDATE).toMatch(/uncertain.*search first|search first/i)
  })

  test('webSearchTool description defaults to search when unsure and limits omit-only cases', () => {
    expect(webSearchTool.description).toMatch(/event transcript|chat supplied/i)
    expect(webSearchTool.description).toMatch(/Default:.*unsure|unsure whether context/i)
    expect(webSearchTool.description).toMatch(/Omit only/i)
  })

  test('buildEventAssistantToolSystemPrompt places tool rules before context', () => {
    const base = 'BASE_SYSTEM_TEMPLATE'
    const topic = 'Test topic title'
    const ctx = 'TRANSCRIPT_SNIPPET_ONLY_HERE'
    const { systemPrompt: full } = buildEventAssistantToolSystemPrompt(base, topic, ctx)
    expect(full.startsWith(base)).toBe(true)
    const toolRulesPos = full.indexOf(EVENT_ASSISTANT_TOOL_USAGE_RULES)
    const contextPos = full.indexOf(ctx)
    expect(toolRulesPos).toBeGreaterThan(-1)
    expect(contextPos).toBeGreaterThan(-1)
    expect(toolRulesPos).toBeLessThan(contextPos)
  })

  test('buildEventAssistantToolSystemPrompt replaces "suggest resources" and "point toward" with tools-aware guidance', () => {
    const { systemPrompt: full } = buildEventAssistantToolSystemPrompt(
      eventAssistantLLMTemplates.semanticSystem,
      'Test topic',
      'Test context'
    )
    expect(full).not.toMatch(/Suggest specific resources or places to find more information/)
    expect(full).toMatch(/Use your available tools \(e\.g\. web_search\) to find the answer before responding/)
    expect(full).toMatch(/If tools return no results, provide what you know from general knowledge/)

    expect(full).not.toMatch(/point toward additional resources/)
    expect(full).toMatch(/use your tools to find information the event materials lack/)
  })
})

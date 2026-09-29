import {
  buildEventAssistantToolSystemPrompt,
  EVENT_ASSISTANT_TOOL_USAGE_RULES,
  EVENT_ASSISTANT_TOOL_USER_MANDATE
} from '../../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'
import { VOICE_OUTPUT_RULES } from '../../../src/agents/helpers/voiceDirectives.js'
import { buildLLMTemplates } from '../../../src/agents/eventAssistant/eventQuestionHandler.js'
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

  test('buildEventAssistantToolSystemPrompt places tool rules before context', async () => {
    const base = 'BASE_SYSTEM_TEMPLATE'
    const topic = 'Test topic title'
    const ctx = 'TRANSCRIPT_SNIPPET_ONLY_HERE'
    const full = await buildEventAssistantToolSystemPrompt(base, topic, ctx)
    expect(full.startsWith(base)).toBe(true)
    const toolRulesPos = full.indexOf(EVENT_ASSISTANT_TOOL_USAGE_RULES)
    const contextPos = full.indexOf(ctx)
    expect(toolRulesPos).toBeGreaterThan(-1)
    expect(contextPos).toBeGreaterThan(-1)
    expect(toolRulesPos).toBeLessThan(contextPos)
  })

  test('buildEventAssistantToolSystemPrompt places voice output rules after tool rules but before context', async () => {
    const ctx = 'TRANSCRIPT_SNIPPET_ONLY_HERE'
    const full = await buildEventAssistantToolSystemPrompt('BASE', 'topic', ctx, { voiceOutput: true })
    const toolRulesPos = full.indexOf(EVENT_ASSISTANT_TOOL_USAGE_RULES)
    const voiceRulesPos = full.indexOf(VOICE_OUTPUT_RULES)
    const contextPos = full.indexOf(ctx)
    expect(voiceRulesPos).toBeGreaterThan(-1)
    expect(toolRulesPos).toBeLessThan(voiceRulesPos)
    expect(voiceRulesPos).toBeLessThan(contextPos)
  })

  test('buildEventAssistantToolSystemPrompt omits voice output rules when voiceOutput is not set', async () => {
    const full = await buildEventAssistantToolSystemPrompt('BASE', 'topic', 'ctx')
    expect(full).not.toContain(VOICE_OUTPUT_RULES)
  })

  test('buildEventAssistantToolSystemPrompt omits web-search rules when hasWebSearch is false', async () => {
    const full = await buildEventAssistantToolSystemPrompt('BASE', 'topic', 'ctx', { hasWebSearch: false })
    expect(full).not.toContain(EVENT_ASSISTANT_TOOL_USAGE_RULES)
    expect(full.startsWith('BASE')).toBe(true)
  })

  test('buildLLMTemplates with tool names produces tools-aware guidance in semanticSystem', () => {
    const { semanticSystem } = buildLLMTemplates(undefined, ['web_search'])
    expect(semanticSystem).not.toMatch(/Suggest specific resources or places to find more information/)
    expect(semanticSystem).toMatch(/Use your available tools \(e\.g\. web_search\) to find the answer before responding/)
    expect(semanticSystem).toMatch(/If tools return no results, provide what you know from general knowledge/)
    expect(semanticSystem).not.toMatch(/point toward additional resources/)
    expect(semanticSystem).toMatch(/use your tools to find information the event materials lack/)
  })

  test('buildLLMTemplates without tool names retains standard resource guidance in semanticSystem', () => {
    const { semanticSystem } = buildLLMTemplates()
    expect(semanticSystem).toMatch(/Suggest specific resources or places to find more information/)
    expect(semanticSystem).toMatch(/point toward additional resources/)
    expect(semanticSystem).not.toMatch(/Use your available tools/)
  })
})

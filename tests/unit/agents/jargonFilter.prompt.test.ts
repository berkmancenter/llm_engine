import { ChatPromptTemplate } from '@langchain/core/prompts'
import jargonFilter, { JARGON_FOLLOW_UP_SYSTEM_PROMPT } from '../../../src/agents/jargonFilter/jargonFilter.js'

// LangChain reads any single-brace span as a placeholder, so a literal JSON example that isn't
// written with {{ }} turns into a variable nobody fills in and every call throws.
const placeholdersIn = (template: string) => ChatPromptTemplate.fromMessages([['system', template]]).inputVariables.sort()

describe('jargon filter prompts', () => {
  it('system prompt has exactly the placeholders the agent declares', () => {
    const declared = jargonFilter.llmTemplateVars.system.map((v) => v.name).sort()

    expect(placeholdersIn(jargonFilter.defaultLLMTemplates.system)).toEqual(declared)
  })

  it('user prompt has exactly the placeholders the agent declares', () => {
    const declared = jargonFilter.llmTemplateVars.user.map((v) => v.name).sort()

    expect(placeholdersIn(jargonFilter.defaultLLMTemplates.user)).toEqual(declared)
  })

  it('follow-up system prompt has no placeholders', () => {
    expect(placeholdersIn(JARGON_FOLLOW_UP_SYSTEM_PROMPT)).toEqual([])
  })
})

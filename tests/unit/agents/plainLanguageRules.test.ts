import PLAIN_LANGUAGE_TERM_RULES from '../../../src/agents/helpers/plainLanguageRules.js'
import {
  JARGON_FILTER_SYSTEM_PROMPT,
  JARGON_FOLLOW_UP_SYSTEM_PROMPT
} from '../../../src/agents/jargonFilter/jargonFilter.js'

describe('PLAIN_LANGUAGE_TERM_RULES', () => {
  it('pitches explanations at a high school student and bans words that make the reader feel slow', () => {
    expect(PLAIN_LANGUAGE_TERM_RULES).toContain('high school student')
    expect(PLAIN_LANGUAGE_TERM_RULES).toContain('"simply"')
  })

  // Prompts are LangChain templates, where a single brace starts a variable
  it('contains no braces, so it can be dropped into any prompt template', () => {
    expect(PLAIN_LANGUAGE_TERM_RULES).not.toMatch(/[{}]/)
  })

  it.each([
    ['proactive jargon filter', JARGON_FILTER_SYSTEM_PROMPT],
    ['jargon follow-up', JARGON_FOLLOW_UP_SYSTEM_PROMPT]
  ])('is used by the %s prompt', (_name, prompt) => {
    expect(prompt).toContain(PLAIN_LANGUAGE_TERM_RULES)
  })
})

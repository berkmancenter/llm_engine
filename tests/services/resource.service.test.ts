import { formatSummary } from '../../src/services/resource.service.js'

describe('formatSummary()', () => {
  const validSummary = {
    mainThesis: ['The central argument'],
    keyFindings: ['Finding one', 'Finding two'],
    practicalRelevance: ['Why it matters']
  }

  it('formats a well-formed summary into markdown sections', () => {
    const result = formatSummary(validSummary)

    expect(result).toContain('**Main Thesis**')
    expect(result).toContain('- The central argument')
    expect(result).toContain('**Key Findings**')
    expect(result).toContain('- Finding one')
    expect(result).toContain('- Finding two')
    expect(result).toContain('**Practical Relevance**')
    expect(result).toContain('- Why it matters')
  })

  it('omits the Methodology section when the field is absent', () => {
    const result = formatSummary(validSummary)
    expect(result).not.toContain('**Methodology**')
  })

  it('includes the Methodology section when the field is present', () => {
    const result = formatSummary({ ...validSummary, methodology: ['Qualitative interviews'] })
    expect(result).toContain('**Methodology**')
    expect(result).toContain('- Qualitative interviews')
  })

  /*
   * The LLM occasionally returns a plain string instead of a single-item array,
   * especially on the Bedrock path where tool-call args are not Zod-validated
   * before being passed to formatSummary. This test captures that crash and
   * ensures the fix handles it gracefully.
   */
  it('does not throw when the LLM returns a string instead of an array for a field', () => {
    const malformed = {
      // LLM returned a bare string for a single-item list
      mainThesis: 'The central argument' as unknown as string[],
      keyFindings: ['Finding one'],
      practicalRelevance: ['Why it matters']
    }

    expect(() => formatSummary(malformed)).not.toThrow()
  })

  it('includes the string value as a bullet when the LLM returns a string for an array field', () => {
    const malformed = {
      mainThesis: 'The central argument' as unknown as string[],
      keyFindings: ['Finding one'],
      practicalRelevance: ['Why it matters']
    }

    const result = formatSummary(malformed)
    expect(result).toContain('- The central argument')
  })
})

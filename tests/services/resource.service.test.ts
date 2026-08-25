import resourceService, { formatSummary } from '../../src/services/resource.service.js'
import Conversation from '../../src/models/conversation.model.js'
import { publicTopic, conversationOne } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { insertUsers, userOne } from '../fixtures/user.fixture.js'
import setupIntTest from '../utils/setupIntTest.js'

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

describe('summarizePdf()', () => {
  setupIntTest()

  /* If this job is torn down mid-flight (LLM call finishes, then the process dies before
     agenda records completion) and retried from scratch, the retry should skip the LLM call
     entirely rather than burn a duplicate one before overwriting the same field. Passing a
     nonexistent filePath proves the skip actually happens before any file/LLM work: if the
     guard didn't short-circuit, PDFLoader would throw trying to read it. */
  test('skips the LLM call entirely when the resource already has a summary', async () => {
    await insertUsers([userOne])
    await insertTopics([publicTopic])
    const conversation = new Conversation({
      ...conversationOne,
      resources: [{ source: 'ai', category: 'suggested', title: 'Paper', citation: 'Cite', summary: 'Already summarized.' }]
    })
    await conversation.save()
    const resourceId = conversation.resources[0]._id!.toString()

    await expect(
      resourceService.summarizePdf(conversation._id.toString(), resourceId, '/nonexistent/path.pdf', 'Cite')
    ).resolves.not.toThrow()

    const updated = await Conversation.findById(conversation._id)
    expect(updated!.resources[0].summary).toBe('Already summarized.')
  })
})

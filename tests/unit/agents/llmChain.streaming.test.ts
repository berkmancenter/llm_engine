import { extractCompleteSentences, streamAgentAndReportChunks } from '../../../src/agents/helpers/llmChain.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamEvent(event: string, extra: object = {}) {
  return { event, ...extra }
}

function chatStreamEvent(runId: string, content: string | unknown[], toolCallChunks?: unknown[]) {
  return streamEvent('on_chat_model_stream', {
    run_id: runId,
    data: {
      chunk: {
        content,
        ...(toolCallChunks ? { tool_call_chunks: toolCallChunks } : {})
      }
    }
  })
}

function chatEndEvent(runId: string, toolCalls: unknown[] = []) {
  return streamEvent('on_chat_model_end', {
    run_id: runId,
    data: { output: { tool_calls: toolCalls } }
  })
}

function toolStartEvent(runId: string) {
  return streamEvent('on_tool_start', { run_id: runId })
}

function langgraphEndEvent(finalOutput: unknown) {
  return streamEvent('on_chain_end', { name: 'LangGraph', data: { output: finalOutput } })
}

function makeAgent(events: object[]) {
  return {
    async *streamEvents() {
      for (const event of events) {
        yield event
      }
    }
  }
}

const FINAL_STATE = { messages: ['final-message'] }

// ---------------------------------------------------------------------------
// extractCompleteSentences
// ---------------------------------------------------------------------------

describe('extractCompleteSentences', () => {
  it('returns empty sentences and the full text when there is no terminator', () => {
    expect(extractCompleteSentences('Hello there')).toEqual({
      sentences: [],
      remainder: 'Hello there'
    })
  })

  it('returns empty output for an empty string', () => {
    expect(extractCompleteSentences('')).toEqual({ sentences: [], remainder: '' })
  })

  it('splits a single terminated sentence', () => {
    const { sentences, remainder } = extractCompleteSentences('Hello there.')
    expect(sentences).toEqual(['Hello there.'])
    expect(remainder).toBe('')
  })

  it('splits multiple sentences and returns the partial remainder', () => {
    const { sentences, remainder } = extractCompleteSentences('First sentence. Second sentence. Still going')
    expect(sentences).toEqual(['First sentence.', 'Second sentence.'])
    expect(remainder).toBe(' Still going')
  })

  it('handles exclamation and question marks as terminators', () => {
    const { sentences } = extractCompleteSentences('Really? Yes! Definitely.')
    expect(sentences).toEqual(['Really?', 'Yes!', 'Definitely.'])
  })

  it('does not split on embedded dots in URLs or domain names', () => {
    // "cyber.harvard.edu" contains dots but only the final period ends the sentence.
    const { sentences, remainder } = extractCompleteSentences('Visit cyber.harvard.edu for more info. And check it out')
    expect(sentences).toEqual(['Visit cyber.harvard.edu for more info.'])
    expect(remainder).toBe(' And check it out')
  })

  it('treats a trailing non-terminated fragment as remainder after complete sentences', () => {
    const { sentences, remainder } = extractCompleteSentences('Done. Almost')
    expect(sentences).toEqual(['Done.'])
    expect(remainder).toBe(' Almost')
  })
})

// ---------------------------------------------------------------------------
// streamAgentAndReportChunks
// ---------------------------------------------------------------------------

describe('streamAgentAndReportChunks', () => {
  it('buffers pre-tool text and emits it on model_end when no tool was called', async () => {
    const chunks: string[] = []
    const events = [chatStreamEvent('r1', 'The answer is yes.'), chatEndEvent('r1', []), langgraphEndEvent(FINAL_STATE)]

    const result = await streamAgentAndReportChunks(makeAgent(events), [], 20, (t) => chunks.push(t))

    expect(chunks).toEqual(['The answer is yes.'])
    expect(result).toBe(FINAL_STATE)
  })

  it('discards pre-tool narration and streams post-tool text as sentences arrive', async () => {
    const chunks: string[] = []
    const events = [
      // narration before the tool call — must be discarded
      chatStreamEvent('r1', 'Let me check on that.'),
      toolStartEvent('t1'),
      // answer after the tool call — streamed live
      chatStreamEvent('r2', 'The answer is '),
      chatStreamEvent('r2', 'forty-two.'),
      langgraphEndEvent(FINAL_STATE)
    ]

    await streamAgentAndReportChunks(makeAgent(events), [], 20, (t) => chunks.push(t))

    expect(chunks).not.toContain('Let me check on that.')
    expect(chunks).toContain('The answer is forty-two.')
  })

  it('flushes a trailing partial sentence after the stream ends', async () => {
    const chunks: string[] = []
    const events = [
      toolStartEvent('t1'),
      // no terminator — will sit in liveBuffer until the stream ends
      chatStreamEvent('r2', 'No period here'),
      langgraphEndEvent(FINAL_STATE)
    ]

    await streamAgentAndReportChunks(makeAgent(events), [], 20, (t) => chunks.push(t))

    expect(chunks).toContain('No period here')
  })

  it('skips tool_call_chunks so partial tool invocations are not spoken', async () => {
    const chunks: string[] = []
    const events = [
      toolStartEvent('t1'),
      // tool_call_chunks present — should be filtered out entirely
      chatStreamEvent('r2', '', [{ index: 0, name: 'web_search' }]),
      chatStreamEvent('r2', 'Real answer.'),
      langgraphEndEvent(FINAL_STATE)
    ]

    await streamAgentAndReportChunks(makeAgent(events), [], 20, (t) => chunks.push(t))

    expect(chunks).toEqual(['Real answer.'])
  })

  it('handles array content blocks (Claude-style) the same as plain strings', async () => {
    const chunks: string[] = []
    const events = [
      chatStreamEvent('r1', [{ text: 'Array-based answer.' }]),
      chatEndEvent('r1', []),
      langgraphEndEvent(FINAL_STATE)
    ]

    await streamAgentAndReportChunks(makeAgent(events), [], 20, (t) => chunks.push(t))

    expect(chunks).toContain('Array-based answer.')
  })

  it('throws when the stream ends without a LangGraph final state', async () => {
    const events = [
      chatStreamEvent('r1', 'Hi.'),
      chatEndEvent('r1', [])
      // no on_chain_end / LangGraph event
    ]

    await expect(streamAgentAndReportChunks(makeAgent(events), [], 20, () => {})).rejects.toThrow(/final LangGraph state/)
  })

  it('accumulates multi-chunk text before splitting into sentences', async () => {
    const chunks: string[] = []
    const events = [
      toolStartEvent('t1'),
      chatStreamEvent('r2', 'The sky '),
      chatStreamEvent('r2', 'is blue. '),
      chatStreamEvent('r2', 'The grass '),
      chatStreamEvent('r2', 'is green.'),
      langgraphEndEvent(FINAL_STATE)
    ]

    await streamAgentAndReportChunks(makeAgent(events), [], 20, (t) => chunks.push(t))

    expect(chunks).toEqual(['The sky is blue.', 'The grass is green.'])
  })
})

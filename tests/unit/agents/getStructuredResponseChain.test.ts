import { ChatPromptTemplate } from '@langchain/core/prompts'
import { RunnableLambda } from '@langchain/core/runnables'
import { z } from 'zod'
import { getStructuredResponseChain } from '../../../src/agents/helpers/llmChain.js'

const responseSchema = z.object({
  header: z.string(),
  standouts: z.array(z.object({ text: z.string() }))
})

/* Stands in for a Claude-family model: the anthropic model name routes llmChain down the
   bindTools path (the one Bedrock uses), and bindTools returns a runnable that replays one
   canned response message. */
function fakeClaudeModel(message: unknown) {
  return {
    model: 'us.anthropic.claude-sonnet-4-6',
    bindTools: () => RunnableLambda.from(async () => message)
  }
}

function toolCallMessage(args: unknown, stopReason: string) {
  return {
    tool_calls: [{ name: 'structured_response', args, id: 'call_1' }],
    response_metadata: { stop_reason: stopReason }
  }
}

function invokeChain(message: unknown) {
  const prompt = ChatPromptTemplate.fromMessages([['user', 'summarize the event']])
  return getStructuredResponseChain(fakeClaudeModel(message), prompt, responseSchema).invoke({})
}

describe('getStructuredResponseChain', () => {
  it('reports a truncated response as truncation, not as a schema mismatch', async () => {
    // What Bedrock returns when the cap lands mid tool call: the fields written before the
    // cutoff, with the rest of the payload missing.
    const truncated = toolCallMessage({ header: 'The Future of Work drew a smaller crowd' }, 'max_tokens')

    await expect(invokeChain(truncated)).rejects.toThrow(/cut off at the max_tokens cap/)
  })

  it('parses a complete tool call', async () => {
    const complete = toolCallMessage(
      { header: 'Quiet room', standouts: [{ text: 'Turnout ran low' }, { text: 'Chat stayed public' }] },
      'tool_use'
    )

    await expect(invokeChain(complete)).resolves.toEqual({
      header: 'Quiet room',
      standouts: [{ text: 'Turnout ran low' }, { text: 'Chat stayed public' }]
    })
  })

  it('still reports a schema mismatch when the response finished', async () => {
    const wrongShape = toolCallMessage({ header: 'Quiet room', standouts: 'not an array' }, 'tool_use')

    await expect(invokeChain(wrongShape)).rejects.toThrow(/did not match schema/)
  })
})

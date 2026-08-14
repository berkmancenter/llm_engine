import { RunnableLambda } from '@langchain/core/runnables'
import { z } from 'zod'
import { getChatPromptResponse } from '../../../src/agents/helpers/llmChain.js'

const responseSchema = z.object({
  header: z.string(),
  standouts: z.array(z.object({ text: z.string() }))
})

/* Stands in for a Claude-family model: the anthropic model name routes llmChain down the
   bindTools path (the one Bedrock uses), and bindTools returns a runnable that replays the
   canned messages in order, one per call, so a retry sees a fresh response. An Error in
   the list is thrown instead, imitating the model client failing. Records how many calls
   the model received. */
function fakeClaudeModelSequence(messages: unknown[]) {
  let calls = 0
  return {
    model: 'us.anthropic.claude-sonnet-4-6',
    bindTools: () =>
      RunnableLambda.from(async () => {
        const message = messages[calls]
        calls += 1
        if (message instanceof Error) throw message
        return message
      }),
    callCount: () => calls
  }
}

function toolCallMessage(args: unknown) {
  return { tool_calls: [{ name: 'structured_response', args, id: 'call_1' }] }
}

function invokeWithSchema(model: ReturnType<typeof fakeClaudeModelSequence>) {
  return getChatPromptResponse(model, 'You are a summarizer', 'summarize the event', {}, undefined, responseSchema)
}

describe('getChatPromptResponse structured-output retry', () => {
  const goodPayload = { header: 'Quiet room', standouts: [{ text: 'Turnout ran low' }, { text: 'Chat stayed public' }] }

  it('retries once when the first structured response is malformed', async () => {
    const model = fakeClaudeModelSequence([toolCallMessage({}), toolCallMessage(goodPayload)])

    await expect(invokeWithSchema(model)).resolves.toEqual(goodPayload)
    expect(model.callCount()).toBe(2)
  })

  it('gives up after a second malformed response', async () => {
    const model = fakeClaudeModelSequence([
      toolCallMessage({}),
      toolCallMessage({ header: 'Quiet room', standouts: 'still not an array' })
    ])

    await expect(invokeWithSchema(model)).rejects.toThrow(/did not match schema/)
    expect(model.callCount()).toBe(2)
  })

  it('does not retry when the model call itself fails', async () => {
    const model = fakeClaudeModelSequence([new Error('connection reset'), toolCallMessage(goodPayload)])

    await expect(invokeWithSchema(model)).rejects.toThrow('connection reset')
    expect(model.callCount()).toBe(1)
  })
})

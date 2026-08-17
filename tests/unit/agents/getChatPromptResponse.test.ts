import { RunnableLambda } from '@langchain/core/runnables'
import { z } from 'zod'
import { getChatPromptResponse } from '../../../src/agents/helpers/llmChain.js'

// ---------------------------------------------------------------------------
// Fake models
// ---------------------------------------------------------------------------

/* Minimal fake LLM: a RunnableLambda (so LangChain accepts it in a RunnableSequence)
   with modelName attached so shouldUseStructuredOutput routes it down the non-Bedrock path.
   Returns a fake AIMessage-shaped object that StringOutputParser can extract text from. */
function fakeLlm() {
  return Object.assign(RunnableLambda.from(async () => ({ content: 'ok' })), { modelName: 'gpt-4o' })
}

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const responseSchema = z.object({
  header: z.string(),
  standouts: z.array(z.object({ text: z.string() }))
})

function invokeWithSchema(model: ReturnType<typeof fakeClaudeModelSequence>) {
  return getChatPromptResponse(model, 'You are a summarizer', 'summarize the event', {}, undefined, responseSchema)
}

function invokeBasic(chatHistory?, question = 'hello') {
  return getChatPromptResponse(fakeLlm(), 'You are a helpful assistant.', 'Answer: {question}', { question }, chatHistory)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getChatPromptResponse', () => {
  describe('structured-output retry', () => {
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

  describe('curly brace handling in chat history', () => {
    it('does not throw when chat history contains curly braces', async () => {
      // If chat history were interpolated as a template string, LangChain would throw
      // "Missing value for input variable 'input: hide'". With MessagesPlaceholder it should not.
      const chatHistory = [
        { role: 'user', content: 'what is {input: hide}?' },
        { role: 'assistant', content: 'I am not sure what {input: hide} means.' }
      ]
      await expect(invokeBasic(chatHistory)).resolves.toBeDefined()
    })

    it('does not throw when a user inputParam value contains curly braces', async () => {
      // inputParam values are substituted into template placeholders but not re-scanned —
      // confirming this holds alongside the history fix.
      await expect(invokeBasic([], '{input: hide}')).resolves.toBeDefined()
    })

    it('handles empty chat history', async () => {
      await expect(invokeBasic([])).resolves.toBeDefined()
    })

    it('handles undefined chat history', async () => {
      await expect(invokeBasic(undefined)).resolves.toBeDefined()
    })
  })
})

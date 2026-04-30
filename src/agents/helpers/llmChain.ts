import { ChatPromptTemplate, PromptTemplate } from '@langchain/core/prompts'
// import { ConsoleCallbackHandler } from 'langchain/callbacks'
import { StringOutputParser, StructuredOutputParser } from '@langchain/core/output_parsers'
import { RunnableSequence } from '@langchain/core/runnables'
import { SystemMessage } from '@langchain/core/messages'
import { createAgent } from 'langchain'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import logger from '../../config/logger.js'
import rag from './rag.js'

const RESPONSE_PLACEHOLDER = '(user sent an empty message)'

// Helper to determine if we should use structured output for a given LLM
function shouldUseStructuredOutput(llm): boolean {
  // Skip structured output for Claude models to avoid tool calling issues
  if (llm.modelName && typeof llm.modelName === 'string' && llm.modelName.toLowerCase().includes('anthropic')) {
    return false
  }
  if (llm.model && typeof llm.model === 'string' && llm.model.toLowerCase().includes('anthropic')) {
    return false
  }
  // Also check for bedrock platform
  if (llm.baseUrl && typeof llm.baseUrl === 'string' && llm.baseUrl.toLowerCase().includes('bedrock')) {
    return false
  }
  return true
}

async function getSinglePromptResponse(llm, template, inputParams, outputSchema?) {
  const prompt = PromptTemplate.fromTemplate(template)
  if (outputSchema) {
    const llmWithTool = llm.withStructuredOutput(outputSchema)
    return prompt.pipe(llmWithTool).invoke(inputParams)
  }
  return prompt.pipe(llm).pipe(new StringOutputParser()).invoke(inputParams)
}

// vLLM and other OpenAI compatible endpoints require strict system (optional), user, assistant, user, ... ordering
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureAlternatingChat(history: any[]) {
  if (history.length === 0) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = []
  let i = 0

  // Accept at most one system at the beginning
  if (history[0].role === 'system') {
    out.push(history[0])
    i = 1
    // Skip further system messages
    while (i < history.length && history[i].role === 'system') i++
  }

  // Gather only user and assistant messages
  const dialogue = history.slice(i).filter((msg) => msg.role === 'user' || msg.role === 'assistant')

  // If there's no dialogue, just return what we have (system or empty)
  if (dialogue.length === 0) return out

  let nextRole: 'user' | 'assistant' = 'user'
  let dIndex = 0

  // Alternate strictly: always expect user, then assistant, etc.
  while (dIndex < dialogue.length) {
    if (dialogue[dIndex].role === nextRole) {
      out.push(dialogue[dIndex])
      dIndex++
    } else {
      // Insert dummy for missing turn
      out.push({ role: nextRole, content: RESPONSE_PLACEHOLDER })
    }
    // Toggle role for next expected
    nextRole = nextRole === 'user' ? 'assistant' : 'user'
  }

  // After consuming, if last was not assistant, append a dummy assistant reply
  if (out[out.length - 1].role !== 'assistant') {
    out.push({ role: 'assistant', content: RESPONSE_PLACEHOLDER })
  }

  return out
}

/**
 * Parses a raw text response into structured output using a Zod schema.
 *
 * This helper handles:
 * - Stripping markdown code fences (```json, ```)
 * - Parsing with StructuredOutputParser
 * - Array wrapping/unwrapping based on schema shape
 *
 * @param text - The raw text response to parse
 * @param responseFormatSchema - The Zod schema to parse against
 * @returns Parsed and validated structured output
 */
async function parseAgentStructuredResponse(text: string, responseFormatSchema) {
  // Deduce the non-structured schema from the structured schema
  // If structured schema is an object with a single property that's an array, unwrap it
  // Otherwise, use the structured schema as-is
  const { shape } = responseFormatSchema
  const keys = Object.keys(shape)

  let arrayKey

  if (keys.length === 1 && shape[keys[0]] instanceof z.ZodArray) {
    ;[arrayKey] = keys
  }
  const parser = StructuredOutputParser.fromZodSchema(responseFormatSchema)

  // Extract JSON from code fences if present, otherwise just trim
  let cleanedText = text.trim()

  // Check if text contains code fences
  if (text.includes('```')) {
    // Find the LAST code fence (in case there are multiple)
    const lastClosingFence = text.lastIndexOf('```')
    if (lastClosingFence > 0) {
      // Find the opening fence before it
      const beforeClosing = text.substring(0, lastClosingFence)
      const lastOpeningFence = beforeClosing.lastIndexOf('```')
      if (lastOpeningFence !== -1) {
        // Extract content between the fences
        let fenceContent = text.substring(lastOpeningFence + 3, lastClosingFence)
        // Remove optional 'json' marker and leading/trailing whitespace
        fenceContent = fenceContent.replace(/^json\s*\n?/i, '').trim()
        cleanedText = fenceContent
      }
    }
  }

  // If the agent returned a bare array but the schema expects a wrapped object, re-wrap it
  let textToParse = cleanedText
  if (arrayKey) {
    try {
      const parsedJson = JSON.parse(cleanedText)
      if (Array.isArray(parsedJson)) {
        textToParse = JSON.stringify({ [arrayKey]: parsedJson })
        logger.debug(`Re-wrapped bare array as '${arrayKey}' property for parsing`)
      }
    } catch (e) {
      logger.debug(`Failed to pre-parse JSON for re-wrapping: ${e}`)
    }
  }

  return parser.parse(textToParse)
}

/**
 * Creates a runnable chain that processes agent output with logging and optional structured parsing.
 *
 * This chain handles:
 * - Extracting and logging tool calls from agent messages
 * - Extracting final text response using StringOutputParser
 * - Optionally parsing structured output with a Zod schema
 *
 * @param responseSchema - Optional Zod schema for structured output parsing
 * @returns A LangChain runnable that processes agent results
 */
function createAgentOutputChain(responseSchema?) {
  // Step 1: Log tool calls and extract final message
  const logAndExtractStep = async (agentResult) => {
    const { messages } = agentResult

    // Log tool calls for debugging
    messages.forEach((msg, idx) => {
      const msgType = msg._getType()
      if (msgType === 'ai') {
        // Type guard: check if message has tool_calls property
        const aiMsg = msg as { tool_calls?: Array<{ name: string; args: unknown; id?: string }> }
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          logger.debug(`[${idx}] AIMessage with ${aiMsg.tool_calls.length} tool calls:`)
          aiMsg.tool_calls.forEach((tc) => {
            logger.debug(`  - Tool: ${tc.name}`)
            logger.debug(`    Args: ${JSON.stringify(tc.args)}`)
          })
        }
      }
    })

    return messages[messages.length - 1]
  }

  // Step 2: Extract text from message (handles both string and array content)
  const parseStep = new StringOutputParser()

  // Build the chain based on whether we need structured parsing
  if (responseSchema) {
    return RunnableSequence.from([
      logAndExtractStep,
      parseStep,
      async (text: string) => parseAgentStructuredResponse(text, responseSchema)
    ])
  }

  return RunnableSequence.from([logAndExtractStep, parseStep])
}

/**
 * Creates a LangChain response chain that handles structured output from an LLM.
 *
 * This function supports two execution paths:
 * 1. **Structured output mode**: Uses the LLM's native structured output capability when available
 * 2. **Tool-based mode**: Falls back to using tool calling with manual parsing
 *
 * The function automatically deduces the non-structured schema format from the provided structured schema:
 * - If the structured schema is an object with a single array property (e.g., `z.object({ results: z.array(...) })`),
 *   it unwraps the array for the non-structured schema and re-wraps parsed arrays with the original key name
 * - Otherwise, it uses the structured schema as-is for both modes
 *
 * @param llm - The language model instance to use for generation
 * @param prompt - The prompt template to pipe input through
 * @param responseFormatSchema - A Zod schema (created with `z.object()`) defining the expected
 *   response structure. If this contains a single property that's an array, the function will automatically
 *   handle unwrapping/rewrapping for compatibility with tool-based parsing.
 *
 * @returns A LangChain runnable that processes the prompt through the LLM and returns structured output
 *   matching the provided schema
 *
 * @example
 * ```typescript
 * // Schema with wrapped array (for structured output compatibility)
 * const schema = z.object({
 *   results: z.array(z.object({
 *     title: z.string(),
 *     score: z.number()
 *   }))
 * });
 *
 * const chain = getStructuredResponseChain(llm, prompt, schema);
 * // Returns: { results: [...] }
 * ```
 *
 * @example
 * ```typescript
 * // Simple object schema (no unwrapping needed)
 * const schema = z.object({
 *   name: z.string(),
 *   age: z.number()
 * });
 *
 * const chain = getStructuredResponseChain(llm, prompt, schema);
 * // Returns: { name: "...", age: ... }
 * ```
 */
function getStructuredResponseChain(llm, prompt, responseFormatSchema) {
  // Deduce the non-structured schema from the structured schema
  // If structured schema is an object with a single property that's an array, unwrap it
  // Otherwise, use the structured schema as-is
  const { shape } = responseFormatSchema
  const keys = Object.keys(shape)
  let arrayKey
  if (keys.length === 1 && shape[keys[0]] instanceof z.ZodArray) {
    ;[arrayKey] = keys
  }

  // Convert Zod schema to JSON Schema and ensure it has type: 'object' for Bedrock compatibility
  // Always use the original responseFormatSchema (not unwrapped) for tool definition
  // because Claude requires the tool's input_schema to be type: 'object'
  const jsonSchema = zodToJsonSchema(responseFormatSchema)
  const parametersSchema = {
    ...(typeof jsonSchema === 'object' && jsonSchema !== null ? jsonSchema : {}),
    type: 'object'
  }

  const toolSchema = {
    type: 'function' as const,
    function: {
      name: 'structured_response',
      description: 'Respond with structured data',
      parameters: parametersSchema
    }
  }

  // BedrockChat (@langchain/community) has a broken withStructuredOutput implementation in LangChain 1.0.
  // The base class checks for AIMessageChunk, but invoke() returns AIMessage, causing "Input is not an AIMessageChunk" error.
  // The modern replacement, ChatBedrockConverse (@langchain/aws), properly implements structured output.
  // For now, we use bindTools + manual parsing for BedrockChat/Anthropic models.
  if (shouldUseStructuredOutput(llm)) {
    return prompt.pipe(llm.withStructuredOutput(responseFormatSchema))
  }

  // For Bedrock/Anthropic: use bindTools and extract tool call arguments
  // This matches LangChain's withStructuredOutput behavior
  return prompt.pipe(llm.bindTools([toolSchema])).pipe(async (message) => {
    // Extract tool call from AIMessage
    const aiMsg = message as { tool_calls?: Array<{ name: string; args: unknown; id?: string }> }

    if (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0) {
      throw new Error('No tool calls found in the response.')
    }

    const structuredResponseCall = aiMsg.tool_calls.find((tc) => tc.name === 'structured_response')
    if (!structuredResponseCall) {
      throw new Error('No structured_response tool call found.')
    }

    // If we have an arrayKey, wrap the result
    if (Array.isArray(structuredResponseCall.args) && arrayKey) {
      return { [arrayKey]: structuredResponseCall.args }
    }
    return structuredResponseCall.args
  })
}

/**
 * Executes a single-turn chat prompt with an LLM, optionally with structured output.
 *
 * This function constructs a chat prompt from system and user templates, optionally includes
 * chat history, and invokes the LLM. When a structured output schema is provided, it uses
 * the `getStructuredResponseChain` function to ensure properly formatted responses.
 * Supports multi-user environments where chat history can include messages from multiple users.
 *
 * @param llm - The language model instance to use for generation
 * @param systemTemplate - The system message template string
 * @param userTemplate - The user message template string
 * @param inputParams - Parameters to fill in the template variables
 * @param inputChatHistory - Optional array of previous chat messages in [role, content] format
 * @param structuredOutputSchema - Optional Zod schema for structured output. When provided,
 *   the response will be parsed and validated against this schema.
 *
 * @returns A promise that resolves to either a string (default) or structured object (when schema provided)
 *
 * @example
 * ```typescript
 * // Simple string response
 * const response = await getChatPromptResponse(
 *   llm,
 *   "You are a helpful assistant",
 *   "What is {topic}?",
 *   { topic: "TypeScript" }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Structured output response
 * const schema = z.object({
 *   results: z.array(z.object({ name: z.string(), score: z.number() }))
 * });
 *
 * const response = await getChatPromptResponse(
 *   llm,
 *   "You are a data analyst",
 *   "Analyze {data}",
 *   { data: "sales figures" },
 *   undefined,
 *   schema
 * );
 * // Returns: { results: [...] }
 * ```
 */
async function getChatPromptResponse(
  llm,
  systemTemplate,
  userTemplate,
  inputParams,
  inputChatHistory?,
  structuredOutputSchema?,
  platform?: string
) {
  // vLLM requires strict alternating human/ai turns; other platforms support consecutive same-role messages
  const chatHistory = platform === 'vllm' ? ensureAlternatingChat(inputChatHistory || []) : inputChatHistory || []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any = [
    ['system', systemTemplate],
    ...(chatHistory && chatHistory.length > 0 ? chatHistory : []),
    ['user', userTemplate]
  ]

  // logger.debug(`Messages for LLM: ${JSON.stringify(messages, null, 2)}`)

  const chatPrompt = ChatPromptTemplate.fromMessages(messages)

  const chain = structuredOutputSchema
    ? getStructuredResponseChain(llm, chatPrompt, structuredOutputSchema)
    : RunnableSequence.from([chatPrompt, llm, new StringOutputParser()])

  const invokeParams = { ...inputParams }

  return chain.invoke(invokeParams)
  // You can do this if you want detailed logging:
  // return chain.invoke(invokeParams, { callbacks: [new ConsoleCallbackHandler()] })
}

// an LLM keep alive ping (e.g. for runpod)
async function pingLLM(llm) {
  const result = await llm.call([{ role: 'user', content: 'Respond "OK"' }])
  return result.content
}

/**
 * Modified RAG function that uses a structured LLM output to return both the answer
 * and citations. The citations are the integer IDs of the retrieved documents.
 * It assumes that the prompt template references a {context} variable.
 *
 * @param {*} llm - The language model to use
 * @param {*} template - The prompt template
 * @param {*} inputParams - Parameters to inject into the prompt
 * @param {*} docNames - Names of docs to search within
 * @param {object|null} outputSchema - Optional Zod schema for structured output. If not provided, returns a string response.
 * @returns A promise that resolves to an object containing the answer and citations when schema is provided, or a string otherwise.
 */
async function getRAGAugmentedResponse(
  llm,
  collectionName,
  template,
  inputParams,
  docNames,
  outputSchema?,
  embeddingsPlatform?,
  embeddingsModelName?
) {
  const formatFunction = (doc, idx) => {
    logger.debug(
      `RAG-Generated context: ${doc.pageContent} \n\nCitation: Source ID ${idx} - ${doc.metadata.citation} (p. ${doc.metadata.pageNumber}: lines ${doc.metadata.lineFrom} - ${doc.metadata.lineTo})`
    )
    return `Source ID: ${idx}\nArticle title: ${doc.metadata.citation}\nArticle Snippet: ${doc.pageContent}`
  }
  const { retrievedDocs, chunks } = await rag.getContextChunksForQuestion(
    collectionName,
    inputParams.question,
    formatFunction,
    {
      pdf: { $in: docNames }
    },
    embeddingsPlatform,
    embeddingsModelName
  )

  const prompt = PromptTemplate.fromTemplate(template)

  if (outputSchema) {
    const llmWithTool = llm.withStructuredOutput(outputSchema)
    const answerChain = prompt.pipe(llmWithTool)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return answerChain.invoke({ ...inputParams, context: chunks }).then((chainResult: any) => ({
      ...chainResult,
      retrievedDocs
    }))
  }

  // Default to string output
  const outputParser = new StringOutputParser()
  const answerChain = prompt.pipe(llm).pipe(outputParser)
  return answerChain.invoke({ ...inputParams, context: chunks })
}

/**
 * Executes an agent with tools and returns a structured or string response.
 *
 * This function creates and invokes a LangChain agent with the provided tools,
 * then extracts and optionally parses the final response. It handles common
 * post-processing like stripping markdown code fences.
 *
 * @param llm - The language model instance to use for generation
 * @param tools - Array of tools available to the agent
 * @param systemPrompt - The system prompt to guide the agent's behavior
 * @param userMessage - The user message to send to the agent
 * @param responseSchema - Optional Zod schema for structured output. When provided,
 *   the response will be parsed and validated against this schema.
 *
 * @returns A promise that resolves to either a string (default) or structured object (when schema provided)
 *

 */
async function getAgentStructuredResponse(
  llm,
  tools,
  systemPrompt,
  userMessage,
  responseSchema?,
  chatHistory?,
  recursionLimit = 20
) {
  // Add format instructions to system prompt if schema is provided
  let finalSystemPrompt = systemPrompt
  if (responseSchema) {
    const parser = StructuredOutputParser.fromZodSchema(responseSchema)
    finalSystemPrompt = `${systemPrompt}

${parser.getFormatInstructions()}`
  }

  // It would be great if we could pass the responseSchema here as the responseFormat argument
  // (or include it in tools as we do in getStructuredResponseChain). This would presumably eliminate the
  // need to extract ONLY the code in the fences in parseStructuredOutput (eliminating the introductory text)
  // However, BedrockChat complains that 'All tools must be of the same type'.
  // Potentially another reason to switch to ChatBedrockConverse
  const agent = createAgent({
    model: llm,
    tools,
    systemPrompt: new SystemMessage(finalSystemPrompt)
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any = [
    ...(chatHistory && chatHistory.length > 0 ? chatHistory : []),
    { role: 'user', content: userMessage }
  ]

  const agentResult = await agent.invoke(
    {
      messages
    },
    { recursionLimit }
  )

  const outputChain = createAgentOutputChain(responseSchema)
  return outputChain.invoke(agentResult)
}

export {
  getSinglePromptResponse,
  getRAGAugmentedResponse,
  getChatPromptResponse,
  shouldUseStructuredOutput,
  pingLLM,
  getStructuredResponseChain,
  getAgentStructuredResponse
}

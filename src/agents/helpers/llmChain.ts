import { ChatPromptTemplate, PromptTemplate } from '@langchain/core/prompts'
// import { ConsoleCallbackHandler } from 'langchain/callbacks'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { RunnableSequence } from '@langchain/core/runnables'
import logger from '../../config/logger.js'
import rag from './rag.js'

const RESPONSE_PLACEHOLDER = ' '

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

async function getSingleUserChatPromptResponse(llm, systemTemplate, userTemplate, inputParams, inputChatHistory?) {
  // a requirement for vLLM over OpenAI compatible API
  const chatHistory = ensureAlternatingChat(inputChatHistory)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any = [
    ['system', systemTemplate],
    ...(chatHistory && chatHistory.length > 0 ? chatHistory : []),
    ['user', userTemplate]
  ]

  // logger.debug(`Messages for LLM: ${JSON.stringify(messages, null, 2)}`)

  const chatPrompt = ChatPromptTemplate.fromMessages(messages)
  const chain = RunnableSequence.from([chatPrompt, llm, new StringOutputParser()])
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

export {
  getSinglePromptResponse,
  getRAGAugmentedResponse,
  getSingleUserChatPromptResponse,
  shouldUseStructuredOutput,
  pingLLM
}

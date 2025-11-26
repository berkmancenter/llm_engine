import { AgentMessageActions, GenericAgentAnswer, ConversationHistory } from '../../../types/index.types.js'
import verify from '../../helpers/verify.js'
import logger from '../../../config/logger.js'
import { formatConversationHistory } from '../../helpers/llmInputFormatters.js'
import { getSinglePromptResponse } from '../../helpers/llmChain.js'
import { generateGenericAgentAnswerSchema } from '../../helpers/responseFormatSchemas.js'

/*
 * A simple, single prompt generic agent. Meant to be customized by a user
 * - Supports simple output text or an outputSchema provided by the user in JSONSchema format
 * - Support visible and non-visible agent contributions
 * - Supports output channel determined by the LLM
 * - Outputs an AgentMessageAction
 *
 * Current limitations:
 *  - Cannot intercept/reject user messages
 *  - Does not support introduction messages
 *  - Does not support RAG
 *
 */

const defaultLLMTemplates = {
  main: `You are an un-configured Generic Agent.
        **CRITICAL!! Regardless of anything that follows you MUST respond with "action": "CONTRIBUTE" and with "message": "I am an un-configured Generic Agent. Please configure me."**

        For reference, the agent outputs these properties:
        * explanation: An short explanation of what was done
        * message: The output either as a string, or in the desired output format
        * visible: If the output should be visible
        * channels: What channels to put it in
        * action: What AgentMessageAction

        Reference materials are below. These must be processed according to the system instructions above.
        * Topic: {topic}
        * Conversation History: {convHistory}

        Answer:`
}

const llmTemplateVars = {
  main: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'convHistory', description: 'The recent history of the conversation' }
  ]
}

export default verify({
  name: 'Generic Agent',
  description: 'An generic agent type, meant to be customized by a user',
  priority: 10,
  maxTokens: 2000,
  defaultTriggers: { periodic: { timerPeriod: 300 } },
  agentConfig: {
    outputSchema: undefined // output schema to use, in JSONSchema format. undefined is unstructured text
  },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  ragCollectionName: undefined,
  parseInput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }
    const translatedMsg = { ...msg }
    translatedMsg.bodyType = 'json'
    translatedMsg.body = { text: msg.body }
    return translatedMsg
  },
  parseOutput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }
    return JSON.stringify(msg, null, 2)
  },
  defaultConversationHistorySettings: { timeWindow: 300 },

  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    return {
      action: AgentMessageActions.CONTRIBUTE,
      userMessage,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage?) {
    const topic = this.conversation.name
    const llm = await this.getLLM()
    const convHistory = formatConversationHistory(conversationHistory, userMessage)
    const result = (await getSinglePromptResponse(
      llm,
      this.llmTemplates.main,
      { convHistory, topic },
      generateGenericAgentAnswerSchema(this.agentConfig.outputSchema)
    )) as GenericAgentAnswer

    logger.debug(`Generic agent result: ${JSON.stringify(result, null, 2)}`)

    const { explanation, visible, message, channels, action } = result

    // should be an integer but LLM sometimes makes a string
    const actionNum = typeof action === 'string' ? parseInt(action, 10) : action

    logger.debug(
      `Generic agent result: ${explanation} -> Action: ${actionNum}; Visible: ${visible}; Channels: ${channels?.join(
        ','
      )}; Output format: ${typeof message}; Output: ${
        typeof message === 'string' ? message : JSON.stringify(message, null, 2)
      }`
    )

    if (actionNum !== AgentMessageActions.CONTRIBUTE) return []

    const agentResponse = {
      visible,
      channels: this.conversation.channels.filter((channel) => channels.includes(channel.name)),
      message,
      messageType: typeof message === 'string' ? 'text' : 'json'
    }

    return [agentResponse]
  },
  async start() {
    return true
  },
  async stop() {
    return true
  }
})

import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import verify from '../helpers/verify.js'

import { BackChannelAgentResponse, Comment, Metric } from './backChannel.types.js'
import logger from '../../config/logger.js'

const defaultLLMTemplates = {
  classification: `You are given a list of comments from a live event about {topic} and a predefined list of category names. Each comment is in the format {{user: username, comment: {{text: ..., preset: true/false}}}}.

For each comment, assign the **most semantically appropriate category** — even if the wording differs. Use your understanding of the comment's **meaning** to choose the best-fitting category from the list.

- Use only the exact category names provided.

- If a comment does not clearly match any of the categories, exclude it.

- Do not create or modify category names.

For example, if "Let's Move On" is a category, then comments indicating boredom, like "I'm scrolling memes" or "Yawn" should go in that category. Similarly, if "I'm confused" is a category, then comments like "That doesn't make sense" or "I don't understand" should go in that category

Report the comments assigned to each category in the format "{{user: username, text:comment, preset:true/false}}".

Categories:
{categories}

Comments:
{convHistory}`
}

const llmTemplateVars = {
  classification: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'convHistory', description: 'The recent history of the conversation' },
    { name: 'categories', description: 'The categories used to classify comments for metrics' }
  ]
}

async function generateMetrics(messages): Promise<Metric[]> {
  // Filter only preset messages
  const presetMessages = messages.filter((message) => message.body.preset)

  // Group messages by text (category)
  const categoriesMap = new Map<string, Comment[]>()

  presetMessages.forEach((message) => {
    const { text } = message.body
    if (!categoriesMap.has(text)) {
      categoriesMap.set(text, [])
    }

    // Add this message to the appropriate category's comments
    categoriesMap.get(text)?.push({
      text: message.body.text,
      preset: message.body.preset,
      user: message.pseudonym
    })
  })

  // Convert the map to the required metrics array format
  const metrics: Metric[] = Array.from(categoriesMap.entries()).map(([name, comments]) => ({
    name,
    value: comments.length,
    comments
  }))

  return metrics
}

export default verify({
  name: 'Back Channel Metrics Agent',
  description: 'An agent to classify participant comments as count metrics',
  priority: 5,
  maxTokens: 2000,
  defaultTriggers: { periodic: { timerPeriod: 120 } },
  agentConfig: {
    categories: ['Boredom', 'Inaudible', 'Confusion'],
    reportingThreshold: 3
  },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  defaultConversationHistorySettings: { timeWindow: 120, channels: ['participant'] },
  ragCollectionName: undefined,

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

  async respond(conversationHistory: ConversationHistory) {
    const metrics = await generateMetrics(conversationHistory.messages)
    for (const metric of metrics) {
      const uniqueUserCount = new Set(metric.comments.map((comment) => comment.user)).size
      metric.value = uniqueUserCount
    }
    const reportableMetrics = metrics.filter((metric) => metric.value >= this.agentConfig.reportingThreshold)
    if (reportableMetrics.length === 0) {
      // This is still necessary b/c could be called if any new messages on conversation, regardless of channel
      // Consider making general agent architecture aware of channels?
      logger.debug('No metrics to report')
      return []
    }
    const response: BackChannelAgentResponse = {
      timestamp: { start: conversationHistory.start.getTime(), end: conversationHistory.end.getTime() },
      metrics: reportableMetrics
    }
    const agentResponse = {
      visible: true,
      message: response,
      channels: this.conversation.channels.filter((channel) => channel.name === 'moderator'),
      messageType: 'json'
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

import verify from '../helpers/verify.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import Conversation from '../../models/conversation.model.js'
import access from '../../auth/access.js'
import conversationCostTrackingService from '../../services/conversationCostTracking.service.js'
import type { BudgetAlertData, BudgetAlert, ConversationCostData } from '../../types/index.types.js'
import { AgentMessageActions } from '../../types/index.types.js'

const HELLO_MESSAGE =
  "Number Cruncher online. I'll check your configured budget endpoints on schedule, and post an estimated LLM cost summary here when an event ends."

interface BudgetConfig {
  label: string
  endpoint: string
  apiKey: string
  thresholdPercent: number
}

interface BudgetApiResponse {
  quota: { limit: string; limit_unit: string }
  remaining_limit: string
}

async function fetchBudgetAlerts(budgets: BudgetConfig[]): Promise<BudgetAlert[]> {
  const alerts: BudgetAlert[] = []
  for (const budget of budgets) {
    try {
      logger.debug(`numberCruncher: retrieving budget from endpoint: ${budget.endpoint}`)
      const res = await fetch(budget.endpoint, {
        headers: { Authorization: `Bearer ${budget.apiKey}` }
      })
      if (!res.ok) {
        logger.warn(`numberCruncher: budget endpoint ${budget.label} returned ${res.status}`)
        continue
      }
      const data = (await res.json()) as BudgetApiResponse
      const limit = parseFloat(data?.quota?.limit)
      const remaining = parseFloat(data?.remaining_limit)
      if (Number.isNaN(limit) || Number.isNaN(remaining) || limit === 0) {
        logger.warn(`numberCruncher: unexpected response shape from ${budget.label}`, data)
        continue
      }
      const used = limit - remaining
      logger.debug(`numberCruncher: ${budget.label} budget usage: $${used}`)
      const percentUsed = (used / limit) * 100
      if (percentUsed >= budget.thresholdPercent) {
        alerts.push({ label: budget.label, used, limit, percentUsed })
      }
    } catch (error) {
      logger.error(`numberCruncher: failed to fetch budget for ${budget.label}`, error)
    }
  }
  return alerts
}

export default verify({
  name: 'Number Cruncher',
  description:
    'Checks LLM API budget endpoints on a schedule, and posts an estimated LLM cost summary when an event ends (public or private).',
  priority: 100,
  maxTokens: undefined,
  defaultTriggers: {
    periodic: {
      timerPeriod: 86400, // once every 24 hours by default
      proactive: true
    }
  },
  llmTemplateVars: undefined,
  defaultLLMTemplates: undefined,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce(channel) {
    return [
      {
        visible: true,
        message: HELLO_MESSAGE,
        messageType: 'text' as const,
        channels: [channel]
      }
    ]
  },

  async evaluate(userMessage = null) {
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond() {
    const budgets: BudgetConfig[] = this.agentConfig.budgets ?? []
    if (budgets.length === 0) return []

    const alerts = await fetchBudgetAlerts(budgets)
    if (alerts.length === 0) return []

    const renderData: BudgetAlertData = {
      alerts,
      checkedAt: new Date().toISOString()
    }

    return [
      {
        visible: true,
        message: `Budget alert: ${alerts.map((a) => `${a.label} at ${Math.round(a.percentUsed)}%`).join(', ')}`,
        messageType: 'text' as const,
        responseKind: 'budgetAlert' as const,
        renderData,
        channels: this.conversation.channels
      }
    ]
  },

  // Fires when ANY event stops, public or private (the dispatcher matches the
  // allTopics read grant — see capabilities.ts). The actual cost computation and
  // ConversationCost persistence (pending, then settled/complete) is handled by
  // trackConversationCost, which also runs unconditionally for every conversation
  // via the standalone `conversationCost` job (see jobs/handlers/conversationCost.ts)
  // regardless of whether Number Cruncher is provisioned. This handler's job is
  // strictly the Slack-facing part: build and post the cost card when Number
  // Cruncher happens to be active.
  async onConversationEvent(evt) {
    if (evt.type !== 'conversationStopped') return []

    const conversation = await Conversation.findById(evt.conversationId).populate('topic')
    if (!conversation) return []

    // Re-check read access at the read site even though the dispatcher already
    // gated it, so least privilege stays explicit. Fail closed: anything but an
    // explicit `private: false` counts as private.
    const topic = conversation.topic as { _id?: { toString(): string }; private?: boolean } | undefined
    const topicIsPrivate = topic?.private !== false
    access.assertCanRead(this, {
      type: 'conversation',
      id: evt.conversationId,
      topicId: topic?._id?.toString(),
      topicIsPrivate
    })

    // Private topics: liveEvent cost is still priced below (real spend happened
    // regardless of privacy), but postEvent will always come back empty — no other
    // agent (e.g. the Vibes Analyst recap) ever runs post-event work on a private
    // topic, so there is genuinely nothing there to price, not merely unknown.
    if (topicIsPrivate) {
      logger.debug(
        `numberCruncher: conversation ${evt.conversationId} has a private topic — liveEvent cost will be ` +
          'recorded, but postEvent processing/cost does not apply (no post-event agent runs on private topics)'
      )
    }

    const result = await conversationCostTrackingService.trackConversationCost(conversation, { topicIsPrivate })
    if (!result) return []
    const { phases, total } = result

    const renderData: ConversationCostData = {
      ...phases,
      total,
      conversationName: conversation.name,
      checkedAt: new Date().toISOString(),
      topicIsPrivate
    }

    // The event name is never shown in the visible fallback text for a private
    // event — the Slack card (conversationCostCard.ts) applies the same redaction
    // to its header. renderData itself still carries the real name for any other
    // consumer (e.g. a future internal report) that reads the persisted record.
    const displayName = topicIsPrivate ? 'a private event' : `*${conversation.name}*`

    return [
      {
        visible: true,
        // Fallback text for adapters that do not render the card (e.g. zoom).
        message: `Estimated LLM cost for ${displayName}: ~$${total.estimatedCostUSD.toFixed(
          2
        )} (LangSmith estimate — actual provider charges may differ)${
          total.hasUnpricedCalls ? ' — some calls could not be priced, so the actual total is higher' : ''
        }`,
        messageType: 'text' as const,
        responseKind: 'conversationCostSummary' as const,
        renderData,
        channels: this.conversation.channels
      }
    ]
  }
})

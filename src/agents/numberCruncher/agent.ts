import verify from '../helpers/verify.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import type { BudgetAlertData, BudgetAlert } from '../../types/index.types.js'
import { AgentMessageActions } from '../../types/index.types.js'

const HELLO_MESSAGE =
  "Number Cruncher online. I'll check your configured budget endpoints on schedule and post here if any exceed their thresholds."

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
  description: 'Checks LLM API budget endpoints on a schedule and posts alerts when spending exceeds configured thresholds.',
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
  }
})

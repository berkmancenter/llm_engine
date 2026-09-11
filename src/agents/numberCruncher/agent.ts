import verify from '../helpers/verify.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import Conversation from '../../models/conversation.model.js'
import { getAdminChannelTypeNames } from '../../conversations/index.js'
import ConversationCost from '../../models/conversationCost.model.js'
import access from '../../auth/access.js'
import conversationCostTrackingService from '../../services/conversationCostTracking.service.js'
import conversationCostService, { ZERO_PHASES } from '../../services/conversationCost.service.js'
import {
  fetchConversationCost,
  combineCostAggregates,
  accumulateCostPhases,
  isLangsmithCostTrackingConfigured
} from './conversationCost.js'
import type {
  BudgetAlertData,
  BudgetAlert,
  ConversationCostData,
  ConversationCostPhases,
  ConversationCostAggregates,
  ConversationCostDelta,
  IChannel
} from '../../types/index.types.js'
import { AgentMessageActions } from '../../types/index.types.js'

const HELLO_MESSAGE =
  "Number Cruncher online. I'll check your configured budget endpoints on schedule, post a nightly cost " +
  "snapshot for every conversation still running, and post an estimated LLM cost summary here when an event ends."

/* A retry after a mid-job kill (see jobs/CLAUDE.md) happens within the cronAgent job's
   lockLifetime, far shorter than a day, so a snapshot already captured this recently is
   certainly this same nightly tick re-running from scratch, not a legitimate new one —
   skip it rather than post the same cost card to Slack twice. */
const NIGHTLY_SNAPSHOT_DEBOUNCE_MS = 12 * 60 * 60 * 1000 // 12 hours

/* The delta clause for the fallback text, mirroring what the card renderer shows. No
   guard against a negative figure: `since` is a directly measured window, not the
   difference of two cumulative reads, so it cannot come out below zero. */
function sinceText(since?: ConversationCostDelta): string {
  if (!since) return ''
  return ` — +$${since.estimatedCostUSD.toFixed(2)} (${since.llmCallCount} calls) since the last check`
}

/* Builds the Slack-facing response for one conversation's cost data, shared by the
   stop-event card (onConversationEvent) and the nightly snapshot (respond()) below —
   only how the phases/total were obtained differs between the two. */
function buildCostSummaryResponse(
  conversation: { name: string },
  topicIsPrivate: boolean,
  phases: ConversationCostPhases,
  total: ConversationCostAggregates,
  channels: IChannel[] | undefined,
  since?: ConversationCostDelta
) {
  const renderData: ConversationCostData = {
    ...phases,
    total,
    conversationName: conversation.name,
    checkedAt: new Date().toISOString(),
    topicIsPrivate,
    ...(since && { since })
  }

  const displayName = topicIsPrivate ? 'a private event' : `*${conversation.name}*`

  return {
    visible: true,
    // Fallback text for adapters that do not render the card (e.g. zoom).
    message: `Estimated LLM cost for ${displayName}: ~$${total.estimatedCostUSD.toFixed(
      2
    )} (LangSmith estimate — actual provider charges may differ)${
      total.hasUnpricedCalls ? ' — some calls could not be priced, so the actual total is higher' : ''
    }${sinceText(since)}`,
    messageType: 'text' as const,
    responseKind: 'conversationCostSummary' as const,
    renderData,
    channels
  }
}

/* One nightly sweep, mirroring Scorekeeper's respond(): find every conversation
   still active right now, take a live (non-settled — there's nothing to settle on a
   conversation that hasn't stopped) cost read for each, and post one card per conversation
   to Number Cruncher's own channel(s), exactly where its stop-event cost cards already go. */
async function buildNightlySnapshotResponses(channels: IChannel[] | undefined) {
  if (!isLangsmithCostTrackingConfigured()) return []

  /* Always-on conversations (a community channel that is started once and never stops) are
     deliberately in scope — their spend is exactly what a nightly snapshot is for. The one
     exclusion is the ops bots' own channels, which would otherwise produce a nightly card
     about the very channel the card is posted into. Conversations with no conversationType
     at all are NOT excluded: $nin matches a missing field, which is the inclusive default
     this filter wants (see ConversationType.adminChannel). */
  const activeConversations = await Conversation.find({
    active: true,
    draft: false,
    conversationType: { $nin: getAdminChannelTypeNames() }
  })
    .select('_id name topic')
    .populate('topic', 'private')
    .lean()

  if (activeConversations.length === 0) return []

  const responses: object[] = []
  for (const conversation of activeConversations) {
    const conversationId = String(conversation._id)
    const topic = conversation.topic as { private?: boolean } | undefined
    const topicIsPrivate = topic?.private !== false

    /* conversationId is uniquely indexed, so there is at most one cost record per
       conversation and this is it — serving both the debounce below and the running total
       this night's window is added onto, rather than reading the same document twice. */
    const previous = await ConversationCost.findOne({ conversationId: conversation._id })
      .select('liveEvent postEvent status capturedAt')
      .lean()

    // status 'pending' scopes the debounce to a previous *nightly snapshot*, not a stop-event's
    // persistCost ('complete') — a conversation can restart after stopping (startConversation
    // has no guard against that), and its ConversationCost record would still carry the old
    // stop's recent capturedAt. Debouncing against that would silently skip a conversation
    // that's genuinely active again, for up to NIGHTLY_SNAPSHOT_DEBOUNCE_MS after its restart.
    /* capturedAt is schema-defaulted, so in practice it is always set; a record somehow
       missing it has no age to judge, and falling through to take a fresh snapshot is the
       safer reading of "is this the same nightly tick re-running" than skipping blind. */
    const capturedAt = previous?.capturedAt
    const debounceCutoff = new Date(Date.now() - NIGHTLY_SNAPSHOT_DEBOUNCE_MS)
    if (previous && previous.status === 'pending' && capturedAt && capturedAt >= debounceCutoff) {
      logger.debug(`numberCruncher: conversation ${conversationId} already has a recent cost snapshot, skipping`)
      continue
    }

    /* Read only what is new since the last capture, then add it to the stored total, rather
       than re-reading the conversation's whole history every night. This is what makes the
       figures survive LangSmith's run retention — see fetchConversationCost's `since`. A
       record with no capturedAt cannot be windowed from, so it is not a usable baseline:
       the unbounded read below already covers everything the record counted, and adding the
       two would double it. Note `readAt` is taken BEFORE the read and stored as the next
       window's start, so runs logged mid-read are picked up next time instead of falling
       between the two windows. */
    const baseline = capturedAt ? { liveEvent: previous!.liveEvent, postEvent: previous!.postEvent } : null
    const readAt = new Date()
    const windowRead = await fetchConversationCost(conversationId, capturedAt ? { since: capturedAt } : {})

    // Nothing new, and nothing on record either: this conversation has never spent anything.
    if (!windowRead && !baseline) continue

    const windowPhases = windowRead ?? ZERO_PHASES
    const windowTotal = combineCostAggregates(windowPhases.liveEvent, windowPhases.postEvent)
    const phases = accumulateCostPhases(baseline, windowPhases)
    const total = combineCostAggregates(phases.liveEvent, phases.postEvent)
    if (total.llmCallCount === 0) continue

    /* Measured, not derived: the window IS this period's spend, so it can never come out
       negative the way subtracting two retention-bounded cumulative reads could. */
    const since: ConversationCostDelta | undefined = capturedAt
      ? {
          estimatedCostUSD: windowTotal.estimatedCostUSD,
          llmCallCount: windowTotal.llmCallCount,
          capturedAt: new Date(capturedAt).toISOString()
        }
      : undefined

    /* Persisted before the no-news check below, deliberately. capturedAt has to advance on
       every sweep, including quiet ones: it is the next window's start, so leaving it put
       on a night nothing was posted would let the window keep growing until it reached past
       LangSmith's retention horizon and started missing runs outright. */
    try {
      await conversationCostService.persistSnapshot(conversation, phases, { topicIsPrivate, capturedAt: readAt })
    } catch (error) {
      logger.error(`numberCruncher: could not persist nightly cost snapshot for ${conversationId}`, error)
    }

    /* Nothing was spent this period, so the card would repeat last night's with a +$0.00
       delta. On an always-on conversation — one that never stops, and so never gets a
       stop-event card — that is most nights, and posting it anyway trains everyone to
       scroll past the cards that do say something. A conversation with no baseline yet
       (its first snapshot) always posts: there is no window to be empty. */
    if (capturedAt && windowTotal.llmCallCount === 0) {
      logger.debug(`numberCruncher: conversation ${conversationId} has no new LLM calls since its last snapshot, skipping`)
      continue
    }

    responses.push(buildCostSummaryResponse(conversation, topicIsPrivate, phases, total, channels, since))
  }
  return responses
}

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
    'Checks LLM API budget endpoints and takes a cost snapshot of every running conversation on a ' +
    'schedule, and posts an estimated LLM cost summary when an event ends (public or private).',
  priority: 100,
  maxTokens: undefined,
  defaultTriggers: {
    /* The nightly cost-snapshot sweep (respond(), below) shares this existing budget-alert
       cron rather than getting one of its own — the framework supports a single cron trigger
       per agent. Left exactly as it was: nothing about the sweep needs a particular hour, so
       retiming it would only strand every already-saved agent on the old expression (the
       agent model fills `triggers` solely when undefined, and an existing agenda job keeps
       its own copy of it), for no gain. */
    cron: { expression: '0 3 * * *' }
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
    const responses: object[] = []

    const budgets: BudgetConfig[] = this.agentConfig.budgets ?? []
    if (budgets.length > 0) {
      const alerts = await fetchBudgetAlerts(budgets)
      if (alerts.length > 0) {
        const renderData: BudgetAlertData = {
          alerts,
          checkedAt: new Date().toISOString()
        }
        responses.push({
          visible: true,
          message: `Budget alert: ${alerts.map((a) => `${a.label} at ${Math.round(a.percentUsed)}%`).join(', ')}`,
          messageType: 'text' as const,
          responseKind: 'budgetAlert' as const,
          renderData,
          channels: this.conversation.channels
        })
      }
    }

    responses.push(...(await buildNightlySnapshotResponses(this.conversation.channels)))

    return responses
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

    // The event name is never shown in the visible fallback text for a private event —
    // the Slack card (conversationCostCard.ts) applies the same redaction to its header.
    // renderData itself still carries the real name for any other consumer (e.g. a
    // future internal report) that reads the persisted record — see buildCostSummaryResponse.
    return [buildCostSummaryResponse(conversation, topicIsPrivate, phases, total, this.conversation.channels)]
  }
})

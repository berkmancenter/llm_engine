import conversationAnalyticsService from '../../services/conversationAnalytics.service.js'
import logger from '../../config/logger.js'
import curateVibesCard from './curate.js'
import verifyCuratedCard from './verifyCuration.js'
import annotateSpikes from './spikeAnnotation.js'
import annotateReceptions from './quoteReception.js'
import { loadReadableMessages } from './capabilities.js'
import { ConversationMetrics, CuratedVibesData } from '../../types/index.types.js'

/* Pulls a log-friendly message off an unknown thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* How long the event ran, in whole minutes, for the card footer. Returns 0 when
   either timestamp is missing so the card still renders. */
function eventDurationMinutes(startTime?: Date, endTime?: Date): number {
  if (!startTime || !endTime) return 0
  const elapsedMs = endTime.getTime() - startTime.getTime()
  return Math.max(0, Math.round(elapsedMs / 60000))
}

/* Short, plain-language scene-setting labels for the agent types that can run alongside
   the Vibes Analyst on a conversation. Kept deliberately short of the full agent type
   registry: only production types a host could plausibly encounter are mapped, and an
   unmapped type is dropped rather than leaking its internal camelCase key into the
   curation prompt (see labelActiveAgentTypes). vibesAnalyst has no entry on purpose: it
   is dropped before the lookup, since a recap naming itself as "active" tells the host
   nothing new. */
const AGENT_TYPE_LABELS: Record<string, string> = {
  eventAssistant: 'an assistant participants could summon',
  voiceAssistant: 'a voice assistant',
  chatbot: 'a chatbot',
  eventMediator: 'a moderator agent',
  moderatorNotifier: 'a moderator-alert agent',
  engagementAgent: 'an engagement prompter',
  jargonFilterAgent: 'a jargon filter',
  librarian: 'a resource librarian',
  eventHistorian: 'an event historian',
  eventSetup: 'an event-setup assistant',
  numberCruncher: 'a number cruncher',
  backChannelMetrics: 'a backchannel metrics tracker',
  backChannelInsights: 'a backchannel insights agent'
}

/* Turns raw agentType strings into their scene-setting labels: dedupes, drops the Vibes
   Analyst's own type, and drops any type with no mapped label so an unrecognized or
   future agent type never reaches the curation prompt as a bare internal key. */
export function labelActiveAgentTypes(agentTypes: string[]): string[] {
  const uniqueTypes = [...new Set(agentTypes)].filter((agentType) => agentType !== 'vibesAnalyst')
  return uniqueTypes.map((agentType) => AGENT_TYPE_LABELS[agentType]).filter((label): label is string => Boolean(label))
}

/* The Agent model imports the agent registry, and the registry imports this agent, so naming it
   at the top of this file closes an import cycle: anything loading the registry first reaches it
   half-built. Both readers below already run inside async functions, so loading the model on
   first use costs nothing and keeps the cycle out of the import graph. */
async function agentModel() {
  return (await import('../../models/index.js')).Agent
}

/* Resolves which agent types are active on this conversation into their scene-setting
   labels, for light framing context only (see VIBES_CURATION_SYSTEM_PROMPT). conversation.agents
   is populated only when enableAgents is true (see Conversation's post-findOne hook), so this
   checks for an already-populated agentType before falling back to an Agent query, the same
   populated-or-not idiom as agentIdOf in conversationAnalytics.service. */
export async function resolveActiveAgentTypeLabels(conversation): Promise<string[]> {
  const agentRefs = conversation.agents ?? []
  if (agentRefs.length === 0) return []

  const isPopulated = typeof agentRefs[0] === 'object' && 'agentType' in agentRefs[0]
  const agentDocs = isPopulated
    ? agentRefs
    : await (await agentModel()).find({ _id: { $in: agentRefs } }).select('agentType')

  return labelActiveAgentTypes(agentDocs.map((agent) => agent.agentType))
}

/* Whether an Event Historian agent is active on this conversation, so a deferred interpretive
   question can point to it by name only when it genuinely exists here rather than referencing a
   capability that is not installed. Same populated-or-not idiom as resolveActiveAgentTypeLabels. */
export async function hasHistorianAgent(conversation): Promise<boolean> {
  const agentRefs = conversation.agents ?? []
  if (agentRefs.length === 0) return false

  const isPopulated = typeof agentRefs[0] === 'object' && 'agentType' in agentRefs[0]
  const agentDocs = isPopulated
    ? agentRefs
    : await (await agentModel()).find({ _id: { $in: agentRefs } }).select('agentType')

  return agentDocs.some((agent) => agent.agentType === 'eventHistorian')
}

/**
 * Builds the verified engagement card for one event. It computes the metrics, adds spike
 * and reception annotations from the channels the VA is allowed to read, then has the
 * curator write the card and the critic fact-check it.
 *
 * Shared by the event-stop auto path and the on-demand summon path so both produce an
 * identical card from one pipeline. The content annotations are best-effort: a failure
 * in either leaves the card with its numbers and still returns. This does NOT fetch
 * external tracked-session snapshots; that is an event-stop concern the caller handles.
 *
 * The spike and reception annotations are mechanical extraction passes (pull a topic, a
 * quote, a sentiment from message text), so they run on fastLlm, a faster model, and run
 * concurrently since neither reads the other's output. The card writing and fact-check
 * stay on llm, the main model, since they carry the judgment. fastLlm defaults to llm so a
 * caller that has only one model still works.
 *
 * Returns the rendered card alongside the enriched metrics it was built from, so the
 * event-stop path can persist a metrics snapshot without recomputing. The metrics are the
 * post-enrichment bundle, so the reception count reflects the analyst's reading pass.
 */
export default async function buildVibesSummary(
  conversation,
  llm,
  fastLlm = llm
): Promise<{ renderData: CuratedVibesData; metrics: ConversationMetrics }> {
  const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

  /* Read message text once, only from the channels the VA is allowed to (see
     loadReadableMessages). This is the one place the recap reads content, so the access
     boundary stays visible here. */
  let readableMessages
  try {
    readableMessages = await loadReadableMessages(conversation._id)
  } catch (error: unknown) {
    logger.error(`Vibes Analyst could not read messages for ${conversation._id}: ${errorText(error)}`)
  }

  if (readableMessages) {
    const messages = readableMessages
    /* Both annotation passes read the same messages and write different metric fields, so run
       them at once on the faster model. Each is best-effort: a failure logs and leaves that
       field as computeConversationMetrics left it, so one failing never blocks the other or
       the card. Spike labelling needs the event start to map a spike's minute window back to
       real times, and only runs when there were spikes to label. */
    const [annotatedSpikes, annotatedReceptions] = await Promise.all([
      metrics.spikes.length > 0 && conversation.startTime
        ? annotateSpikes(messages, conversation.startTime, metrics.spikes, fastLlm).catch((error: unknown) => {
            logger.error(`Vibes Analyst could not annotate spikes for ${conversation._id}: ${errorText(error)}`)
            return metrics.spikes
          })
        : Promise.resolve(metrics.spikes),
      annotateReceptions(messages, metrics.participation.posterCount, fastLlm).catch((error: unknown) => {
        logger.error(`Vibes Analyst could not annotate receptions for ${conversation._id}: ${errorText(error)}`)
        return metrics.receptions
      })
    ])
    metrics.spikes = annotatedSpikes
    metrics.receptions = annotatedReceptions
  }

  const eventMeta = {
    eventName: conversation.name,
    durationMinutes: eventDurationMinutes(conversation.startTime, conversation.endTime),
    speakerCount: conversation.presenters?.length ?? 0,
    activeAgentTypeLabels: await resolveActiveAgentTypeLabels(conversation)
  }
  const draftCard = await curateVibesCard(metrics, eventMeta, llm)
  const renderData = await verifyCuratedCard(draftCard, metrics, llm)
  return { renderData, metrics }
}

import Conversation from '../../models/conversation.model.js'
import access from '../../auth/access.js'
import logger from '../../config/logger.js'
import { AgentResponse } from '../../types/index.types.js'
import buildVibesSummary from './buildSummary.js'
import { extractEventReference, findCandidatePublicEvents, resolveSummonedEvent, EventCandidate } from './eventResolution.js'

/* The channel the vibes analyst lives in and answers summons from. */
const SUMMON_CHANNEL = 'vibesAnalyst'

/* How many recent public events to offer back when nothing matched, so the reply gives
   the asker something to pick from instead of a dead end. */
const MAX_RECENT_SUGGESTIONS = 5

/* The reply when nothing public matches what was asked for. When there are recent public
   events to suggest, it lists them so the asker can pick one or ask for the latest, rather
   than guessing at an exact title. */
export function notFoundMessage(query: string, recent: EventCandidate[]): string {
  if (recent.length === 0) {
    return `I couldn't find a public event matching "${query}", and I don't have any public events to recap yet.`
  }
  const list = recent.map((candidate) => `• ${candidate.name}`).join('\n')
  return `I couldn't find a public event matching "${query}", and I recap one event at a time. Recent public events:\n${list}\nReply with one of these names, or ask for "the latest" and I'll take the most recent.`
}

/* The reply when several public events match and the asker needs to pick one. */
export function ambiguousMessage(candidates: EventCandidate[]): string {
  const list = candidates.map((candidate) => `• ${candidate.name}`).join('\n')
  return `A few public events match that. Which one did you mean?\n${list}`
}

/* Builds a reply that threads under the summoning message, in the channel it came from.
   Threading keeps each recap attached to the question that asked for it. An optional
   card turns the plain reply into the rendered engagement summary. */
function reply(
  context,
  parent: AgentResponse<string>['parent'],
  message: string,
  card?: { responseKind: string; renderData: unknown }
): AgentResponse<string> {
  const channels = context.conversation.channels.filter((channel) => channel.name === SUMMON_CHANNEL)
  return { visible: true, message, messageType: 'text', channels, parent, ...card }
}

/**
 * Handles one on-demand summon. Works out which past public event the message refers to,
 * then either posts that event's engagement card or replies asking for a clearer name.
 * The candidate set is privacy-filtered, and access is re-checked on the resolved event
 * before its content is read, so a summon can never recap a private event. Every reply
 * threads under the summoning message in the channel it came from.
 */
export default async function handleSummon(context, userMessage, llm): Promise<AgentResponse<string>[]> {
  const parent = userMessage._id

  const reference = await extractEventReference(userMessage.body ?? '', llm)
  const candidates = await findCandidatePublicEvents()
  const resolution = resolveSummonedEvent(reference, candidates)

  // Newest first, capped, so a miss can suggest real recent events instead of dead-ending.
  const recent = [...candidates].sort((a, b) => b.endTime.getTime() - a.endTime.getTime()).slice(0, MAX_RECENT_SUGGESTIONS)

  if (resolution.status === 'notFound') {
    return [reply(context, parent, notFoundMessage(reference.eventQuery, recent))]
  }
  if (resolution.status === 'ambiguous') {
    return [reply(context, parent, ambiguousMessage(resolution.candidates))]
  }

  const conversation = await Conversation.findById(resolution.event.id).populate('topic')
  if (!conversation) {
    return [reply(context, parent, notFoundMessage(reference.eventQuery, recent))]
  }

  // Re-check read access on the resolved event before reading it. Fail closed, same as
  // the auto path: anything but an explicit public topic is refused, not recapped.
  const topic = conversation.topic as { _id?: { toString(): string }; private?: boolean } | undefined
  try {
    access.assertCanRead(context, {
      type: 'conversation',
      id: conversation._id.toString(),
      topicId: topic?._id?.toString(),
      topicIsPrivate: topic?.private !== false
    })
  } catch (error: unknown) {
    logger.warn(
      `Vibes Analyst refused summon for ${conversation._id}: ${error instanceof Error ? error.message : String(error)}`
    )
    return [reply(context, parent, `I can only recap public events, and "${conversation.name}" isn't one I can share.`)]
  }

  // A summon recaps a past event on demand. Only the auto path persists a metrics snapshot
  // (an event is snapshotted once, when it ends), so the metrics are unused here.
  const { renderData } = await buildVibesSummary(conversation, llm)
  // Fallback text for adapters that do not render the card (e.g. zoom); the card itself
  // rides along as responseKind + renderData for adapters that do (Slack).
  return [
    reply(context, parent, `Vibes summary for *${conversation.name}*`, { responseKind: 'curatedVibesSummary', renderData })
  ]
}

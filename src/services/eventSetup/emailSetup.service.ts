/**
 * Two ways an event can arrive by email: a calendar invite (createConversationFromInvite) or a
 * plain email carrying a Zoom link (createConversationFromEmail). Neither says who owns the
 * event or which Topic it's in, so we work those out here with plain rules, no LLM. Everything
 * fuzzier (Zoom link, speakers, etc.) is extracted separately.
 */
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { Conversation, Topic } from '../../models/index.js'
import { TopicDocument } from '../../models/topic.model.js'
import userService from '../user.service.js'
import topicService from '../topic.service.js'
import emailService from '../email.service.js'
import eventUrls from '../eventUrls.service.js'
import conversationService from '../conversation.service/index.js'
import plannerService from './planner.service.js'
import { ExtractedFields } from './eventFieldsSchema.js'
import { getConversationType } from '../../conversations/index.js'
import { isZoomUrl } from '../../conversations/propertyFormats.js'
import { ConversationType, InboundInvite, InboundEmail } from '../../types/index.types.js'

/**
 * Everything before the first colon in the invite's SUMMARY, trimmed: "Team Sync: Jane Presents"
 * gives "Team Sync". Null if there's no colon; the caller treats that as "nothing to match".
 */
export const topicPrefixFromSummary = (summary?: string): string | null => {
  if (!summary) return null
  const colonIndex = summary.indexOf(':')
  if (colonIndex === -1) return null
  const prefix = summary.slice(0, colonIndex).trim()
  return prefix.length > 0 ? prefix : null
}

/**
 * Exact match only, ignoring case and extra spaces: "Team Sync" won't match "Team Syncs". This
 * doesn't check permissions; it trusts `candidates` to already be limited to Topics the sender
 * can see.
 */
export const matchTopicByPrefix = <T extends { name?: string }>(summary: string | undefined, candidates: T[]): T | null => {
  const prefix = topicPrefixFromSummary(summary)
  if (!prefix) return null
  const target = prefix.toLowerCase()
  return candidates.find((candidate) => (candidate.name ?? '').trim().toLowerCase() === target) ?? null
}

const emailDomain = (address: string): string | null => {
  const atIndex = address.lastIndexOf('@')
  if (atIndex === -1) return null
  const domain = address
    .slice(atIndex + 1)
    .trim()
    .toLowerCase()
  return domain.length > 0 ? domain : null
}

/** True if the sender's email domain is in the allowlist (env var ALLOWED_ORGANIZER_EMAIL_DOMAINS). */
const isAllowedOrganizerDomain = (address: string): boolean => {
  const domain = emailDomain(address)
  return domain !== null && config.allowedOrganizerEmailDomains.includes(domain)
}

/**
 * Looks up the user account for an inbound email's sender, restricted to domains in
 * config.allowedOrganizerEmailDomains. Three outcomes:
 *   - sender's domain is allowlisted and has an account -> returns that account
 *   - sender's domain is allowlisted but has no account -> sends a signup email, returns null
 *   - sender's domain is not allowlisted -> returns null, no email sent at all
 *
 * fromAddress must be the trusted envelope From, not a value read out of the email body (which
 * anyone can fake). statedOrganizer is an optional second address the message itself claims as
 * its organizer (e.g. a calendar invite's ORGANIZER field); it's never used for the lookup, only
 * compared against fromAddress to log a warning if the two disagree.
 */
export const resolveOrganizer = async (fromAddress: string, statedOrganizer?: string) => {
  if (!isAllowedOrganizerDomain(fromAddress)) {
    logger.warn(`Email webhook: sender ${fromAddress} is outside the allowlisted domains; rejecting, no event created`)
    return null
  }

  // Case-insensitive: a mixed-case From would otherwise miss a lowercase-stored account.
  const organizer = await userService.getUserByEmail(fromAddress.toLowerCase())
  if (organizer) {
    // Might be a spoofed ORGANIZER or a relay rewriting headers. Worth logging, not worth blocking a real event over.
    if (statedOrganizer && statedOrganizer.toLowerCase() !== fromAddress.toLowerCase()) {
      logger.warn(
        `Email webhook: .ics ORGANIZER ${statedOrganizer} differs from envelope From ${fromAddress}; trusting From`
      )
    }
    return organizer
  }

  await emailService.sendSignupInviteEmail(fromAddress)
  logger.info(`Email webhook: no account for ${fromAddress} (allowlisted domain); sent signup invite`)
  return null
}

/**
 * Matches the invite's Topic prefix (see topicPrefixFromSummary) against the organizer's own
 * Topics, public and private. No match means no Topic; we don't invent one just because an
 * invite mentioned it once.
 */
export const resolveTopic = async (inboundInvite: InboundInvite, organizer): Promise<TopicDocument | null> => {
  const { invite } = inboundInvite

  const candidates = await topicService.allTopicsByUser(organizer)
  const matched = matchTopicByPrefix(invite.summary, candidates)
  if (!matched?.id) return null

  return Topic.findById(matched.id)
}

// A missing title isn't worth rejecting the invite over: a renamable placeholder beats no event.
const PLACEHOLDER_CONVERSATION_NAME = 'Untitled event'

/**
 * Sets each feature to its own default (e.g. moderatorSupport: true, seriesHistory: false). Has
 * to be explicit: leaving `features` unset turns every feature off instead of using the defaults
 * (see resolver.ts's resolveFeatures).
 */
const defaultFeatures = (conversationType: ConversationType) =>
  (conversationType.features ?? []).map((feature) => ({ name: feature.name, enabled: feature.default }))

/**
 * Lists what's still missing before this conversation can run (e.g. a Zoom link, a Topic). Same
 * rules as lifecycle.ts's isConversationDraft check, just broken out by name instead of one
 * true/false, so the email can say exactly what's missing.
 */
const missingRequirements = (
  conversation: { topic?: unknown; properties?: Record<string, unknown> },
  conversationType?: ConversationType
): string[] => {
  const missing: string[] = []
  if (!conversation.topic) missing.push('a series')
  ;(conversationType?.properties ?? []).forEach((property) => {
    if (!property.required) return
    const value = conversation.properties?.[property.name] ?? property.default
    if (value === undefined || value === null || value === '') missing.push(property.label ?? property.name)
  })
  return missing
}

export const findConversationBySource = async (sourceKey: string, sourceValue?: string) => {
  if (!sourceValue) return null
  return Conversation.findOne({ [`source.${sourceKey}`]: sourceValue })
}

// Shared by every inbound-email flow (just the invite flow so far). Never throws: it emails the
// organizer about a failure instead of letting it propagate.
export const createEventForOrganizer = async ({
  organizer,
  topic,
  extracted,
  name,
  timing,
  source,
  referenceId,
  sendReply
}: {
  organizer: { email?: string }
  topic: TopicDocument | null
  extracted: { description?: string; zoomLink?: string; speakers?: unknown; moderators?: unknown }
  name: string
  timing: { scheduledTime?: Date; scheduledEndTime?: Date }
  source: Record<string, unknown>
  referenceId?: string
  sendReply: (conversation, missing: string[]) => Promise<void>
}) => {
  const conversationType = getConversationType('eventAssistant')

  try {
    const conversation = await conversationService.createConversationFromType(
      {
        type: 'eventAssistant',
        name,
        topicId: topic?.id,
        source,
        // Must be exactly this pair. ['nextspace'] alone matches no adapter config here and falls
        // back to audio-only, with no chat channels.
        platforms: ['nextspace', 'zoom'],
        scheduledTime: timing.scheduledTime,
        scheduledEndTime: timing.scheduledEndTime,
        description: extracted.description,
        properties: {
          // Must be a missing key, not `undefined`: resolver.ts checks for a property with
          // `prop.name in properties`, and `undefined` still passes that check.
          ...(extracted.zoomLink !== undefined && { zoomMeetingUrl: extracted.zoomLink })
        },
        features: conversationType ? defaultFeatures(conversationType) : undefined,
        presenters: extracted.speakers,
        moderators: extracted.moderators
      },
      organizer,
      { allowDraft: true }
    )

    await sendReply(conversation, missingRequirements(conversation, conversationType))
    return conversation
  } catch (err) {
    // The webhook already got its 200 OK, so there's no retry to fall back on: this email is the
    // only notice the organizer gets. No error detail in the body, since anyone can email this address.
    logger.error(`Email webhook: failed to create conversation (reference ${referenceId ?? 'none'})`, err)
    await emailService.sendEventCreationFailedEmail(organizer.email, referenceId)
    return null
  }
}

/**
 * Safe to run twice for the same invite: Postmark can retry a webhook, so a retry must reuse the
 * existing event instead of creating a second one. We track that with source.inviteUid, which
 * only trusted internal code can set, so no outside caller can plant a fake UID and silently
 * block a real invite later.
 *
 * Returns null when resolveOrganizer rejects the sender.
 */
export const createConversationFromInvite = async (inboundInvite: InboundInvite) => {
  const { invite, fromAddress, body } = inboundInvite

  if (invite.uid) {
    const existing = await findConversationBySource('inviteUid', invite.uid)
    if (existing) {
      logger.info(`Email webhook: invite UID ${invite.uid} already created as conversation ${existing._id}, skipping`)
      return existing
    }
  } else {
    logger.warn('Email webhook: invite has no UID; cannot dedup a webhook retry for this message')
  }

  const organizer = await resolveOrganizer(fromAddress, invite.organizer)
  if (!organizer) return null

  try {
    const topic = await resolveTopic(inboundInvite, organizer)
    const extracted = await plannerService.planConversationFromInvite({ invite, body })

    return await createEventForOrganizer({
      organizer,
      topic,
      extracted,
      name: invite.summary ?? PLACEHOLDER_CONVERSATION_NAME,
      timing: { scheduledTime: invite.startDate, scheduledEndTime: invite.endDate },
      source: { inviteUid: invite.uid },
      referenceId: invite.uid,
      sendReply: (conversation, missing) => emailService.sendEventCreatedEmail(organizer.email, conversation, missing)
    })
  } catch (err) {
    // Only covers resolveTopic/planConversationFromInvite above. A createConversationFromType
    // failure is already handled inside createEventForOrganizer and never reaches here.
    logger.error(`Email webhook: failed to create conversation from invite UID ${invite.uid ?? 'none'}`, err)
    await emailService.sendEventCreationFailedEmail(organizer.email, invite.uid)
    return null
  }
}

/* When the subject is blank, name the event after whoever sent it and when. fromName is the
   sender's display name off the inbound webhook payload (Postmark's FromName), a truer read of
   "the organizer's name" than the account; organizerLabel (username, then email local part) is
   the same fallback topic.service.ts uses for its auto-created Topic name, for when fromName is
   also blank. */
const onDemandEventName = ({
  subject,
  fromName,
  organizer
}: {
  subject?: string
  fromName?: string
  organizer: { username?: string; email?: string }
}): string => {
  const trimmedSubject = (subject ?? '').trim()
  if (trimmedSubject) return trimmedSubject

  const name = (fromName ?? '').trim() || topicService.organizerLabel(organizer)
  const now = new Date()
  const shortDate = `${now.getMonth() + 1}-${now.getDate()}-${String(now.getFullYear()).slice(-2)}`
  return `${name} Call ${shortDate}`
}

/* A dateTime that parses to a future instant schedules the event, with an end time computed from
   the stated or default duration; anything else (none stated, a past instant, unparseable text)
   takes the join-now branch, since createConversation rejects a scheduledTime in the past anyway.
   A join-now event gets neither field: nothing reads scheduledEndTime once scheduledTime is
   absent (see isConversationDraft), and every other instant-start conversation in this codebase
   (the existing "create and start now" web flow) leaves it unset too. */
const onDemandTiming = (extracted: ExtractedFields): { scheduledTime?: Date; scheduledEndTime?: Date } => {
  const parsed = extracted.dateTime ? new Date(extracted.dateTime) : null
  const isFuture = parsed !== null && !Number.isNaN(parsed.getTime()) && parsed.getTime() > Date.now()
  if (!isFuture) return {}

  const durationMs = (extracted.duration ?? config.onDemandEventDurationMinutes) * 60 * 1000
  return { scheduledTime: parsed!, scheduledEndTime: new Date(parsed!.getTime() + durationMs) }
}

/* Shared by a freshly-created conversation and an already-active one found by Zoom link below.
   Reads channels back from the database with populate rather than off the in-memory document:
   this avoids depending on whether Mongoose's in-memory array still holds the full Channel
   documents createConversation just pushed, or only their ids. */
const sendOnDemandReply = async (
  organizerEmail: string | undefined,
  conversation: { _id: string | { toString(): string }; scheduledTime?: Date }
) => {
  const populated = (await Conversation.findById(conversation._id).populate('channels')) ?? conversation
  await emailService.sendOnDemandEventEmail(
    organizerEmail,
    {
      eventPageUrl: eventUrls.eventPageUrl(populated),
      moderatorUrl: eventUrls.moderatorUrl(populated),
      participantUrl: eventUrls.participantUrl(populated)
    },
    { joinAt: conversation.scheduledTime }
  )
}

/**
 * Safe to run twice for the same email: Postmark can retry a webhook, so a retry must reuse the
 * existing event instead of creating a second one. We track that with source.messageId, the same
 * way the invite flow tracks source.inviteUid.
 *
 * Unlike an invite, a plain email has no Topic to match and no title guaranteed, so this always
 * provisions the organizer's own auto-created Topic (findOrCreateEmailTopic) and, when the
 * subject is blank, builds a name from the sender and the date instead of a placeholder.
 *
 * Returns null when resolveOrganizer rejects the sender, or when the email carries no usable
 * Zoom link.
 */
export const createConversationFromEmail = async (inboundEmail: InboundEmail) => {
  const { fromAddress, fromName, subject, body, messageId } = inboundEmail

  if (messageId) {
    const existing = await findConversationBySource('messageId', messageId)
    if (existing) {
      logger.info(`Email webhook: message ID ${messageId} already created as conversation ${existing._id}, skipping`)
      return existing
    }
  } else {
    logger.warn('Email webhook: email has no Message-ID; cannot dedup a webhook retry for this message')
  }

  const organizer = await resolveOrganizer(fromAddress)
  if (!organizer) return null

  try {
    const extracted = await plannerService.planConversationFromEmail({ subject, body })

    if (!extracted.zoomLink) {
      logger.info(`Email webhook: no Zoom link found in email from ${fromAddress}; nothing created`)
      await emailService.sendOnDemandEventFailedEmail(organizer.email, 'noZoomLink')
      return null
    }
    if (!isZoomUrl(extracted.zoomLink)) {
      logger.info(`Email webhook: "${extracted.zoomLink}" from ${fromAddress} is not a valid Zoom link`)
      await emailService.sendOnDemandEventFailedEmail(organizer.email, 'invalidZoomLink')
      return null
    }

    // Pre-empts adapter.service.ts's active-meeting-uniqueness throw and makes a repeat email
    // (e.g. someone forwarding the same link to a colleague, who also emails it in) idempotent.
    // Scoped to this organizer: an unscoped match would leak another organizer's moderator link
    // to anyone who happens to email in the same Zoom URL.
    const activeMeeting = await Conversation.findOne({
      active: true,
      owner: organizer._id,
      'properties.zoomMeetingUrl': extracted.zoomLink
    })
    if (activeMeeting) {
      logger.info(
        `Email webhook: ${extracted.zoomLink} is already active as conversation ${activeMeeting._id}; replying with its links`
      )
      await sendOnDemandReply(organizer.email, activeMeeting)
      return activeMeeting
    }

    const topic = await topicService.findOrCreateEmailTopic(organizer)

    return await createEventForOrganizer({
      organizer,
      topic,
      extracted,
      name: onDemandEventName({ subject, fromName, organizer }),
      timing: onDemandTiming(extracted),
      source: { messageId },
      referenceId: messageId,
      sendReply: (conversation) => sendOnDemandReply(organizer.email, conversation)
    })
  } catch (err) {
    // Only covers extraction/Topic resolution above. A createConversationFromType failure is
    // already handled inside createEventForOrganizer and never reaches here.
    logger.error(`Email webhook: failed to create conversation from email (message ${messageId ?? 'none'})`, err)
    await emailService.sendEventCreationFailedEmail(organizer.email, messageId)
    return null
  }
}

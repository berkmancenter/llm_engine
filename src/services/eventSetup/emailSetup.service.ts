/**
 * Resolves the two things an inbound calendar invite doesn't state directly: who owns the event
 * (the organizer) and which Topic it belongs to. Both are decided deterministically here, with no
 * LLM involved (see the plan's "Topic matching never uses the LLM"). The fuzzy fields (Zoom link,
 * speakers, etc.) are extracted separately.
 */
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { Conversation, Topic } from '../../models/index.js'
import { TopicDocument } from '../../models/topic.model.js'
import userService from '../user.service.js'
import topicService from '../topic.service.js'
import emailService from '../email.service.js'
import conversationService from '../conversation.service/index.js'
import plannerService from './planner.service.js'
import { getConversationType } from '../../conversations/index.js'
import { ConversationType, InboundInvite } from '../../types/index.types.js'

/**
 * The Topic prefix an invite's SUMMARY points at: the substring before the first colon, trimmed.
 * Conversations in a series are named "<topic>: <additional info>", so "Team Sync: Jane Presents"
 * points at the "Team Sync" topic. Returns null when there's no colon or the prefix is empty, which
 * the caller reads as "no prefix to match, fall back to a new Topic."
 */
export const topicPrefixFromSummary = (summary?: string): string | null => {
  if (!summary) return null
  const colonIndex = summary.indexOf(':')
  if (colonIndex === -1) return null
  const prefix = summary.slice(0, colonIndex).trim()
  return prefix.length > 0 ? prefix : null
}

/**
 * Pick the candidate Topic whose name exactly equals the invite SUMMARY's prefix, comparing
 * case-insensitively and ignoring surrounding whitespace. Exact match only: "Team Sync" must not
 * match a "Team Syncs" Topic. Returns null when there's no prefix or nothing matches. The candidate
 * list is the permission boundary; the caller decides which Topics go in it.
 */
export const matchTopicByPrefix = <T extends { name?: string }>(summary: string | undefined, candidates: T[]): T | null => {
  const prefix = topicPrefixFromSummary(summary)
  if (!prefix) return null
  const target = prefix.toLowerCase()
  return candidates.find((candidate) => (candidate.name ?? '').trim().toLowerCase() === target) ?? null
}

/** The lowercased domain of an email address, or null if it isn't shaped like `local@domain`. */
const emailDomain = (address: string): string | null => {
  const atIndex = address.lastIndexOf('@')
  if (atIndex === -1) return null
  const domain = address
    .slice(atIndex + 1)
    .trim()
    .toLowerCase()
  return domain.length > 0 ? domain : null
}

/** True when the sender is inside a domain we invite to sign up (see ALLOWED_ORGANIZER_EMAIL_DOMAINS). */
const isAllowedOrganizerDomain = (address: string): boolean => {
  const domain = emailDomain(address)
  return domain !== null && config.allowedOrganizerEmailDomains.includes(domain)
}

/**
 * Find the account that owns this invite, keying off the envelope From that Postmark
 * received (never the spoofable .ics ORGANIZER). Returns the organizer, or null when no event should
 * be created. The allowlisted domain is a hard gate checked first: any sender outside it is rejected
 * outright, account or not, with no reply (confirming the address "just needs to sign up" would be a
 * small information leak to arbitrary outsiders). Inside the allowlist, a known sender is the
 * organizer and an unknown one gets a "please sign up" reply.
 */
export const resolveOrganizer = async (inboundInvite: InboundInvite) => {
  const { fromAddress, invite } = inboundInvite

  if (!isAllowedOrganizerDomain(fromAddress)) {
    logger.warn(`Email webhook: sender ${fromAddress} is outside the allowlisted domains; rejecting, no event created`)
    return null
  }

  // Match the organizer case-insensitively: the domain gate above already lowercases, and a
  // lowercase-stored account would otherwise be missed by a mixed-case From and wrongly bounced.
  const organizer = await userService.getUserByEmail(fromAddress.toLowerCase())
  if (organizer) {
    // A mismatch is worth watching (a spoof attempt, or a relay rewriting headers) but not worth
    // blocking a real organizer's event over, so log and proceed on the trusted From.
    if (invite.organizer && invite.organizer.toLowerCase() !== fromAddress.toLowerCase()) {
      logger.warn(
        `Email webhook: .ics ORGANIZER ${invite.organizer} differs from envelope From ${fromAddress}; trusting From`
      )
    }
    return organizer
  }

  await emailService.sendSignupInviteEmail(fromAddress)
  logger.info(`Email webhook: no account for ${fromAddress} (allowlisted domain); sent signup invite`)
  return null
}

/**
 * Decide which existing Topic this invite belongs to, deterministically. Match the SUMMARY's
 * "<topic>:" prefix against the sender's candidate set (public Topics plus their own private ones),
 * case-insensitively; the candidate set is the permission boundary. Returns the matched Topic, or
 * null when nothing matches. On null the draft event is created with a blank topic for the organizer
 * to fill in later, rather than inventing a Topic from a one-off invite.
 */
export const resolveTopic = async (inboundInvite: InboundInvite, organizer): Promise<TopicDocument | null> => {
  const { invite } = inboundInvite

  const candidates = await topicService.allTopicsByUser(organizer)
  const matched = matchTopicByPrefix(invite.summary, candidates)
  if (!matched?.id) return null

  return Topic.findById(matched.id)
}

/* A .ics file without a title is a malformed edge case, not something worth rejecting the whole
   invite over: the plan's own design is "best-effort data plus sane placeholders," and a
   conversation the organizer can rename from the detail page beats none at all. */
const PLACEHOLDER_CONVERSATION_NAME = 'Untitled event'

/**
 * Each of the type's features, enabled or disabled exactly as its own definition defaults it
 * (e.g. moderatorSupport on, seriesHistory off). Leaving `features` unset resolves to zero
 * feature agents rather than "apply each default" (see resolver.ts's resolveFeatures), so an
 * invite-created event has to send this explicitly to end up with the same feature agents a
 * manually-created event gets from the create form.
 */
const defaultFeatures = (conversationType: ConversationType) =>
  (conversationType.features ?? []).map((feature) => ({ name: feature.name, enabled: feature.default }))

/**
 * Ties organizer resolution, Topic resolution, and the fuzzy-field extraction together into an
 * actual Conversation. Idempotent: Postmark can redeliver the same message (up to 10 retries over
 * ~10.5 hours), so a retry must not create a second conversation. Dedup keys off the invite's
 * .ics UID, stored on the Conversation as sourceInviteUid, which only a trusted allowDraft caller
 * can ever set (see conversation.service/index.ts createConversation) so a public API client
 * cannot squat on a UID and cause a future legitimate invite to silently no-op.
 *
 * Returns the created (or already-existing) Conversation, or null when none should be created at
 * all, i.e. resolveOrganizer rejected the sender.
 */
export const createConversationFromInvite = async (inboundInvite: InboundInvite) => {
  const { invite } = inboundInvite

  if (invite.uid) {
    const existing = await Conversation.findOne({ sourceInviteUid: invite.uid })
    if (existing) {
      logger.info(`Email webhook: invite UID ${invite.uid} already created as conversation ${existing._id}, skipping`)
      return existing
    }
  } else {
    logger.warn('Email webhook: invite has no UID; cannot dedup a Postmark retry for this message')
  }

  const organizer = await resolveOrganizer(inboundInvite)
  if (!organizer) return null

  try {
    const topic = await resolveTopic(inboundInvite, organizer)
    const extracted = await plannerService.planConversationFromInvite({ invite })

    const conversationType = getConversationType('eventAssistant')

    const conversation = await conversationService.createConversationFromType(
      {
        type: 'eventAssistant',
        name: invite.summary ?? PLACEHOLDER_CONVERSATION_NAME,
        topicId: topic?.id,
        sourceInviteUid: invite.uid,
        platforms: ['nextspace'],
        scheduledTime: invite.startDate,
        scheduledEndTime: invite.endDate,
        description: extracted.description,
        properties: {
          // Present-but-undefined would still satisfy the type's "required property" presence
          // check (see resolver.ts's `prop.name in properties`), so the key must be fully absent
          // rather than set to undefined when there is no Zoom link.
          ...(extracted.zoomLink !== undefined && { zoomMeetingUrl: extracted.zoomLink })
        },
        features: conversationType ? defaultFeatures(conversationType) : undefined,
        presenters: extracted.speakers,
        moderators: extracted.moderators
      },
      organizer,
      { allowDraft: true }
    )

    await emailService.sendEventCreatedEmail(organizer.email, conversation)
    return conversation
  } catch (err) {
    /* handlers/email.ts acknowledges Postmark with a 200 before any of this runs, so there is no
       retry to fall back on: this email is the only way the organizer learns something went wrong.
       The error itself stays server-side (see email.service.ts's sendEventCreationFailedEmail),
       since the inbound address accepts mail from anyone and the reply body is not a safe place
       for a stack trace. */
    logger.error(`Email webhook: failed to create conversation from invite UID ${invite.uid ?? 'none'}`, err)
    await emailService.sendEventCreationFailedEmail(organizer.email, invite.uid)
    return null
  }
}

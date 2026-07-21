/**
 * Resolves the two things an inbound calendar invite doesn't state directly: who owns the event
 * (the organizer) and which Topic it belongs to. Both are decided deterministically here, with no
 * LLM involved (see the plan's "Topic matching never uses the LLM"). The fuzzy fields (Zoom link,
 * speakers, etc.) are extracted separately.
 */
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { Topic } from '../../models/index.js'
import { TopicDocument } from '../../models/topic.model.js'
import userService from '../user.service.js'
import topicService from '../topic.service.js'
import emailService from '../email.service.js'
import { InboundInvite } from '../../types/index.types.js'

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
 * Find the Nextspace account that owns this invite, keying off the envelope From that Postmark
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

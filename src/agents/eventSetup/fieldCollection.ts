import { z } from 'zod'
import mongoose from 'mongoose'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { ConversationHistory, IMessage } from '../../types/index.types.js'
import { getConversationType } from '../../conversations/index.js'
import logger from '../../config/logger.js'
import {
  ZOOM_MEETING_URL_PROPERTY,
  TRANSCRIPT_CHANNEL,
  CHAT_CHANNEL,
  RESOURCES_CHANNEL,
  MODERATOR_CHANNEL
} from '../../conversations/eventAssistant.js'

// Lazy imports to avoid a circular dependency: these modules load the agent
// registry, which imports this file.

export interface Speaker {
  name: string
  bio: string
  alternateName?: string
}

export interface CollectedFields {
  eventName?: string
  dateTime?: string
  duration?: number
  description?: string
  zoomLink?: string
  hasResources?: boolean
  topicName?: string
  speakers?: Speaker[]
  moderators?: Speaker[]
  skipSpeakers?: boolean
  skipModerators?: boolean
  confirmed?: boolean
  timeZone?: string
}

export type RoundKey = 'round1' | 'round2' | 'round3' | 'round4' | 'round5' | 'confirmation' | 'complete'

const ROUND3_PROMPT = 'What topic should this event be under?'
const ROUND4_PROMPT =
  'Who is speaking? For each speaker, share their name plus an optional bio and an optional alternate name (nickname or other name) if they go by one. Reply *skip* if there are no speakers yet.'
const ROUND5_PROMPT =
  'And who is moderating? For each moderator, share their name plus an optional bio and an optional alternate name. Reply *skip* if there are no moderators yet.'

/**
 * Returns the prompt for the given round, listing only the fields that are
 * still missing. For rounds with multiple fields, uses a friendly opener on
 * first contact and a targeted "still need" message on re-prompts.
 */
export function getRoundPrompt(round: Exclude<RoundKey, 'complete' | 'confirmation'>, fields: CollectedFields): string {
  if (round === 'round1') {
    const missing: string[] = []
    if (!fields.eventName) missing.push('• The event name')
    if (!fields.dateTime) missing.push('• The date and time')
    if (typeof fields.duration !== 'number') missing.push('• The duration (in minutes)')
    const isFirstContact = !fields.eventName && !fields.dateTime && typeof fields.duration !== 'number'
    const opener = isFirstContact ? "Sure, let's get this event set up. To start, please share:" : 'Still need:'
    return `${opener}\n${missing.join('\n')}`
  }
  if (round === 'round2') {
    const missing: string[] = []
    if (!fields.description) missing.push('• A short description of the event')
    if (!fields.zoomLink) missing.push('• The Zoom link')
    if (typeof fields.hasResources !== 'boolean')
      missing.push('• Whether the event needs a *resources* channel for sharing files and links (yes/no)')
    const isFirstContact = !fields.description && !fields.zoomLink && typeof fields.hasResources !== 'boolean'
    const opener = isFirstContact ? 'Got it. Next:' : 'Still need:'
    return `${opener}\n${missing.join('\n')}`
  }
  if (round === 'round3') return ROUND3_PROMPT
  if (round === 'round4') return ROUND4_PROMPT
  return ROUND5_PROMPT
}

/**
 * Which round to prompt for next, or `'complete'` once every required field
 * is set.
 */
export function getNextRound(fields: CollectedFields): RoundKey {
  if (!fields.eventName || !fields.dateTime || typeof fields.duration !== 'number') return 'round1'
  if (!fields.description || !fields.zoomLink || typeof fields.hasResources !== 'boolean') return 'round2'
  if (!fields.topicName) return 'round3'
  if (!fields.skipSpeakers && (!fields.speakers || fields.speakers.length === 0)) return 'round4'
  if (!fields.skipModerators && (!fields.moderators || fields.moderators.length === 0)) return 'round5'
  if (!fields.confirmed) return 'confirmation'
  return 'complete'
}

const speakerSchema = z.object({
  name: z.string(),
  bio: z.string(),
  alternateName: z.string().optional().describe('Nickname or stage name the speaker also goes by')
})

const collectedFieldsSchema = z.object({
  eventName: z.string().optional(),
  dateTime: z.string().optional().describe('ISO 8601 datetime string'),
  duration: z.number().optional().describe('Duration in minutes'),
  description: z.string().optional(),
  zoomLink: z.string().optional(),
  hasResources: z.boolean().optional().describe('True if the organizer wants a resources channel for sharing files/links'),
  topicName: z.string().optional(),
  speakers: z.array(speakerSchema).optional(),
  moderators: z.array(speakerSchema).optional(),
  skipSpeakers: z.boolean().optional(),
  skipModerators: z.boolean().optional(),
  confirmed: z.boolean().optional().describe('True when the organizer explicitly approves the summary'),
  timeZone: z
    .string()
    .optional()
    .describe(
      'IANA timezone (e.g. America/New_York) inferred from any timezone the organizer mentioned, like ET, Eastern, PST, or GMT+1'
    )
})

/**
 * Filters history down to the current setup thread, so the LLM extractor
 * doesn't see unrelated channel messages.
 */
export function getThreadMessages(history: ConversationHistory, userMessage: IMessage): IMessage[] {
  if (!userMessage.parentMessage) {
    if (history.messages.length > 0) {
      logger.warn(
        `eventSetup getThreadMessages: root message with no parentMessage but history has ${history.messages.length} messages — prior context will not be included in extraction`
      )
    }
    return [userMessage]
  }
  const parentId = userMessage.parentMessage.toString()
  const thread = history.messages.filter((m) => {
    if (m._id?.toString() === parentId) return true
    return m.parentMessage?.toString() === parentId
  })
  if (!thread.some((m) => m._id?.toString() === userMessage._id?.toString())) {
    thread.push(userMessage)
  }
  return thread
}

const EXTRACTION_SYSTEM_PROMPT = `You extract structured event details from a Slack conversation between an organizer and a setup bot.

Today's date (for resolving relative dates like "tomorrow"): {today}

Rules:
- Extract from the ENTIRE conversation, not just the most recent message. Earlier messages still count; carry their values forward.
- Extract every field that appears anywhere in the conversation. Leave a field undefined only if it has never been mentioned.
- For dateTime, return ISO 8601 in UTC (always end with Z). Resolve relative dates from "today" above.
- If the organizer mentions a timezone (e.g. "5pm ET", "6:30 Pacific", "14:00 GMT+1"), use that timezone to compute the UTC dateTime, AND set timeZone to the matching IANA name (e.g. America/New_York for ET/Eastern, America/Los_Angeles for PT/Pacific, Europe/London for GMT/BST, etc.). If no timezone is mentioned, leave timeZone undefined.
- duration is in minutes.
- When the organizer answers the resources question, set hasResources=true on an affirmative reply (yes, yeah, sure, please) and hasResources=false on a negative reply (no, nope, skip, none). Leave undefined until they answer.
- If the organizer says "skip" or "none" for speakers, set skipSpeakers=true.
- If they say "skip" or "none" for moderators, set skipModerators=true.
- speakers and moderators are arrays of {{name, bio, alternateName?}}. Include a speaker or moderator entry as soon as a name is provided, even if the bio is missing — set bio to an empty string in that case. Capture alternateName only when the organizer gives an explicit alias such as "also goes by", "aka", "nickname", or "stage name"; leave it undefined otherwise.
- topicName must be the EXACT text the organizer typed when answering the topic question. Do not shorten, paraphrase, drop leading words, normalize casing, or "clean up" the value — preserve it character-for-character (you may trim surrounding whitespace).
- Only tokens that begin with a literal "@" character are bot mentions. Strip them. Words without an "@" prefix are normal text — never drop or alter them even if they resemble a bot name.
- If the bot has shown a summary of the event and the organizer's most recent reply is an affirmative such as "confirm", "yes", "yep", "looks good", "lgtm", "go ahead", or "create it", set confirmed=true. If the organizer's reply changes a field instead, leave confirmed undefined and apply the change.`

/**
 * Rebuilds the field state from the thread text via one LLM call. We don't
 * persist state between turns.
 */
export async function extractFieldsFromThread(
  llm,
  thread: IMessage[],
  today: Date = new Date(),
  botName?: string
): Promise<CollectedFields> {
  // Strip bot @-mentions before the LLM sees the transcript so they can't
  // be misread as part of a field value (e.g. "@Eventbot Setup Test" → "Setup Test").
  const escapedBotName = botName?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // eslint-disable-next-line security/detect-non-literal-regexp
  const mentionPattern = escapedBotName ? new RegExp(`@${escapedBotName}\\b`, 'gi') : null
  const transcript = thread
    .map((m) => {
      const role = m.fromAgent ? 'Bot' : 'Organizer'
      let body = typeof m.body === 'string' ? m.body : JSON.stringify(m.body)
      if (mentionPattern) body = body.replace(mentionPattern, '').replace(/\s+/g, ' ').trim()
      return `${role}: ${body}`
    })
    .join('\n')

  const systemPrompt = EXTRACTION_SYSTEM_PROMPT.replace('{today}', today.toISOString().split('T')[0])

  try {
    const result = await getChatPromptResponse(
      llm,
      systemPrompt,
      'Conversation:\n{transcript}',
      { transcript },
      [],
      collectedFieldsSchema
    )
    const fields = (result ?? {}) as CollectedFields
    // Warn if the LLM returned nothing but the thread had agent prompts already.
    // That means we just lost state and the user will see the flow restart.
    if (Object.keys(fields).length === 0 && thread.some((m) => m.fromAgent)) {
      logger.warn(
        `eventSetup extractFieldsFromThread returned empty for a thread with ${thread.length} messages. Transcript:\n${transcript}`
      )
    }
    return fields
  } catch (err) {
    logger.error(`eventSetup extractFieldsFromThread failed: ${(err as Error).message}`)
    return {}
  }
}

/**
 * Finds a public topic by name. Match is case-insensitive and ignores
 * whitespace, hyphens, and underscores on both sides — so "Event Setup Test"
 * matches a topic named "EventSetupTest" or "event_setup_test". Returns a
 * single match, or a list of options when several topics match.
 */
export async function lookupTopicByName(name: string) {
  const { default: topicService } = await import('../../services/topic.service.js')
  const topics = await topicService.allPublicTopics()
  const normalize = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, '')
  const needle = normalize(name)
  if (!needle) return { match: null, options: [] }
  const exact = topics.filter((t) => t.name && normalize(t.name) === needle)
  if (exact.length === 1) return { match: exact[0], options: null }
  if (exact.length > 1) return { match: null, options: exact }
  const partial = topics.filter((t) => t.name && normalize(t.name).includes(needle))
  if (partial.length === 1) return { match: partial[0], options: null }
  if (partial.length > 1) return { match: null, options: partial }
  return { match: null, options: [] }
}

/**
 * Creates an eventAssistant conversation from the collected fields. Uses
 * the topic owner as the acting user, since this agent has no user
 * identity of its own.
 */
export async function createEvent(fields: CollectedFields, topicId: mongoose.Types.ObjectId | string) {
  const { default: topicService } = await import('../../services/topic.service.js')
  const { default: conversationService } = await import('../../services/conversation.service/index.js')
  const { default: User } = await import('../../models/user.model/user.model.js')

  const topic = await topicService.findById(topicId)
  if (!topic) throw new Error(`Topic ${topicId} not found`)
  const owner = await User.findById(topic.owner)
  if (!owner) throw new Error(`Topic owner ${topic.owner} not found`)

  const created = await conversationService.createConversationFromType(
    {
      type: 'eventAssistant',
      name: fields.eventName,
      description: fields.description,
      platforms: ['nextspace', 'zoom'],
      topicId: topicId.toString(),
      properties: {
        [ZOOM_MEETING_URL_PROPERTY]: fields.zoomLink
      },
      features: (getConversationType('eventAssistant')?.features ?? [])
        .filter(f => f.default)
        .map(f => ({ name: f.name })),
      scheduledTime: fields.dateTime,
      presenters: fields.skipSpeakers ? [] : (fields.speakers ?? []),
      moderators: fields.skipModerators ? [] : (fields.moderators ?? [])
    },
    owner
  )

  // Re-fetch with channels populated so the caller can read channel
  // passcodes for the participant/moderator links.
  const populated = await conversationService.findByIdFull(String(created._id ?? created.id), owner)
  return populated ?? created
}

/**
 * Renders an ISO datetime in a human-friendly form for the organizer's
 * confirmation summary. Timezone defaults to America/New_York and is
 * overridable via the EVENT_DISPLAY_TIMEZONE env var.
 */
export function formatDisplayDateTime(iso: string, timeZoneOverride?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const timeZone = timeZoneOverride || process.env.EVENT_DISPLAY_TIMEZONE || 'America/New_York'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const hour12 = get('hour')
  const minute = get('minute')
  const dayPeriod = get('dayPeriod')
  const tz = get('timeZoneName')
  return `${get('month')} ${get('day')}, ${get('year')} at ${hour12}:${minute} ${dayPeriod} ${tz}`
}

function formatPeople(people?: Speaker[]): string {
  if (!people || people.length === 0) return 'None'
  return people
    .map((p) => {
      const displayName = p.alternateName ? `${p.name} (aka ${p.alternateName})` : p.name
      return p.bio ? `${displayName} — ${p.bio}` : displayName
    })
    .join(', ')
}

interface ConfirmationOptions {
  /** Canonical topic name from the DB, shown instead of the raw user input. */
  resolvedTopicName?: string
  /** Inline warning rendered next to the topic line (e.g. no match found). */
  topicWarning?: string
}

/**
 * Renders the summary the bot shows before creating the event so the
 * organizer can spot-check every field and reply "confirm".
 */
export function buildConfirmationPrompt(fields: CollectedFields, options: ConfirmationOptions = {}): string {
  const speakers = fields.skipSpeakers ? 'None' : formatPeople(fields.speakers)
  const moderators = fields.skipModerators ? 'None' : formatPeople(fields.moderators)
  const topicDisplay = options.resolvedTopicName || fields.topicName
  const topicLine = options.topicWarning ? `• Topic: ${topicDisplay} (${options.topicWarning})` : `• Topic: ${topicDisplay}`
  return [
    'Here is what I have so far:',
    `• Name: ${fields.eventName}`,
    `• Date/time: ${fields.dateTime ? formatDisplayDateTime(fields.dateTime, fields.timeZone) : ''}`,
    `• Duration: ${fields.duration} minutes`,
    `• Description: ${fields.description}`,
    `• Zoom link: ${fields.zoomLink}`,
    topicLine,
    `• Speakers: ${speakers}`,
    `• Moderators: ${moderators}`,
    '',
    'Reply *confirm* to create the event, or tell me what to change.'
  ].join('\n')
}

interface EventLinkInputs {
  name: string
  description?: string
  zoomLink?: string
  dateTime: string
  duration: number
}

/**
 * Builds an "add to calendar" deep link. Returns an empty string when the
 * deployment hasn't configured CALENDAR_DEEPLINK_BASE_URL, so callers can
 * conditionally skip the link instead of pointing organizers at a generic
 * landing page.
 */
export function buildCalendarLink({ name, description, zoomLink, dateTime, duration }: EventLinkInputs): string {
  const base = process.env.CALENDAR_DEEPLINK_BASE_URL
  if (!base) return ''
  const start = new Date(dateTime)
  const end = new Date(start.getTime() + duration * 60 * 1000)
  const params: Record<string, string> = {
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: name,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: description || '',
    location: zoomLink || ''
  }
  // encodeURIComponent (vs URLSearchParams) keeps spaces as %20, which is
  // what most calendar deep-link endpoints expect.
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  return `${base}?${query}`
}

const DEFAULT_PARTICIPANT_TEMPLATE =
  `{host}/assistant/?conversationId={conversationId}` +
  `[&channel=${TRANSCRIPT_CHANNEL},{${TRANSCRIPT_CHANNEL}_passcode}]` +
  `[&channel=${CHAT_CHANNEL},{${CHAT_CHANNEL}_passcode}]` +
  `[&channel=${RESOURCES_CHANNEL},{${RESOURCES_CHANNEL}_passcode}]`

const DEFAULT_MODERATOR_TEMPLATE =
  `{host}/moderator/?conversationId={conversationId}` +
  `&channel=${MODERATOR_CHANNEL},{${MODERATOR_CHANNEL}_passcode}` +
  `[&channel=${TRANSCRIPT_CHANNEL},{${TRANSCRIPT_CHANNEL}_passcode}]`

interface ChannelLike {
  name?: string
  passcode?: string
}
interface ConversationLike {
  id?: string
  _id?: { toString(): string } | string
  slug?: string
  channels?: ChannelLike[]
}

function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  // Optional `[...]` segments drop out when any placeholder inside them is
  // missing — mirrors nextspace's "only include this query param if the
  // channel exists" behavior. Required placeholders sit outside the brackets.
  const withOptionalsApplied = template.replace(/\[([^\]]+)\]/g, (_match, inner: string) => {
    const placeholders: string[] = inner.match(/\{([^}]+)\}/g) || []
    const allResolved = placeholders.every((p) => Boolean(vars[p.slice(1, -1)]))
    return allResolved ? inner : ''
  })
  return withOptionalsApplied.replace(/\{([^}]+)\}/g, (_match, key: string) => vars[key] ?? '')
}

/**
 * Builds participant and moderator URLs from the conversation. Templates are
 * env-driven so other frontends can override the URL shape without changing
 * this file. The moderator URL is empty when the moderator channel lacks a
 * passcode (e.g. moderator support disabled).
 */
export function buildEventLinks(
  conversation: ConversationLike,
  host: string,
  options: { includeResources?: boolean } = {}
): { participantUrl: string; moderatorUrl: string } {
  const { includeResources = true } = options
  const participantTemplate = process.env.EVENT_PARTICIPANT_URL_TEMPLATE || DEFAULT_PARTICIPANT_TEMPLATE
  const moderatorTemplate = process.env.EVENT_MODERATOR_URL_TEMPLATE || DEFAULT_MODERATOR_TEMPLATE
  const conversationId =
    conversation.id ?? (typeof conversation._id === 'string' ? conversation._id : conversation._id?.toString())

  const vars: Record<string, string | undefined> = {
    host,
    conversationId,
    slug: conversation.slug
  }
  for (const channel of conversation.channels ?? []) {
    if (channel.name && channel.passcode) {
      // Skip the resources passcode when the organizer didn't ask for a
      // resources section, so the bracket segment drops out of the URL.
      if (channel.name === RESOURCES_CHANNEL && !includeResources) continue
      vars[`${channel.name}_passcode`] = channel.passcode
    }
  }

  const participantUrl = renderTemplate(participantTemplate, vars)
  // Skip the moderator link entirely if the conversation has no moderator
  // passcode — the rendered URL would be missing the required token.
  const moderatorUrl = vars.moderator_passcode ? renderTemplate(moderatorTemplate, vars) : ''
  return { participantUrl, moderatorUrl }
}

function eventTypeSupportsModerators(event): boolean {
  const features = event?.features
  if (!Array.isArray(features)) return false
  return features.some((f) => f?.name === 'moderatorSupport' && f?.enabled !== false)
}

export function formatCompletionReply(event, fields?: CollectedFields): string {
  // EVENT_UI_BASE_URL points at the frontend (e.g. http://localhost:8080).
  // APP_HOST is the llm_engine server itself, so it's only a fallback for
  // dev setups where both run on the same host.
  const host = process.env.EVENT_UI_BASE_URL || process.env.APP_HOST || ''
  const { participantUrl, moderatorUrl } = buildEventLinks(event, host, {
    includeResources: fields?.hasResources ?? false
  })
  if (eventTypeSupportsModerators(event) && !moderatorUrl) {
    // moderatorSupport is on, but we couldn't build a link — usually means
    // the moderator channel passcode was stripped when the conversation was
    // re-fetched (passcodes are only returned to the owner or an admin).
    logger.warn(
      `eventSetup: moderator link is empty even though moderatorSupport is enabled on conversation ${event?._id ?? event?.id}. Check that the topic owner can see channel passcodes.`
    )
  }
  const zoomLink = event.properties?.[ZOOM_MEETING_URL_PROPERTY] ?? fields?.zoomLink
  // The conversation model stores scheduledTime + scheduledEndTime, not
  // duration — so we fall back to the collected fields for the deep-link
  // start/duration pair.
  const dateTime = fields?.dateTime || event.scheduledTime
  const duration = fields?.duration
  const calendarLink =
    dateTime && duration
      ? buildCalendarLink({
          name: event.name,
          description: fields?.description ?? event.description,
          zoomLink,
          dateTime,
          duration
        })
      : ''

  const lines = [`Your event is set up!`, `*${event.name}*`]
  if (participantUrl) lines.push(`• Participant link: ${participantUrl}`)
  if (moderatorUrl) lines.push(`• Moderator link: ${moderatorUrl}`)
  if (zoomLink) lines.push(`• Zoom: ${zoomLink}`)
  if (calendarLink) lines.push(`• Add to Calendar: ${calendarLink}`)
  return lines.join('\n\n')
}

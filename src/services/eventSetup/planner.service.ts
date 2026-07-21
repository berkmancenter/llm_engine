/*
 * The LLM call that powers the agentic event-creation form.
 *
 * When an organizer opens the form they type a free-form description of
 * the event they want to create ("AI ethics roundtable next Thursday at
 * 3pm ET, online via Zoom..."). This service takes that description and
 * asks the LLM to:
 *   - extract every field it can spot (eventName, dateTime, speakers, ...)
 *   - judge whether the description is too vague to interpret confidently
 *   - recommend the next steps the form should walk the organizer through
 *   - decide which form sections obviously do not apply and can be hidden
 *   - suggest feature toggles for the event (transcription, Q&A, ...)
 *
 * The shape of the response is enforced by EventSetupPlanSchema (Zod) so
 * the form receives something it can render directly.
 *
 * If the LLM call fails for any reason (rate limit, malformed output, ...)
 * we fall back to a minimal plan with tooVague=true. The form then shows
 * the organizer clarifying questions instead of erroring out, which is a
 * degraded but still-usable experience.
 *
 * The timezone, ISO-date, and topicName-preservation rules in the prompt
 * have been tuned over many iterations and are load-bearing. Be careful
 * editing them.
 */

import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'
import { getModelChat } from '../../agents/helpers/getModelChat.js'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { EventSetupPlan, EventSetupPlanSchema } from './planSchema.js'
import { ExtractedFields, ExtractedFieldsSchema } from './eventFieldsSchema.js'
import { ParsedInvite } from '../../types/index.types.js'

const SYSTEM_PROMPT = `You help an organizer set up an event in Nextspace. The organizer has written a free-form description of what they already know about the event in a web form. Your job is to (a) extract any structured fields you can, (b) judge whether the description is too vague to interpret confidently, (c) recommend the next steps for the rest of the form, (d) decide which form sections can be skipped entirely, and (e) recommend feature toggles.

Today's date (for resolving relative dates like "tomorrow"): {today}

Extraction rules:
- Extract every field that appears in the description. Leave a field undefined only if it has never been mentioned. Do NOT guess or invent details.
- For dateTime, return ISO 8601 in UTC (always end with Z). Resolve relative dates from "today" above.
- If the organizer mentions a timezone (e.g. "5pm ET", "6:30 Pacific", "14:00 GMT+1"), use that timezone to compute the UTC dateTime, AND set timeZone to the matching IANA name (e.g. America/New_York for ET/Eastern, America/Los_Angeles for PT/Pacific, Europe/London for GMT/BST, etc.). If no timezone is mentioned, leave timeZone undefined.
- duration is in minutes.
- speakers and moderators are arrays of {{name, bio, alternateName?}}. Include a speaker or moderator entry as soon as a name is provided, even if the bio is missing — set bio to an empty string in that case. Capture alternateName only when the organizer gives an explicit alias such as "also goes by", "aka", "nickname", or "stage name"; leave it undefined otherwise.
- topicName must be the EXACT text the organizer typed when naming the topic or series. Do not shorten, paraphrase, drop leading words, normalize casing, or "clean up" the value — preserve it character-for-character (you may trim surrounding whitespace).

Planner-meta rules:
- Set tooVague=true ONLY if the description has no concrete signal at all (e.g. "not sure yet", "an event of some kind", or a single empty greeting). Otherwise tooVague=false.
- confidence reflects how much of the description is structured information vs. handwave. high = several fields extractable plus clear intent; medium = a few fields, some ambiguity; low = mostly vague, one or two extractable hints.
- When tooVague is true, propose 2-4 short clarifying questions in clarifyingQuestions covering the highest-value unknowns (typically: what the event is about, when it is, who it's for, modality).
- Steps recommend the remaining ordered sequence the form should walk through. Each step has a stable key (e.g. "schedule", "speakers", "resources"), a short user-facing prompt, and the field names it covers. Skip steps for fields you've already extracted with confidence. Order steps most-natural-first.

Section-skipping rules — populate skippedSections with sections the form should HIDE because they obviously do not apply:
- Section IDs are exactly: "basic" (event name/series), "when" (date/time), "where" (modality/Zoom link/venue), "who" (speakers), "res" (resources/readings), "feat" (event features).
- Only skip when the description gives you confident evidence. Examples: an online-only event with a Zoom link → DO NOT skip "where" (the Zoom link still lives there), but a one-person solo update may justify skipping "who". A casual social hour may justify skipping "res".
- Each entry: {{ id, label, reason }}. label is the human-readable section name. reason is one short sentence the organizer would understand.
- When unsure, leave the section out of skippedSections — the form will show it. Empty array is the right answer if nothing is obviously skippable.

Feature-decision rules — populate featureDecisions with toggle recommendations:
- Feature IDs are exactly: "transcription" (live event transcript), "backChannel" (moderator-only insights from participant comments), "resourcesChannel" (separate channel for sharing readings), "modAgent" (AI moderator agent), "qaAssistant" (participant Q&A assistant).
- System defaults: qaAssistant ON, transcription OFF, backChannel OFF, resourcesChannel OFF, modAgent OFF.
- Only set byAgent=true when you actively chose a non-default value based on signal in the description. Examples that warrant byAgent=true: a workshop with assigned readings → enable resourcesChannel; a hybrid event with attendees joining remotely → enable transcription; an on-the-record panel → enable transcription. If you have no opinion on a feature, omit it from featureDecisions entirely.
- Each entry: {{ id, label, enabled, reason, byAgent, byDefault }}. byDefault is the system default value for that feature.
- Empty array is the right answer if you have no feature opinions.

Return ONLY valid JSON matching the response schema.`

const USER_PROMPT = `Organizer description:
{description}`

export interface PlanEventSetupInput {
  description: string
  /* Today's date gets baked into the system prompt so the LLM can resolve
     relative dates like "next Thursday". Tests pass a fixed date here so
     they get deterministic prompts; production code leaves it undefined
     and the service uses new Date(). */
  today?: Date
}

/* The form needs SOMETHING back from this service to render — a 500
   would just leave the organizer staring at an empty form. So when the
   LLM call fails we return a minimal valid plan that flags tooVague and
   includes generic clarifying questions. The form treats that the same
   as a description it could not interpret, which is the closest thing
   to a useful degraded experience. */
const fallbackPlan = (): EventSetupPlan => ({
  extracted: {},
  tooVague: true,
  confidence: 'low',
  clarifyingQuestions: [
    'What is the event about?',
    'When does it happen?',
    'Who is it for?',
    'Is it online, in person, or both?'
  ],
  steps: [],
  skippedSections: [],
  featureDecisions: []
})

export const planEventSetup = async ({ description, today = new Date() }: PlanEventSetupInput): Promise<EventSetupPlan> => {
  const llm = await getModelChat(config.classificationLLMPlatform, config.classificationLLMModel)
  try {
    const result = (await getChatPromptResponse(
      llm,
      SYSTEM_PROMPT,
      USER_PROMPT,
      {
        description,
        today: today.toISOString().split('T')[0]
      },
      [],
      EventSetupPlanSchema
    )) as EventSetupPlan
    return result ?? fallbackPlan()
  } catch (err) {
    logger.error(`event-setup planEventSetup failed: ${(err as Error).message}`)
    return fallbackPlan()
  }
}

/*
 * The LLM extraction that runs on an inbound calendar invite (see the plan's email-to-events
 * "One LLM extraction call, not per-field regex"). Unlike planEventSetup above, this only fills in
 * the fields the .ics file's own structured data cannot answer: a Zoom link (other video platforms
 * are ignored), speakers, moderators, and description. Everything else about the event, name, time,
 * and Topic, is already resolved deterministically elsewhere (see emailSetup.service.ts), so this
 * never asks the model to guess dateTime, duration, topicName, timeZone, or eventName, and strips
 * them if it answers anyway.
 */

const INVITE_SYSTEM_PROMPT = `You are a data extraction engine. Parse the three input fields below — **title**, **body**, and **location** — pulled directly from an inbound \`.ics\` calendar file, and return structured event metadata.

**Extract exactly these four fields and no others:** \`zoomLink\`, \`speakers\`, \`moderators\`, \`description\`. Do not populate any other fields. The event's date, time, and topic are already resolved from the \`.ics\` structured fields and must not be derived from this text.

---

**Extraction rules:**

- **\`zoomLink\`** — A Zoom URL only, if present in the location or body. Ignore all other video platforms. Leave undefined if absent.

- **\`speakers\`** and **\`moderators\`** — Each is an array of objects with the shape \`{{ name, bio, alternateName? }}\`.
  - Include an entry for every person mentioned by name, even if no bio is given — set \`bio\` to an empty string in that case.
  - Default any unlabeled person to \`speakers\`. Only place a person in \`moderators\` if the text explicitly identifies them using the word "moderator" or "host."
  - Set \`alternateName\` only when the text provides an explicit alias using language like "also goes by," "aka," or "nickname." Do not infer aliases.

- **\`description\`** — A short summary of what the event is about, drawn from the body text. Leave undefined unless the body contains at least 2–3 sentences of substantive topical content. Do not populate it based solely on logistics such as Zoom links, dial-in numbers, or boilerplate.

- Do not guess or invent any value. If a field is not clearly supported by the text, leave it undefined.

---

Return **only** valid JSON matching the response schema. No explanation, no commentary, no wrapper text.`

const INVITE_USER_PROMPT = `Invite title: {summary}

Invite body: {description}

Invite location: {location}`

export interface PlanEventFromInviteInput {
  invite: ParsedInvite
}

/* A failed extraction should not block event creation: the deterministic fields (name, time,
   Topic) already came from the .ics file, so the worst case here is a draft missing the Zoom
   link, speakers, or description for the organizer to fill in themselves. */
const fallbackExtractedFields = (): ExtractedFields => ({})

/* Keep only the fields this flow actually asked for, even if the model answers with more. See
   the module comment above for why dateTime/duration/topicName/timeZone/eventName must not
   leak through here regardless of what the model returns. */
const pickInviteExtractedFields = ({ zoomLink, speakers, moderators, description }: ExtractedFields): ExtractedFields => ({
  ...(zoomLink !== undefined && { zoomLink }),
  ...(speakers !== undefined && { speakers }),
  ...(moderators !== undefined && { moderators }),
  ...(description !== undefined && { description })
})

export const planEventFromInvite = async ({ invite }: PlanEventFromInviteInput): Promise<ExtractedFields> => {
  const llm = await getModelChat(config.classificationLLMPlatform, config.classificationLLMModel)
  try {
    const result = (await getChatPromptResponse(
      llm,
      INVITE_SYSTEM_PROMPT,
      INVITE_USER_PROMPT,
      {
        summary: invite.summary ?? '(none)',
        description: invite.description ?? '(none)',
        location: invite.location ?? '(none)'
      },
      [],
      ExtractedFieldsSchema
    )) as ExtractedFields
    return result ? pickInviteExtractedFields(result) : fallbackExtractedFields()
  } catch (err) {
    logger.error(`eventSetup planEventFromInvite failed: ${(err as Error).message}`)
    return fallbackExtractedFields()
  }
}

export default { planEventSetup, planEventFromInvite }

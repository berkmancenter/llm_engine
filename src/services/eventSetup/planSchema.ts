/*
 * Defines what the LLM planner is allowed to return when interpreting an
 * organizer's free-form description of an event.
 *
 * The agentic event-creation form sends the description here once, up
 * front, and uses the response to:
 *   - prefill fields the LLM could extract from the description
 *   - hide form sections that obviously do not apply (skippedSections)
 *   - turn on optional features the LLM thinks fit (featureDecisions)
 *   - ask clarifying questions instead of showing the form when the
 *     description is too vague (tooVague + clarifyingQuestions)
 *   - order the remaining steps the form walks through (steps)
 *
 * Using Zod here forces the LLM into structured output. Anything the
 * LLM is not confident about is omitted rather than guessed.
 *
 * The field-extraction half of this schema (ExtractedFieldsSchema) is
 * kept manually in sync with the Conversation model
 * (src/models/conversation.model.ts), which is the canonical event
 * record. When that model gains a new user-supplied field, decide
 * whether the LLM should try to extract it and add it below.
 *
 * If a second Zod consumer ever appears in the codebase (e.g. a Zod
 * port of the conversation Joi validator), pull ExtractedFieldsSchema
 * into a shared eventFieldsSchema module so both consumers can .pick()
 * from it instead of drifting.
 */

import { z } from 'zod'

const speakerSchema = z.object({
  name: z.string(),
  bio: z.string(),
  alternateName: z.string().optional().describe('Nickname or stage name the speaker also goes by')
})

export const ExtractedFieldsSchema = z.object({
  eventName: z.string().optional(),
  dateTime: z.string().optional().describe('ISO 8601 datetime string'),
  duration: z.number().optional().describe('Duration in minutes'),
  description: z.string().optional(),
  zoomLink: z.string().optional(),
  topicName: z.string().optional(),
  speakers: z.array(speakerSchema).optional(),
  moderators: z.array(speakerSchema).optional(),
  timeZone: z
    .string()
    .optional()
    .describe(
      'IANA timezone (e.g. America/New_York) inferred from any timezone the organizer mentioned, like ET, Eastern, PST, or GMT+1'
    )
})

export const StepHintSchema = z.object({
  key: z.string().describe('Stable identifier for the step, e.g. "schedule", "speakers", "resources"'),
  prompt: z.string().describe('User-facing prompt or question for this step'),
  fields: z.array(z.string()).describe('Names of the fields this step asks the organizer to fill')
})

/* The set of form sections the LLM is allowed to hide. These IDs are
   the same keys the form uses to render section groups, so the LLM
   cannot make up a section that the UI does not know how to handle. */
const SKIPPABLE_SECTION_IDS = ['basic', 'when', 'where', 'who', 'res', 'feat'] as const

export const SkippedSectionSchema = z.object({
  id: z.enum(SKIPPABLE_SECTION_IDS).describe('Section identifier matching the form\'s section renderer keys'),
  label: z.string().describe('Human-readable section name (e.g. "Speakers", "Resources")'),
  reason: z.string().describe('Brief plain-language explanation of why this section was hidden')
})

/* The event features the LLM is allowed to recommend turning on or off.
   Held as a fixed enum so the LLM cannot suggest a feature the UI does
   not actually render a toggle for. */
const FEATURE_IDS = ['transcription', 'backChannel', 'resourcesChannel', 'modAgent', 'qaAssistant'] as const

export const FeatureDecisionSchema = z.object({
  id: z.enum(FEATURE_IDS).describe('Feature identifier'),
  label: z.string().describe('Human-readable feature name'),
  enabled: z.boolean().describe('Whether the feature should be on for this event'),
  reason: z.string().describe('Brief plain-language explanation of the choice'),
  byAgent: z
    .boolean()
    .describe('True if Mason actively chose this value; false if it matches the default and Mason did not weigh in'),
  byDefault: z.boolean().describe('What this feature would be if Mason did nothing — the system default')
})

export const EventSetupPlanSchema = z.object({
  extracted: ExtractedFieldsSchema.describe('Fields plausibly inferable from the description, omitted if unknown'),
  tooVague: z
    .boolean()
    .describe(
      'True if the description does not contain enough signal to interpret confidently — e.g. "not sure yet", a single-sentence vague intent'
    ),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('Overall interpretation confidence — informs whether the form falls back to clarifying questions'),
  clarifyingQuestions: z
    .array(z.string())
    .optional()
    .describe('When tooVague is true, 2-4 short questions to ask the organizer next'),
  steps: z
    .array(StepHintSchema)
    .describe('Recommended ordered sequence of steps for the rest of the form, with per-step copy hints'),
  skippedSections: z
    .array(SkippedSectionSchema)
    .describe(
      'Sections the form should hide because they do not apply to this event (e.g. skip "where" for online-only). Empty array if nothing to skip.'
    ),
  featureDecisions: z
    .array(FeatureDecisionSchema)
    .describe(
      'Feature toggles Mason has an opinion about for this event. Sparse: include ONLY features where Mason actively chose a value based on signal in the description. Absent features mean Mason had no opinion and the system default applies. Empty array is fine.'
    )
})

export type EventSetupPlan = z.infer<typeof EventSetupPlanSchema>
export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>
export type Speaker = z.infer<typeof speakerSchema>
export type SkippedSection = z.infer<typeof SkippedSectionSchema>
export type FeatureDecision = z.infer<typeof FeatureDecisionSchema>

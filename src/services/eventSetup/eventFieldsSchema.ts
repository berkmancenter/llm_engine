/*
 * The field-extraction schema shared by every LLM consumer that pulls
 * structured event fields out of free-form text.
 *
 * Two consumers use it today:
 *   - the Slack/web event planner (planSchema.ts), which embeds
 *     ExtractedFieldsSchema in its larger EventSetupPlanSchema
 *   - the email-invite flow, which extends it via InviteExtractedFieldsSchema
 *     to also carry the Topic an inbound invite was matched to
 *
 * ExtractedFieldsSchema is kept manually in sync with the Conversation
 * model (src/models/conversation.model.ts), the canonical event record.
 * When that model gains a new user-supplied field, decide whether the LLM
 * should try to extract it and add it here so both consumers pick it up
 * at once instead of drifting apart.
 *
 * Using Zod forces the LLM into structured output. Anything the LLM is
 * not confident about is omitted rather than guessed.
 */

import { z } from 'zod'

export const speakerSchema = z.object({
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

/* The invite flow's variant: the same fields the planner extracts, plus
   the Topic an inbound calendar invite was matched to (null when no
   existing Topic fit and a new one should be created). */
export const InviteExtractedFieldsSchema = ExtractedFieldsSchema.extend({
  matchedTopicId: z.string().nullable()
})

export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>
export type InviteExtractedFields = z.infer<typeof InviteExtractedFieldsSchema>
export type Speaker = z.infer<typeof speakerSchema>

import { z } from 'zod'
import { traceable } from 'langsmith/traceable'
import logger from '../../config/logger.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'

/*
 * The second half of the Chatham House check, covering what the deterministic one cannot.
 *
 * quoteSafety.ts matches an exact list: the pseudonyms, reserved real names, presenters and
 * moderators this conversation knows. That list is precise and free, and it is the backstop
 * — but it is closed. A name the system never recorded ("my colleague Dana"), or an
 * affiliation that identifies someone in a small room ("the chair of the registry working
 * group"), passes it untouched, because no pattern distinguishes a person's name from any
 * other capitalised phrase.
 *
 * Judging that needs world knowledge and context, so this pass asks a model. It is
 * deliberately narrow: one batched call, one question, over only the text that already
 * survived the exact checks. And it fails closed — a screen that errors or answers
 * unusably drops every candidate rather than letting the batch through, because the cost of
 * a false positive is one missing sentence and the cost of a false negative is a named
 * participant in a document that cannot be unpublished.
 */

const SCREEN_SCHEMA = z.object({
  flagged: z
    .array(
      z.object({
        index: z.number().describe('The [n] index of the offending line.'),
        reason: z.string().describe('Briefly, what identifies someone.')
      })
    )
    .describe('Every line that reveals an identity or affiliation. Empty when all lines are clean.')
})

const SCREEN_PROMPT = `
You are checking text extracted from a private event held under the Chatham House Rule
before it is published to people who were not in the room. What was said may be used freely;
the identity and the affiliation of anyone who took part may not be revealed.

You will be given numbered lines. Flag the index of every line that does any of these:
- names a person who took part in the event, under any name, pseudonym or initials
- gives someone's affiliation, employer, job title or role, including an indirect
  description that would identify one person to others who were there
- names any other private individual, such as someone's colleague, client or family member
- contains an email address, phone number, street address, social handle or URL

Do NOT flag a line merely because it mentions a genuinely well-known public figure or cites
a published source — a widely read author, a standards body's published position, a widely
reported statement. The test is whether an ordinary member of the public would recognise the
name, not whether it is known within the field. Nobody who took part in this private event
qualifies, however they are described.

Do NOT flag a line for being about people in general ("participants disagreed about trust"),
for naming an organisation that is not being used to identify a person, or for describing a
role in the abstract ("issuers must rotate keys").

Return only the flagged indexes. If every line is clean, return an empty list.
`.trim()

/**
 * Screens candidate texts for anything that would breach the rule.
 *
 * @param llm Chat model to screen with.
 * @param texts Candidate lines, already past the exact-match checks.
 * @param conversationId For cost attribution on the trace.
 * @returns Indexes of `texts` that must not be published.
 */
export const screenForIdentities = async (llm, texts: string[], conversationId?: string): Promise<Set<number>> => {
  if (texts.length === 0) return new Set()

  const numbered = texts.map((text, i) => `[${i}] ${text}`).join('\n')

  try {
    const result = (await traceable(
      async () =>
        getChatPromptResponse(llm, SCREEN_PROMPT, 'Lines to check:\n\n{numbered}', { numbered }, undefined, SCREEN_SCHEMA),
      { name: 'conceptGraphIdentityScreen', metadata: { conversationId, costPhase: 'postEvent' as const } }
    )()) as z.infer<typeof SCREEN_SCHEMA>

    const flagged = new Set<number>()
    for (const entry of result?.flagged ?? []) {
      if (Number.isInteger(entry?.index) && entry.index >= 0 && entry.index < texts.length) {
        flagged.add(entry.index)
        logger.debug(`conceptGraph: identity screen flagged line ${entry.index}: ${entry.reason}`)
      }
    }
    return flagged
  } catch (error) {
    /* Fail closed. An unavailable or malformed screen is not evidence the text is clean, and
       this is the only check that can catch an unrecorded name — so the batch is dropped and
       the graph keeps its structure without the prose. */
    logger.warn(
      `conceptGraph: identity screen failed for ${conversationId}, dropping all ${texts.length} candidates: ${error}`
    )
    return new Set(texts.map((_, i) => i))
  }
}

export default { screenForIdentities }

import { z } from 'zod'
import { getChatPromptResponse } from './llmChain.js'
import { SocraticSlots } from './socraticSlots.js'

const QuestionSchema = z.object({
  question: z.string().describe('The single question to post in the group chat, ending in one question mark.')
})

const SYSTEM_PROMPT = `You write one Socratic question for a group chat. You have NOT read the source; you only know its name and one term from it. That is deliberate: ask how the source treats the term, never say what it concluded.

## Rules
- Exactly one question, one sentence, at most 35 words, ending in a single question mark. No statement before it.
- Name the source in the question, using the source name you are given.
- Anchor on the given concept. If a loaded word is given, put it in double quotes in the question exactly as written.
- Ask what the source says or how it treats the idea, and whether that fits what the group is describing. Do not guess, state, or hint at any result, number, trend, or outcome.
- Do not name participants. Do not invent analogies, hypotheticals, or examples.
- Do not repeat or reword the facilitator's recent posts.
- Genuine curiosity, never a quiz or a gotcha.

## Good examples
- In Ostrom's 'Governing the Commons', what part does monitoring play in whether trust holds up, and where would that show up in what we're describing?
- How does Gillespie's reading treat the idea that moderation can be neutral, and does that match how we're using the word?
- When you say 'legitimacy', is that closer to how the procedural fairness reading defines it, or to something else?
- When we call the rules "fair", would Tyler's 'Why People Obey the Law' mean the same thing by that word, or something narrower?

## Never do this
- Lee found trust fell by a third once monitoring was removed, so why are we assuming it holds? (states a finding, then asks)

## Output Format
{{
  "question": "the single question"
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const USER_PROMPT = `Source name: {sourceLabel}
Concept: {concept}
Loaded word: {loadedWord}

Recent chat from participants:
{chatLines}

Your recent posts (do not repeat these):
{recentPosts}
{rejected}
Write the question.`

export interface RejectedDraft {
  draft: string
  reasons: string[]
}

export interface SocraticWriterInput {
  slots: SocraticSlots
  humanChatLines: string[]
  recentPosts: string[]
  rejected?: RejectedDraft[]
}

/**
 * Writes the question from slots and chat only. The reading passage is intentionally not an input:
 * a writer that was never shown a finding cannot leak one.
 */
export default async function writeSocraticQuestion(llm, input: SocraticWriterInput): Promise<string> {
  const rejected = (input.rejected ?? [])
    .map((r) => `\nA previous draft was rejected: "${r.draft}"\nFix: ${r.reasons.join('; ')}.`)
    .join('')
  const result = (await getChatPromptResponse(
    llm,
    SYSTEM_PROMPT,
    USER_PROMPT,
    {
      sourceLabel: input.slots.sourceLabel,
      concept: input.slots.concept,
      loadedWord: input.slots.loadedWord ?? '(none)',
      chatLines: input.humanChatLines.map((l) => `- ${l}`).join('\n') || '(none)',
      recentPosts: input.recentPosts.map((p) => `- ${p}`).join('\n') || '(none)',
      rejected: rejected ? `${rejected}\n` : ''
    },
    [],
    QuestionSchema
  )) as z.infer<typeof QuestionSchema>
  return result.question.trim()
}

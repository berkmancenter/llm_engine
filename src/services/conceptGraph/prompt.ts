/*
 * The extraction prompt, and the shape the model must answer in.
 *
 * The governing rule is the Chatham House Rule, which these events run under: what was said
 * may be used freely, but neither the identity nor the affiliation of any speaker or
 * participant may be revealed. That is the actual standard the output has to meet, and
 * naming it in the prompt does more work than any list of prohibitions would — it is a rule
 * the model already understands, and it covers cases an enumerated list misses, affiliation
 * being the one people forget.
 *
 * Two further things about this prompt are load-bearing rather than stylistic:
 *
 * It asks for concept *labels* everywhere a reference is needed, never ids. Models hold a
 * label they just wrote far more reliably than an opaque id across a long generation, and
 * assembleGraph turns labels into ids afterwards — so referential integrity comes out of
 * the assembly step by construction instead of depending on the model getting it right.
 *
 * It states the quoting rule in the same terms quoteSafety.ts enforces, so the common case
 * is the model complying and the checker agreeing, rather than the checker deleting work
 * the prompt invited.
 */
import { z } from 'zod'

const SOURCE_REFS = z
  .array(z.string())
  .optional()
  .describe('The [m#] tags of the lines this came from, copied exactly, e.g. ["m12", "m13"].')

export const EXTRACTION_SCHEMA = z.object({
  concepts: z
    .array(
      z.object({
        label: z.string().describe('Short noun phrase naming the idea, 1-4 words, as a participant would say it.'),
        gloss: z.string().optional().describe('One plain sentence saying what this concept means in this discussion.'),
        sourceRefs: SOURCE_REFS
      })
    )
    .describe('The distinct ideas the discussion actually turned on. Prefer fewer, well-chosen concepts over many.'),
  contributions: z
    .array(
      z.object({
        kind: z
          .string()
          .describe('The relationship in 1-3 words, as a label on a node: "anchors", "issued by", "co-governs".'),
        concepts: z
          .array(z.string())
          .describe(
            'Labels of the concepts this relationship joins, copied exactly. Two or more where the discussion related that many at once.'
          ),
        statement: z
          .string()
          .describe(
            'One sentence saying what was actually argued about this relationship. Paraphrase; see the quoting rule.'
          ),
        originPrompt: z
          .string()
          .optional()
          .describe('Text of the prompt this came out of, copied exactly, when one applies.'),
        sourceRefs: SOURCE_REFS
      })
    )
    .describe('How the discussion related those concepts to each other.'),
  originPrompts: z
    .array(
      z.object({
        text: z.string().describe('The question or prompt, lightly cleaned up.'),
        sourceRefs: SOURCE_REFS
      })
    )
    .describe('The questions or prompts the discussion was organised around.')
})

export const EXTRACTION_PROMPT = `
You are reading the record of a private event — a transcript of what was said, plus the
participants' group chat — and building a concept map of what the discussion turned on.

THE EVENT RAN UNDER THE CHATHAM HOUSE RULE. What was said may be used freely. The identity
and the affiliation of everyone who took part may not be revealed. Your output is read by
people who were not in the room, so the rule is on you, absolutely, and it outranks every
other instruction here.

That means:
- Never name anyone who took part, under any name, pseudonym or initials.
- Never give anyone's affiliation, employer, job title or role — not "someone from a
  standards body", not "the registry working group's chair". Affiliation identifies people
  as surely as a name does, in a room this size.
- Never write "one participant said" or "a speaker argued". Write what was argued, not who
  argued it: "A trust registry only means something if verifiers check it."
- Never include an email address, phone number, street address, social handle or URL.
- Never name any other private individual the discussion happened to mention — someone's
  colleague, client or family member is private too.

THE ONE EXCEPTION is a genuinely well-known public figure or a cited source: a published
author, a standards body's published position, a widely reported statement the discussion
referenced. The test is whether an ordinary member of the public would recognise the name or
the position — not whether it is well known within this field. Nobody who took part in this
event qualifies, however senior they are or however they introduced themselves. If you are
at all unsure, leave the name out and describe the position instead.

CONCEPTS THE SERIES HAS ALREADY ESTABLISHED are listed for you below the instructions. They
come from earlier events in this same series.

- Where this discussion touches one of them, reuse that label EXACTLY as written. That is
  what connects this event to the rest of the series; a near-miss spelling silently creates a
  second node for one idea.
- A contribution may join an established concept to a new one. Those crossings are the most
  valuable thing you can produce here, because they are what turns a pile of separate events
  into one map.
- Do NOT force a fit. If an idea is genuinely new, coin a new label for it. A list of
  established concepts is a vocabulary offered to you, not a set of boxes to sort into, and an
  event that introduces nothing new is a rare thing.

Produce three things:

1. CONCEPTS. The distinct ideas the discussion actually turned on. Name each as a short noun
   phrase a participant would recognise. Merge synonyms into one concept rather than listing
   both. Be selective: a map of fifteen well-chosen concepts is far more useful than one of
   sixty. Do not create a concept for a person, an organisation, or the event itself.

2. CONTRIBUTIONS. How the discussion related those concepts. Each one names the concepts it
   joins, by copying their labels exactly as you wrote them above. A contribution may join
   more than two concepts when the discussion related that many at once — prefer one
   three-way contribution over three pairwise ones where that is what was actually said.
   Each carries a short "kind" label and one sentence saying what was argued.

3. ORIGIN PROMPTS. The questions or prompts the discussion was organised around — a posed
   question, a set exercise. Attach one to a contribution when that contribution came out of
   it. State the question, never who asked it.

THE QUOTING RULE:
- Paraphrase by default. Your sentence should be your own wording, not the transcript's.
- You may quote verbatim when the exact words matter, but only inside quotation marks, and
  only when the quoted words name nobody and carry no affiliation or other identifying
  detail.
- If the words you want to quote identify anyone, do not quote them. Rephrase instead.
- Anything you lift word-for-word without quotation marks will be discarded.

Every line of the record is tagged [m1], [m2] and so on. Cite the tags a concept or
contribution came from in its sourceRefs, copying them exactly. They are how a reader gets
back to the moment in the record; they are not part of any sentence you write, so never put
a tag inside a label, statement or prompt.

Write about what the room worked out, not about the event's format or how it went.
`.trim()

export default { EXTRACTION_PROMPT, EXTRACTION_SCHEMA }

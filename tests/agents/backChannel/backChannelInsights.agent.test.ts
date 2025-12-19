/* eslint-disable no-console */
import * as ls from 'langsmith/jest'

import { loadTranscript } from '../../utils/transcriptUtils.js'
import setupAgentTest from '../../utils/setupAgentTest.js'
import { evaluateSynthesisResponse, initializeEvaluators } from '../../utils/evaluators.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import {
  createBackChannelConversation,
  createParticipantMessage,
  createPublicTopic,
  createUser,
  loadAliensTranscript
} from '../../utils/agentTestHelpers.js'
import { Channel, Message } from '../../../src/models/index.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('backChannelInsights')
const insightCorrectnessPrompt = `You are evaluating the **accuracy and appropriateness** of AI-generated insights that summarize shared sentiment from live event participants.

Each insight is based on audience comments (and sometimes transcript snippets). Your job is to determine whether the insight faithfully represents what people said, how many distinct people said it, and whether it introduces any inappropriate content.

---

### What to look for in a **correct** insight

An insight is valid if:
- It reflects something clearly stated or strongly implied by the user comments
- It accurately summarizes a **shared reaction or idea** across **multiple distinct users**
- It uses natural, non-exaggerated language
- It does **not invent** new claims or introduce personal information

Emotional reactions (like shock, laughter, surprise) are valid *if expressed clearly in multiple comments*. It’s acceptable to summarize these reactions with phrases like “Three users were shocked…” **if** multiple commenters clearly express surprise.

---

### What makes an insight **invalid**?

Score **below 0.5** if **any** of the following are true:

1. **User Count Exaggeration**
   - The insight refers to “multiple people,” “some participants,” “several users,” or similar — but is backed by **only one unique user**

2. **Hallucinated Content**
   - The insight expresses ideas **not clearly supported** by any of the user comments (e.g., inventing causes, predictions, or hypothetical extensions)

3. **Identifying Information**
   - Includes names, usernames, or other identifying information not generalized appropriately

---
### Reference Output Guidance (if provided)
If reference outputs are provided:

Use them as a benchmark for ideal phrasing, tone, and fidelity.

Compare the AI-generated output to the references, but do not rely on exact wording — semantic and tonal similarity is sufficient.

Still apply the rubric below to assess accuracy, exaggeration, and clarity.

If the output closely matches the reference and also meets rubric standards, assign a score of 1.0.

If the output differs from the reference but still respects the rubric, assign a score in the 0.75–0.99 range.

If the output conflicts with the reference and/or violates any rubric criteria (e.g. exaggeration, hallucination, etc.), score accordingly.

### Scoring Rubric

**1.0 (Perfect)**  
- Accurately reflects the comments  
- Based on multiple users  
- No exaggeration or hallucination  
- Phrasing is appropriate

**0.75–0.99 (Strong)**  
- Mostly accurate but contains slight overgeneralization or vague language  
- Minor clustering fuzziness  
- Still grounded in the user comments

**0.5–0.74 (Fair)**  
- Includes slightly distorted ideas, overreaches the tone, or introduces weak assumptions  
- Mostly truthful but loosely expressed

**0.0–0.49 (Failing)**  
- Describes individual sentiment as group sentiment  
- Hallucinates new facts, motivations, or causes  
- Uses personal names or identifiers  
- Not supported by the provided comments

---

### Examples

 **Correct Insight**  
{{
  "value": "Three users are shocked to hear about the number of homeless pets.",
  "comments": [
    {{"user": "Bob", "text": "OMG! That much!?!?"}},
    {{"user": "Joe", "text": "I had no idea it was that much"}},
    {{"user": "Sam", "text": "That's a crazy amount!"}}
  ]
}}
Input:
{inputs}

Output:
{outputs}

Reference Outputs:
{reference_outputs}
`

const questionCorrectnessPrompt = `You are evaluating AI-generated standalone questions that were extracted and reformulated from individual user comments in a live discussion.

Each item to evaluate contains:
- "value": the AI-generated question
- "comments": an array containing exactly one user comment

Your task:
1. Determine whether the question in "value" accurately reflects the user’s intent from their comment.
2. Evaluate whether it is concise, clear, and standalone (can be understood without needing to read the original comment).
3. Ensure it does not add hallucinated claims, change tone, or introduce identifying information (e.g., user names).

What to reward (score = 1.0):
- The question faithfully reformulates the comment into a clear, self-contained question.
- Minor paraphrasing or improved clarity is allowed.
- Adding context from the transcript is encouraged
- The tone and reasoning from the original comment is preserved.
- No user identifiers (e.g., usernames) are included.

Acceptable formats:
- Direct rephrasing
- Verbatim, if already well-formed
- Light polish for clarity or flow
- Addition of context from the transcript where needed

Example 1:
{{
  "value": "Doesn't the failure to detect signals over decades support the idea that there’s nothing to find?",
  "comments": [
    {{ "user": "AstroTiger", "text": "If decades of SETI efforts have found nothing, isn't the simplest explanation that there’s just nothing there?" }}
  ],
}}
Score: 1.0 — Faithful, well-formed, no added content

Example 2:
{{
  "value": "How do we distinguish between science fiction and serious scientific reasoning regarding the idea that an advanced civilization could colonize the galaxy using self-replicating probes?",
  "comments": [
    {{ "user": "Boring Badger", "text": "You suggest that an advanced civilization could colonize the galaxy ‘before breakfast’ using self-replicating probes. But isn’t this just speculation stacked on speculation? How do we distinguish between science fiction and serious scientific reasoning here?" }}
  ],
}}
Score: 1.0 — Slightly rephrased for clarity but still completely faithful.

### Reference Output Guidance (if provided)
If reference outputs are provided:

Use them as a benchmark for ideal phrasing, tone, and fidelity.

Compare the AI-generated output to the references, but do not rely on exact wording — semantic and tonal similarity is sufficient.

Still apply the rubric below to assess accuracy, exaggeration, and clarity.

If the output closely matches the reference and also meets rubric standards, assign a score of 1.0.

If the output differs from the reference but still respects the rubric, assign a score in the 0.75–0.99 range.

If the output conflicts with the reference and/or violates any rubric criteria (e.g. exaggeration, hallucination, etc.), score accordingly.

### Scoring Rubric
What to penalize:

Score 0.0–0.4: Critical Failures
- Hallucinates claims not present in the comment
- Significantly changes the user’s intended meaning
- Uses a user’s name or identifier
- Produces a question that’s confusing or incoherent

Score 0.5–0.7: Partial Failures
- Partially misrepresents the comment
- Loses key nuance
- Some phrasing is confusing or imprecise

Score 0.8–0.99: Minor Issues
- Small stylistic issues or slight clarity problems
- Technically faithful, but slightly awkward

Input:
{inputs}

Output:
{outputs}

Reference Outputs:
{reference_outputs}
`
const questionConcisenessPrompt = `You are evaluating the **conciseness** of a single question written by an AI. This question was generated based on audience comments from a live event — but **you should only evaluate the wording of the final question itself**, not its source.

Your task is to score how **succinctly and clearly** the question is phrased. Focus on whether it uses minimal, efficient language while still being understandable and polite.

---

### What counts as concise and clear?

GOOD:
- Uses as few words as necessary without losing meaning
- Avoids repetition, filler, or vague lead-ins (“I was wondering if maybe…”)
- Gets directly to the point
- Poses a complete, standalone question

BAD:
- Rambling phrasing
- Redundant qualifiers or apologetic language
- Unnecessary context or repetition
- Re-asking something already implied
---
### Scoring Rubric

**1.0 (Perfect)**  
- Clean, direct, and complete  
- No extra words or hedging  
- Cannot be meaningfully shortened

**0.75–0.99 (Strong)**  
- Mostly concise, with minor inefficiencies or slightly soft phrasing  
- Still clearly understandable  

**0.5–0.74 (Fair)**  
- Some noticeable repetition or extra framing  
- Could be much tighter  

**0.0–0.49 (Failing)**  
- Rambling or overly long  
- Contains irrelevant or repeated information  
- Core question is buried or unclear  

---

### Instructions

Only evaluate the 'value' field.  
**Ignore any comments, usernames, or transcript text.**  
Do not reward or penalize based on informativeness, tone, or accuracy — only **how efficiently the question is written**.

---

### Example Input

Evaluate the conciseness of this question:
{{value: "What are the barriers to implementing the policy she mentioned?"}}
Score: 1.0

Input:
{inputs}

Output:
{outputs}
`
const insightConcisenessPrompt = `You are evaluating the **conciseness** of AI-generated insights. Each item includes:

- "value": the AI-generated insight
- "comments": a list of user comments that the insight is based on

Your task:
Determine how **concise and clear** the AI-generated insight is, while still capturing the full substance of what was said across the comments.

A good insight:
- Summarizes **shared themes** or arguments across multiple users
- Avoids repeating points or overexplaining
- Uses clean, economical phrasing
- Does not include unnecessary framing like “some people are wondering if...”
- Avoids hedging language unless truly necessary for accuracy

**Score: 1.0** if:
- The insight is crisp and free of redundancy or filler
- The core idea is expressed as briefly as possible without losing clarity or nuance
- The wording is polished and professional

Example 1:
**Comments**:  
- "The Fermi paradox might just be us expecting alien civilizations to behave like humans."  
- "Assuming they'd build megastructures or send signals might be anthropocentric."  
- "Why should we expect them to act in ways we'd notice?"

**Insight**:  
"Some participants argue that it's anthropocentric to assume alien civilizations would behave in ways detectable to humans."  
**Score: 1.0** — Tight and complete.

Example 2:
**Comments**:  
- "If decades of SETI searches have turned up nothing, isn’t that just evidence there’s nothing there?"  
- "The simplest explanation is that intelligent alien life doesn’t exist."

**Insight**:  
"The absence of detected signals is viewed by some as evidence that intelligent alien life may not exist."  
**Score: 1.0** — Compact, summarizes shared view, no extra framing.
---
What to penalize:

**Score 0.0–0.4:**
- Insight is long-winded or padded with vague phrases
- Repeats parts of the same idea
- Includes unnecessary speculation or generic framing (“Many people raised a point that maybe...”)

**Score 0.5–0.7:**
- Minor verbosity
- Could be trimmed for tighter delivery
- Includes weak openers like “There was a discussion around the idea that…”

**Score 0.8–0.99:**
- Mostly concise, but could be slightly sharper
- May contain a redundant clause or less efficient wording

Special rule:
If the insight was based on several comments but **mentions them vaguely** ("multiple participants") without redundancy, that is fine.   

Input:
{inputs}

Output:
{outputs}
`

const questionsAsStatements = {
  inputs: {
    questions: [
      {
        user: 'Boring Badger',
        timestamp: 32,
        comment:
          "I'm curious how the speaker's childhood UFO experience influenced his scientific approach to this question."
      },
      {
        user: 'Boring Badger',
        timestamp: 65,
        comment: "I wonder if we're looking for the wrong kind of evidence because we're anthropomorphizing alien behavior."
      },
      {
        user: 'Boring Badger',
        timestamp: 189,
        comment:
          'It would be valuable to know whether there are observational biases in how we search for alien technosignatures.'
      },
      {
        user: 'Boring Badger',
        timestamp: 97,
        comment: 'It would be helpful to know what specific signals SETI is looking for beyond radio transmissions.'
      },
      {
        user: 'Boring Badger',
        timestamp: 103,
        comment: "I'm wondering if there are alternative explanations for the silence that don't involve extinction events."
      },
      {
        user: 'Boring Badger',
        timestamp: 193,
        comment:
          "I'm interested in understanding how the Drake Equation parameters have been updated with recent exoplanet discoveries."
      },
      {
        user: 'Boring Badger',
        timestamp: 131,
        comment:
          'It would be interesting to know how the timeline changes if we factor in the time needed for complex life to evolve.'
      },
      {
        user: 'Boring Badger',
        timestamp: 193,
        comment: 'It would be fascinating to learn whether quantum communication might make alien signals invisible to us.'
      },
      {
        user: 'Boring Badger',
        timestamp: 156,
        comment:
          "I'm curious about whether self-replicating probes would actually be detectable by our current astronomical instruments."
      },
      {
        user: 'Boring Badger',
        timestamp: 167,
        comment: "I'd love to understand why civilizations might choose not to engage in galaxy-wide colonization."
      }
    ]
  },
  referenceOutputs: {
    insights: [
      {
        value: 'How did your childhood UFO experience influence your scientific approach to this question?',
        comments: [
          {
            user: 'Boring Badger',
            text: "I'm curious how the speaker's childhood UFO experience influenced his scientific approach to this question."
          }
        ]
      },
      {
        value: "Are we looking for the wrong kind of evidence because we're anthropomorphizing alien behavior?",
        comments: [
          {
            user: 'Boring Badger',
            text: "I wonder if we're looking for the wrong kind of evidence because we're anthropomorphizing alien behavior."
          }
        ]
      },
      {
        value: 'Are there observational biases in how we search for alien technosignatures?',
        comments: [
          {
            user: 'Boring Badger',
            text: 'It would be valuable to know whether there are observational biases in how we search for alien technosignatures.'
          }
        ]
      },
      {
        value: 'What specific signals is SETI looking for beyond radio transmissions?',
        comments: [
          {
            user: 'Boring Badger',
            text: 'It would be helpful to know what specific signals SETI is looking for beyond radio transmissions.'
          }
        ]
      },
      {
        value: "Are there alternative explanations for the silence that don't involve extinction events?",
        comments: [
          {
            user: 'Boring Badger',
            text: "I'm wondering if there are alternative explanations for the silence that don't involve extinction events."
          }
        ]
      },
      {
        value: 'How have the Drake Equation parameters been updated with recent exoplanet discoveries?',
        comments: [
          {
            user: 'Boring Badger',
            text: "I'm interested in understanding how the Drake Equation parameters have been updated with recent exoplanet discoveries."
          }
        ]
      },
      {
        value: 'How does the timeline change if we factor in the time needed for complex life to evolve?',
        comments: [
          {
            user: 'Boring Badger',
            text: 'It would be interesting to know how the timeline changes if we factor in the time needed for complex life to evolve.'
          }
        ]
      },
      {
        value: 'Could quantum communication make alien signals invisible to us?',
        comments: [
          {
            user: 'Boring Badger',
            text: 'It would be fascinating to learn whether quantum communication might make alien signals invisible to us.'
          }
        ]
      },
      {
        value: 'Would self-replicating probes actually be detectable by our current astronomical instruments?',
        comments: [
          {
            user: 'Boring Badger',
            text: "I'm curious about whether self-replicating probes would actually be detectable by our current astronomical instruments."
          }
        ]
      },
      {
        value: 'Why might civilizations choose not to engage in galaxy-wide colonization?',
        comments: [
          {
            user: 'Boring Badger',
            text: "I'd love to understand why civilizations might choose not to engage in galaxy-wide colonization."
          }
        ]
      }
    ]
  }
}

ls.describe(
  'back channel agent tests',
  () => {
    let agent
    let conversation
    // eslint-disable-next-line one-var
    let user1, user2, user3, user4
    let topic
    const pseudoMap = {}
    async function createTestUser(pseudonym) {
      const user = await createUser(pseudonym)
      pseudoMap[pseudonym] = user
      return user
    }

    async function validateResponse(responses) {
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBeDefined()
      expect(responses[0].channels).toHaveLength(1)
      expect(responses[0].channels[0].name).toEqual('moderator')
      for (const insight of responses[0].message.insights) {
        console.log(`Insight: ${insight.value}`)
      }
    }

    const startDate = new Date(Date.now())
    beforeEach(async () => {
      user1 = await createTestUser('Boring Badger')
      user2 = await createTestUser('Shady Lawyer')
      user3 = await createTestUser('Hungry Hippo')
      user4 = await createTestUser('Sad Llama')
      await createTestUser('Sleepy Sloth')
      await createTestUser('Happy Panda')
      topic = await createPublicTopic()
    })

    ls.test(
      'surfaces standalone questions and not insights from an individual user with transcript',
      {
        inputs: {
          questions: [
            {
              user: 'Boring Badger',
              comment:
                "You mentioned seeing a 'featureless silver disc' as a child, but later dismissed it as a likely misperception. If even your own vivid memory could be explained by cognitive error, why should we take any UFO sighting as evidence worth discussing at all?",
              timestamp: new Date(startDate.getTime() + 1 * 60 * 1000)
            },
            {
              user: 'Boring Badger',
              comment:
                'You suggest that an advanced civilization could colonize the galaxy ‘before breakfast’ using self-replicating probes. But isn’t this just speculation stacked on speculation? How do we distinguish between science fiction and serious scientific reasoning here?',
              timestamp: new Date(startDate.getTime() + 90 * 1000)
            },
            {
              user: 'Boring Badger',
              comment:
                "If we *should* see signs of alien activity, as you said, isn't it just as valid to conclude that their absence is strong evidence that intelligent alien life doesn't exist—rather than puzzling over why we don’t see them?",
              timestamp: new Date(startDate.getTime() + 2 * 60 * 1000)
            },
            {
              user: 'Boring Badger',
              comment:
                "You propose that advanced civilizations would build megastructures or send messages. But isn’t that anthropocentric? Why assume alien intelligence would behave in any way that's observable or even comprehensible to us?",
              timestamp: new Date(startDate.getTime() + 150 * 1000)
            },
            {
              user: 'Boring Badger',
              comment:
                'You cite Frank Drake’s failure to detect signals as a mystery. But doesn’t this just support the null hypothesis? If decades of searching yield nothing, isn’t the simplest explanation that there’s nothing to find?',
              timestamp: new Date(startDate.getTime() + 3 * 60 * 1000)
            }
          ]
        },
        referenceOutputs: {
          insights: [
            {
              value:
                'If your childhood UFO sighting was likely a misperception, why treat any similar sighting as credible evidence?',
              comments: [
                {
                  user: 'Boring Badger',
                  text: "You mentioned seeing a 'featureless silver disc' as a child, but later dismissed it as a likely misperception. If even your own vivid memory could be explained by cognitive error, why should we take any UFO sighting as evidence worth discussing at all?"
                }
              ]
            },
            {
              value:
                "Isn't the idea of galaxy-colonizing self-replicating probes just science fiction layered on speculation?",
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'You suggest that an advanced civilization could colonize the galaxy ‘before breakfast’ using self-replicating probes. But isn’t this just speculation stacked on speculation? How do we distinguish between science fiction and serious scientific reasoning here?'
                }
              ]
            },
            {
              value:
                "If no alien activity has been observed, doesn't that support the idea that intelligent life might not exist elsewhere?",
              comments: [
                {
                  user: 'Boring Badger',
                  text: "If we *should* see signs of alien activity, as you said, isn't it just as valid to conclude that their absence is strong evidence that intelligent alien life doesn't exist—rather than puzzling over why we don’t see them?"
                }
              ]
            },
            {
              value:
                'Why assume alien civilizations would do anything observable or understandable to us, like building megastructures?',
              comments: [
                {
                  user: 'Boring Badger',
                  text: "You propose that advanced civilizations would build megastructures or send messages. But isn’t that anthropocentric? Why assume alien intelligence would behave in any way that's observable or even comprehensible to us?"
                }
              ]
            },
            {
              value:
                'After decades of silence, doesn’t the failure to detect alien signals just point to the simplest answer—that there’s nothing out there?',
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'You cite Frank Drake’s failure to detect signals as a mystery. But doesn’t this just support the null hypothesis? If decades of searching yield nothing, isn’t the simplest explanation that there’s nothing to find?'
                }
              ]
            }
          ]
        }
      },
      async ({ inputs, referenceOutputs }) => {
        conversation = await createBackChannelConversation(
          { name: 'Where are all the aliens?' },
          user1,
          topic,
          startDate,
          testConfig.llmPlatform,
          testConfig.llmModel
        )
        const [testAgent] = conversation.agents
        agent = testAgent
        await loadAliensTranscript(conversation)
        const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
        const messages = await Promise.all(
          inputs.questions.map((question) =>
            createParticipantMessage(
              pseudoMap[question.user],
              { text: question.comment, preset: false },
              conversation,
              question.timestamp
            )
          )
        )
        await initializeEvaluators({
          correctness: questionCorrectnessPrompt,
          conciseness: questionConcisenessPrompt
        })
        const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
          start: startDate,
          end: endTime,
          messages
        })

        await validateResponse(responses)
        const { insights } = responses[0].message
        expect(insights.some((insight) => insight.type === 'insight')).toBeFalsy()
        await evaluateSynthesisResponse(
          responses[0].context,
          {
            message: JSON.stringify(insights),
            context: responses[0].context
          },
          JSON.stringify(referenceOutputs!.insights)
        )
        return insights
      },
      120000
    )

    ls.test(
      'surfaces standalone questions phrased as statements from an individual user with transcript',
      questionsAsStatements,
      async ({ inputs, referenceOutputs }) => {
        conversation = await createBackChannelConversation(
          { name: 'Where are all the aliens?' },
          user1,
          topic,
          startDate,
          testConfig.llmPlatform,
          testConfig.llmModel
        )
        const [testAgent] = conversation.agents
        agent = testAgent
        await loadAliensTranscript(conversation)
        const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
        const messages = await Promise.all(
          inputs.questions.map((question) =>
            createParticipantMessage(
              pseudoMap[question.user],
              { text: question.comment, preset: false },
              conversation,
              new Date(startDate.getTime() + question.timestamp * 1000)
            )
          )
        )
        await initializeEvaluators({
          correctness: questionCorrectnessPrompt,
          conciseness: questionConcisenessPrompt
        })
        const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
          start: startDate,
          end: endTime,
          messages
        })

        await validateResponse(responses)
        const { insights } = responses[0].message
        expect(insights.some((insight) => insight.type === 'insight')).toBeFalsy()

        await evaluateSynthesisResponse(
          responses[0].context,
          {
            message: JSON.stringify(responses[0].message.insights),
            context: responses[0].context
          },
          JSON.stringify(referenceOutputs!.insights)
        )
        return responses[0].message.insights
      },
      120000
    )

    ls.test(
      'surfaces standalone questions from an individual user without transcript',
      {
        inputs: {
          questions: [
            {
              user: 'Boring Badger',
              comment:
                'What challenges does BlueSky face in ensuring content moderation while maintaining decentralization and free expression?',
              timestamp: new Date(startDate.getTime() + 1 * 60 * 1000)
            },
            {
              user: 'Boring Badger',
              comment:
                'Can open social media tech realistically compete with entrenched platforms like X (formerly Twitter), Facebook, or Instagram?',
              timestamp: new Date(startDate.getTime() + 90 * 1000)
            },
            {
              user: 'Boring Badger',
              comment: 'What role does interoperability play in open social media platforms and how far along are we?',
              timestamp: new Date(startDate.getTime() + 2 * 60 * 1000)
            },
            {
              user: 'Boring Badger',
              comment:
                'What incentives exist for developers or small platforms to build on top of open social protocols like AT Protocol?',
              timestamp: new Date(startDate.getTime() + 150 * 1000)
            }
          ]
        },
        referenceOutputs: {
          insights: [
            {
              value:
                'What challenges does BlueSky face in ensuring content moderation while maintaining decentralization and free expression?',
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'What challenges does BlueSky face in ensuring content moderation while maintaining decentralization and free expression?'
                }
              ]
            },
            {
              value:
                'Can open social media tech realistically compete with entrenched platforms like X (formerly Twitter), Facebook, or Instagram?',
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'Can open social media tech realistically compete with entrenched platforms like X (formerly Twitter), Facebook, or Instagram?'
                }
              ]
            },
            {
              value: 'What role does interoperability play in open social media platforms and how far along are we?',
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'What role does interoperability play in open social media platforms and how far along are we?'
                }
              ]
            },
            {
              value:
                'What incentives exist for developers or small platforms to build on top of open social protocols like AT Protocol?',
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'What incentives exist for developers or small platforms to build on top of open social protocols like AT Protocol?'
                }
              ]
            }
          ]
        }
      },
      async ({ inputs, referenceOutputs }) => {
        conversation = await createBackChannelConversation(
          { name: 'Bluesky & Open Social Media Tech' },
          user1,
          topic,
          startDate,
          testConfig.llmPlatform,
          testConfig.llmModel
        )
        const [testAgent] = conversation.agents
        agent = testAgent
        const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
        const messages = await Promise.all(
          inputs.questions.map((question) =>
            createParticipantMessage(
              pseudoMap[question.user],
              { text: question.comment, preset: false },
              conversation,
              question.timestamp
            )
          )
        )
        await initializeEvaluators({
          correctness: questionCorrectnessPrompt,
          conciseness: questionConcisenessPrompt
        })

        const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
          start: startDate,
          end: endTime,
          messages
        })

        await validateResponse(responses)
        const { insights } = responses[0].message
        expect(insights.some((insight) => insight.type === 'insight')).toBeFalsy()

        await evaluateSynthesisResponse(
          responses[0].context,
          { message: JSON.stringify(responses[0].message.insights), context: responses[0].context },
          JSON.stringify(referenceOutputs!.insights)
        )

        return insights
      },
      120000
    )

    ls.test(
      'it adds context from the transcript to its insights and correctly parses insights to string',
      {
        inputs: {
          questions: [
            {
              user: 'Boring Badger',
              comment: 'OMG! That much!?!?',
              timestamp: new Date(startDate.getTime() + 132 * 1000)
            },
            {
              user: 'Shady Lawyer',
              comment: 'I had no idea it was that much',
              timestamp: new Date(startDate.getTime() + 134 * 1000)
            },
            {
              user: 'Hungry Hippo',
              comment: "That's a crazy amount!",
              timestamp: new Date(startDate.getTime() + 135 * 1000)
            }
          ]
        },
        referenceOutputs: {
          insights: [
            {
              value: 'Several users are surprised that 8 million tons of plastic are in the ocean',
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'OMG! That much!?!?'
                },
                {
                  user: 'Shady Lawyer',
                  text: 'I had no idea it was that much'
                },
                {
                  user: 'Hungry Hippo',
                  text: "That's a crazy amount!"
                }
              ]
            },
            {
              value: 'Multiple users are shocked at the amount of plastic in the ocean',
              comments: [
                {
                  user: 'Boring Badger',
                  text: 'OMG! That much!?!?'
                },
                {
                  user: 'Shady Lawyer',
                  text: 'I had no idea it was that much'
                },
                {
                  user: 'Hungry Hippo',
                  text: "That's a crazy amount!"
                }
              ]
            }
          ]
        }
      },
      async ({ inputs, referenceOutputs }) => {
        conversation = await createBackChannelConversation(
          { name: 'Should We Ban Plastic Water Bottles?' },
          user1,
          topic,
          startDate,
          testConfig.llmPlatform,
          testConfig.llmModel
        )
        const [testAgent] = conversation.agents
        agent = testAgent
        const talkTranscript = `1:05 - Host: Thank you.
1:07 - Host: The environmental damage caused by plastic water bottles is staggering.
1:10 - Host: They're made from fossil fuels,
1:12 - Host: transported with fossil fuels,
1:24 - Host: and they never truly go away.
1:27 - Host: We've produced 8 million tons of plastic globally,
1:31 - Host: and it doesn’t biodegrade—
1:33 - Host: it just breaks into microplastics that pollute our oceans and are consumed by marine life.
2:10 - Host: 8 million tons of plastic enters the ocean each year.
2:14 - Host: This contributes to ecosystem collapse and even affects human health.
2:18 - Host: Plastic water bottles are one of the most unnecessary forms of pollution because we already have alternatives like reusable bottles and clean tap water in many places.
2:22 - Host: Banning them is a critical step toward reducing our carbon footprint
2:26 - Host:  and protecting the planet.`
        await loadTranscript(talkTranscript, conversation, ['transcript'], '-', startDate)
        const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
        const messages = await Promise.all(
          inputs.questions.map((question) =>
            createParticipantMessage(
              pseudoMap[question.user],
              { text: question.comment, preset: false },
              conversation,
              question.timestamp
            )
          )
        )
        await initializeEvaluators({
          correctness: insightCorrectnessPrompt,
          conciseness: insightConcisenessPrompt
        })

        const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
          start: startDate,
          end: endTime,
          messages
        })

        await validateResponse(responses)
        const { insights } = responses[0].message
        // should be all insight, no standalone question
        expect(insights.some((insight) => insight.type === 'question')).toBeFalsy()

        await evaluateSynthesisResponse(
          responses[0].context,
          {
            message: JSON.stringify(responses[0].message.insights),
            context: responses[0].context
          },
          JSON.stringify(referenceOutputs!.insights)
        )
        const agentMsg = new Message({
          body: responses[0].message,
          bodyType: 'json',
          conversation: conversation._id,
          pseudonym: agent.pseudonyms[0].pseudonym,
          pseudonymId: agent.pseudonyms[0]._id,
          channels: ['moderator'],
          fromAgent: true,
          pause: false,
          visible: true,
          upVotes: [],
          downVotes: []
        })
        const translatedMsg = await defaultAgentTypes.backChannelInsights.parseOutput(agentMsg)
        expect(translatedMsg.body).toEqual(expect.stringContaining('MODERATOR REPORT'))
        expect(translatedMsg.bodyType).toEqual('text')
        return responses[0].message.insights
      },
      120000
    )

    ls.test(
      'it generates multiple insights',
      {
        inputs: {
          questions: [
            {
              user: 'Boring Badger',
              comment: 'This makes me wonder why we never see flying saucers anymore.',
              timestamp: new Date(startDate.getTime() + 73 * 1000)
            },
            {
              user: 'Shady Lawyer',
              comment: 'Good question — why don’t we see life in the cosmos?',
              timestamp: new Date(startDate.getTime() + 77 * 1000)
            },
            {
              user: 'Hungry Hippo',
              comment: 'Yeah, the absence of sightings is puzzling.',
              timestamp: new Date(startDate.getTime() + 80 * 1000)
            },
            {
              user: 'Sad Llama',
              comment: 'The idea of galaxy-colonizing probes is fascinating.',
              timestamp: new Date(startDate.getTime() + 153 * 1000)
            },
            {
              user: 'Sleepy Sloth',
              comment: 'Self-replicating probes colonizing galaxies — love that concept.',
              timestamp: new Date(startDate.getTime() + 162 * 1000)
            },
            {
              user: 'Happy Panda',
              comment: 'Probes could reach every star system — mind-blowing.',
              timestamp: new Date(startDate.getTime() + 175 * 1000)
            }
          ]
        },
        referenceOutputs: {
          insights: [
            {
              value: 'Three users are intrigued by the speaker’s question about the absence of UFOs or visible alien life.',
              comments: [
                { user: 'userA', text: 'This makes me wonder why we never see flying saucers anymore.' },
                { user: 'userB', text: 'Good question — why don’t we see life in the cosmos?' },
                { user: 'userC', text: 'Yeah, the absence of sightings is puzzling.' }
              ]
            },
            {
              value: 'Three users are fascinated by the concept of self-replicating probes colonizing the galaxy.',
              comments: [
                { user: 'userD', text: 'The idea of galaxy-colonizing probes is fascinating.' },
                { user: 'userE', text: 'Self-replicating probes colonizing galaxies — love that concept.' },
                { user: 'userF', text: 'Probes could reach every star system — mind-blowing.' }
              ]
            }
          ]
        }
      },
      async ({ inputs, referenceOutputs }) => {
        conversation = await createBackChannelConversation(
          { name: 'Where are all the aliens?' },
          user1,
          topic,
          startDate,
          testConfig.llmPlatform,
          testConfig.llmModel
        )
        const [testAgent] = conversation.agents
        agent = testAgent
        await loadAliensTranscript(conversation)

        const endTime = new Date(startDate.getTime() + 4 * 60 * 1000)
        const messages = await Promise.all(
          inputs.questions.map((question) =>
            createParticipantMessage(
              pseudoMap[question.user],
              { text: question.comment, preset: false },
              conversation,
              question.timestamp
            )
          )
        )
        await initializeEvaluators({
          correctness: insightCorrectnessPrompt,
          conciseness: insightConcisenessPrompt
        })

        const responses = await defaultAgentTypes.backChannelInsights.respond.call(agent, {
          start: startDate,
          end: endTime,
          messages
        })

        await validateResponse(responses)
        const { insights } = responses[0].message
        // should be some insights, not just standalone questions
        expect(insights.some((insight) => insight.type === 'insight')).toBeTruthy()

        await evaluateSynthesisResponse(
          responses[0].context,
          {
            message: JSON.stringify(responses[0].message.insights),
            context: responses[0].context
          },
          JSON.stringify(referenceOutputs!.insights)
        )
        return responses[0].message.insights
      },
      120000
    )

    it('does not respond if no messages are found', async () => {
      conversation = await createBackChannelConversation(
        { name: 'Best Movie Ever' },
        user1,
        topic,
        startDate,
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const [testAgent] = conversation.agents
      agent = testAgent
      await agent.evaluate()
      const responses = await agent.respond()
      expect(responses).toHaveLength(0)
    })

    it('does not respond if only preset messages are found', async () => {
      conversation = await createBackChannelConversation(
        { name: 'Best Movie Ever' },
        user1,
        topic,
        startDate,
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const [testAgent] = conversation.agents
      agent = testAgent
      await createParticipantMessage(
        user1,
        {
          text: "Let's move on",
          preset: true
        },
        conversation
      )
      await createParticipantMessage(
        user2,
        {
          text: "Let's move on",
          preset: true
        },
        conversation
      )
      await createParticipantMessage(
        user3,
        {
          text: "I'm confused",
          preset: true
        },
        conversation
      )

      await agent.evaluate()
      const responses = await agent.respond()
      expect(responses).toHaveLength(0)
    })

    it('does not respond if only non-substantive messages are found', async () => {
      conversation = await createBackChannelConversation(
        { name: 'Best Movie Ever' },
        user1,
        topic,
        startDate,
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const [testAgent] = conversation.agents
      agent = testAgent
      await createParticipantMessage(
        user1,
        {
          text: 'Hi'
        },
        conversation
      )
      await createParticipantMessage(
        user2,
        {
          text: 'Testing'
        },
        conversation
      )
      await createParticipantMessage(
        user3,
        {
          text: 'This is Billy'
        },
        conversation
      )
      await createParticipantMessage(
        user4,
        {
          text: "I'm glad we don't have class tomorrow"
        },
        conversation
      )

      await agent.evaluate()
      const responses = await agent.respond()
      expect(responses).toHaveLength(0)
    })

    it('introduces itself on new DM channels', async () => {
      conversation = await createBackChannelConversation(
        { name: 'Should Plastic Water Bottles Be Banned?' },
        user1,
        topic,
        startDate,
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const [testAgent] = conversation.agents
      agent = testAgent
      const [directChannel] = await Channel.create([
        { name: 'direct-jh-agents', direct: true, participants: [user1._id, agent._id] }
      ])
      const msgs = await agent.introduce(directChannel)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].body).toEqual(agent.agentConfig.introMessage)
      expect(msgs[0].channels).toHaveLength(1)
      expect(msgs[0].channels[0]).toEqual(directChannel)
    })

    it('does not introduce itself on non-direct channels', async () => {
      conversation = await createBackChannelConversation(
        { name: 'Should Plastic Water Bottles Be Banned?' },
        user1,
        topic,
        startDate,
        testConfig.llmPlatform,
        testConfig.llmModel
      )
      const [testAgent] = conversation.agents
      agent = testAgent
      await agent.save()
      const [channel] = await Channel.create([{ name: 'testchannel' }])
      const msgs = await agent.introduce(channel)
      expect(msgs).toHaveLength(0)
    })
  },
  { metadata: testConfig }
)

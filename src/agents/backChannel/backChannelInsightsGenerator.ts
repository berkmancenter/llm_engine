import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import { StructuredOutputParser } from '@langchain/core/output_parsers'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import * as fuzzball from 'fuzzball'
import { z } from 'zod'
import { formatMessages } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import logger from '../../config/logger.js'
import responseFormatSchemas from '../helpers/responseFormatSchemas.js'
import { shouldUseStructuredOutput } from '../helpers/llmChain.js'
import { BackChannelAgentResponse } from './backChannel.types.js'
import filterHallucinations from './hallucinations.js'
import { AgentResponse } from '../../types/index.types.js'

export const backChannelLLMTemplates = {
  insightsSystem: `You're a live event moderator reviewing audience comments. Your job is to quickly surface what matters most — questions, patterns, surprises, or anything that could guide the presenters.

Each comment you receive includes a text field, a timestamp, and an optional transcript snippet. Comments are grouped by user. You will receive them in the following structure:

{{
  "username1": [
    {{
      "text": "This feels risky to deploy in schools.",
      "timestamp": "12:43",
      "transcript": "12:43 | Presenter: This model is now being tested in some public school systems."
}},
    {{
      "text": "Is this open source?",
      "timestamp": "12:45",
      "transcript": ""
}}
  ],
  "username2": [
    {{
      "text": "Wait... 2.5 *billion* records?",
      "timestamp": "12:46",
      "transcript": "12:45 | Presenter: The dataset includes 2.5 billion medical records."
}}
  ]
}}

If a transcript is provided for a comment (i.e., not an empty string), it represents the portion of the event that occurred within ± a range of seconds of when the comment was made.

**When a transcript snippet is provided:**
- Use that snippet to precisely identify what the comment is reacting to.
- Always prefer the **most recent**, **specific**, and **emotionally salient** part of the transcript within the window.
- Do not generalize or summarize beyond what is said in the snippet. If the transcript says "this model has 2.5 billion parameters," your insight must reference model size — not just "technical scale."
- Never reference or draw from parts of the transcript that fall outside the provided window.

**When no transcript is provided:**
- Base your insights solely on the content of the comments, following all other rules strictly.

**CRITICAL:**
- DO NOT invent, exaggerate, or modify audience comments. You must be 100% faithful to the actual content.
- Do not suggest more users share a sentiment than actually do.
- Do not infer sentiment unless clearly present.
- NEVER derive patterns, clusters, or shared sentiment based on multiple comments from the same user.
- Only treat an idea as shared or meaningful if it is supported by input from the required number of unique users, which will be specified separately.


**Clustering and Shared Sentiment:**
- You may only group comments that express strongly overlapping meaning, using similar or clearly aligned language.
- Never group vague or loosely related comments.
- A comment from a single user counts only once toward any insight, no matter how many similar things they say.**
- When counting toward the required threshold, use the number of distinct usernames — not the number of comments.
- Never treat repetition from a single user as a sign of shared sentiment.
- Only produce an insight if the number of unique users expressing that idea meets or exceeds the required threshold (provided in the input).
- If this threshold is not met for any idea, output nothing.

**Style:**
- Insights must be short, human, and natural — 1 sentence is often enough.
- Insights should include detail and nuance (e.g., specific players, moments, or ideas from the comments).
- Always include how many unique users contributed to an insight. If it's only two people, say "Two people..."; do not say "Some" or "Many" unless you can count it.

**Tone:** Natural and conversational. Think like a fast-thinking human scanning a room. Short is better. It's fine to say things like:
- "Three people are asking if this is open source"
- "There's pushback from four participants on the privacy claims"

**Prioritize:**
- Widely shared or repeated ideas
- Insights that could guide discussion
- Novel or surprising takes

** Output Format:**
- Use this structure:
[
  {{
    "value": "Insight goes here",
    "comments": [
      {{"user": "username", "text": "comment content"}},
      ...
    ]
}}
]
**Examples:**
(Example if transcript says: “This model was trained on 2.5 billion medical records from 37 countries.”)

Comments:
- “Wait… 2.5 *billion*?”
- “That's more than I thought was even legal”

Then output:
[
{{
  "value": "Multiple users are surprised at the scale of training data — 2.5 billion medical records",
  "comments": [
    {{"user": "GP", "text": "Wait… 2.5 *billion*?"}},
    {{"user": "AL", "text": "That's more than I thought was even legal"}}
  ]
}}
]
**IMPORTANT:** All example comments before this line are illustrative only. Do NOT include them in your response or copy them into output.
Final Check Before Output:

For every proposed insight, verify that the “comments” list contains comments from the threshold number of distinct usernames. If it does not, discard the insight.`,
  insightsUser: `This is a presentation about {topic}.

Only generate an insight if it is clearly supported by comments from {reportingThreshold} or more unique users, either using similar language or clearly expressing the same sentiment. Do not group vague or unrelated comments.

If no such insights exist, return nothing — not even an explanation. Just an empty array.

Do NOT guess or assume a pattern unless it is explicitly supported by matching or clearly aligned user comments. Avoid grouping vague or unrelated points.

NEVER include more than {maxInsights} total insights.

**Comments:**
{comments}`,
  standaloneQuestionSystem: `I’m providing a list of audience comments from a live presentation, each with a timestamp. Some are questions, some are reactions or observations.

Each comment you receive includes a text field, a timestamp, and an optional transcript snippet. Comments are grouped by user. You will receive them in the following structure:

{{
  "username1": [
    {{
      "text": "This feels risky to deploy in schools.",
      "timestamp": "12:43",
      "transcript": "12:43 | Presenter: This model is now being tested in some public school systems."
}},
    {{
      "text": "Is this open source?",
      "timestamp": "12:45",
      "transcript": ""
}}
  ],
  "username2": [
    {{
      "text": "Wait... 2.5 *billion* records?",
      "timestamp": "12:46",
      "transcript": "12:45 | Presenter: The dataset includes 2.5 billion medical records."
}}
  ]
}}
If a transcript is provided for a comment (i.e., not an empty string), it represents the portion of the event that occurred within ±15 seconds of when the comment was made.

Before starting, apply the following early filters:

- Exclude any comment that is:
  - Shorter than 6 words and not phrased as a question
  - A test message or system input ("Testing", ".", etc.)
  - A general agreement, praise, or cheer (“Cool!”, “👏👏👏”, “Same here”)
  - A directive or stage instruction (“Let’s move on”, “Keep going”)

Please do the following:

1. Identify which comments should be surfaced to the moderator as individual questions using the following criteria:

- Clarifying Questions – Asks for explanation or elaboration of something the speaker said.

- Insightful Connections – Links the topic to a meaningful outside reference (e.g., historical event, theory, current trend).

- Focused Topic Expansion Requests – Expresses a desire to go deeper into a specific idea mentioned in the talk.

- Challenging or Reframing Questions – Offers a contrasting or philosophical angle that enriches the discussion.

- Strategic or Structural Questions – Asks how decisions, systems, or priorities work (relevant across fields).

- Analytical or Comparative Observations - Highlights a historical parallel, technical distinction, or philosophical tension that implicitly invites reflection or expansion—even if not phrased as a question.

2. DO NOT surface any of the following:

- Greetings, emojis, applause, laughter, or generic affirmations (“Hi,” “👏👏👏,” “Love this,” “That’s cool,” “Same!”)
- Test messages or content-free inputs (“test,” “checking,” “.”)
- Praise or agreement that doesn’t contain a clear question, reasoning, or insight
- Vague, fragmentary, or contextless statements that cannot be interpreted without guessing
- Off-topic, irrelevant, or random input
- Questions that are rhetorical, unserious, or made in jest
- Repetitive or echo comments that mirror something already clearly addressed or expressed in the speaker’s transcript snippet
- Do not surface any comment under 6 words unless:
  - It is phrased as a direct question (begins with who, what, where, when, why, or how)
  - OR it includes a technical or topic-specific noun (e.g., “graph embeddings?”, “What's GPT-4’s context window?”)

Examples of what NOT to surface include: “Testing”, “Let’s move on”, “Great point”, “Same”, “?”, “Wait what?”, “That’s interesting”, etc.

3. For each surfaced question, do the following:

- Rephrase the question only as much as needed to:

-- Fix spelling or grammar

-- Add minimal context to make the question understandable on its own (if it refers to something in the talk)

-- Preserve the tone, voice, and intent of the original speaker

- If needed, you may draw from the speaker’s transcript snippet to briefly clarify the reference (e.g., “in reference to the quote about ‘network structure based on human reality’”)

Do not over-formalize or change the meaning. Keep edits light-touch.

**CRITICAL:** DO NOT under any circumstances invent, hallucinate or modify audience comments. You must be totally, 100% faithful to the comments you receive. DO NOT invent comments!
**CRITICAL:** If there are no meaningful comments, it is best to provide no output - in that case no response is the best response.
**CRITICAL:** Never include usernames in the 'value' or 'text' fields. If a comment refers to a user (e.g., "@someone"), replace it with a neutral phrase like "[another commenter]". Redact any full names or sensitive information.

**Output Format:**
- Report each question and the original comment it came from separately in this format:
[{{"value": "Question goes here", "comments": [{{"user": "username here", "text": "redacted comment here"}}]}}]`,
  standaloneQuestionUser: `
This is a presentation about {topic}.

**Comments:**
{comments}
If no questions meet the required threshold, return nothing. Do not explain or justify. Do not say "no questions can be surfaced." Just return an empty array.
`
}

export const backChannelLLMTemplateVars = {
  insightsUser: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'comments', description: 'The comments to process' },
    { name: 'reportingThreshold', description: 'The minimum number of users from which to generate an insight' },
    { name: 'maxInsights', description: 'The maximum number of insights to generate' }
  ],
  insightsSystem: [], // TODO don't require for system prompts?,
  standaloneQuestionUser: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'comments', description: 'The comments to process' }
  ],
  standaloneQuestionSystem: [] // TODO don't require for system prompts?
}

function groupCommentsByUser(commentMsgs) {
  return JSON.stringify(
    commentMsgs.reduce((acc, item) => {
      const username = item.comment.user
      if (!acc[username]) {
        acc[username] = []
      }
      acc[username].push(item)
      return acc
    }, {})
  )
}

function filterInsightsByCommentDiversity(data) {
  const filteredInsights = data.results.filter((insight) => {
    const uniqueUsers = new Set(insight.comments.map((comment) => comment.user))
    return uniqueUsers.size > 1
  })
  return {
    ...data,
    results: filteredInsights
  }
}

export async function processParticipantMessages(messages, startTime, endTime) {
  // Retrieve 30 seconds behind first message for transcript context
  const transcriptMessages = transcript.getTranscriptMessages(
    this.conversation,
    (endTime.getTime() - startTime.getTime()) / 1000 + 30,
    endTime
  )

  // Add only the transcript snippets occurring +- 15 seconds (default) to each comment for analysis
  // Allows the agent to be more specific in contextualization
  const commentMsgs = formatMessages(messages, true, transcriptMessages, this.agentConfig.transcriptTimeWindow || 15)

  const comments = groupCommentsByUser(commentMsgs)
  logger.debug(`Processing comments: ${comments}`)

  const topic = this.conversation.name
  const llm = await this.getLLM()
  const { maxInsights, reportingThreshold } = this.agentConfig

  const insightsPrompt = ChatPromptTemplate.fromMessages([
    ['system', this.llmTemplates.insightsSystem],
    ['user', this.llmTemplates.insightsUser]
  ])

  const questionsPrompt = ChatPromptTemplate.fromMessages([
    ['system', this.llmTemplates.standaloneQuestionSystem],
    ['user', this.llmTemplates.standaloneQuestionUser]
  ])

  const toolSchema = {
    name: 'structured_response',
    description: 'Respond with structured data',
    input_schema: responseFormatSchemas.commentInsights
  }

  const llmWithTool = llm.bind({
    tools: [toolSchema]
  })

  const parser = StructuredOutputParser.fromZodSchema(responseFormatSchemas.commentInsights)
  const insightsChain = shouldUseStructuredOutput(llm)
    ? insightsPrompt.pipe(llm.withStructuredOutput(responseFormatSchemas.insights))
    : insightsPrompt
        .pipe(llmWithTool)
        .pipe(parser)
        .pipe(async (parsed) => {
          if (Array.isArray(parsed)) {
            return { results: parsed }
          }
          return parsed
        })

  const questionsChain = shouldUseStructuredOutput(llm)
    ? questionsPrompt.pipe(llm.withStructuredOutput(responseFormatSchemas.insights))
    : questionsPrompt
        .pipe(llmWithTool)
        .pipe(parser)
        .pipe(async (parsed) => {
          if (Array.isArray(parsed)) {
            return { results: parsed }
          }
          return parsed
        })

  const insightsLambda = new RunnableLambda({
    func: async (input: { comments: string; topic: string; maxInsights: string; reportingThreshold: string }) => {
      // Remove lines from comments that match any comments from all insights, to prevent duplicate procesing
      const insightsResponse = await insightsChain.invoke(input)
      const insights = insightsResponse as z.infer<typeof responseFormatSchemas.insights>

      let filteredComments = input.comments
      if (insights.results && Array.isArray(insights.results)) {
        const commentsUsedForInsights = insights.results.flatMap((insight) => insight.comments)
        const unusedComments = commentMsgs.filter((commentMsg) => {
          try {
            const { comment } = commentMsg
            // Check if this comment matches any insight comment with 70% similarity
            return !commentsUsedForInsights.some((insightComment) => {
              const userMatch = comment.user === insightComment.user
              const textSimilarity = fuzzball.token_sort_ratio(comment.text, insightComment.text) / 100
              return userMatch && textSimilarity >= 0.7
            })
          } catch {
            // If parsing fails, keep the line (might be malformed but safer to keep)
            return true
          }
        })
        filteredComments = groupCommentsByUser(unusedComments)
      }
      // add the type property to distinguish insights from standalone questions
      insights.results = insights.results.map((insight) => ({ ...insight, type: 'insight' }))
      return {
        insightsFromInsights: filterInsightsByCommentDiversity(insights),
        comments: filteredComments,
        topic: input.topic,
        maxInsights: input.maxInsights,
        reportingThreshold: input.reportingThreshold
      }
    }
  })

  const questionsLambda = new RunnableLambda({
    func: async (input: {
      insightsFromInsights: z.infer<typeof responseFormatSchemas.insights>
      comments: string
      topic: string
      maxInsights: string
      reportingThreshold: string
    }) => {
      const questionsResponse =
        input.comments === '{}'
          ? { results: [] }
          : await questionsChain.invoke({
              comments: input.comments,
              topic: input.topic
            })
      const questionsInsights = questionsResponse as z.infer<typeof responseFormatSchemas.insights>
      // add the type property to distinguish insights from standalone questions
      questionsInsights.results = questionsInsights.results.map((insight) => ({ ...insight, type: 'question' }))

      return {
        insightsFromInsights: input.insightsFromInsights,
        insightsFromQuestions: questionsInsights
      }
    }
  })

  const combineInsightsLambda = new RunnableLambda({
    func: async (input: {
      insightsFromInsights: z.infer<typeof responseFormatSchemas.insights>
      insightsFromQuestions: z.infer<typeof responseFormatSchemas.insights>
    }) => {
      // Combine insights from both sources
      const combinedInsights = {
        results: [...input.insightsFromInsights.results, ...input.insightsFromQuestions.results]
      }
      return combinedInsights
    }
  })

  const chain = RunnableSequence.from([insightsLambda, questionsLambda, combineInsightsLambda])

  const llmResponse = (await chain.invoke({
    comments,
    topic,
    maxInsights,
    reportingThreshold
  })) as z.infer<typeof responseFormatSchemas.insights>

  const response: BackChannelAgentResponse = {
    timestamp: { start: startTime.getTime(), end: endTime.getTime() },
    // filter insights with hallucinated comments - could not be stopped with prompt - yet! ;)
    // and sometimes real comments will be modified by the LLM (e.g. modifying punctuation or fixing typos)
    insights: await filterHallucinations(llmResponse.results, messages)
  }

  if (!response.insights?.length) return []

  const agentResponse: AgentResponse<BackChannelAgentResponse> = {
    visible: true,
    channels: this.conversation.channels.filter((channel) => channel.name === 'moderator'),
    message: response,
    messageType: 'json',
    context: comments
  }
  return [agentResponse]
}

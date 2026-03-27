import { RunnableLambda, RunnableSequence } from '@langchain/core/runnables'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import * as fuzzball from 'fuzzball'
import { z } from 'zod'
import { formatMessages } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import logger from '../../config/logger.js'
import responseFormatSchemas from '../helpers/responseFormatSchemas.js'
import { getStructuredResponseChain } from '../helpers/llmChain.js'
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
{comments}`
}

export const backChannelLLMTemplateVars = {
  insightsUser: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'comments', description: 'The comments to process' },
    { name: 'reportingThreshold', description: 'The minimum number of users from which to generate an insight' },
    { name: 'maxInsights', description: 'The maximum number of insights to generate' }
  ],
  insightsSystem: [] // TODO don't require for system prompts?
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

  const insightsChain = getStructuredResponseChain(llm, insightsPrompt, responseFormatSchemas.insights)

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
      /**
       * Surface remaining comments directly to the moderator without LLM filtering.
       * Uses `input.comments`, which is pre-filtered by insightsLambda via fuzzy matching.
       * @remarks A comment that partially overlaps with a clustered insight may be silently
       * dropped here even if it shouldn't have been consumed by insightsLambda.
       */
      type CommentMsg = { comment: { user: string; timestamp: string; text: string }; transcript?: string }
      const remainingComments: Record<string, CommentMsg[]> = input.comments === '{}' ? {} : JSON.parse(input.comments)
      const questionsInsights = {
        results: Object.values(remainingComments).flatMap((userComments) =>
          userComments.map((commentMsg) => ({
            value: commentMsg.comment.text,
            comments: [{ user: commentMsg.comment.user, text: commentMsg.comment.text }],
            type: 'question'
          }))
        )
      }

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

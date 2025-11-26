import { z } from 'zod'

const citedAnswer = z.object({
  answer: z.string().describe('The answer to the user question, which is based only on the given sources.'),
  questionPosed: z.string().describe('A follow-up question for discussion.'),
  citations: z.array(z.number()).describe('The integer IDs of the specific sources justifying the answer.')
})

const votingAnswer = z.object({
  results: z.array(
    z.object({
      chunk: z.number().describe('The number of the discussion chunk you found most interesting.'),
      reason: z.string().describe('The reason you think this chunk was the most interesting.')
    })
  )
})

const insight = z.object({
  value: z.string().describe('The insight.'),
  comments: z.array(
    z.object({
      user: z.string().describe('The user who made the comment'),
      text: z.string().describe('The comment from the LLM')
    })
  )
})

const insights = z.object({ results: z.array(insight) })

const commentInsights = z.array(insight)

// This schema uses JSONSchema so we can inject a user's outputSchema as the result property
export function generateGenericAgentAnswerSchema(outputSchema) {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['explanation', 'message', 'visible', 'channels', 'action'],
    properties: {
      explanation: {
        type: 'string',
        description: 'A short phrase, describing What the agent did'
      },
      // message.type can be overridden with an embedded outputSchema from a user
      message: outputSchema
        ? { ...outputSchema, description: 'The user specified output schema' }
        : {
            type: 'string',
            description: "The agent's output text"
          },
      visible: {
        type: 'boolean',
        default: true,
        description: 'Is the agent contribution visible?'
      },
      channels: {
        type: 'array',
        items: {
          type: 'string'
        },
        default: [],
        description: 'The channels to contribute to'
      },
      action: {
        type: 'integer',
        enum: [0, 1, 2],
        default: 2,
        description:
          'AgentMessageAction enum: 0 = "OK", 1 = "REJECT", 2 = "CONTRIBUTE". ALWAYS choose 2 unless directed otherwise'
      }
    }
  }
}

export default {
  citedAnswer,
  votingAnswer,
  commentInsights,
  insights,
  generateGenericAgentAnswerSchema
}

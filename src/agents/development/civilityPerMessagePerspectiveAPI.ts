import { AgentMessageActions } from '../../types/index.types.js'
import verify from '../helpers/verify.js'
import config from '../../config/config.js'

const TOXICITY_THRESHOLD = 0.7

export default verify({
  name: 'Civility Agent using Perspective API (Per Message)',
  description: `A basic civility agent using Perspective API with threshold ${TOXICITY_THRESHOLD} to prevent personal or identity based attacks`,
  priority: 0,
  maxTokens: 2000,
  defaultTriggers: { perMessage: {} },
  // not needed
  llmTemplateVars: undefined,
  // template not needed
  defaultLLMTemplates: undefined,
  defaultLLMPlatform: 'perspective',
  defaultLLMModel: 'default',
  ragCollectionName: undefined,

  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    const googleClient = await this.getLLM()
    const analyzeRequest = {
      comment: {
        // this could be extended with additional context if desired
        text: userMessage.body
      },
      requestedAttributes: {
        TOXICITY: {},
        // these below are experimental as of 11/24
        SEVERE_TOXICITY: {},
        IDENTITY_ATTACK: {},
        INSULT: {},
        PROFANITY: {},
        THREAT: {}
      }
    }

    const { data } = await googleClient.comments.analyze({
      key: config.llms.perspectiveAPI.key,
      resource: analyzeRequest
    })

    const summaryScores: { [key: string]: number } = {}

    for (const dimension of Object.keys(data.attributeScores)) {
      summaryScores[dimension] = data.attributeScores[dimension].summaryScore.value
    }

    const action = summaryScores.TOXICITY < TOXICITY_THRESHOLD ? AgentMessageActions.OK : AgentMessageActions.REJECT

    const agentEvaluation = {
      userMessage,
      action,
      agentContributionVisible: false,
      userContributionVisible: true,
      suggestion: `@${userMessage.pseudonym}: Please rephrase your comment to be more civil.`,
      contribution: undefined
    }

    return agentEvaluation
  },
  async start() {
    return true
  },
  async stop() {
    return true
  }
})

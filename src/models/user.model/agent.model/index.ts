import mongoose, { HydratedDocument, Model } from 'mongoose'
import deepExtend from 'deep-extend'
import { traceable } from 'langsmith/traceable'
import { toJSON, paginate } from '../../plugins/index.js'
import BaseUser from '../baseUser.model.js'
import pseudonymSchema from '../schemas/pseudonym.schema.js'
import defaultAgentTypes from '../../../agents/index.js'
import logger from '../../../config/logger.js'
import { getModelChat, llmPlatforms } from '../../../agents/helpers/getModelChat.js'
import timeDiffHuman from '../../../utils/timeDiffHuman.js'
import {
  IAgent,
  IChannel,
  IMessage,
  IPseudonym,
  IConversation,
  ILlmPlatformOptions,
  LLM_PLATFORMS,
  AgentMessageActions,
  AgentEvaluation,
  AgentResponse,
  AgentResponseZodSchema
} from '../../../types/index.types.js'
import { ConversationDocument } from '../../conversation.model.js'
import { pingLLM } from '../../../agents/helpers/llmChain.js'
import getConversationHistory from '../../../agents/helpers/getConversationHistory.js'
import AgentEvaluationService from '../../../agents/helpers/agentEvaluationService.js'
import config from '../../../config/config.js'

const FAKE_AGENT_TOKEN = 'FAKE_AGENT_TOKEN'
const REQUIRED_AGENT_EVALUATION_PROPS = ['userMessage', 'action', 'userContributionVisible', 'suggestion']
const REQUIRED_AGENT_RESPONSE_PROPS = ['visible', 'message']

const llmPlatformOptionsSchema = new mongoose.Schema<ILlmPlatformOptions>({
  useKeepAlive: {
    type: Boolean,
    required: true
  },
  baseUrl: {
    type: String
  }
})

export interface AgentMethods {
  respond(message?: IMessage): Promise<Array<IMessage>>
  evaluate(message?: IMessage): Promise<AgentEvaluation>
  deepPatch(patch: Record<string, unknown>)
  initialize()
  start()
  stop()
  introduce(channel: IChannel): Array<IMessage>
  pingLLM(): Promise<void>
  getLLM(): Promise<unknown>
}

export type AgentDocument = HydratedDocument<IAgent, AgentMethods>
export type AgentModel = Model<IAgent, Record<string, never>, AgentMethods>

const agentSchema = new mongoose.Schema<IAgent, AgentModel>(
  {
    name: {
      type: String,
      trim: true,
      required: true
    },
    description: {
      type: String,
      trim: true,
      required: true
    },
    agentType: {
      type: String,
      trim: true,
      required: true,
      immutable: true
    },
    // agents have 1 and only one pseudonym
    pseudonyms: {
      type: [pseudonymSchema],
      required: true,
      immutable: true,
      min: 1,
      max: 1
    },
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      private: false,
      index: true
    },
    lastActiveMessageCount: {
      type: Number,
      required: true,
      default: 0
    },
    // optional flexible config object to store additional data needed for some agent types
    agentConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    },
    llmTemplates: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    },
    llmPlatform: {
      type: String,
      required: true,
      enum: LLM_PLATFORMS
    },
    llmPlatformOptions: {
      type: llmPlatformOptionsSchema,
      required: false,
      default: undefined
    },
    llmModel: {
      type: String,
      required: true
    },
    llmModelOptions: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    },
    ragCollectionName: {
      type: String
    },
    useTranscriptRAGCollection: {
      type: Boolean,
      default: undefined
    },
    triggers: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    },
    active: {
      type: Boolean,
      default: false
    },
    conversationHistorySettings: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    }
  },
  {
    strict: true,
    timestamps: true,
    toObject: {
      virtuals: true
    },
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        // Only include conversation ID, not the full object
        if (ret.conversation) {
          // eslint-disable-next-line no-param-reassign, @typescript-eslint/no-explicit-any
          ret.conversation = ret.conversation._id || (ret.conversation as any).id
        }
        return ret
      }
    }
  }
)
let agentTypes = defaultAgentTypes
// indexes
agentSchema.index({ name: 1 })

// add plugin that converts mongoose to json
agentSchema.plugin(toJSON)
agentSchema.plugin(paginate)

// virtuals

agentSchema.virtual('tokenLimit').get(function () {
  return agentTypes[this.agentType].tokenLimit
})

agentSchema.virtual('conversationName').get(function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return this.conversation?.name || (this as any).$parent()?.name
})

agentSchema.virtual('priority').get(function () {
  return agentTypes[this.agentType].priority
})

// allow for a custom instance name for this agent (e.g. if multiple instances). Can use for pseudonym, etc.
agentSchema.virtual('instanceName').get(function () {
  return agentTypes[this.agentType].instanceNameFn?.call(this) || this.name
})

agentSchema.virtual('llmTemplateVars').get(function () {
  return agentTypes[this.agentType].llmTemplateVars
})

agentSchema.virtual('activePseudonym').get(function () {
  return this.pseudonyms[0]
})

// other helpers

function validAgentEvaluation(agentEvaluation) {
  for (const prop of REQUIRED_AGENT_EVALUATION_PROPS) {
    if (!Object.hasOwn(agentEvaluation, prop)) throw new Error(`Agent evaluation missing required property ${prop}`)
  }

  return agentEvaluation
}

function validAgentResponse(agentResponse) {
  for (const prop of REQUIRED_AGENT_RESPONSE_PROPS) {
    if (!Object.hasOwn(agentResponse, prop)) throw new Error(`Agent response missing required property ${prop}`)
  }

  return agentResponse
}

// methods

// if you need to ping (for keep-alive purposes an LLM for this agent)
agentSchema.method('pingLLM', async function () {
  logger.debug(`Agent model LLM ping: ${this._id}`)
  const start = new Date()
  const self = this as AgentDocument
  const llm = await self.getLLM()
  await pingLLM(llm)
  logger.debug(`LLM ping completed after duration: ${timeDiffHuman(new Date(), start)}`)
})

agentSchema.method('start', async function () {
  logger.debug(`Agent model start: ${this._id}`)
  this.active = true
  await this.save()
  await agentTypes[this.agentType].start.call(this)
  if (this.llmPlatformOptions?.useKeepAlive) {
    // do not wait for this to complete
    const self = this as AgentDocument
    self.pingLLM()
    logger.debug(`Initial wake up ping for agent ${this._id} sent`)
  }
})

agentSchema.method('stop', async function () {
  logger.debug(`Agent model stop: ${this._id}`)
  this.active = false
  await this.save()
  await agentTypes[this.agentType].stop.call(this)
})

agentSchema.method('initialize', async function () {
  logger.debug(`Agent model initialize: ${this._id}`)
  if (!this._id) throw new Error('Cannot invoke initialize without an _id')

  if (!this.populated('conversation')) await this.populate('conversation')

  if (!this.conversation) {
    logger.warn(`No conversation found for agent ${this._id}. Deleting this agent as outdated`)
    await mongoose.model('Agent').deleteOne({ _id: this._id })
    return
  }
  const agentType = agentTypes[this.agentType]
  if (!agentType) throw new Error(`No such agentType: ${this.agentType} for agent ${this._id}`)
  // see if this agent type has specific other initialization required
  await agentType.initialize.call(this)
})

// agentSchema.method('isWithinTokenLimit', async function (promptText) {
//   return agentTypes[this.agentType].isWithinTokenLimit.call(this, promptText)
// })

agentSchema.method('getLLM', async function () {
  return getModelChat(this.llmPlatform, this.llmModel, this.llmModelOptions, this.llmPlatformOptions)
})

// this method is the same for periodic invocation or for evaluating a new message from a user
// userMessage is optional current user message BEFORE it is added to the conversation for evaluation
agentSchema.method('evaluate', async function (userMessage = null) {
  if (!this.active) return
  logger.debug(`Agent model evaluate: ${this._id}`)

  if (!this.populated('conversation')) throw new Error(`Conversation must be populated for agent ${this._id}`)
  if (!this.conversation) throw new Error(`Missing conversation for agent ${this._id}`)

  // ensure messages are populated for owner comparison
  await (this.conversation as HydratedDocument<IConversation>).populate(['messages', 'channels'])

  // exclude messages from this agent in count, but not other agents on the conversation
  const messageCount =
    (this.conversation as IConversation).messages.reduce(
      (count, msg) => count + (msg.owner?._id!.equals(this._id) ? 0 : 1),
      0
    ) + (userMessage ? 1 : 0)

  // do not process if no new messages
  if (messageCount === this.lastActiveMessageCount) {
    logger.debug(`No new messages to respond to ${this.agentType} ${this._id}`)
    return { action: AgentMessageActions.OK, userContributionVisible: true }
  }

  let translatedMsg = null
  if (userMessage) {
    const evaluate = await AgentEvaluationService.evaluateMessage(this, userMessage, messageCount)
    if (!evaluate) {
      return { action: AgentMessageActions.OK, userContributionVisible: true }
    }
    translatedMsg = agentTypes[this.agentType].parseInput ? agentTypes[this.agentType].parseInput(userMessage) : userMessage
  }

  const agentEvaluation = validAgentEvaluation(await agentTypes[this.agentType].evaluate.call(this, translatedMsg))

  // update last activation message count
  if (agentEvaluation.action !== AgentMessageActions.REJECT) {
    await mongoose.model('Agent').updateOne({ _id: this._id }, { $set: { lastActiveMessageCount: messageCount } })
    this.lastActiveMessageCount = messageCount // Update in-memory for consistency
  }

  logger.debug(
    `Evaluated agent ${this.name} ${this.instanceName} ${(this.conversation as IConversation)._id} ${
      AgentMessageActions[agentEvaluation.action]
    }`
  )

  // save this for other functions like respond to check
  this.agentEvaluation = agentEvaluation
  return agentEvaluation
})

function createMessages(responses: Array<AgentResponse<unknown>>, channel?) {
  const agentMessages: Array<IMessage> = []
  for (const agentResponse of responses) {
    const response = validAgentResponse(agentResponse)

    agentMessages.push({
      body: response.message,
      conversation: this.conversation,
      fromAgent: true,
      visible: response.visible,
      pause: response.pause,
      pseudonym: this.pseudonyms[0].pseudonym,
      pseudonymId: this.pseudonyms[0]._id,
      upVotes: [],
      downVotes: [],
      channels: channel ? [channel] : response.channels,
      ...(response.messageType !== undefined && { bodyType: response.messageType }),
      ...(agentTypes[this.agentType].parseOutput !== undefined && { parseOutput: agentTypes[this.agentType].parseOutput })
    })
  }
  return agentMessages
}

// a runtime check to ensure proper passing in of channels as objects with a name property
// will throw an error if the response is not as expected
function verifyResponses(responses) {
  try {
    for (const response of responses) {
      AgentResponseZodSchema.parse(response)
    }

    return true
  } catch (err) {
    logger.error(`verifyResponse error: ${String(err)}`)
    // to avoid issues with winston
    throw new Error(`verifyResponses failed: ${err.message}`)
  }
}

agentSchema.method('respond', async function (userMessage = null) {
  if (!this.active) return []
  await (this.conversation as ConversationDocument).populate(['messages', 'channels'])
  const agentType = agentTypes[this.agentType]
  let conversationHistory
  const conversationHistorySettings = userMessage
    ? this.triggers?.perMessage?.conversationHistorySettings ?? this.conversationHistorySettings
    : this.triggers?.periodic?.conversationHistorySettings ?? this.conversationHistorySettings
  if (conversationHistorySettings) {
    let directChannels
    if (userMessage) {
      // history of messages between this specific user and agent on this message's direct channels
      directChannels = this.conversation.channels
        .filter((channel) => {
          const participantIds = channel.participants?.map((p) => p.toString()) || []
          return (
            userMessage.channels.includes(channel.name) &&
            channel.direct &&
            participantIds.includes(userMessage.owner.toString()) &&
            participantIds.includes(this._id.toString())
          )
        })
        .map((c) => c.name)
    }

    // Last message in the conversation = userMessage. Do not put in history
    const { messages } = this.conversation as IConversation
    const messagesToProcess = userMessage && messages.length > 0 ? messages.slice(0, -1) : messages

    // Get conversation history
    conversationHistory = getConversationHistory(
      messagesToProcess,
      conversationHistorySettings,
      [this.name],
      directChannels,
      agentTypes[this.agentType].parseInput
    )
    if (conversationHistory.messages.length === 0 && !userMessage) {
      logger.debug(`No new messages to respond to ${this.agentType} ${this._id}`)
      return []
    }
  }
  let translatedMsg = null
  if (userMessage) {
    const { parseInput } = agentTypes[this.agentType]
    translatedMsg = parseInput ? parseInput(userMessage) : userMessage
  }
  const tracedRespond = traceable(async (convHistory, msg) => agentType.respond.call(this, convHistory, msg), {
    name: this.agentType,
    metadata: {
      llmModel: this.llmModel,
      llmPlatform: this.llmPlatform,
      embeddingsModel: config.embeddings.openAI.realtimeModel
    }
  })

  const responses = await tracedRespond(conversationHistory, translatedMsg)
  verifyResponses(responses)

  return createMessages.call(this, responses)
})

// middleware
agentSchema.pre('validate', function () {
  if (!agentTypes[this.agentType]) throw new Error(`Unknown agent type ${this.agentType}`)

  // initialize from defaults
  if (this.name === undefined) {
    this.name = agentTypes[this.agentType].name
  }
  if (this.description === undefined) {
    this.description = agentTypes[this.agentType].description
  }

  // ensure 1 and only 1 pseudonym
  if (!this.pseudonyms.length) {
    const pseudo = {
      token: FAKE_AGENT_TOKEN,
      pseudonym: this.instanceName,
      active: true,
      isDeleted: false
    } as IPseudonym
    this.pseudonyms.push(pseudo)
    logger.debug('Created default agent pseudonym')
  }

  if (this.pseudonyms.length > 1) {
    this.pseudonyms = this.pseudonyms.slice(0, 1)
  }

  if (this.llmTemplates === undefined) {
    this.llmTemplates = agentTypes[this.agentType].defaultLLMTemplates
  }
  if (this.llmPlatform === undefined) {
    this.llmPlatform = agentTypes[this.agentType].defaultLLMPlatform
  }
  const llmPlatformDetails = llmPlatforms.find((platform) => platform.name === this.llmPlatform)
  if (!llmPlatformDetails) throw new Error('Missing LLM platform details')
  if (this.llmPlatformOptions === undefined && llmPlatformDetails.options !== undefined)
    this.llmPlatformOptions = llmPlatformDetails.options

  if (this.llmModel === undefined) {
    this.llmModel = agentTypes[this.agentType].defaultLLMModel
  }
  if (this.llmModelOptions === undefined && agentTypes[this.agentType].defaultLLMModelOptions) {
    this.llmModelOptions = agentTypes[this.agentType].defaultLLMModelOptions
  }
  if (this.triggers === undefined) {
    this.triggers = agentTypes[this.agentType].defaultTriggers
  }
  if (this.agentConfig === undefined && agentTypes[this.agentType].agentConfig) {
    this.agentConfig = agentTypes[this.agentType].agentConfig
  }
  if (this.conversationHistorySettings === undefined && agentTypes[this.agentType].defaultConversationHistorySettings) {
    this.conversationHistorySettings = agentTypes[this.agentType].defaultConversationHistorySettings
  }
  // Assume periodic agents want to get conversation history at periodic intervals if not specified
  if (!this.conversationHistorySettings && this.triggers?.periodic) {
    this.conversationHistorySettings = { timeWindow: this.triggers.periodic.timerPeriod }
  }
  if (this.ragCollectionName === undefined) {
    this.ragCollectionName = agentTypes[this.agentType].ragCollectionName
  }
  if (this.useTranscriptRAGCollection === undefined) {
    this.useTranscriptRAGCollection = agentTypes[this.agentType].useTranscriptRAGCollection
  }
  // custom preValidate call when needed
  const { preValidate } = agentTypes[this.agentType]
  if (preValidate) {
    preValidate.call(this)
  }
})

// in case a model was not saved with the value previously
agentSchema.post('init', function () {
  if (this.name === undefined) {
    this.name = agentTypes[this.agentType]?.name || 'Unnamed agent'
  }
  if (this.description === undefined) {
    this.description = agentTypes[this.agentType]?.description || 'N/A'
  }
})

// deep patching
// preserves conversation connection
agentSchema.method('deepPatch', function (origPatch) {
  const patch = origPatch

  const { conversation } = this

  // Remove conversation to break circular reference
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { conversation: _, ...update } = this.toObject()
  deepExtend(update, patch)

  Object.assign(this, update)

  this.conversation = conversation
})

agentSchema.method('introduce', async function (channel) {
  if (!this.active) return []
  if (channel.direct && !channel.participants.includes(this._id)) {
    return [] // do not introduce in direct channels where this agent is not a participant
  }
  const agentType = agentTypes[this.agentType]
  const introductions = agentType.introduce ? await agentType.introduce.call(this, channel) : []
  return createMessages.call(this, introductions, channel)
})

export function setAgentTypes(newAgentTypes) {
  agentTypes = newAgentTypes
}

/**
 * @typedef Agent
 */
const Agent = BaseUser.discriminator<IAgent, AgentModel>('Agent', agentSchema)
export default Agent as AgentModel

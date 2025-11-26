import mongoose, { HydratedDocument, Model } from 'mongoose'
import { toJSON } from './plugins/index.js'
import { AdapterChannelConfig, Direction, IAdapter, IMessage } from '../types/index.types.js'
import defaultAdapterTypes from '../adapters/index.js'
import logger from '../config/logger.js'

export interface AdapterMethods {
  start()
  stop()
  receiveMessage(message: Record<string, unknown>)
  sendMessage(message: IMessage)
  validateBeforeUpdate()
  participantJoined(participant: Record<string, unknown>)
}

interface AdapterStatics {
  getUniqueKeys(type: string): string[]
}

type AdapterModel = Model<IAdapter, Record<string, never>, AdapterMethods> & AdapterStatics
const adapterChannelConfigSchema = new mongoose.Schema<AdapterChannelConfig>({
  direction: {
    type: String,
    enum: Object.values(Direction),
    default: Direction.INCOMING
  },
  direct: {
    type: Boolean,
    required: false,
    default: false
  },
  name: {
    type: String,
    required: false
  },
  agent: {
    type: mongoose.Types.ObjectId,
    required: false
  },
  config: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined
  }
})
const adapterSchema = new mongoose.Schema<IAdapter, AdapterModel>(
  {
    type: {
      type: String,
      trim: true,
      required: true,
      immutable: true
    },
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      private: false,
      index: true
    },
    config: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    active: {
      type: Boolean,
      default: false
    },
    audioChannels: {
      type: [adapterChannelConfigSchema],
      default: []
    },
    chatChannels: {
      type: [adapterChannelConfigSchema],
      default: []
    },
    dmChannels: {
      type: [adapterChannelConfigSchema],
      default: []
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
let adapterTypes = defaultAdapterTypes
// indexes TODO what?
adapterSchema.index({ name: 1 })

// add plugin that converts mongoose to json
adapterSchema.plugin(toJSON)

function getChannelConfigByName(channelName) {
  const audioAndChatChannels = [...(this.audioChannels || []), ...(this.chatChannels || []), ...(this.dmChannels || [])]
  const matchedChannel = audioAndChatChannels.find((ch) => ch.name === channelName)
  if (matchedChannel) {
    return matchedChannel
  }
  // Check each dmChannel's configuration for channelName
  for (const dmChannel of this.dmChannels) {
    if (dmChannel.config && dmChannel.config[channelName]) {
      return dmChannel
    }
  }
}

async function populateConversation() {
  if (!this.populated('conversation')) {
    await this.populate('conversation')
  }
  await this.conversation.populate('channels')
}

// methods
adapterSchema.statics.getUniqueKeys = function (type: string) {
  const adapterType = adapterTypes[type]
  if (!adapterType) {
    throw new Error(`Unknown adapter type: ${type}`)
  }
  return adapterType.getUniqueKeys()
}

adapterSchema.method('start', async function () {
  await populateConversation.call(this)
  await adapterTypes[this.type].start.call(this)
  this.active = true
  await this.save()
})

adapterSchema.method('stop', async function () {
  await populateConversation.call(this)
  await adapterTypes[this.type].stop.call(this)
  this.active = false
  await this.save()
})

adapterSchema.method('receiveMessage', async function (message) {
  if (!this.active) {
    logger.warn(`Inactive adapter: ${this._id} received message`)
    return []
  }
  await populateConversation.call(this)

  const channels = await adapterTypes[this.type].getChannels.call(this, message)
  if (!channels.some((channel) => channel.direction === Direction.INCOMING || channel.direction === Direction.BOTH)) {
    logger.debug(`Message with no channel: ${JSON.stringify(message)}`)
    return []
  }

  return await adapterTypes[this.type].receiveMessage.call(this, message)
})

adapterSchema.method('sendMessage', async function (message) {
  if (!this.active) {
    logger.warn(`Attempt to send message through inactive adapter: ${this._id}`)
    return
  }
  // do not send messages back out to the source they arrived from
  if (message.source === this.type) {
    return
  }
  if (!message.channels) {
    return
  }

  await populateConversation.call(this)

  for (const channelName of message.channels) {
    logger.debug(`Evaluating channel ${channelName} for sending message through adapter ${this._id}`)
    const channel = getChannelConfigByName.call(this, channelName)
    if (channel) {
      if (!(channel.direction === Direction.OUTGOING || channel.direction === Direction.BOTH)) {
        logger.warn(`Attempt to send message on channel that does not support outgoing messages: ${channelName}`)
        return
      }
      logger.debug(`Sending message with channel ${channelName} through adapter ${this._id}`)
      const channelConfig = channel.direct ? channel.config[channelName] : channel.config
      await adapterTypes[this.type].sendMessage.call(this, message, channelConfig)
    }
  }
})
adapterSchema.method('participantJoined', async function (participant) {
  if (!this.active) {
    logger.warn(`Inactive adapter: ${this._id} received message`)
    return
  }
  await populateConversation.call(this)
  if (!this.conversation.enableDMs.includes('agents')) {
    logger.info(
      `Conversation ${this.conversation._id} does not have DMs enabled, not configuring direct channel for new participant.`
    )
    return
  }
  return await adapterTypes[this.type].participantJoined.call(this, participant)
})

adapterSchema.pre('validate', async function () {
  if (!adapterTypes[this.type]) throw new Error(`Unknown adapter type ${this.type}`)
  const { validateBeforeUpdate } = adapterTypes[this.type]
  if (validateBeforeUpdate) {
    await validateBeforeUpdate.call(this)
  }
})

export function setAdapterTypes(newAdapterTypes) {
  adapterTypes = newAdapterTypes
}

const Adapter = mongoose.model<IAdapter, AdapterModel>('Adapter', adapterSchema)

export type AdapterDocument = HydratedDocument<IAdapter> & AdapterMethods

export default Adapter

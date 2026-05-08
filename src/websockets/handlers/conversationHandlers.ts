import catchAsync from '../../utils/catchAsync.js'
import { checkAuth, getRoomId, getRoomIds } from '../utils.js'
import logger from '../../config/logger.js'
import authChannels from '../../utils/authChannels.js'
import { conversationService } from '../../services/index.js'
import { Conversation } from '../../models/index.js'
import { AgentResponse, IChannel } from '../../types/index.types.js'

async function collectChannelIntros(conversation, channelNames: string[]) {
  const intros: AgentResponse<string>[] = []
  for (const channelName of channelNames) {
    const channel = conversation.channels?.find((c) => c.name === channelName)
    if (!channel) continue
    for (const agent of conversation.agents) {
      const agentIntros = await agent.introduce(channel)
      intros.push(...agentIntros)
    }
  }
  return intros.map((intro) => ({
    ...intro,
    channels: intro.channels?.map((ch) => ch.name)
  }))
}

export default (io, socket) => {
  const joinUser = catchAsync(async (data) => {
    logger.debug('Joining user via socket. UserId = %s', data.user._id)
    socket.join(data.userId.toString())
  })
  const joinTopic = catchAsync(async (data) => {
    logger.debug('Joining topic via socket. TopicId = %s', data.topicId)
    socket.join(data.topicId.toString())
  })
  const joinChannel = catchAsync(async (data, callback) => {
    await authChannels([data.channel], data.conversationId.toString(), data.user)
    const roomId = getRoomId(data.conversationId.toString(), data.channel.name)
    logger.debug('Joining channel via socket. Room: %s', roomId)
    socket.join(roomId)
    const conversation = await Conversation.findOne({ _id: data.conversationId }).populate(['agents', 'channels'])
    const intros = await collectChannelIntros(conversation, [data.channel.name])
    if (typeof callback === 'function') callback({ intros })
  })
  const joinConversation = catchAsync(async (data, callback) => {
    const conversation = await conversationService.joinConversation(data.conversationId.toString(), data.user)

    // Support both single channel and array of channels
    const channels: IChannel[] = data.channels || []
    if (data.channel) {
      channels.push(data.channel)
    }

    if (channels.length > 0) {
      await authChannels(channels, data.conversationId.toString(), data.user)
      const channelNames = channels.map((ch) => ch.name)
      const roomIds = getRoomIds(data.conversationId.toString(), channelNames) as string[]

      roomIds.forEach((roomId) => {
        logger.debug('Joining conversation via socket. Room: %s', roomId)
        socket.join(roomId)
      })
      await conversation.populate(['agents', 'channels'])
      const intros = await collectChannelIntros(conversation, channelNames)
      if (typeof callback === 'function') callback({ intros })
    } else {
      const roomId = getRoomId(data.conversationId.toString())
      logger.debug('Joining conversation via socket. Room: %s', roomId)
      socket.join(roomId)
      if (typeof callback === 'function') callback({ intros: [] })
    }
  })
  socket.use(([event, args], next) => {
    logger.debug('Checking auth (JWT) for topic socket requests.')
    checkAuth(event, args, next)
  })
  socket.on('user:join', joinUser)
  socket.on('topic:join', joinTopic)
  socket.on('channel:join', joinChannel)
  socket.on('conversation:join', joinConversation)
  socket.on('topic:disconnect', () => {
    logger.info('Socket disconnecting from topic.')
    socket.disconnect(true)
  })
}

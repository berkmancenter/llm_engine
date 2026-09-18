import catchAsync from '../../utils/catchAsync.js'
import { checkAuth, getRoomId, getRoomIds } from '../utils.js'
import logger from '../../config/logger.js'
import authChannels from '../../utils/authChannels.js'
import { conversationService } from '../../services/index.js'
import { agentResponseToMessageData } from '../../services/message.service.js'
import { Conversation } from '../../models/index.js'
import { IChannel } from '../../types/index.types.js'
import introduceOnce from '../../services/agentIntroduction.service.js'

export async function collectChannelIntros(conversation, channelNames, user) {
  const intros: ReturnType<typeof agentResponseToMessageData>[] = []
  if (!conversation.active) return intros
  for (const channelName of channelNames) {
    const channel = conversation.channels?.find((c) => c.name === channelName)
    if (!channel) continue
    for (const agent of conversation.agents) {
      agent.conversation = conversation
      const agentIntros = await introduceOnce({ conversation, agent, channel, user })
      for (const intro of agentIntros) {
        intros.push(agentResponseToMessageData(intro, agent))
      }
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
    const startedAt = Date.now()
    await authChannels([data.channel], data.conversationId.toString(), data.user)
    const roomId = getRoomId(data.conversationId.toString(), data.channel.name)
    socket.join(roomId)
    const conversation = await Conversation.findOne({ _id: data.conversationId }).populate(['agents', 'channels'])
    const intros = await collectChannelIntros(conversation, [data.channel.name], data.user)
    logger.info(`Socket join: user ${data.user._id} joined room ${roomId} in ${Date.now() - startedAt}ms`)
    if (typeof callback === 'function') callback({ intros })
  })
  const joinConversation = catchAsync(async (data, callback) => {
    const startedAt = Date.now()
    const conversation = await conversationService.joinConversation(data.conversationId.toString(), data.user)

    // Support both single channel and array of channels
    const channels: IChannel[] = data.channels || []
    if (data.channel) {
      channels.push(data.channel)
    }

    // Always join the bare conversation room (receives conversation-level events e.g. resources:updated)
    const conversationRoomId = getRoomId(data.conversationId.toString())
    socket.join(conversationRoomId)

    let intros: Awaited<ReturnType<typeof collectChannelIntros>> = []
    if (channels.length > 0) {
      await authChannels(channels, data.conversationId.toString(), data.user)
      const channelNames = channels.map((ch) => ch.name)
      const roomIds = getRoomIds(data.conversationId.toString(), channelNames) as string[]
      roomIds.forEach((roomId) => socket.join(roomId))
      await conversation.populate(['agents', 'channels'])
      intros = await collectChannelIntros(conversation, channelNames, data.user)
    }
    // Timed through the agent intros: those LLM calls are the slow part of a join, not the room membership
    logger.info(
      `Socket join: user ${data.user._id} joined room ${conversationRoomId} (${channels.length} channels) in ${
        Date.now() - startedAt
      }ms`
    )
    if (typeof callback === 'function') callback({ intros })
  })
  /* Only the bare room: Socket.io gives a client no room attribution on a received event,
     so a client moving between conversations has to leave the old room to stop hearing
     conversation-level events for it. Channel rooms are still dropped on disconnect. */
  const leaveConversation = catchAsync(async (data) => {
    const roomId = getRoomId(data.conversationId.toString())
    logger.debug('Leaving conversation via socket. Room: %s', roomId)
    socket.leave(roomId)
  })
  socket.use(([event, args], next) => {
    logger.debug('Checking auth (JWT) for topic socket requests.')
    checkAuth(event, args, next)
  })
  socket.on('user:join', joinUser)
  socket.on('topic:join', joinTopic)
  socket.on('channel:join', joinChannel)
  socket.on('conversation:join', joinConversation)
  socket.on('conversation:leave', leaveConversation)
  socket.on('topic:disconnect', () => {
    logger.info('Socket disconnecting from topic.')
    socket.disconnect(true)
  })
}

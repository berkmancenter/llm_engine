import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { Conversation, ConversationMembership } from '../models/index.js'
import ApiError from './ApiError.js'

export default async function assertMembership(user, conversationOrId) {
  if (!user) throw new ApiError(httpStatus.UNAUTHORIZED, 'Authentication required.')
  if (user.role === 'admin') return

  let enforceMembership: boolean | undefined
  let conversationId: string

  if (typeof conversationOrId === 'string' || conversationOrId instanceof mongoose.Types.ObjectId) {
    conversationId = conversationOrId.toString()
    const conv = await Conversation.findById(conversationId).select('enforceMembership').lean()
    enforceMembership = conv?.enforceMembership
  } else {
    conversationId = conversationOrId._id.toString()
    enforceMembership = conversationOrId.enforceMembership
  }

  if (!enforceMembership) return

  const isMember = await ConversationMembership.exists({ conversation: conversationId, userAccount: user._id })
  if (!isMember) throw new ApiError(httpStatus.FORBIDDEN, 'You are not a member of this conversation.')
}

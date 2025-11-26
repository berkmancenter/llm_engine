import jwt from 'jsonwebtoken'
import config from '../config/config.js'
import catchAsync from '../utils/catchAsync.js'
import User from '../models/user.model/user.model.js'

export const checkAuth = catchAsync(async (event, args, next) => {
  const payload = jwt.verify(args.token, config.jwt.secret)
  // eslint-disable-next-line no-param-reassign
  args.user = await User.findById(payload.sub)
  next()
})

export function getRoomId(conversation: string, channel?: string) {
  // keep it compatible with conversation only systems like nymspace
  return `${conversation}${channel ? `_${channel}` : ''}`
}

export function getRoomIds(conversation: string, channels?: string[]) {
  if (channels) {
    return channels.map((channel) => getRoomId(conversation, channel))
  }
  return getRoomId(conversation)
}

export default {
  checkAuth,
  getRoomId,
  getRoomIds
}

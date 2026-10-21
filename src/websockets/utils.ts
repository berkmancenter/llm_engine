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

/* Admin-only room for a conversation: `admin:<conversation>`. Channel names are free text, so no
   separator can be kept out of them; the prefix does the work instead. Every other room name (bare
   conversation, `<conversation>_<channel>`, a user id, a topic id) starts with a 24-hex ObjectId, and
   "admin:" is not hex, so no channel name or id can ever produce this room name. */
export function getAdminRoomId(conversation: string) {
  return `admin:${conversation}`
}

/* Tracks which sockets of one user sit in an admin room, so a role change can find them without knowing which
   conversations they joined. Starts with "moderator:", which no ObjectId-based room name does. */
export function getModeratorTrackerRoomId(userId: string) {
  return `moderator:${userId}`
}

export const isAdminRoom = (room: string) => room.startsWith('admin:')

export function getRoomIds(conversation: string, channels?: string[]) {
  if (channels) {
    return channels.map((channel) => getRoomId(conversation, channel))
  }
  return getRoomId(conversation)
}

export default {
  checkAuth,
  getRoomId,
  getRoomIds,
  getAdminRoomId,
  getModeratorTrackerRoomId,
  isAdminRoom
}

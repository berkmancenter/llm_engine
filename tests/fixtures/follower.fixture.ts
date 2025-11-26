import mongoose from 'mongoose'
import Follower from '../../src/models/follower.model.js'
import { userOne } from './user.fixture.js'
import { conversationThree } from './conversation.fixture.js'

const conversationFollow = {
  _id: new mongoose.Types.ObjectId(),
  user: userOne._id,
  conversation: conversationThree._id
}

const insertFollowers = async (followers) => {
  const ret = await Follower.insertMany(followers)
  return ret
}

export { conversationFollow, insertFollowers }

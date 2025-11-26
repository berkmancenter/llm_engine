/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'
import faker from 'faker'
import Conversation from '../../src/models/conversation.model.js'
import Channel from '../../src/models/channel.model.js'
import { userOne, userTwo, registeredUser } from './user.fixture.js'
import { newPublicTopic, newPrivateTopic } from './topic.fixture.js'

const publicTopic = newPublicTopic()
const privateTopic = newPrivateTopic()

const nameSlug1 = faker.lorem.word().toLowerCase()
const nameSlug2 = faker.lorem.word().toLowerCase()
const nameSlug3 = faker.lorem.word().toLowerCase()
const nameSlug4 = faker.lorem.word().toLowerCase()
const nameSlug5 = faker.lorem.word().toLowerCase()

const conversationOne: any = {
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug1,
  slug: nameSlug1,
  owner: userOne._id,
  topic: publicTopic._id,
  agents: [],
  messages: []
}

const conversationTwo: any = {
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug2,
  slug: nameSlug2,
  owner: userOne._id,
  topic: privateTopic._id,
  messages: []
}

const conversationThree: any = {
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug3,
  slug: nameSlug3,
  owner: userTwo._id,
  topic: privateTopic._id,
  messages: []
}

const experimentalConversation: any = {
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug3,
  slug: nameSlug3,
  owner: userOne._id,
  topic: publicTopic._id,
  messages: [],
  experimental: true
}

const conversationAgentsEnabled = {
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug4,
  owner: registeredUser._id,
  topic: publicTopic._id,
  enableAgents: true,
  agents: [],
  messages: []
}

const conversationWithChannels: any = {
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug5,
  owner: registeredUser._id,
  topic: publicTopic._id,
  enableAgents: true,
  agents: [],
  messages: [],
  channels: [
    { name: 'channel1', passcode: 'Channel1_CoDe' },
    { name: 'channel2', passcode: 'channel2_CODE' },
    { name: 'channel3', passcode: null, direct: true, participants: [registeredUser._id, new mongoose.Types.ObjectId()] }
  ]
}

const insertConversations = async (conversations) => Conversation.insertMany(conversations)

const insertChannels = async (channels) => Channel.insertMany(channels)

export {
  conversationOne,
  conversationTwo,
  conversationThree,
  experimentalConversation,
  insertConversations,
  insertChannels,
  publicTopic,
  privateTopic,
  conversationAgentsEnabled,
  conversationWithChannels
}

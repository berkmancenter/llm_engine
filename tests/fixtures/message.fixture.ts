/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'
import faker from 'faker'
import Message from '../../src/models/message.model.js'
import { registeredUser } from './user.fixture.js'
import { conversationOne, conversationTwo, conversationThree, conversationWithChannels } from './conversation.fixture.js'

const messageOne: any = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationOne._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym
}

const messageTwo: any = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationTwo._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym
}

const messageThree: any = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationTwo._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym
}

const messageFour: any = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationThree._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym
}

const invisibleMessage: any = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationThree._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  visible: false
}

const messagePost = {
  body: faker.lorem.words(10),
  conversation: conversationOne._id
}

// for channel message tests
const messageChannelIncorrect = {
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  channels: [
    {
      name: 'channel1',
      passcode: 'bad_channel_code'
    }
  ]
}

const messageChannelCorrect = {
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  channels: [
    {
      name: 'channel1',
      passcode: 'Channel1_CoDe'
    }
  ]
}

const messageChannelDirect = {
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  channels: [
    {
      name: 'channel3'
    }
  ]
}

const visibleMessageTC = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  visible: true
}

const invisibleMessageTC = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  visible: false
}

const postVisibleChannelMessageTC = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  channels: [
    {
      name: 'channel2',
      passcode: 'channel2_CODE'
    }
  ],
  visible: true
}

const visibleChannelMessageTC = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  channels: ['channel2'],
  visible: true
}

const postInvisibleChannelMessageTC = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  channels: [
    {
      channel: 'channel2',
      passcode: 'channel2_CODE'
    }
  ],
  visible: false
}

const invisibleChannelMessageTC = {
  _id: new mongoose.Types.ObjectId(),
  body: faker.lorem.words(10),
  conversation: conversationWithChannels._id,
  owner: registeredUser._id,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  channels: ['channel2'],
  visible: false
}

const insertMessages = async (msgs) => Message.insertMany(msgs)

export {
  messageOne,
  messageTwo,
  messageThree,
  messageFour,
  invisibleMessage,
  messagePost,
  messageChannelIncorrect,
  messageChannelCorrect,
  messageChannelDirect,
  visibleMessageTC,
  invisibleMessageTC,
  visibleChannelMessageTC,
  postVisibleChannelMessageTC,
  invisibleChannelMessageTC,
  postInvisibleChannelMessageTC,
  insertMessages
}

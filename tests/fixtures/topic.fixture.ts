import mongoose from 'mongoose'
import faker from 'faker'
import Topic from '../../src/models/topic.model.js'
import { userOne } from './user.fixture.js'

const nameSlug = faker.lorem.word().toLowerCase()
const getRandomInt = (origMin, origMax) => {
  const min = Math.ceil(origMin)
  const max = Math.floor(origMax)
  return Math.floor(Math.random() * (max - min) + min)
}

const topicPost = {
  name: nameSlug,
  votingAllowed: true,
  conversationCreationAllowed: true,
  private: false,
  archivable: true,
  archiveEmail: faker.internet.email()
}

const newPublicTopic = () => ({
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug,
  slug: nameSlug,
  votingAllowed: true,
  conversationCreationAllowed: true,
  private: false,
  archivable: true,
  archived: false,
  owner: userOne._id,
  isDeleted: false,
  isArchiveNotified: false,
  conversations: []
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const newPrivateTopic: any = () => ({
  _id: new mongoose.Types.ObjectId(),
  name: nameSlug,
  slug: nameSlug,
  votingAllowed: false,
  conversationCreationAllowed: false,
  private: true,
  passcode: getRandomInt(1000000, 9999999),
  archivable: true,
  archived: false,
  owner: userOne._id,
  isDeleted: false,
  isArchiveNotified: false,
  conversations: []
})

const insertTopics = async (topics) => {
  await Topic.insertMany(topics)
}

export { newPublicTopic, newPrivateTopic, topicPost, insertTopics, getRandomInt }

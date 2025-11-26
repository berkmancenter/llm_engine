import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import faker from 'faker'
import { User } from '../../src/models/index.js'

const password = 'password1'
const salt = bcrypt.genSaltSync(8)
const hashedPassword = bcrypt.hashSync(password, salt)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userOne: any = {
  _id: new mongoose.Types.ObjectId(),
  username: faker.name.findName(),
  email: faker.internet.email().toLowerCase(),
  password,
  role: 'user',
  isEmailVerified: false
}

const userTwo = {
  _id: new mongoose.Types.ObjectId(),
  username: faker.name.findName(),
  email: faker.internet.email().toLowerCase(),
  password,
  role: 'user',
  isEmailVerified: false
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registeredUser: any = {
  _id: new mongoose.Types.ObjectId(),
  username: faker.name.findName(),
  email: faker.internet.email().toLowerCase(),
  password,
  role: 'user',
  isEmailVerified: false,
  pseudonyms: [
    {
      _id: new mongoose.Types.ObjectId(),
      token:
        '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
      pseudonym: 'Boring Badger',
      active: 'true'
    }
  ]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin: any = {
  _id: new mongoose.Types.ObjectId(),
  name: faker.name.findName(),
  email: faker.internet.email().toLowerCase(),
  password,
  role: 'admin',
  isEmailVerified: false
}

const insertUsers = async (users) => {
  const ret = await User.insertMany(users.map((user) => ({ ...user, password: hashedPassword })))
  return ret
}

export { userOne, userTwo, registeredUser, admin, insertUsers }

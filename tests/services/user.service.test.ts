import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { insertMessages, messageOne } from '../fixtures/message.fixture.js'
import userService from '../../src/services/user.service.js'

setupIntTest()

const createVote = () => ({
  _id: new mongoose.Types.ObjectId(),
  owner: new mongoose.Types.ObjectId()
})

describe('User service methods', () => {
  describe('createUser()', () => {
    test('should create a user with hashed password and pseudonym with admin role', async () => {
      const userBody = {
      username: 'testuser',
      password: 'password123',
      token: 'sometoken',
      pseudonym: 'Bold Aardvark',
      email: 'test@example.com',
      role: 'admin'
      }

      const user = await userService.createUser(userBody)

      expect(user).toBeDefined()
      expect(user.username).toBe(userBody.username)
      expect(user.email).toBe(userBody.email)
      expect(user.password).not.toBe(userBody.password)
      expect(user.pseudonyms).toHaveLength(1)
      expect(user.pseudonyms[0].token).toBe(userBody.token)
      expect(user.pseudonyms[0].pseudonym).toBe(userBody.pseudonym)
      expect(user.pseudonyms[0].active).toBe(true)
      expect(user.role).toBe('admin')
    })

    test('should create a user without email if not provided', async () => {
      const userBody = {
      username: 'testuser2',
      password: 'password123',
      token: 'sometoken2',
      pseudonym: 'Brave Beaver'
      }

      const user = await userService.createUser(userBody)

      expect(user).toBeDefined()
      expect(user.username).toBe(userBody.username)
      expect(user.email).toBeUndefined()
      expect(user.role).toBe('admin')
    })

    test('should create a user without password if not provided', async () => {
      const userBody = {
      username: 'testuser3',
      token: 'sometoken3',
      pseudonym: 'Calm Cobra'
      }

      const user = await userService.createUser(userBody)

      expect(user).toBeDefined()
      expect(user.username).toBe(userBody.username)
      expect(user.password).toBeUndefined()
      expect(user.role).toBe('admin')
    })
    })
  
  describe('goodReputation()', () => {
    beforeEach(() => {
      // Add five upvotes
      messageOne.upVotes = []
      for (let x = 0; x < 5; x++) {
        messageOne.upVotes.push(createVote())
      }
    })

    test('should return true if user vote score < -5 and account is more than 1 week old', async () => {
      // Set created date to > week ago
      const d = new Date()
      d.setDate(d.getDate() - 8)
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      await insertMessages([messageOne])

      registeredUser.id = registeredUser._id
      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(true)
    })

    test('should return false if user vote score < -5', async () => {
      // Set created date to > week ago
      const d = new Date()
      d.setDate(d.getDate() - 8)
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      messageOne.downVotes = []
      // Add eleven downvotes
      for (let x = 0; x < 11; x++) {
        messageOne.downVotes.push(createVote())
      }
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })

    test('should return false if user account is less than one week old', async () => {
      // Set created date to > week ago
      const d = new Date()
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })

    test('should return false if user account is less than one week old user vote score < -5', async () => {
      // Set created date to > week ago
      const d = new Date()
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      messageOne.downVotes = []
      // Add eleven downvotes
      for (let x = 0; x < 11; x++) {
        messageOne.downVotes.push(createVote())
      }
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })
  })
})

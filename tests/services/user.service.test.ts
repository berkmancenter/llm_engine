/* eslint-disable no-console */
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { insertMessages, messageOne } from '../fixtures/message.fixture.js'
import userService from '../../src/services/user.service.js'
import { User } from '../../src/models/index.js'
import config from '../../src/config/config.js'

setupIntTest()

jest.setTimeout(30000)

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

    test('should generate and store a fun fact for the initial pseudonym', async () => {
      const user = await userService.createUser({ username: 'u1', token: 't1', pseudonym: 'Bold Aardvark' })
      console.log('createUser fun fact:', user.pseudonyms[0].funFact)
      expect(user.pseudonyms[0].funFact).toBeDefined()
    })

    test('should skip fun fact generation when trulyRandomPseudonyms is enabled', async () => {
      const original = config.trulyRandomPseudonyms
      config.trulyRandomPseudonyms = 'true'
      try {
        const user = await userService.createUser({ username: 'u2', token: 't2', pseudonym: 'Woodpecker_e65ddfe1d20' })
        expect(user.pseudonyms[0].funFact).toBeUndefined()
      } finally {
        config.trulyRandomPseudonyms = original
      }
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

  describe('addPseudonym()', () => {
    test('should generate and store a fun fact for the added pseudonym', async () => {
      const user = await User.create({
        username: 'addtest',
        pseudonyms: [{ token: 'tok1', pseudonym: 'Calm Cobra', active: true }],
        role: 'admin'
      })
      await userService.addPseudonym({ token: 'tok2', pseudonym: 'Brave Beaver' }, { id: user._id })
      const updated = await User.findById(user._id)
      const added = updated!.pseudonyms.find((p) => p.pseudonym === 'Brave Beaver')
      console.log('addPseudonym fun fact:', added!.funFact)
      expect(added!.funFact).toBeDefined()
    })
  })

  describe('activatePseudonym()', () => {
    test('should generate a fun fact when activating a pseudonym that does not have one', async () => {
      const user = await User.create({
        username: 'activatetest',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          { token: 'tok2', pseudonym: 'Brave Beaver', active: false }
        ],
        role: 'admin'
      })
      await userService.activatePseudonym({ token: 'tok2' }, { id: user._id })
      const updated = await User.findById(user._id)
      const activated = updated!.pseudonyms.find((p) => p.token === 'tok2')
      console.log('activatePseudonym fun fact:', activated!.funFact)
      expect(activated!.funFact).toBeDefined()
    })

    test('should not regenerate a fun fact when activating a pseudonym that already has one', async () => {
      const existingFact = 'Fun Fact about your pseudonym: existing fact'
      const user = await User.create({
        username: 'activatetest2',
        pseudonyms: [
          { token: 'tok1', pseudonym: 'Calm Cobra', active: true },
          { token: 'tok2', pseudonym: 'Brave Beaver', active: false, funFact: existingFact }
        ],
        role: 'admin'
      })
      await userService.activatePseudonym({ token: 'tok2' }, { id: user._id })
      const updated = await User.findById(user._id)
      const activated = updated!.pseudonyms.find((p) => p.token === 'tok2')
      expect(activated!.funFact).toBe(existingFact)
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
      const d = new Date()
      d.setDate(d.getDate() - 8)
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      messageOne.downVotes = []
      for (let x = 0; x < 11; x++) {
        messageOne.downVotes.push(createVote())
      }
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })

    test('should return false if user account is less than one week old', async () => {
      const d = new Date()
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })

    test('should return false if user account is less than one week old user vote score < -5', async () => {
      const d = new Date()
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      messageOne.downVotes = []
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

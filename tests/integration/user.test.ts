import request from 'supertest'
import faker from 'faker'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import app from '../../src/app.js'
import setupIntTest from '../utils/setupIntTest.js'
import { User } from '../../src/models/index.js'
import { insertUsers, registeredUser, userOne } from '../fixtures/user.fixture.js'
import { registeredUserAccessToken, userOneAccessToken } from '../fixtures/token.fixture.js'
import { insertMessages, messageOne } from '../fixtures/message.fixture.js'
import userService from '../../src/services/user.service.js'
import config from '../../src/config/config.js'

const createPseudo = () => ({
  _id: new mongoose.Types.ObjectId(),
  token: faker.datatype.uuid(),
  pseudonym: faker.name.findName(),
  active: false,
  isDeleted: false
})

const createVote = () => ({
  _id: new mongoose.Types.ObjectId(),
  owner: new mongoose.Types.ObjectId()
})

setupIntTest()

describe('User routes', () => {
  describe('GET v1/users/user/:userId', () => {
    test('should return 200 with user body', async () => {
      await insertUsers([registeredUser])
      const ret = await request(app)
        .get(`/v1/users/user/${registeredUser._id}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(ret.body.username).toEqual(registeredUser.username)
    })

    test('should return 401 if user is requesting a different user id', async () => {
      await insertUsers([registeredUser, userOne])
      await request(app)
        .get(`/v1/users/user/${userOne._id}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.UNAUTHORIZED)
    })
  })

  describe('POST v1/users/pseudonyms', () => {
    let newPseudo
    beforeEach(async () => {
      newPseudo = {
        token: userService.newToken(),
        pseudonym: await userService.newPseudonym(0)
      }
    })

    test('should return 201 and successfully create pseudonym', async () => {
      await insertUsers([registeredUser])
      const ret = await request(app)
        .post('/v1/users/pseudonyms')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(newPseudo)
        .expect(httpStatus.CREATED)

      const activePseudo = ret.body.find((x) => x.active)
      expect(activePseudo.token).toBe(newPseudo.token)
    })

    test('should return 200 and activate pseudonym', async () => {
      await insertUsers([registeredUser])
      await request(app)
        .post('/v1/users/pseudonyms')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(newPseudo)

      const ret = await request(app)
        .put('/v1/users/pseudonyms/activate')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          token: registeredUser.pseudonyms[0].token
        })
        .expect(httpStatus.OK)

      expect(ret.body).toHaveLength(2)
      const activePseudo = ret.body.find((x) => x.active)
      expect(activePseudo.token).toBe(registeredUser.pseudonyms[0].token)
    })

    test('should return 500 if user already has 5 pseudonyms', async () => {
      userOne.pseudonyms = []
      for (let x = 0; x < 5; x++) {
        userOne.pseudonyms.push(createPseudo())
      }

      await insertUsers([userOne])
      await request(app)
        .post('/v1/users/pseudonyms')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(newPseudo)
        .expect(httpStatus.INTERNAL_SERVER_ERROR)
    })
  })

  describe('GET v1/users/pseudonyms', () => {
    test('should return 200 and with pseudonyms as body', async () => {
      await insertUsers([registeredUser])
      const ret = await request(app)
        .get('/v1/users/pseudonyms')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(ret.body).toHaveLength(1)
    })
  })

  describe('DELETE v1/users/pseudonyms/:pseudonymId', () => {
    test('should return 200 and hard delete Pseudonym without messages', async () => {
      await insertUsers([registeredUser])
      const pseudoId = registeredUser.pseudonyms[0]._id
      await request(app)
        .delete(`/v1/users/pseudonyms/${pseudoId}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      const user = await User.findById(registeredUser._id)
      expect(user!.pseudonyms).toHaveLength(0)
    })

    test('should return 200 and soft delete Pseudonym with messages', async () => {
      await insertUsers([registeredUser])
      const pseudoId = registeredUser.pseudonyms[0]._id
      await insertMessages([messageOne])
      await request(app)
        .delete(`/v1/users/pseudonyms/${pseudoId}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      const user = await User.findById(registeredUser._id)
      expect(user!.pseudonyms).toHaveLength(1)
      expect(user!.pseudonyms[0].isDeleted).toBe(true)
    })
  })

  describe('PUT v1/users/', () => {
    let email
    let username
    let password
    beforeEach(async () => {
      email = faker.internet.email().toLowerCase()
      username = faker.internet.userName()
      password = 'testing123!'
      await insertUsers([registeredUser])
    })

    test('should return 200 and successfully update the user', async () => {
      await request(app)
        .put('/v1/users')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          userId: registeredUser._id,
          email,
          username,
          password
        })
        .expect(httpStatus.OK)

      const user = await User.findById(registeredUser._id)
      expect(user!.email).toEqual(email)
      expect(user!.username).toEqual(username)
      const match = await bcrypt.compare(password, user!.password)
      expect(match).toBe(true)
    })

    test('should return 400 if userId is not sent in request body', async () => {
      await request(app)
        .put('/v1/users')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          email,
          username,
          password
        })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 404 if userId is not found in db', async () => {
      await request(app)
        .put('/v1/users')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          userId: new mongoose.Types.ObjectId(),
          email,
          username,
          password
        })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 409 if email is already in use', async () => {
      await insertUsers([userOne])
      await request(app)
        .put('/v1/users')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          userId: registeredUser._id,
          email: userOne.email,
          username,
          password
        })
        .expect(httpStatus.CONFLICT)
    })

    test('should return 409 if username is already in use', async () => {
      await insertUsers([userOne])
      await request(app)
        .put('/v1/users')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          userId: registeredUser._id,
          email,
          username: userOne.username,
          password
        })
        .expect(httpStatus.CONFLICT)
    })
  })
})

describe('User service', () => {
  describe('goodReputation()', () => {
    beforeEach(() => {
      // Add five upvotes
      messageOne.upVotes = []
      for (let x = 0; x < 5; x++) {
        messageOne.upVotes.push(createVote())
      }
    })

    test('should return true if user vote score < -5 and account is more than DAYS_FOR_GOOD_REPUTATION old', async () => {
      // Set created date to > week ago
      const d = new Date()
      d.setDate(d.getDate() - (config.DAYS_FOR_GOOD_REPUTATION + 1))
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
      d.setDate(d.getDate() - (config.DAYS_FOR_GOOD_REPUTATION + 1))
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

    test('should return false if user account is less than DAYS_FOR_GOOD_REPUTATION old', async () => {
      const d = new Date()
      registeredUser.createdAt = d.toISOString()
      await insertUsers([registeredUser])
      await insertMessages([messageOne])
      registeredUser.id = registeredUser._id

      const goodReputation = await userService.goodReputation(registeredUser)
      expect(goodReputation).toBe(false)
    })

    test('should return false if user account is less DAYS_FOR_GOOD_REPUTATION old and user vote score < -5', async () => {
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

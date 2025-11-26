import request from 'supertest'
import faker from 'faker'
import httpStatus from 'http-status'
import httpMocks from 'node-mocks-http'
import moment from 'moment'
import bcrypt from 'bcryptjs'
import app from '../../src/app.js'
import config from '../../src/config/config.js'
import auth from '../../src/middlewares/auth.js'
import { tokenService, emailService, userService } from '../../src/services/index.js'
import ApiError from '../../src/utils/ApiError.js'
import setupIntTest from '../utils/setupIntTest.js'
import { User, Token } from '../../src/models/index.js'
import { roleRights } from '../../src/config/roles.js'
import tokenTypes from '../../src/config/tokens.js'
import { userOne, admin, insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { userOneAccessToken, adminAccessToken } from '../fixtures/token.fixture.js'

setupIntTest()

describe('Auth routes', () => {
  describe('POST /v1/auth/register', () => {
    let newUser
    beforeEach(() => {
      newUser = {
        username: faker.internet.email().toLowerCase(),
        password: 'password1',
        token: userService.newToken(),
        pseudonym: faker.name.findName(),
        email: faker.internet.email()
      }
    })

    test('should return 201 and successfully register user if request data is ok', async () => {
      const res = await request(app).post('/v1/auth/register').send(newUser).expect(httpStatus.CREATED)

      expect(res.body.user).not.toHaveProperty('password')
      expect(res.body.user.role).toEqual('user')
      expect(res.body.user.pseudonyms).toHaveLength(1)
      expect(res.body.user.pseudonyms[0].active).toBe(true)

      const dbUser = await User.findById(res.body.user.id)
      expect(dbUser).toBeDefined()

      expect(res.body.tokens).toEqual({
        access: { token: expect.anything(), expires: expect.anything() },
        refresh: { token: expect.anything(), expires: expect.anything() }
      })
    })

    test('should return 400 error if username is already used', async () => {
      await insertUsers([userOne])
      newUser.username = userOne.username

      await request(app).post('/v1/auth/register').send(newUser).expect(httpStatus.CONFLICT)
    })

    test('should return 409 error if email is already used', async () => {
      await insertUsers([userOne])
      newUser.email = userOne.email

      await request(app).post('/v1/auth/register').send(newUser).expect(httpStatus.CONFLICT)
    })

    test('should return 409 error if password length is less than 8 characters', async () => {
      newUser.password = 'passwo1'

      await request(app).post('/v1/auth/register').send(newUser).expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 error if password does not contain both letters and numbers', async () => {
      newUser.password = 'password'

      await request(app).post('/v1/auth/register').send(newUser).expect(httpStatus.BAD_REQUEST)

      newUser.password = '11111111'

      await request(app).post('/v1/auth/register').send(newUser).expect(httpStatus.BAD_REQUEST)
    })
  })

  describe('POST /v1/auth/login', () => {
    test('should return 200 and login user if email and password match', async () => {
      await insertUsers([registeredUser])
      const loginCredentials = {
        username: registeredUser.username,
        password: registeredUser.password
      }

      const res = await request(app).post('/v1/auth/login').send(loginCredentials).expect(httpStatus.OK)

      expect(res.body.user).not.toHaveProperty('password')
      expect(res.body.user.role).toEqual('user')
      expect(res.body.user.pseudonyms).toHaveLength(1)
      expect(res.body.user.pseudonyms[0].active).toBe(true)

      expect(res.body.tokens).toEqual({
        access: { token: expect.anything(), expires: expect.anything() },
        refresh: { token: expect.anything(), expires: expect.anything() }
      })
    })

    test('should return 401 error if there are no users with that email', async () => {
      const loginCredentials = {
        username: userOne.username,
        password: userOne.password
      }

      const res = await request(app).post('/v1/auth/login').send(loginCredentials).expect(httpStatus.UNAUTHORIZED)

      expect(res.body).toEqual({ code: httpStatus.UNAUTHORIZED, message: 'Incorrect username or password' })
    })

    test('should return 401 error if password is wrong', async () => {
      await insertUsers([userOne])
      const loginCredentials = {
        username: userOne.username,
        password: 'wrongPassword1'
      }

      const res = await request(app).post('/v1/auth/login').send(loginCredentials).expect(httpStatus.UNAUTHORIZED)

      expect(res.body).toEqual({ code: httpStatus.UNAUTHORIZED, message: 'Incorrect username or password' })
    })
  })

  describe('POST /v1/auth/logout', () => {
    test('should return 204 if refresh token is valid', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)
      await tokenService.saveToken(refreshToken, userOne._id, expires, tokenTypes.REFRESH)

      await request(app).post('/v1/auth/logout').send({ refreshToken }).expect(httpStatus.NO_CONTENT)

      const dbRefreshTokenDoc = await Token.findOne({ token: refreshToken })
      expect(dbRefreshTokenDoc).toBe(null)
    })

    test('should return 400 error if refresh token is missing from request body', async () => {
      await request(app).post('/v1/auth/logout').send().expect(httpStatus.BAD_REQUEST)
    })

    test('should return 404 error if refresh token is not found in the database', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)

      await request(app).post('/v1/auth/logout').send({ refreshToken }).expect(httpStatus.NOT_FOUND)
    })

    test('should return 404 error if refresh token is blacklisted', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)
      await tokenService.saveToken(refreshToken, userOne._id, expires, tokenTypes.REFRESH, true)

      await request(app).post('/v1/auth/logout').send({ refreshToken }).expect(httpStatus.NOT_FOUND)
    })
  })

  describe('POST /v1/auth/refresh-tokens', () => {
    test('should return 200 and new auth tokens if refresh token is valid', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)
      await tokenService.saveToken(refreshToken, userOne._id, expires, tokenTypes.REFRESH)

      const res = await request(app).post('/v1/auth/refresh-tokens').send({ refreshToken }).expect(httpStatus.OK)

      expect(res.body).toEqual({
        access: { token: expect.anything(), expires: expect.anything() },
        refresh: { token: expect.anything(), expires: expect.anything() }
      })

      const dbRefreshTokenDoc = await Token.findOne({ token: res.body.refresh.token })
      expect(dbRefreshTokenDoc).toMatchObject({ type: tokenTypes.REFRESH, user: userOne._id, blacklisted: false })

      const dbRefreshTokenCount = await Token.countDocuments()
      expect(dbRefreshTokenCount).toBe(1)
    })

    test('should return 400 error if refresh token is missing from request body', async () => {
      await request(app).post('/v1/auth/refresh-tokens').send().expect(httpStatus.BAD_REQUEST)
    })

    test('should return 401 error if refresh token is signed using an invalid secret', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH, 'invalidSecret')
      await tokenService.saveToken(refreshToken, userOne._id, expires, tokenTypes.REFRESH)

      await request(app).post('/v1/auth/refresh-tokens').send({ refreshToken }).expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 401 error if refresh token is not found in the database', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)

      await request(app).post('/v1/auth/refresh-tokens').send({ refreshToken }).expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 401 error if refresh token is blacklisted', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)
      await tokenService.saveToken(refreshToken, userOne._id, expires, tokenTypes.REFRESH, true)

      await request(app).post('/v1/auth/refresh-tokens').send({ refreshToken }).expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 401 error if refresh token is expired', async () => {
      await insertUsers([userOne])
      const expires = moment().subtract(1, 'minutes')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)
      await tokenService.saveToken(refreshToken, userOne._id, expires, tokenTypes.REFRESH)

      await request(app).post('/v1/auth/refresh-tokens').send({ refreshToken }).expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 401 error if user is not found', async () => {
      const expires = moment().add(config.jwt.refreshExpirationDays, 'days')
      const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)
      await tokenService.saveToken(refreshToken, userOne._id, expires, tokenTypes.REFRESH)

      await request(app).post('/v1/auth/refresh-tokens').send({ refreshToken }).expect(httpStatus.UNAUTHORIZED)
    })
  })

  describe('POST /v1/auth/forgotPassword', () => {
    beforeEach(() => {
      jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue()
    })

    test('should return 204 and send reset password email to the user', async () => {
      await insertUsers([userOne])
      const sendResetPasswordEmailSpy = jest.spyOn(emailService, 'sendPasswordResetEmail')

      await request(app).post('/v1/auth/forgotPassword').send({ email: userOne.email }).expect(httpStatus.NO_CONTENT)

      expect(sendResetPasswordEmailSpy).toHaveBeenCalledWith(userOne.email, expect.any(String), expect.any(Function))
      const resetPasswordToken = sendResetPasswordEmailSpy.mock.calls[0][1]
      const dbResetPasswordTokenDoc = await Token.findOne({ token: resetPasswordToken, user: userOne._id })
      expect(dbResetPasswordTokenDoc).toBeDefined()
    })

    test('should return 400 if email is missing', async () => {
      await insertUsers([userOne])

      await request(app).post('/v1/auth/forgotPassword').send().expect(httpStatus.BAD_REQUEST)
    })
  })

  describe('POST /v1/auth/resetPassword', () => {
    test('should return 204 and reset the password', async () => {
      await insertUsers([registeredUser])
      const expires = moment().add(config.jwt.resetPasswordExpirationMinutes, 'minutes')
      const resetPasswordToken = tokenService.generateToken(registeredUser._id, expires, tokenTypes.RESET_PASSWORD)
      await tokenService.saveToken(resetPasswordToken, registeredUser._id, expires, tokenTypes.RESET_PASSWORD)

      await request(app)
        .post('/v1/auth/resetPassword')
        .send({ password: 'testing123', token: resetPasswordToken })
        .expect(httpStatus.NO_CONTENT)

      const dbUser = await User.findById(registeredUser._id)
      const isPasswordMatch = await bcrypt.compare('testing123', dbUser!.password)
      expect(isPasswordMatch).toBe(true)

      const dbResetPasswordTokenCount = await Token.countDocuments({
        user: registeredUser._id,
        type: tokenTypes.RESET_PASSWORD
      })
      expect(dbResetPasswordTokenCount).toBe(0)
    })

    test('should return 400 if reset password token is missing', async () => {
      await insertUsers([userOne])

      await request(app).post('/v1/auth/resetPassword').send({ password: 'password2' }).expect(httpStatus.BAD_REQUEST)
    })

    test('should return 500 if reset password token is blacklisted', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.resetPasswordExpirationMinutes, 'minutes')
      const resetPasswordToken = tokenService.generateToken(userOne._id, expires, tokenTypes.RESET_PASSWORD)
      await tokenService.saveToken(resetPasswordToken, userOne._id, expires, tokenTypes.RESET_PASSWORD, true)

      await request(app)
        .post('/v1/auth/resetPassword')
        .send({ password: 'testing123', token: resetPasswordToken })
        .expect(httpStatus.INTERNAL_SERVER_ERROR)
    })

    test('should return 500 if reset password token is expired', async () => {
      await insertUsers([userOne])
      const expires = moment().subtract(1, 'minutes')
      const resetPasswordToken = tokenService.generateToken(userOne._id, expires, tokenTypes.RESET_PASSWORD)
      await tokenService.saveToken(resetPasswordToken, userOne._id, expires, tokenTypes.RESET_PASSWORD)

      await request(app)
        .post('/v1/auth/resetPassword')
        .send({ password: 'testing123', token: resetPasswordToken })
        .expect(httpStatus.INTERNAL_SERVER_ERROR)
    })

    test('should return 401 if user is not found', async () => {
      const expires = moment().add(config.jwt.resetPasswordExpirationMinutes, 'minutes')
      const resetPasswordToken = tokenService.generateToken(userOne._id, expires, tokenTypes.RESET_PASSWORD)
      await tokenService.saveToken(resetPasswordToken, userOne._id, expires, tokenTypes.RESET_PASSWORD)

      await request(app)
        .post('/v1/auth/resetPassword')
        .send({ password: 'testing123', token: resetPasswordToken })
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 if password is missing or invalid', async () => {
      await insertUsers([userOne])
      const expires = moment().add(config.jwt.resetPasswordExpirationMinutes, 'minutes')
      const resetPasswordToken = tokenService.generateToken(userOne._id, expires, tokenTypes.RESET_PASSWORD)
      await tokenService.saveToken(resetPasswordToken, userOne._id, expires, tokenTypes.RESET_PASSWORD)

      await request(app).post('/v1/auth/resetPassword').send({ password: 'password2' }).expect(httpStatus.BAD_REQUEST)

      await request(app)
        .post('/v1/auth/resetPassword')
        .send({ password: 'short1', token: resetPasswordToken })
        .expect(httpStatus.BAD_REQUEST)

      await request(app)
        .post('/v1/auth/resetPassword')
        .send({ password: 'password', token: resetPasswordToken })
        .expect(httpStatus.BAD_REQUEST)

      await request(app)
        .post('/v1/auth/resetPassword')
        .send({ password: '11111111', token: resetPasswordToken })
        .expect(httpStatus.BAD_REQUEST)
    })
  })
})

describe('Auth middleware', () => {
  test('should call next with no errors if access token is valid', async () => {
    await insertUsers([userOne])
    const req = httpMocks.createRequest({ headers: { Authorization: `Bearer ${userOneAccessToken}` } })
    const next = jest.fn()

    await auth()(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.user._id).toEqual(userOne._id)
  })

  test('should call next with unauthorized error if access token is not found in header', async () => {
    await insertUsers([userOne])
    const req = httpMocks.createRequest()
    const next = jest.fn()

    await auth()(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith(expect.any(ApiError))
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: httpStatus.UNAUTHORIZED, message: 'Please log in' })
    )
  })

  test('should call next with unauthorized error if access token is not a valid jwt token', async () => {
    await insertUsers([userOne])
    const req = httpMocks.createRequest({ headers: { Authorization: 'Bearer randomToken' } })
    const next = jest.fn()

    await auth()(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith(expect.any(ApiError))
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: httpStatus.UNAUTHORIZED, message: 'Please log in' })
    )
  })

  test('should call next with unauthorized error if the token is not an access token', async () => {
    await insertUsers([userOne])
    const expires = moment().add(config.jwt.accessExpirationMinutes, 'minutes')
    const refreshToken = tokenService.generateToken(userOne._id, expires, tokenTypes.REFRESH)
    const req = httpMocks.createRequest({ headers: { Authorization: `Bearer ${refreshToken}` } })
    const next = jest.fn()

    await auth()(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith(expect.any(ApiError))
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: httpStatus.UNAUTHORIZED, message: 'Please log in' })
    )
  })

  test('should call next with unauthorized error if access token is generated with an invalid secret', async () => {
    await insertUsers([userOne])
    const expires = moment().add(config.jwt.accessExpirationMinutes, 'minutes')
    const accessToken = tokenService.generateToken(userOne._id, expires, tokenTypes.ACCESS, 'invalidSecret')
    const req = httpMocks.createRequest({ headers: { Authorization: `Bearer ${accessToken}` } })
    const next = jest.fn()

    await auth()(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith(expect.any(ApiError))
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: httpStatus.UNAUTHORIZED, message: 'Please log in' })
    )
  })

  test('should call next with unauthorized error if access token is expired', async () => {
    await insertUsers([userOne])
    const expires = moment().subtract(1, 'minutes')
    const accessToken = tokenService.generateToken(userOne._id, expires, tokenTypes.ACCESS)
    const req = httpMocks.createRequest({ headers: { Authorization: `Bearer ${accessToken}` } })
    const next = jest.fn()

    await auth()(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith(expect.any(ApiError))
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: httpStatus.UNAUTHORIZED, message: 'Please log in' })
    )
  })

  test('should call next with unauthorized error if user is not found', async () => {
    const req = httpMocks.createRequest({ headers: { Authorization: `Bearer ${userOneAccessToken}` } })
    const next = jest.fn()

    await auth()(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith(expect.any(ApiError))
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: httpStatus.UNAUTHORIZED, message: 'Please log in' })
    )
  })

  test('should call next with forbidden error if user does not have required rights and userId is not in params', async () => {
    await insertUsers([userOne])
    const req = httpMocks.createRequest({ headers: { Authorization: `Bearer ${userOneAccessToken}` } })
    const next = jest.fn()

    await auth('anyRight')(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith(expect.any(ApiError))
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: httpStatus.FORBIDDEN, message: 'Forbidden' }))
  })

  test('should call next with no errors if user does not have required rights but userId is in params', async () => {
    await insertUsers([userOne])
    const req = httpMocks.createRequest({
      headers: { Authorization: `Bearer ${userOneAccessToken}` },
      params: { userId: userOne._id.toHexString() }
    })
    const next = jest.fn()

    await auth('anyRight')(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith()
  })

  test('should call next with no errors if user has required rights', async () => {
    await insertUsers([admin])
    const req = httpMocks.createRequest({
      headers: { Authorization: `Bearer ${adminAccessToken}` },
      params: { userId: admin._id.toHexString() }
    })
    const next = jest.fn()

    await auth(...(<[]>roleRights.get('admin')))(req, httpMocks.createResponse(), next)

    expect(next).toHaveBeenCalledWith()
  })
})

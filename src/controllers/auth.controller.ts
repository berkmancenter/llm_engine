import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { authService, userService, tokenService } from '../services/index.js'
import ApiError from '../utils/ApiError.js'

const register = catchAsync(async (req, res) => {
  if (userService.isTokenGeneratedByConversations(req.body.token) === false) {
    throw new Error('Invalid token')
  }
  if (req.body.username) {
    const existingUser = await userService.getUserByUsername(req.body.username)
    if (existingUser) {
      throw new ApiError(httpStatus.CONFLICT, 'Username is already registered')
    }
  }
  if (req.body.email) {
    const existingUser = await userService.getUserByEmail(req.body.email)
    if (existingUser) {
      throw new ApiError(httpStatus.CONFLICT, 'Email address is already registered')
    }
  }
  const user = await userService.createUser(req.body)
  user.goodReputation = await userService.goodReputation(user)
  const tokens = await tokenService.generateAuthTokens(user)
  res.status(httpStatus.CREATED).send({ user, tokens })
})
const login = catchAsync(async (req, res) => {
  const user = await authService.loginUser(req.body)
  user.goodReputation = await userService.goodReputation(user)
  const tokens = await tokenService.generateAuthTokens(user)
  res.send({ user, tokens })
})
const logout = catchAsync(async (req, res) => {
  await authService.logout(req.body.refreshToken)
  res.status(httpStatus.NO_CONTENT).send()
})
const refreshTokens = catchAsync(async (req, res) => {
  const tokens = await authService.refreshAuth(req.body.refreshToken)
  res.send({ ...tokens })
})
const ping = catchAsync(async (req, res) => {
  res.send('pong')
})
const newPseudonym = catchAsync(async (req, res) => {
  const token = userService.newToken()
  const pseudonym = await userService.newPseudonym(0)
  res.send({ token, pseudonym })
})
const sendPasswordReset = catchAsync(async (req, res) => {
  await authService.sendPasswordReset(req.body.email)
  res.status(httpStatus.NO_CONTENT).send()
})
const resetPassword = catchAsync(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password)
  res.status(httpStatus.NO_CONTENT).send()
})

export { register, login, logout, refreshTokens, ping, newPseudonym, sendPasswordReset, resetPassword }

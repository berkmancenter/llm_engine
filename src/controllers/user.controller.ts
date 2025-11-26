import httpStatus from 'http-status'
import ApiError from '../utils/ApiError.js'
import catchAsync from '../utils/catchAsync.js'
import config from '../config/config.js'
import { userService } from '../services/index.js'
import ExportAudit from '../models/exportAudit.model.js'

const createUser = catchAsync(async (req, res) => {
  const user = await userService.createUser(req.body)
  user.goodReputation = await userService.goodReputation(user)
  res.status(httpStatus.CREATED).send(user)
})
const updateUser = catchAsync(async (req, res) => {
  const user = await userService.updateUser(req.body)
  user.goodReputation = await userService.goodReputation(user)
  res.status(httpStatus.OK).send(user)
})
const getUser = catchAsync(async (req, res) => {
  if (req.params.userId !== req.user.id) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User can only request their own details')
  }
  const user = await userService.getUserById(req.params.userId)
  user!.goodReputation = await userService.goodReputation(user)
  res.send(user)
})
const getPseudonyms = catchAsync(async (req, res) => {
  const user = await userService.getUserById(req.user)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  res.send(user!.pseudonyms.filter((x) => !x.isDeleted))
})
const addPseudonym = catchAsync(async (req, res) => {
  const user = await userService.addPseudonym(req.body, req.user)
  res.status(httpStatus.CREATED).send(user!.pseudonyms.filter((x) => !x.isDeleted))
})
const deletePseudonym = catchAsync(async (req, res) => {
  await userService.deletePseudonym(req.params.pseudonymId, req.user)
  res.status(httpStatus.OK).send()
})
const activatePseudonym = catchAsync(async (req, res) => {
  const user = await userService.activatePseudonym(req.body, req.user)
  res.status(httpStatus.OK).send(user!.pseudonyms.filter((x) => !x.isDeleted))
})

const updateDataExportPreference = catchAsync(async (req, res) => {
  if (!config.enableExportOptOut) {
    return res.status(httpStatus.FORBIDDEN).send({ message: 'Export opt-out feature is disabled' })
  }

  if (req.params.userId !== req.user.id) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Cannot update preferences for another user')
  }

  const user = await userService.getUserById(req.user.id)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  user.dataExportOptOut = req.body.optOut
  await user.save()
  res.status(httpStatus.OK).send({ dataExportOptOut: user.dataExportOptOut })
})

const getDataExportPreference = catchAsync(async (req, res) => {
  if (!config.enableExportOptOut) {
    return res.status(httpStatus.FORBIDDEN).send({ message: 'Export opt-out feature is disabled' })
  }

  if (req.params.userId !== req.user.id) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Cannot get preferences for another user')
  }

  const user = await userService.getUserById(req.user.id)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  res.status(httpStatus.OK).send({ dataExportOptOut: user.dataExportOptOut })
})

const getExportAuditLog = catchAsync(async (req, res) => {
  if (req.params.userId !== req.user.id) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Cannot get audit log for another user')
  }

  const audits = await ExportAudit.find({
    'affectedUsers.userId': req.user.id
  })
    .select('conversationName exporterUsername format exportDate messageCount')
    .sort({ exportDate: -1 })

  res.status(httpStatus.OK).send({ audits })
})

export {
  createUser,
  updateUser,
  getUser,
  addPseudonym,
  activatePseudonym,
  getPseudonyms,
  deletePseudonym,
  updateDataExportPreference,
  getDataExportPreference,
  getExportAuditLog
}

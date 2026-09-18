import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import pick from '../utils/pick.js'
import { artifactService } from '../services/index.js'
import conceptGraphService from '../services/conceptGraph/index.js'

/* The created artifact plus the container's read passcode, so the creator can build the
   link a client loads it with without a second request. GET /artifacts/passcode is the
   only other place it is returned; it is kept out of the serialized topic and
   conversation. */
const createArtifact = catchAsync(async (req, res) => {
  const { artifact, passcode } = await artifactService.createArtifact(req.body, req.user)
  res.status(httpStatus.CREATED).send({ ...artifact!.toJSON(), artifactPasscode: passcode })
})

const appendVersion = catchAsync(async (req, res) => {
  const version = await artifactService.appendVersion(req.params.artifactId, req.body, req.user)
  res.status(httpStatus.CREATED).send(version.toJSON())
})

const listArtifacts = catchAsync(async (req, res) => {
  const artifacts = await artifactService.listArtifacts(
    { topicId: req.query.topicId, conversationId: req.query.conversationId },
    req.user,
    req.query.artifactPasscode
  )
  res.status(httpStatus.OK).send(artifacts)
})

/* 202 rather than 201: the caller is asking for the graph to be rebuilt, and what comes
   back is whichever artifact version that produced — a new artifact on the first run, a new
   version of the existing one after that. A run that finds too little to map is a success
   with nothing to show, not an error, so it answers 200 with a reason. */
const generateConceptGraph = catchAsync(async (req, res) => {
  const result = req.body.topicId
    ? await conceptGraphService.refineTopicGraph(req.body.topicId, req.user)
    : await conceptGraphService.generateConceptGraph(req.body.conversationId, req.user)
  if (!result) {
    res.status(httpStatus.OK).send({ generated: false, reason: 'Not enough of the record to map' })
    return
  }
  res.status(httpStatus.ACCEPTED).send({
    generated: true,
    artifact: result.artifact!.toJSON(),
    version: result.version.toJSON(),
    report: result.report
  })
})

const getContainerPasscode = catchAsync(async (req, res) => {
  const artifactPasscode = await artifactService.getContainerPasscode(
    { topicId: req.query.topicId, conversationId: req.query.conversationId },
    req.user
  )
  res.status(httpStatus.OK).send({ artifactPasscode })
})

const getArtifact = catchAsync(async (req, res) => {
  const artifact = await artifactService.getArtifact(req.params.artifactId, req.user, req.query.artifactPasscode)
  res.status(httpStatus.OK).send(artifact)
})

const listVersions = catchAsync(async (req, res) => {
  const options = pick(req.query, ['sortBy', 'limit', 'page'])
  const versions = await artifactService.listVersions(req.params.artifactId, req.user, req.query.artifactPasscode, options)
  res.status(httpStatus.OK).send(versions)
})

const getVersion = catchAsync(async (req, res) => {
  const version = await artifactService.getVersion(
    req.params.artifactId,
    Number(req.params.versionNumber),
    req.user,
    req.query.artifactPasscode
  )
  res.status(httpStatus.OK).send(version)
})

export {
  createArtifact,
  appendVersion,
  generateConceptGraph,
  listArtifacts,
  getContainerPasscode,
  getArtifact,
  listVersions,
  getVersion
}

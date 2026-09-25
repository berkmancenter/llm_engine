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

/* 202: generation runs in a background job (see jobs/handlers/conceptGraph.ts), not inline
   in this request — the pipeline can run long enough to exceed the load balancer's backend
   timeout (infra/modules/webserver-mig/lb.tf), so this route only claims/creates the target
   artifact and enqueues the job before responding. The caller polls GET /:artifactId (or
   listens for the artifact:version / artifact:generationFailed socket events) to see the
   claim resolve to a new version or a failure. A generation already in flight for this
   artifact is a no-op: the same, still-pending artifact comes back rather than a second job. */
const generateConceptGraph = catchAsync(async (req, res) => {
  const artifact = await conceptGraphService.enqueueGeneration(
    { conversationId: req.body.conversationId, topicId: req.body.topicId, reset: req.body.reset },
    req.user
  )
  res.status(httpStatus.ACCEPTED).send({
    generated: true,
    artifact: artifact.toJSON(),
    status: artifact.generationStatus
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

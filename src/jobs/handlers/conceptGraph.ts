import logger from '../../config/logger.js'
import conceptGraphService from '../../services/conceptGraph/index.js'
import Artifact from '../../models/artifact.model/artifact.js'
import BaseUser from '../../models/user.model/baseUser.model.js'
import websocketGateway from '../../websockets/websocketGateway.js'

const NOT_ENOUGH_TO_MAP = 'Not enough of the record to map'

/* generationError is shown to passcode readers and broadcast to a topic room that needs no
   auth to join, so an unexpected failure must never put raw error text (LLM provider or
   Mongo messages) in it. The full error is logged server-side instead. */
const GENERIC_GENERATION_FAILURE = 'Generation failed. Try again, or check the server logs.'

/* A successful run already flips generationStatus to 'ready' and broadcasts artifact:version
   via artifactService.appendVersion, so only the failure/skip path needs to touch the
   artifact here. Mirrors appendVersion's own broadcast-is-best-effort handling: the status
   write already landed by the time a down socket layer could throw, so a missed broadcast
   costs a delayed refresh, not the result.

   `room` is whichever container the job was run for — the conversation for a
   conversation-scoped run, the topic for a topic-scoped one — the same room
   appendVersion's own broadcast would have targeted on success.

   enqueueGeneration creates the artifact shell before this job runs, so a first-ever run that
   fails would otherwise leave an empty "Generation failed" artifact visible to every reader of
   the container for good. With no currentVersion there is nothing to show, so the shell is
   soft-deleted (isDeleted, as everywhere else) and the next Generate starts from scratch. An
   artifact that already has a version keeps it, and goes back to 'ready' when the run only
   found too little to map (`keepVersion`: a result, not an error, and the existing graph is
   still good) or to 'failed' on a genuine error. Every case still broadcasts, so a waiting
   client can stop waiting and say that nothing new was written. */
const failGeneration = async (
  artifactId: string,
  room: string,
  reason: string,
  { keepVersion = false }: { keepVersion?: boolean } = {}
) => {
  const artifact = await Artifact.findById(artifactId).select('currentVersion').lean().exec()
  let update
  if (!artifact?.currentVersion) {
    update = { $set: { isDeleted: true } }
  } else if (keepVersion) {
    update = { $set: { generationStatus: 'ready' }, $unset: { generationError: '' } }
  } else {
    update = { $set: { generationStatus: 'failed', generationError: reason } }
  }
  await Artifact.updateOne({ _id: artifactId }, update).exec()
  try {
    await websocketGateway.broadcastArtifactGenerationFailed(room, { artifactId, reason })
  } catch (err) {
    logger.warn(`conceptGraph handler: failed to broadcast generation failure for artifact ${artifactId}: ${err}`)
  }
}

const generateConceptGraph = async (job) => {
  const { artifactId, conversationId, topicId, callerId, reset } = job.attrs.data
  const room = conversationId ?? topicId
  try {
    /* If this job is redelivered after its Agenda lock expired — e.g. the instance running
       it died right after a successful appendVersion but before Agenda recorded the job as
       done, a routine occurrence under autoscaling per jobs/CLAUDE.md — the artifact is no
       longer 'pending' and redoing the LLM work here would silently write a duplicate
       version. The claim itself lives in enqueueGeneration; this is the handler declining to
       act on a claim that already resolved, one way or the other. */
    const current = await Artifact.findById(artifactId).select('generationStatus').lean().exec()
    if (current?.generationStatus !== 'pending') {
      logger.info(`conceptGraph handler: artifact ${artifactId} is no longer pending, skipping`)
      return
    }

    const caller = await BaseUser.findById(callerId).exec()
    if (!caller) {
      await failGeneration(artifactId, room, 'The user or agent that requested this generation no longer exists')
      return
    }

    const result = topicId
      ? await conceptGraphService.refineTopicGraph(topicId, caller, undefined, { reset })
      : await conceptGraphService.generateConceptGraph(conversationId, caller)

    if (!result) {
      await failGeneration(artifactId, room, NOT_ENOUGH_TO_MAP, { keepVersion: true })
    }
  } catch (err) {
    logger.error(`conceptGraph handler: failed to generate concept graph for artifact ${artifactId}`, err)
    await failGeneration(artifactId, room, GENERIC_GENERATION_FAILURE)
  }
}

export default { generateConceptGraph }

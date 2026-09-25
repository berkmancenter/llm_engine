import logger from '../../config/logger.js'
import conceptGraphService from '../../services/conceptGraph/index.js'
import Artifact from '../../models/artifact.model/artifact.js'
import BaseUser from '../../models/user.model/baseUser.model.js'
import websocketGateway from '../../websockets/websocketGateway.js'

const NOT_ENOUGH_TO_MAP = 'Not enough of the record to map'

/* A successful run already flips generationStatus to 'ready' and broadcasts artifact:version
   via artifactService.appendVersion, so only the failure/skip path needs to touch the
   artifact here. Mirrors appendVersion's own broadcast-is-best-effort handling: the status
   write already landed by the time a down socket layer could throw, so a missed broadcast
   costs a delayed refresh, not the result. Topic-scoped runs get no broadcast at all, same
   as appendVersion's success path — there is no topic-wide room (see
   docs/pages/developers/artifacts.md). */
const failGeneration = async (artifactId: string, conversationId: string | undefined, reason: string) => {
  await Artifact.updateOne(
    { _id: artifactId },
    { $set: { generationStatus: 'failed', generationError: reason } }
  ).exec()
  if (!conversationId) return
  try {
    await websocketGateway.broadcastArtifactGenerationFailed(conversationId, { artifactId, reason })
  } catch (err) {
    logger.warn(`conceptGraph handler: failed to broadcast generation failure for artifact ${artifactId}: ${err}`)
  }
}

const generateConceptGraph = async (job) => {
  const { artifactId, conversationId, topicId, callerId, reset } = job.attrs.data
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
      await failGeneration(artifactId, conversationId, 'The user or agent that requested this generation no longer exists')
      return
    }

    const result = topicId
      ? await conceptGraphService.refineTopicGraph(topicId, caller, undefined, { reset })
      : await conceptGraphService.generateConceptGraph(conversationId, caller)

    if (!result) {
      await failGeneration(artifactId, conversationId, NOT_ENOUGH_TO_MAP)
    }
  } catch (err) {
    logger.error(`conceptGraph handler: failed to generate concept graph for artifact ${artifactId}`, err)
    await failGeneration(artifactId, conversationId, err instanceof Error ? err.message : String(err))
  }
}

export default { generateConceptGraph }

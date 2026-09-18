import mongoose from 'mongoose'
import httpStatus from 'http-status'
import { nanoid } from 'nanoid'
import Artifact from '../models/artifact.model/artifact.js'
import ArtifactVersion from '../models/artifact.model/version.js'
import { artifactKind, artifactTypes } from '../models/artifact.model/registry.js'
import Conversation from '../models/conversation.model.js'
import Topic from '../models/topic.model.js'
import ApiError from '../utils/ApiError.js'
import access from '../auth/access.js'
import logger from '../config/logger.js'
import websocketGateway from '../websockets/websocketGateway.js'
import { roleRights } from '../config/roles.js'
import { ArtifactScope, IAgent, IArtifact, IBaseUser } from '../types/index.types.js'

const PASSCODE_LENGTH = 8

/* One wording for every refusal a read can trigger: wrong passcode, no passcode, an
   artifact id that matches nothing, and a container that matches nothing. The read routes
   only ask for rights every participant holds, so a message that varied by case would let
   any signed-in account probe for artifact, conversation and topic ids and learn which
   containers have artifacts at all. It still names what the caller needs, which is all
   someone holding a stale link can act on. Mirrors TRANSCRIPT_REFUSAL in
   transcript.service.ts, for the same reason. */
const READ_REFUSAL = "You need this artifact's passcode, or owner or administrator rights, to read it"

const holdsRight = (user, right: string) => !!roleRights.get(user?.role)?.includes(right)

const idOf = (value): string | undefined => {
  if (!value) return undefined
  if (typeof value === 'string') return value
  if (value instanceof mongoose.Types.ObjectId) return value.toString()
  return (value._id ?? value.id)?.toString()
}

/*
 * Where an artifact lives, resolved to everything a permission check needs: the two owner
 * ids and the read passcode. Both scopes collapse to this shape so the guards below have
 * one thing to reason about rather than a topic branch and a conversation branch.
 */
interface ArtifactContainer {
  scope: ArtifactScope
  topicId: string
  conversationId?: string
  topicOwnerId?: string
  conversationOwnerId?: string
  artifactPasscode?: string
}

/* Names exactly one container. Both fields are optional here rather than a union, because
   the caller may legitimately pass neither or both — that is a 400 the service raises
   itself, so the HTTP layer is not the only thing enforcing it. */
interface ContainerSelector {
  topicId?: string
  conversationId?: string
}

/* A conversation-scoped artifact answers to its own owner and to the owner of the topic it
   sits under; a topic-scoped one only to the topic's owner. Read passcodes come off the
   container the artifact is actually scoped to, never the parent: a conversation artifact
   is readable by whoever holds that conversation's key, and giving the topic key that reach
   would leak every conversation's artifacts to anyone holding it. */
const resolveConversationContainer = async (conversationId: string): Promise<ArtifactContainer | null> => {
  if (!mongoose.Types.ObjectId.isValid(conversationId)) return null
  const conversation = await Conversation.findById(conversationId)
    .select('owner topic artifactPasscode')
    .populate('topic', 'owner')
    .lean()
    .exec()
  if (!conversation?.topic) return null
  return {
    scope: 'conversation',
    topicId: idOf(conversation.topic)!,
    conversationId,
    topicOwnerId: idOf(conversation.topic.owner),
    conversationOwnerId: idOf(conversation.owner),
    artifactPasscode: conversation.artifactPasscode
  }
}

const resolveTopicContainer = async (topicId: string): Promise<ArtifactContainer | null> => {
  if (!mongoose.Types.ObjectId.isValid(topicId)) return null
  const topic = await Topic.findOne({ _id: topicId, isDeleted: { $ne: true } })
    .select('owner artifactPasscode')
    .lean()
    .exec()
  if (!topic) return null
  return {
    scope: 'topic',
    topicId,
    topicOwnerId: idOf(topic.owner),
    artifactPasscode: topic.artifactPasscode
  }
}

const resolveContainer = async ({ topicId, conversationId }: ContainerSelector): Promise<ArtifactContainer | null> => {
  if (conversationId) return resolveConversationContainer(conversationId)
  if (topicId) return resolveTopicContainer(topicId)
  return null
}

// The agent's conversation is usually populated but its topic is not, so fall back to a lookup.
const agentTopicId = async (caller: IAgent): Promise<string | undefined> => {
  const conversation = caller.conversation as { topic?: unknown } | undefined
  const conversationId = idOf(conversation)
  if (!conversationId) return undefined
  const populatedTopicId = typeof conversation === 'object' ? idOf(conversation.topic) : undefined
  if (populatedTopicId) return populatedTopicId
  const found = await Conversation.findById(conversationId).select('topic').lean().exec()
  return idOf(found?.topic)
}

const containerOf = (artifact: IArtifact): Promise<ArtifactContainer | null> =>
  artifact.scope === 'conversation'
    ? resolveConversationContainer(idOf(artifact.conversation)!)
    : resolveTopicContainer(idOf(artifact.topic)!)

/*
 * Mints the container's artifact passcode if it does not have one yet, and returns it.
 *
 * Lazy rather than minted with the topic or conversation itself, which is what let this
 * ship without a migration: a container that never gets an artifact never gets a key, and
 * the first artifact creation is the moment one is actually needed. The `$exists` guard
 * makes it race-free — two organizers creating the first artifact at once can both reach
 * here, and the loser's update matches nothing, so it re-reads the winner's code instead of
 * overwriting it and invalidating a key that was already handed out.
 */
const ensureArtifactPasscode = async (container: ArtifactContainer): Promise<string> => {
  if (container.artifactPasscode) return container.artifactPasscode

  const id = container.scope === 'conversation' ? container.conversationId : container.topicId
  const minted = nanoid(PASSCODE_LENGTH)
  const filter = { _id: id, artifactPasscode: { $in: [null, undefined] } }
  const update = { $set: { artifactPasscode: minted } }

  /* Conversation and Topic are separate mongoose models whose query generics are not
     assignable to one another, so the two branches stay fully separate rather than sharing
     one `Conversation | Topic` chain — a union of those query types is not callable. */
  const claimed =
    container.scope === 'conversation'
      ? await Conversation.findOneAndUpdate(filter, update, { new: true }).select('artifactPasscode').lean().exec()
      : await Topic.findOneAndUpdate(filter, update, { new: true }).select('artifactPasscode').lean().exec()
  if (claimed?.artifactPasscode) return claimed.artifactPasscode

  const existing =
    container.scope === 'conversation'
      ? await Conversation.findById(id).select('artifactPasscode').lean().exec()
      : await Topic.findById(id).select('artifactPasscode').lean().exec()
  return existing?.artifactPasscode ?? minted
}

/*
 * Guards every artifact read: list, current version, history, one version.
 *
 * Two ways in, the same two the transcript controls use. Owners and administrators pass
 * with nothing on the request, because they reach artifacts from an admin view that has no
 * passcode to hand. Everyone else presents the container's artifact passcode, which is how
 * a client loads an artifact for a participant who may never have signed in.
 *
 * A container with no passcode minted refuses everyone but its owners — that state means no
 * artifact has ever been created there, so there is nothing to read anyway, and treating an
 * absent key as "no key required" would be the wrong way round.
 */
const authorizeArtifactRead = (container: ArtifactContainer, user, presentedPasscode?: string) => {
  const userId = idOf(user?._id)
  if (holdsRight(user, 'manageArtifacts')) return
  if (userId && (userId === container.topicOwnerId || userId === container.conversationOwnerId)) return
  if (container.artifactPasscode && presentedPasscode === container.artifactPasscode) return
  throw new ApiError(httpStatus.FORBIDDEN, READ_REFUSAL)
}

/*
 * Guards creating an artifact and appending a version to one.
 *
 * Writes are never passcode-authorized: a read key is handed to everyone who can see the
 * artifact, so accepting it here would let any reader rewrite what they were shown.
 *
 * - Topic scope needs the `manageArtifacts` right, i.e. an administrator. A topic spans
 *   other people's conversations, so there is no owner short of an admin whose say covers
 *   the whole set.
 * - Conversation scope needs the conversation's owner, its topic's owner, or an
 *   administrator — the same trio that may already edit the conversation and upload its
 *   resources (see resource.service.ts).
 * - An agent goes through access.assertCanWrite, so it may write to its own conversation,
 *   and to that conversation's topic, since the series graph is topic-scoped.
 */
const authorizeArtifactWrite = async (container: ArtifactContainer, caller: IBaseUser) => {
  if (caller?.__t === 'Agent') {
    if (container.scope === 'conversation' && container.conversationId) {
      await access.assertCanWrite(caller, { type: 'conversation', id: container.conversationId })
      return
    }
    const agent = caller as IAgent
    const ownConversationId = idOf(agent.conversation)
    const ownTopicId = await agentTopicId(agent)
    if (ownConversationId && ownTopicId && ownTopicId === container.topicId) {
      await access.assertCanWrite(caller, { type: 'conversation', id: ownConversationId })
      return
    }
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'An agent may only write artifacts for its own conversation or the topic that conversation belongs to'
    )
  }

  if (holdsRight(caller, 'manageArtifacts') && container.scope === 'topic') return

  const userId = idOf(caller?._id)
  const isOwner = !!userId && (userId === container.conversationOwnerId || userId === container.topicOwnerId)
  if (container.scope === 'conversation' && (isOwner || holdsRight(caller, 'manageArtifacts'))) return

  throw new ApiError(
    httpStatus.FORBIDDEN,
    container.scope === 'topic'
      ? 'Only an administrator can create artifacts for a topic'
      : 'Only the conversation owner, the topic owner, or an administrator can create artifacts for a conversation'
  )
}

/* Rejects a payload that does not match the kind's shape before it reaches the version
   collection, where it would be stored as Mixed and validated by nothing. */
const validatePayload = (type: string, payload: unknown) => {
  const kind = artifactKind(type)
  if (!kind) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Unsupported artifact type: ${type}. Supported types: ${artifactTypes.join(', ')}`
    )
  }
  const { error, value } = kind.payloadSchema.validate(payload, { convert: true })
  if (error) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid ${kind.label} artifact payload: ${error.message}`)
  }
  return value
}

const findArtifact = async (artifactId: string) => {
  if (!mongoose.Types.ObjectId.isValid(artifactId)) return null
  return Artifact.findOne({ _id: artifactId, isDeleted: { $ne: true } }).exec()
}

/* Loads an artifact and clears the read guard in one step. Every read path starts here, so
   none of them can forget the check, and all of them refuse identically for an artifact
   that does not exist and one the caller may not see. */
const readableArtifact = async (artifactId: string, user, passcode?: string) => {
  const artifact = await findArtifact(artifactId)
  if (!artifact) throw new ApiError(httpStatus.FORBIDDEN, READ_REFUSAL)
  const container = await containerOf(artifact)
  if (!container) throw new ApiError(httpStatus.FORBIDDEN, READ_REFUSAL)
  authorizeArtifactRead(container, user, passcode)
  return artifact
}

/* The content of one revision. `note` is optional: an agent revising an artifact live has
   nothing useful to say about what changed, while an organizer saving an edit often does. */
interface VersionInput {
  payload: unknown
  note?: string
}

/*
 * Appends a new version and makes it current.
 *
 * The version number is claimed by a single atomic $inc on the artifact, not computed from
 * the highest existing version: this is the path an agent takes while revising an artifact
 * live, so a concurrent organizer edit is a real possibility rather than a theoretical one,
 * and a read-then-write would give both the same number. A claim that is never written
 * leaves a gap in the numbering, which is why versionNumber is documented as increasing
 * rather than contiguous — a gap costs nothing, two writers sharing a number would lose one
 * of the two edits.
 *
 * The pointer update is guarded on the number this call claimed, so a slow append cannot
 * repoint `currentVersion` backwards over a newer one that landed while it was writing.
 *
 * The claim, the insert and the pointer update are three separate writes, not a
 * transaction, so a process killed between the insert and the pointer update leaves
 * `currentVersionNumber` one ahead of what `currentVersion` points at: the artifact reads
 * as its previous version until the next append repoints it. Accepted rather than wrapped
 * in withTransaction, which would need a replica set — the artifact is never wrong in that
 * window, only one version stale, and the version that landed is still in the history.
 */
const appendVersion = async (artifactId: string, { payload, note }: VersionInput, caller: IBaseUser) => {
  const artifact = await findArtifact(artifactId)
  if (!artifact) throw new ApiError(httpStatus.NOT_FOUND, `Artifact with id ${artifactId} not found`)

  const container = await containerOf(artifact)
  if (!container) throw new ApiError(httpStatus.NOT_FOUND, `Artifact with id ${artifactId} not found`)
  await authorizeArtifactWrite(container, caller)

  const validated = validatePayload(artifact.__t!, payload)

  const claimed = await Artifact.findOneAndUpdate(
    { _id: artifact._id, isDeleted: { $ne: true }, locked: { $ne: true } },
    { $inc: { currentVersionNumber: 1 } },
    { new: true }
  ).exec()
  if (!claimed) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This artifact is locked and cannot be revised')
  }
  const versionNumber = claimed.currentVersionNumber!

  const version = await ArtifactVersion.create({
    artifact: artifact._id,
    versionNumber,
    payload: validated,
    createdBy: caller?._id,
    ...(note !== undefined && { note })
  })

  await Artifact.updateOne(
    { _id: artifact._id, currentVersionNumber: versionNumber },
    { $set: { currentVersion: version._id } }
  ).exec()

  logger.info('Appended version %s to artifact %s (%s)', versionNumber, artifact._id, artifact.__t)

  /* The version is already committed by this point, so a socket layer that is down must not
     turn a successful append into a 500: the client would retry and write a duplicate
     version. Clients reconcile by fetching the artifact, so a missed broadcast costs a
     delayed re-render, not the edit. */
  if (container.scope === 'conversation' && container.conversationId) {
    try {
      await websocketGateway.broadcastArtifactVersion(container.conversationId, {
        artifactId: artifact._id!.toString(),
        versionNumber
      })
    } catch (err) {
      logger.warn(`artifact.service: failed to broadcast version ${versionNumber} of artifact ${artifact._id}: ${err}`)
    }
  }

  return version
}

/*
 * Creates an artifact and its first version together.
 *
 * An artifact with no version would be a title with no content, and every read path would
 * have to handle it, so creation always writes version 1 — through the same appendVersion
 * used for every later revision, which is what keeps numbering and broadcasting identical
 * on the first version and the hundredth.
 *
 * Returns the container's read passcode alongside the artifact, minting it if this is the
 * container's first artifact. This is the only response that carries it: the creator needs
 * it to build the link a client loads the artifact with.
 */
const createArtifact = async (body, caller: IBaseUser) => {
  const { type, topicId, conversationId, title, description, payload, note } = body

  if (!!topicId === !!conversationId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Provide exactly one of topicId or conversationId')
  }

  const container = await resolveContainer({ topicId, conversationId })
  if (!container) {
    throw new ApiError(
      httpStatus.NOT_FOUND,
      conversationId ? `Conversation with id ${conversationId} not found` : `Topic with id ${topicId} not found`
    )
  }

  await authorizeArtifactWrite(container, caller)
  validatePayload(type, payload)

  const artifact = await Artifact.create({
    __t: type,
    scope: container.scope,
    topic: container.topicId,
    ...(container.scope === 'conversation' && { conversation: container.conversationId }),
    title,
    ...(description !== undefined && { description }),
    createdBy: caller?._id
  })

  const version = await appendVersion(artifact._id!.toString(), { payload, note }, caller)
  const passcode = await ensureArtifactPasscode(container)

  logger.info('Created %s artifact %s for %s %s', type, artifact._id, container.scope, topicId ?? conversationId)

  return { artifact: await Artifact.findById(artifact._id).populate('currentVersion').exec(), version, passcode }
}

/*
 * The container's read passcode, minting it if it does not have one yet.
 *
 * Without this an owner who lost the create response could never recover the key, since
 * `private: true` keeps it out of every serialized topic and conversation and
 * GET /topics/:topicId is unauthenticated. It also lets a client build an artifact link
 * before the first artifact exists.
 *
 * Authorized as a write, not a read: handing out the key that grants read access to
 * everything in the container is an owner's decision, so requiring only the key itself
 * here would let any reader confirm and re-share it.
 */
const getContainerPasscode = async ({ topicId, conversationId }: ContainerSelector, caller: IBaseUser) => {
  const container = await resolveContainer({ topicId, conversationId })
  if (!container) {
    throw new ApiError(
      httpStatus.NOT_FOUND,
      conversationId ? `Conversation with id ${conversationId} not found` : `Topic with id ${topicId} not found`
    )
  }
  await authorizeArtifactWrite(container, caller)
  return ensureArtifactPasscode(container)
}

/*
 * Every artifact for a topic or a conversation, newest first, with its current version
 * inlined so a client can render the set without a request per artifact.
 *
 * A topic listing includes its conversations' artifacts only for the topic owner and
 * administrators. A topic passcode never opens a conversation artifact (see
 * resolveConversationContainer), so the list must not return what the single read refuses.
 */
const listArtifacts = async ({ topicId, conversationId }: ContainerSelector, user, passcode?: string) => {
  const container = await resolveContainer({ topicId, conversationId })
  if (!container) throw new ApiError(httpStatus.FORBIDDEN, READ_REFUSAL)
  authorizeArtifactRead(container, user, passcode)

  const userId = idOf(user?._id)
  const readsEveryConversation = holdsRight(user, 'manageArtifacts') || (!!userId && userId === container.topicOwnerId)
  const topicFilter = readsEveryConversation ? { topic: topicId } : { topic: topicId, scope: 'topic' }
  const filter = conversationId ? { conversation: conversationId } : topicFilter
  return Artifact.find({ ...filter, isDeleted: { $ne: true } })
    .populate('currentVersion')
    .sort('-createdAt')
    .exec()
}

/** One artifact at its latest version — the default read, per the API contract. */
const getArtifact = async (artifactId: string, user, passcode?: string) => {
  const artifact = await readableArtifact(artifactId, user, passcode)
  return artifact.populate('currentVersion')
}

/** Every version of an artifact, newest first and paginated: the full saved history. */
const listVersions = async (artifactId: string, user, passcode: string | undefined, options) => {
  const artifact = await readableArtifact(artifactId, user, passcode)
  return ArtifactVersion.paginate(
    { artifact: artifact._id },
    { ...options, sortBy: options?.sortBy ?? 'versionNumber:desc' }
  )
}

/** One numbered version, for a client showing a specific point in an artifact's history. */
const getVersion = async (artifactId: string, versionNumber: number, user, passcode?: string) => {
  const artifact = await readableArtifact(artifactId, user, passcode)
  const version = await ArtifactVersion.findOne({ artifact: artifact._id, versionNumber }).exec()
  if (!version) {
    throw new ApiError(httpStatus.NOT_FOUND, `Artifact ${artifactId} has no version ${versionNumber}`)
  }
  return version
}

const artifactService = {
  createArtifact,
  appendVersion,
  getContainerPasscode,
  listArtifacts,
  getArtifact,
  listVersions,
  getVersion,
  authorizeArtifactRead,
  authorizeArtifactWrite,
  ensureArtifactPasscode,
  READ_REFUSAL
}
export default artifactService

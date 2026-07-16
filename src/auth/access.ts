import Conversation from '../models/conversation.model.js'
import { IAgent, IBaseUser, ReadGrant, ReadScope, WriteGrant, WriteScope } from '../types/index.types.js'
import AccessDeniedError from '../utils/AccessDeniedError.js'

export { AccessDeniedError }

function isAgent(caller: IBaseUser): caller is IAgent {
  return caller.__t === 'Agent'
}

function assertCanRead(caller: IBaseUser, scope: ReadScope) {
  if (!isAgent(caller)) {
    // User read checks are not yet centralised here — fall through for now
    return
  }

  const grants: ReadGrant[] = caller.capabilities?.read ?? []
  const allowed = grants.some((g) => {
    if (g.type === 'allTopics') return true
    if (g.type === 'allPublicTopics') return scope.topicIsPrivate !== true
    if (g.type === scope.type) return g.id === scope.id
    if (g.type === 'topic' && scope.type === 'conversation' && scope.topicId !== undefined) return g.id === scope.topicId
    return false
  })
  if (!allowed) throw new AccessDeniedError(`Agent does not have read access to ${scope.type} ${scope.id}`)
}

async function assertCanWrite(caller: IBaseUser, scope: WriteScope) {
  if (isAgent(caller)) {
    // An ownConversation grant resolves to the agent's actual conversation
    const grants: WriteGrant[] = caller.capabilities?.write ?? [{ type: 'ownConversation' }]
    const allowed = grants.some((g) => g.type === 'ownConversation' && caller.conversation?._id?.toString() === scope.id)
    if (!allowed) throw new AccessDeniedError(`Agent does not have write access to conversation ${scope.id}`)
  } else {
    // User: owner of the conversation may write to it
    const conv = await Conversation.findById(scope.id).select('owner').lean()
    if (!conv || conv.owner.toString() !== caller._id?.toString()) {
      throw new AccessDeniedError(`User does not have write access to conversation ${scope.id}`)
    }
  }
}

async function listReadableConversations(caller: IBaseUser, scope: ReadScope) {
  assertCanRead(caller, scope)

  if (scope.type === 'topic') return Conversation.find({ topic: scope.id }).exec()
  return Conversation.find({ _id: scope.id }).exec()
}

const access = { assertCanRead, assertCanWrite, listReadableConversations }
export default access

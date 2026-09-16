import rag from '../agents/helpers/rag.js'
import logger from '../config/logger.js'

/**
 * Per-conversation vector store of community-room member bios/interests, searched by the
 * `member_bios` tool (see ../agents/tools/memberBios.ts) so the community assistant can answer
 * questions like "who here works on AI policy" — the same treatment event transcripts already
 * give speaker/moderator bios (see loadEventMetadataIntoVectorStore in transcript.ts).
 */
export const MEMBER_BIO_COLLECTION_PREFIX = 'member-bio'

export const memberBioCollectionName = (conversationId: string) => `${MEMBER_BIO_COLLECTION_PREFIX}-${conversationId}`

export interface MemberBioInput {
  id: string
  name: string
  bio?: string
  interests?: string
}

/**
 * (Re)index one or more members' bio/interests into the conversation's member-bio collection.
 * Safe to call repeatedly (e.g. after a CSV re-import): each member's prior entry is removed by
 * membershipId before current content is added, so both edits and clears take effect. A member
 * with neither bio nor interests ends up unindexed — nothing there worth searching.
 */
const CHROMA_BATCH_SIZE = 100

async function indexMemberBios(conversationId: string, members: MemberBioInput[]): Promise<void> {
  if (members.length === 0) return
  const collection = memberBioCollectionName(conversationId)

  // Remove stale entries in batches to avoid 502s on large imports. Failures are
  // logged but do not block the add — Chroma has no transactions so we can't
  // guarantee atomicity; a failed batch may have partially executed. The add
  // proceeds regardless: worst case a member is temporarily double-indexed until
  // the next re-import. The whole operation is already best-effort at the call site.
  const ids = members.map((m) => m.id)
  for (let i = 0; i < ids.length; i += CHROMA_BATCH_SIZE) {
    try {
      await rag.removeFromVectorStore(collection, { membershipId: { $in: ids.slice(i, i + CHROMA_BATCH_SIZE) } })
    } catch (error) {
      logger.warn(
        `indexMemberBios: failed to remove stale entries for conversation ${conversationId} (batch ${
          i / CHROMA_BATCH_SIZE + 1
        }): ${error.message}`
      )
    }
  }

  const docs: string[] = []
  const metadatas: Record<string, string>[] = []
  members.forEach((member) => {
    const bioText = member.bio?.trim()
    const interestsText = member.interests?.trim()
    if (!bioText && !interestsText) return
    const parts = [`${member.name} is a member of this community.`]
    if (bioText) parts.push(bioText)
    if (interestsText) parts.push(`Interests: ${interestsText}`)
    docs.push(parts.join(' '))
    metadatas.push({ membershipId: member.id, name: member.name })
  })

  if (docs.length === 0) return

  // addTextsToVectorStore sends all docs in one request; batch to avoid 502s on large imports.
  for (let i = 0; i < docs.length; i += CHROMA_BATCH_SIZE) {
    await rag.addTextsToVectorStore(collection, docs.slice(i, i + CHROMA_BATCH_SIZE), {
      metadatas: metadatas.slice(i, i + CHROMA_BATCH_SIZE)
    })
  }
}

const removeMemberBio = async (conversationId: string, membershipId: string): Promise<void> => {
  try {
    await rag.removeFromVectorStore(memberBioCollectionName(conversationId), { membershipId })
  } catch (error) {
    logger.debug(`removeMemberBio: could not remove ${membershipId} (collection may not exist): ${error.message}`)
  }
}

const deleteMemberBioCollection = async (conversationId: string): Promise<void> => {
  await rag.deleteCollection(memberBioCollectionName(conversationId))
}

export default {
  indexMemberBios,
  removeMemberBio,
  deleteMemberBioCollection,
  memberBioCollectionName
}

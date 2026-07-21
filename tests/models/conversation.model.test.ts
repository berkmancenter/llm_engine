import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Conversation } from '../../src/models/index.js'

setupIntTest()

/* Minimum fields a conversation needs to save, so each test can focus on the
   analyticsRefs behaviour rather than unrelated required fields. */
function baseConversation() {
  return {
    name: 'Analytics refs event',
    slug: `refs-${new mongoose.Types.ObjectId().toString()}`,
    owner: new mongoose.Types.ObjectId(),
    topic: new mongoose.Types.ObjectId()
  }
}

describe('conversation analyticsRefs', () => {
  it('persists a source-keyed map of external analytics references', async () => {
    const conversation = await Conversation.create({
      ...baseConversation(),
      analyticsRefs: { matomo: 'dimension7' }
    })

    const reloaded = await Conversation.findById(conversation._id)

    expect(reloaded!.analyticsRefs!.get('matomo')).toBe('dimension7')
  })

  it('leaves analyticsRefs undefined when no source reference is set', async () => {
    const conversation = await Conversation.create(baseConversation())

    const reloaded = await Conversation.findById(conversation._id)

    expect(reloaded!.analyticsRefs).toBeUndefined()
  })
})

describe('conversation draft default', () => {
  /* Fail-closed guarantee: a conversation saved without the service layer setting draft
     must persist as draft, so a bypassed or partially-built record can never auto-start. */
  it('defaults draft to true when none is provided', async () => {
    const conversation = await Conversation.create(baseConversation())

    const reloaded = await Conversation.findById(conversation._id)

    expect(reloaded!.draft).toBe(true)
  })
})

describe('conversation sourceInviteUid', () => {
  it('persists the .ics UID for a conversation created from an inbound invite', async () => {
    const conversation = await Conversation.create({
      ...baseConversation(),
      sourceInviteUid: 'UID-ABC-123'
    })

    const reloaded = await Conversation.findById(conversation._id)

    expect(reloaded!.sourceInviteUid).toBe('UID-ABC-123')
  })

  it('leaves sourceInviteUid undefined for a conversation not created from an invite', async () => {
    const conversation = await Conversation.create(baseConversation())

    const reloaded = await Conversation.findById(conversation._id)

    expect(reloaded!.sourceInviteUid).toBeUndefined()
  })

  /* The field is intentionally non-unique: most conversations have no invite UID at all, and a
     unique index would treat every one of those missing values as a colliding duplicate. Dedup
     against Postmark retries happens in createEventFromInvite, not via a DB constraint. */
  it('allows multiple conversations with no sourceInviteUid to coexist', async () => {
    await Conversation.create(baseConversation())
    await expect(Conversation.create(baseConversation())).resolves.toBeTruthy()
  })
})

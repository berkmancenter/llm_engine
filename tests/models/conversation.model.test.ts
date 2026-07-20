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

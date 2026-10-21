/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { messageHideService } from '../../src/services/index.js'
import { Conversation, Message, ModerationEvent } from '../../src/models/index.js'
import { roleRights } from '../../src/config/roles.js'
import { insertMessage, seedHideScenario, conversationOne, conversationTwo } from '../fixtures/messageHide.fixture.js'

setupIntTest()

let s: Awaited<ReturnType<typeof seedHideScenario>>
let broadcastSpy: jest.SpiedFunction<typeof websocketGateway.broadcast>
const conversationId = conversationOne._id.toString()

const events = (filter = {}) => ModerationEvent.find({ conversation: conversationOne._id, ...filter }).sort({ _id: 1 })
const sorted = (ids: unknown[]) => ids.map(String).sort()

beforeEach(async () => {
  s = await seedHideScenario()
  broadcastSpy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)
})
afterEach(() => {
  jest.restoreAllMocks()
})

describe('moderation event log', () => {
  describe('hiding one message', () => {
    it('writes one event with the actor, target, concrete ids and reason', async () => {
      const result = await messageHideService.hideMessage(s.authorMsg._id, s.admin, 'harassment')

      const [event] = await events()
      expect(await events()).toHaveLength(1)
      expect(event).toMatchObject({ action: 'hide', scope: 'message', reason: 'harassment' })
      expect(event.actor.toString()).toBe(s.admin._id.toString())
      expect(event.targetMessage!.toString()).toBe(s.authorMsg._id.toString())
      expect(event.targetUser!.toString()).toBe(s.author._id.toString())
      expect(event.conversation.toString()).toBe(conversationId)
      // exactly what the REST call returned: the message plus the reply cascading from it
      expect(sorted(event.messageIds)).toEqual(sorted(result.messageIds))
      expect(sorted(event.messageIds)).toEqual(sorted([s.authorMsg._id, s.reply._id]))
    })

    it('stores no message body anywhere in the event', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin, 'pii')
      const raw = JSON.stringify(await ModerationEvent.collection.find({}).toArray())
      expect(raw).not.toContain(s.authorMsg.body as string)
      expect(raw).not.toContain(s.reply.body as string)
    })

    it('works without a reason', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      expect((await events())[0].reason).toBeUndefined()
    })

    it('logs the unhide as its own event, with its own free-text reason', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin, 'off-topic')
      await messageHideService.unhideMessage(s.authorMsg._id, s.admin, 'hidden by mistake')

      const all = await events()
      expect(all.map((e) => e.action)).toEqual(['hide', 'unhide'])
      expect(all[1].reason).toBe('hidden by mistake')
      expect(sorted(all[1].messageIds)).toEqual(sorted([s.authorMsg._id, s.reply._id]))
    })

    it('writes nothing for a no-op, and nothing for a rejected call', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      await messageHideService.unhideMessage(s.otherMsg._id, s.admin) // never hidden
      expect(await events()).toHaveLength(1)

      const inAssistant = await insertMessage(s.author, conversationOne, { channels: ['assistant'] })
      await expect(messageHideService.hideMessage(inAssistant._id, s.admin)).rejects.toMatchObject({ statusCode: 400 })
      await expect(messageHideService.hideMessage(s.otherMsg._id, s.other)).rejects.toMatchObject({ statusCode: 403 })
      await expect(messageHideService.hideMessage(new mongoose.Types.ObjectId().toString(), s.admin)).rejects.toBeDefined()
      expect(await events()).toHaveLength(1)
    })
  })

  describe('hiding all of a user', () => {
    it('writes one event with the cascaded ids, and logs the unhide', async () => {
      const result = await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin, 'harassment')

      const [event] = await events()
      expect(await events()).toHaveLength(1)
      expect(event).toMatchObject({ action: 'hide', scope: 'user', reason: 'harassment' })
      expect(event.targetUser!.toString()).toBe(s.author._id.toString())
      expect(event.targetMessage).toBeUndefined()
      expect(sorted(event.messageIds)).toEqual(sorted(result.messageIds))
      expect(sorted(event.messageIds)).toEqual(sorted([s.authorMsg._id, s.reply._id]))

      await messageHideService.unhideUserMessages(conversationId, s.author._id, s.admin)
      expect((await events()).map((e) => e.action)).toEqual(['hide', 'unhide'])
    })

    it('writes nothing for a repeat, and logs a first hide of a user with no chat messages', async () => {
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      expect(await events()).toHaveLength(1)

      await messageHideService.hideUserMessages(conversationId, s.admin._id, s.admin)
      const last = (await events()).pop()!
      expect(last.messageIds).toHaveLength(0)
      expect(await events()).toHaveLength(2)
    })

    it('keeps conversations apart: events and state belong to the conversation they were made in', async () => {
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      await messageHideService.hideMessage(s.authorMsgElsewhere._id, s.admin)

      expect(await events()).toHaveLength(1)
      const other = await ModerationEvent.find({ conversation: conversationTwo._id })
      expect(other).toHaveLength(1)
      expect(other[0].messageIds.map(String)).toEqual([s.authorMsgElsewhere._id.toString()])
    })
  })

  describe('when the event cannot be saved', () => {
    it('reverts a single hide, writes nothing, and tells no client', async () => {
      jest.spyOn(ModerationEvent, 'create').mockRejectedValueOnce(new Error('disk full') as never)

      await expect(messageHideService.hideMessage(s.authorMsg._id, s.admin)).rejects.toThrow('disk full')

      expect((await Message.findById(s.authorMsg._id))!.hiddenByAdmin).toBe(false)
      expect(await ModerationEvent.countDocuments()).toBe(0)
      expect(broadcastSpy).not.toHaveBeenCalled()
    })

    it('reverts an unhide back to hidden', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      broadcastSpy.mockClear()
      jest.spyOn(ModerationEvent, 'create').mockRejectedValueOnce(new Error('disk full') as never)

      await expect(messageHideService.unhideMessage(s.authorMsg._id, s.admin)).rejects.toThrow('disk full')

      expect((await Message.findById(s.authorMsg._id))!.hiddenByAdmin).toBe(true)
      expect(await ModerationEvent.countDocuments()).toBe(1)
      expect(broadcastSpy).not.toHaveBeenCalled()
    })

    it('reverts hide-all and unhide-all', async () => {
      jest.spyOn(ModerationEvent, 'create').mockRejectedValueOnce(new Error('disk full') as never)
      await expect(messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)).rejects.toThrow('disk full')
      expect((await Conversation.findById(conversationOne._id))!.hiddenAuthors).toHaveLength(0)

      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      jest.spyOn(ModerationEvent, 'create').mockRejectedValueOnce(new Error('disk full') as never)
      await expect(messageHideService.unhideUserMessages(conversationId, s.author._id, s.admin)).rejects.toThrow('disk full')
      expect((await Conversation.findById(conversationOne._id))!.hiddenAuthors).toHaveLength(1)
    })
  })
})

describe('listModerationEvents', () => {
  it('returns newest first with a paginated envelope, and the actor as id and username only', async () => {
    await messageHideService.hideMessage(s.authorMsg._id, s.admin, 'pii')
    await messageHideService.hideUserMessages(conversationId, s.other._id, s.admin)
    await messageHideService.unhideMessage(s.authorMsg._id, s.admin)

    const page = await messageHideService.listModerationEvents(conversationId, s.admin)

    expect(page).toMatchObject({ page: 1, limit: 10, totalPages: 1, totalResults: 3 })
    expect(page.results.map((e: any) => `${e.action}:${e.scope}`)).toEqual(['unhide:message', 'hide:user', 'hide:message'])
    expect(page.results[0].actor).toEqual({ id: s.admin._id.toString(), username: s.admin.username })
    expect(JSON.stringify(page)).not.toContain(s.admin.email)
    expect(JSON.stringify(page)).not.toContain(s.authorMsg.body as string)
  })

  it('paginates, and keeps the order across pages', async () => {
    for (let i = 0; i < 5; i += 1) {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      await messageHideService.unhideMessage(s.authorMsg._id, s.admin)
    }
    const first = await messageHideService.listModerationEvents(conversationId, s.admin, { limit: 4, page: 1 })
    const second = await messageHideService.listModerationEvents(conversationId, s.admin, { limit: 4, page: 3 })

    expect(first.totalResults).toBe(10)
    expect(first.totalPages).toBe(3)
    expect(first.results).toHaveLength(4)
    expect(second.results).toHaveLength(2)
    expect(first.results[0].action).toBe('unhide')
    expect(second.results[1].action).toBe('hide')
  })

  it('is scoped to the conversation and admin only', async () => {
    await messageHideService.hideMessage(s.authorMsgElsewhere._id, s.admin)
    expect((await messageHideService.listModerationEvents(conversationId, s.admin)).results).toHaveLength(0)
    await expect(messageHideService.listModerationEvents(conversationId, s.other)).rejects.toMatchObject({ statusCode: 403 })
    await expect(messageHideService.listModerationEvents('000000000000000000000000', s.admin)).rejects.toMatchObject({
      statusCode: 404
    })
  })
})

describe('who may moderate', () => {
  const withRights = async (role: string, rights: string[], run: () => Promise<void>) => {
    const original = roleRights.get(role)!
    roleRights.set(role, rights)
    try {
      await run()
    } finally {
      roleRights.set(role, original)
    }
  }

  it('follows the moderateMessages right in the role table, not the literal admin role', async () => {
    await withRights('participant', [...roleRights.get('participant')!, 'moderateMessages'], async () => {
      await expect(messageHideService.hideMessage(s.authorMsg._id, s.other)).resolves.toMatchObject({ hidden: true })
      await expect(messageHideService.listModerationEvents(conversationId, s.other)).resolves.toBeDefined()
    })
  })

  it('refuses a role that no longer carries the right, even the admin role', async () => {
    await withRights(
      'admin',
      roleRights.get('admin')!.filter((right) => right !== 'moderateMessages'),
      async () => {
        await expect(messageHideService.hideMessage(s.authorMsg._id, s.admin)).rejects.toMatchObject({ statusCode: 403 })
        await expect(messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)).rejects.toMatchObject({
          statusCode: 403
        })
        await expect(messageHideService.listModerationEvents(conversationId, s.admin)).rejects.toMatchObject({
          statusCode: 403
        })
      }
    )
    expect((await Message.findById(s.authorMsg._id))!.hiddenByAdmin).toBeFalsy()
  })

  it('refuses a requester with no role', async () => {
    await expect(messageHideService.hideMessage(s.authorMsg._id, { _id: s.admin._id })).rejects.toMatchObject({
      statusCode: 403
    })
  })
})

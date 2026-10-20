import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { Message, Conversation, User, ModerationEvent } from '../../src/models/index.js'
import waitFor from '../utils/waitFor.js'
import { insertMessage, seedHideScenario, conversationOne, conversationTwo } from '../fixtures/messageHide.fixture.js'

setupIntTest()

let s: Awaited<ReturnType<typeof seedHideScenario>>
let broadcastSpy: jest.SpiedFunction<typeof websocketGateway.broadcast>

const history = (token: string, conversation = conversationOne) =>
  request(app)
    .get(`/v1/messages/${conversation._id}`)
    .query({ channel: 'chat' })
    .set('Authorization', `Bearer ${token}`)
    .expect(httpStatus.OK)
const replies = (token: string, messageId) =>
  request(app).get(`/v1/messages/${messageId}/replies`).set('Authorization', `Bearer ${token}`).expect(httpStatus.OK)
const hideOne = (token: string, messageId, method: 'post' | 'delete' = 'post') =>
  request(app)[method](`/v1/messages/${messageId}/hide`).set('Authorization', `Bearer ${token}`)
const hideUser = (token: string, userId, method: 'post' | 'delete' = 'post', conversation = conversationOne) =>
  request(app)
    [method](`/v1/conversations/${conversation._id}/users/${userId}/hide-messages`)
    .set('Authorization', `Bearer ${token}`)
const ids = (body: Array<{ id: string }>) => body.map((m) => m.id)

describe('admin hide message', () => {
  beforeEach(async () => {
    s = await seedHideScenario()
    broadcastSpy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('authorization', () => {
    test('a participant gets 403 on every hide route and nothing changes', async () => {
      await hideOne(s.otherToken, s.authorMsg._id).expect(httpStatus.FORBIDDEN)
      await hideOne(s.otherToken, s.authorMsg._id, 'delete').expect(httpStatus.FORBIDDEN)
      await hideUser(s.otherToken, s.author._id).expect(httpStatus.FORBIDDEN)
      await hideUser(s.otherToken, s.author._id, 'delete').expect(httpStatus.FORBIDDEN)
      expect((await Message.findById(s.authorMsg._id))!.hiddenByAdmin).toBe(false)
      expect((await Conversation.findById(conversationOne._id))!.hiddenAuthors).toHaveLength(0)
    })

    test('401 without a token, 404 for an unknown message, user or conversation', async () => {
      await request(app).post(`/v1/messages/${s.authorMsg._id}/hide`).expect(httpStatus.UNAUTHORIZED)
      await hideOne(s.adminToken, new mongoose.Types.ObjectId()).expect(httpStatus.NOT_FOUND)
      await hideUser(s.adminToken, new mongoose.Types.ObjectId()).expect(httpStatus.NOT_FOUND)
      await hideUser(s.adminToken, s.author._id, 'post', { _id: new mongoose.Types.ObjectId() } as never).expect(
        httpStatus.NOT_FOUND
      )
    })

    test('a malformed id is rejected', async () => {
      await hideOne(s.adminToken, 'not-an-id').expect(httpStatus.BAD_REQUEST)
    })

    test('401 without a token on every route and method', async () => {
      await request(app).delete(`/v1/messages/${s.authorMsg._id}/hide`).expect(httpStatus.UNAUTHORIZED)
      await request(app)
        .post(`/v1/conversations/${conversationOne._id}/users/${s.author._id}/hide-messages`)
        .expect(httpStatus.UNAUTHORIZED)
      await request(app)
        .delete(`/v1/conversations/${conversationOne._id}/users/${s.author._id}/hide-messages`)
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('malformed ids are rejected on the user route too', async () => {
      await hideUser(s.adminToken, 'not-an-id').expect(httpStatus.BAD_REQUEST)
      await hideUser(s.adminToken, s.author._id, 'post', { _id: 'not-an-id' } as never).expect(httpStatus.BAD_REQUEST)
    })

    test('the role is checked as it is now: an admin demoted after logging in is refused', async () => {
      await User.updateOne({ _id: s.admin._id }, { role: 'participant' })
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.FORBIDDEN)
      await hideUser(s.adminToken, s.author._id).expect(httpStatus.FORBIDDEN)
      expect((await Message.findById(s.authorMsg._id))!.hiddenByAdmin).toBe(false)
    })

    test('a participant promoted after logging in can hide', async () => {
      await User.updateOne({ _id: s.other._id }, { role: 'admin' })
      await hideOne(s.otherToken, s.authorMsg._id).expect(httpStatus.OK)
    })
  })

  describe('hiding one message', () => {
    test('returns the concrete ids, replies included, and is reversible', async () => {
      const hidden = await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      expect(hidden.body.hidden).toBe(true)
      expect(hidden.body.messageIds.sort()).toEqual([s.authorMsg._id.toString(), s.reply._id.toString()].sort())

      // repeating it changes nothing
      const again = await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      expect(again.body.messageIds).toEqual([])

      const restored = await hideOne(s.adminToken, s.authorMsg._id, 'delete').expect(httpStatus.OK)
      expect(restored.body.hidden).toBe(false)
      expect(restored.body.messageIds.sort()).toEqual([s.authorMsg._id.toString(), s.reply._id.toString()].sort())

      const forOther = await history(s.otherToken)
      expect(ids(forOther.body)).toContain(s.authorMsg._id.toString())
      expect(forOther.body.every((m) => m.hidden === undefined)).toBe(true)
    })

    test('history: admin sees it flagged, the author sees it unflagged, others do not see it', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)

      const admin = (await history(s.adminToken)).body
      const flagged = admin.find((m) => m.id === s.authorMsg._id.toString())
      expect(flagged.hidden).toBe(true)
      expect(flagged.body).toBe(s.authorMsg.body)
      expect(admin.find((m) => m.id === s.otherMsg._id.toString()).hidden).toBeUndefined()
      expect(flagged.hiddenByAdmin).toBeUndefined()

      const author = (await history(s.authorToken)).body
      const own = author.find((m) => m.id === s.authorMsg._id.toString())
      expect(own.body).toBe(s.authorMsg.body)
      expect(own.hidden).toBeUndefined()
      expect(own.hiddenByAdmin).toBeUndefined()
      expect(own.owner).toBe(s.author._id.toString())
      expect((await replies(s.adminToken, s.authorMsg._id)).body[0].owner).toBe(s.other._id.toString())

      const other = (await history(s.otherToken)).body
      expect(ids(other)).toEqual([s.otherMsg._id.toString()])
      expect(JSON.stringify(other)).not.toContain(s.authorMsg.body as string)
    })

    test('replies to a hidden parent are hidden for participants and flagged for admins', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)

      const forAdmin = (await replies(s.adminToken, s.authorMsg._id)).body
      expect(forAdmin).toHaveLength(1)
      expect(forAdmin[0]).toMatchObject({ id: s.reply._id.toString(), hidden: true })

      expect((await replies(s.authorToken, s.authorMsg._id)).body).toEqual([])
      // their own reply to a hidden parent stays visible to its writer
      expect((await replies(s.otherToken, s.authorMsg._id)).body.map((m) => m.id)).toEqual([s.reply._id.toString()])
    })

    test('replyCount leaves out hidden replies for non-admins but not for admins or the reply author', async () => {
      await hideOne(s.adminToken, s.reply._id).expect(httpStatus.OK)

      const count = async (token: string) =>
        (await history(token)).body.find((m) => m.id === s.authorMsg._id.toString()).replyCount
      expect(await count(s.adminToken)).toBe(1)
      expect(await count(s.otherToken)).toBe(1) // the reply is theirs
      expect(await count(s.authorToken)).toBe(0)
    })

    test('a hidden message cannot be voted on by someone who cannot see it', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      await request(app)
        .post(`/v1/messages/${s.authorMsg._id}/vote`)
        .set('Authorization', `Bearer ${s.otherToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.NOT_FOUND)
    })

    test('hiding a message in one conversation leaves another conversation untouched', async () => {
      const res = await hideOne(s.adminToken, s.authorMsgElsewhere._id).expect(httpStatus.OK)
      expect(res.body.conversationId).toBe(conversationTwo._id.toString())
      expect(res.body.messageIds).toEqual([s.authorMsgElsewhere._id.toString()])

      expect(ids((await history(s.otherToken)).body)).toEqual(
        expect.arrayContaining([s.authorMsg._id.toString(), s.otherMsg._id.toString()])
      )
      expect(ids((await history(s.otherToken, conversationTwo)).body)).toEqual([])
    })

    test('a hidden message stays visible to admins and the author across routes, and voting on it is fine for an admin', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      const voted = await request(app)
        .post(`/v1/messages/${s.authorMsg._id}/vote`)
        .set('Authorization', `Bearer ${s.adminToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.OK)
      expect(voted.body.upVotes).toHaveLength(1)
      // vote() does not await the broadcast, so wait for it before the mocks are restored
      await waitFor(() => expect(broadcastSpy.mock.calls.filter((c) => c[1] === 'vote:new')).toHaveLength(1))
      const [voteCall] = broadcastSpy.mock.calls.filter((c) => c[1] === 'vote:new')
      expect(voteCall[4]).toEqual([`admin:${conversationOne._id}`])
      expect(voteCall[3]).toEqual([])
    })

    test('voting on a visible message is unaffected by hiding another one', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      await request(app)
        .post(`/v1/messages/${s.otherMsg._id}/vote`)
        .set('Authorization', `Bearer ${s.authorToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.OK)
      await waitFor(() => expect(broadcastSpy.mock.calls.filter((c) => c[1] === 'vote:new')).toHaveLength(1))
    })

    test('does not touch the visible flag', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      expect((await Message.findById(s.authorMsg._id))!.visible).toBe(true)
    })
  })

  describe('hiding all of a user messages', () => {
    test('covers past and future messages, in this conversation only, and is reversible', async () => {
      const res = await hideUser(s.adminToken, s.author._id).expect(httpStatus.OK)
      expect(res.body).toMatchObject({ hidden: true, userId: s.author._id.toString() })
      // the author's message plus the reply cascading from it
      expect(res.body.messageIds.sort()).toEqual([s.authorMsg._id.toString(), s.reply._id.toString()].sort())

      expect(ids((await history(s.otherToken)).body)).toEqual([s.otherMsg._id.toString()])
      // another conversation is untouched
      expect(ids((await history(s.otherToken, conversationTwo)).body)).toContain(s.authorMsgElsewhere._id.toString())

      // a message posted afterwards is hidden too
      const created = await request(app)
        .post('/v1/messages')
        .set('Authorization', `Bearer ${s.authorToken}`)
        .send({
          body: 'posted while hidden',
          conversation: conversationOne._id.toString(),
          channels: [{ name: 'chat' }]
        })
        .expect(httpStatus.CREATED)
      expect(ids((await history(s.otherToken)).body)).not.toContain(created.body[0].id)
      const adminView = (await history(s.adminToken)).body.find((m) => m.id === created.body[0].id)
      expect(adminView.hidden).toBe(true)
      expect((await history(s.authorToken)).body.find((m) => m.id === created.body[0].id).hidden).toBeUndefined()

      const undone = await hideUser(s.adminToken, s.author._id, 'delete').expect(httpStatus.OK)
      expect(undone.body.hidden).toBe(false)
      expect(undone.body.messageIds).toHaveLength(3)
      expect(ids((await history(s.otherToken)).body)).toEqual(
        expect.arrayContaining([s.authorMsg._id.toString(), created.body[0].id])
      )
    })

    test('hiding user X in conversation A does not hide X in conversation B', async () => {
      const res = await hideUser(s.adminToken, s.author._id).expect(httpStatus.OK)
      expect(res.body.messageIds).not.toContain(s.authorMsgElsewhere._id.toString())
      expect((await Conversation.findById(conversationTwo._id))!.hiddenAuthors).toHaveLength(0)
      expect(ids((await history(s.otherToken, conversationTwo)).body)).toEqual([s.authorMsgElsewhere._id.toString()])

      // and the reverse: hiding X in B leaves A's state as it was
      await hideUser(s.adminToken, s.author._id, 'post', conversationTwo).expect(httpStatus.OK)
      expect((await Conversation.findById(conversationOne._id))!.hiddenAuthors).toHaveLength(1)
      await hideUser(s.adminToken, s.author._id, 'delete', conversationTwo).expect(httpStatus.OK)
      expect(ids((await history(s.otherToken)).body)).toEqual([s.otherMsg._id.toString()])
    })

    test('repeating hide-all or unhide-all is a no-op that returns no ids', async () => {
      await hideUser(s.adminToken, s.author._id).expect(httpStatus.OK)
      expect((await hideUser(s.adminToken, s.author._id).expect(httpStatus.OK)).body.messageIds).toEqual([])
      await hideUser(s.adminToken, s.author._id, 'delete').expect(httpStatus.OK)
      expect((await hideUser(s.adminToken, s.author._id, 'delete').expect(httpStatus.OK)).body.messageIds).toEqual([])
      expect((await Conversation.findById(conversationOne._id))!.hiddenAuthors).toHaveLength(0)
    })

    test('a message hidden on its own stays hidden after the author is unhidden', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      await hideUser(s.adminToken, s.author._id).expect(httpStatus.OK)
      const undone = await hideUser(s.adminToken, s.author._id, 'delete').expect(httpStatus.OK)
      expect(undone.body.messageIds).toEqual([])
      expect(ids((await history(s.otherToken)).body)).toEqual([s.otherMsg._id.toString()])
    })
  })

  /* Hiding is a group chat feature: anything outside the `chat` channel, such as a participant's
     private assistant channel, is never hidden. */
  describe('scope: the chat channel only', () => {
    const channelHistory = (token: string, channel: string) =>
      request(app)
        .get(`/v1/messages/${conversationOne._id}`)
        .query({ channel })
        .set('Authorization', `Bearer ${token}`)
        .expect(httpStatus.OK)

    test('hiding a single message outside the chat channel is rejected with 400 and changes nothing', async () => {
      const inAssistant = await insertMessage(s.author, conversationOne, { channels: ['assistant'] })
      const noChannel = await insertMessage(s.author, conversationOne, { channels: [] })

      const res = await hideOne(s.adminToken, inAssistant._id).expect(httpStatus.BAD_REQUEST)
      expect(res.body.message).toMatch(/chat channel/)
      await hideOne(s.adminToken, noChannel._id).expect(httpStatus.BAD_REQUEST)

      expect((await Message.findById(inAssistant._id))!.hiddenByAdmin).toBe(false)
      expect(broadcastSpy).not.toHaveBeenCalled()
    })

    test('unhiding such a message is not an error and reports nothing to restore', async () => {
      const inAssistant = await insertMessage(s.author, conversationOne, { channels: ['assistant'] })
      const res = await hideOne(s.adminToken, inAssistant._id, 'delete').expect(httpStatus.OK)
      expect(res.body.messageIds).toEqual([])
    })

    test('hide-all hides the user chat messages but not their messages in other channels', async () => {
      const inAssistant = await insertMessage(s.author, conversationOne, { channels: ['assistant'], body: 'private' })
      const noChannel = await insertMessage(s.author, conversationOne, { channels: [], body: 'main' })

      const res = await hideUser(s.adminToken, s.author._id).expect(httpStatus.OK)

      expect(res.body.messageIds).not.toContain(inAssistant._id.toString())
      expect(res.body.messageIds).not.toContain(noChannel._id.toString())
      expect(ids((await channelHistory(s.otherToken, 'assistant')).body)).toContain(inAssistant._id.toString())
      expect((await channelHistory(s.otherToken, 'assistant')).body[0].hidden).toBeUndefined()
      expect(ids((await history(s.otherToken)).body)).not.toContain(s.authorMsg._id.toString())
    })

    test('a reply in another channel under a hidden chat message is not cascaded away', async () => {
      const inAssistant = await insertMessage(s.other, conversationOne, {
        channels: ['assistant'],
        parentMessage: s.authorMsg._id
      })
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)

      // a non-admin still receives it, unflagged; an admin sees no flag either
      const otherReplies = (await replies(s.otherToken, s.authorMsg._id)).body
      expect(otherReplies.map((m) => m.id)).toContain(inAssistant._id.toString())
      const adminReplies = (await replies(s.adminToken, s.authorMsg._id)).body
      expect(adminReplies.find((m) => m.id === inAssistant._id.toString()).hidden).toBeUndefined()
      expect(adminReplies.find((m) => m.id === s.reply._id.toString()).hidden).toBe(true)
    })

    test('a hidden author keeps seeing nothing different in other channels, and admins see no flag there', async () => {
      const inAssistant = await insertMessage(s.author, conversationOne, { channels: ['assistant'] })
      await hideUser(s.adminToken, s.author._id).expect(httpStatus.OK)

      const forAdmin = (await channelHistory(s.adminToken, 'assistant')).body.find(
        (m) => m.id === inAssistant._id.toString()
      )
      expect(forAdmin.hidden).toBeUndefined()
    })
  })

  describe('reason and the moderation activity log', () => {
    const events = (token: string, conversation = conversationOne, query: Record<string, unknown> = {}) =>
      request(app)
        .get(`/v1/conversations/${conversation._id}/moderation-events`)
        .query(query)
        .set('Authorization', `Bearer ${token}`)

    test('accepts a JSON body with a reason on hide and persists it', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).send({ reason: 'pii' }).expect(httpStatus.OK)
      expect((await ModerationEvent.findOne({}))!.reason).toBe('pii')
    })

    test('rejects an unknown reason, a non-string reason and unknown keys with 400, writing nothing', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).send({ reason: 'because' }).expect(httpStatus.BAD_REQUEST)
      await hideOne(s.adminToken, s.authorMsg._id).send({ reason: 5 }).expect(httpStatus.BAD_REQUEST)
      await hideOne(s.adminToken, s.authorMsg._id).send({ reason: 'pii', extra: 1 }).expect(httpStatus.BAD_REQUEST)
      await hideUser(s.adminToken, s.author._id).send({ reason: 'because' }).expect(httpStatus.BAD_REQUEST)
      expect((await Message.findById(s.authorMsg._id))!.hiddenByAdmin).toBe(false)
      expect(await ModerationEvent.countDocuments()).toBe(0)
    })

    test('unhide accepts an enum value or short free text, but not a long note', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      await hideOne(s.adminToken, s.authorMsg._id, 'delete')
        .send({ reason: 'x'.repeat(201) })
        .expect(httpStatus.BAD_REQUEST)
      await hideOne(s.adminToken, s.authorMsg._id, 'delete')
        .send({ reason: 'resolved with the author' })
        .expect(httpStatus.OK)
      const log = await ModerationEvent.find({}).sort({ _id: 1 })
      expect(log.map((e) => e.action)).toEqual(['hide', 'unhide'])
      expect(log[1].reason).toBe('resolved with the author')
    })

    test('hide-all with a reason logs one event with the cascaded ids, and the admin reads it back', async () => {
      const res = await hideUser(s.adminToken, s.author._id).send({ reason: 'harassment' }).expect(httpStatus.OK)

      const log = await events(s.adminToken).expect(httpStatus.OK)
      expect(log.body.totalResults).toBe(1)
      const [event] = log.body.results
      expect(event).toMatchObject({
        action: 'hide',
        scope: 'user',
        reason: 'harassment',
        conversation: conversationOne._id.toString(),
        targetUser: s.author._id.toString(),
        actor: { id: s.admin._id.toString(), username: s.admin.username }
      })
      expect(event.messageIds.sort()).toEqual(res.body.messageIds.sort())
      expect(event.messageIds).toHaveLength(2)
      expect(event.id).toBeDefined()
      expect(event.createdAt).toBeDefined()
    })

    test('a no-op, a rejected call and an unauthorized call write nothing', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK) // no-op
      await hideOne(s.otherToken, s.otherMsg._id).expect(httpStatus.FORBIDDEN)
      await hideOne(s.adminToken, new mongoose.Types.ObjectId()).expect(httpStatus.NOT_FOUND)
      await request(app).post(`/v1/messages/${s.otherMsg._id}/hide`).expect(httpStatus.UNAUTHORIZED)
      expect(await ModerationEvent.countDocuments()).toBe(1)
    })

    test('the log is per conversation: another conversation sees only its own events', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      await hideOne(s.adminToken, s.authorMsgElsewhere._id).expect(httpStatus.OK)

      expect((await events(s.adminToken).expect(httpStatus.OK)).body.totalResults).toBe(1)
      const other = (await events(s.adminToken, conversationTwo).expect(httpStatus.OK)).body
      expect(other.totalResults).toBe(1)
      expect(other.results[0].messageIds).toEqual([s.authorMsgElsewhere._id.toString()])
    })

    test('lists newest first and paginates with page and limit', async () => {
      for (let i = 0; i < 3; i += 1) {
        await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
        await hideOne(s.adminToken, s.authorMsg._id, 'delete').expect(httpStatus.OK)
      }
      const page1 = (await events(s.adminToken, conversationOne, { limit: 4 }).expect(httpStatus.OK)).body
      const page2 = (await events(s.adminToken, conversationOne, { limit: 4, page: 2 }).expect(httpStatus.OK)).body

      expect(page1).toMatchObject({ page: 1, limit: 4, totalPages: 2, totalResults: 6 })
      expect(page1.results.map((e) => e.action)).toEqual(['unhide', 'hide', 'unhide', 'hide'])
      expect(page2.results).toHaveLength(2)
      const stamps = [...page1.results, ...page2.results].map((e) => new Date(e.createdAt).getTime())
      expect(stamps).toEqual([...stamps].sort((a, b) => b - a))
    })

    test('reading needs an admin: 401 without a token, 403 for a participant, 404 unknown, 400 malformed', async () => {
      await request(app).get(`/v1/conversations/${conversationOne._id}/moderation-events`).expect(httpStatus.UNAUTHORIZED)
      await events(s.otherToken).expect(httpStatus.FORBIDDEN)
      await events(s.adminToken, { _id: new mongoose.Types.ObjectId() } as never).expect(httpStatus.NOT_FOUND)
      await events(s.adminToken, { _id: 'nope' } as never).expect(httpStatus.BAD_REQUEST)
      await events(s.adminToken, conversationOne, { limit: 0 }).expect(httpStatus.BAD_REQUEST)
      await events(s.adminToken, conversationOne, { limit: 101 }).expect(httpStatus.BAD_REQUEST)
      await events(s.adminToken, conversationOne, { page: 0 }).expect(httpStatus.BAD_REQUEST)
    })

    test('an admin demoted after logging in can no longer read the log', async () => {
      await User.updateOne({ _id: s.admin._id }, { role: 'participant' })
      await events(s.adminToken).expect(httpStatus.FORBIDDEN)
    })

    test('there is no route to edit or delete an event', async () => {
      await hideOne(s.adminToken, s.authorMsg._id).expect(httpStatus.OK)
      const id = (await ModerationEvent.findOne({}))!._id
      for (const method of ['put', 'patch', 'delete'] as const) {
        const res = await request(app)
          [method](`/v1/conversations/${conversationOne._id}/moderation-events/${id}`)
          .set('Authorization', `Bearer ${s.adminToken}`)
        expect([httpStatus.NOT_FOUND, httpStatus.METHOD_NOT_ALLOWED]).toContain(res.status)
      }
      await request(app)
        .delete(`/v1/conversations/${conversationOne._id}/moderation-events`)
        .set('Authorization', `Bearer ${s.adminToken}`)
        .expect((res) => expect([404, 405]).toContain(res.status))
      expect(await ModerationEvent.countDocuments()).toBe(1)
    })
  })
})

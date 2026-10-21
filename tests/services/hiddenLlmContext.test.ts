/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Conversation, Message, Topic } from '../../src/models/index.js'
import getConversationHistory from '../../src/agents/helpers/getConversationHistory.js'
import getThreadMessages from '../../src/agents/helpers/getThreadMessages.js'
import conceptGraphService from '../../src/services/conceptGraph/index.js'
import { duplicateConversationMessages } from '../../src/services/message.service.js'
import topicService from '../../src/services/topic.service.js'
import { fetchThread } from '../../src/agents/vibesAnalyst/thread.js'
import {
  findMessages,
  hiddenMessagesMatch,
  loadHideContext,
  populateMessagesForModel
} from '../../src/utils/messageVisibility.js'
import { insertMessage, seedHideScenario, conversationOne } from '../fixtures/messageHide.fixture.js'
import { publicTopic } from '../fixtures/conversation.fixture.js'

/**
 * Hidden messages must never reach a model, whoever the reply is for. Each case seeds the same three
 * ways a message becomes hidden (hidden on its own, written by a hidden author, a reply under a hidden
 * message) next to messages that must still pass through.
 */
setupIntTest()

let s: Awaited<ReturnType<typeof seedHideScenario>>

const bodies = (messages: any[]) => messages.map((m) => m.body).sort()

/** authorMsg hidden on its own (reply under it cascades); otherMsg stays visible. */
const hideSingle = async () => {
  await Message.updateOne({ _id: s.authorMsg._id }, { hiddenByAdmin: true })
}
/** author hidden for the whole conversation, including a later message of theirs. */
const hideAuthor = async () => {
  await Conversation.updateOne({ _id: conversationOne._id }, { $addToSet: { hiddenAuthors: s.author._id } })
}

beforeEach(async () => {
  s = await seedHideScenario()
})

describe('hiddenMessagesMatch', () => {
  it('is empty when nothing is hidden, so visible messages are never excluded', async () => {
    expect(await hiddenMessagesMatch(conversationOne._id, 'model')).toEqual({})
  })

  it.each([
    ['hidden on its own', hideSingle],
    ['a hidden author', hideAuthor]
  ])('excludes the message and the reply under it for %s, but not the bystander', async (_name, hide) => {
    await hide()
    const match = await hiddenMessagesMatch(conversationOne._id, 'model')
    const kept = await Message.find({ conversation: conversationOne._id, ...match })
    expect(kept.map((m) => m._id.toString())).toEqual([s.otherMsg._id.toString()])
  })
})

describe('findMessages', () => {
  const idsFor = async (audience: 'participant' | 'admin' | 'model', filter = {}) =>
    (await findMessages(conversationOne._id, audience, filter)).map((m) => m._id.toString()).sort()
  const everyone = () => [s.authorMsg, s.reply, s.otherMsg].map((m) => m._id.toString()).sort()

  it.each([['participant'], ['admin'], ['model']] as const)(
    'returns every message to %s when nothing is hidden',
    async (audience) => {
      expect(await idsFor(audience)).toEqual(everyone())
    }
  )

  it.each([
    ['hidden on its own', hideSingle],
    ['a hidden author', hideAuthor]
  ])('leaves out %s and the reply under it for participant and model, but not admin', async (_name, hide) => {
    await hide()
    expect(await idsFor('participant')).toEqual([s.otherMsg._id.toString()])
    expect(await idsFor('model')).toEqual([s.otherMsg._id.toString()])
    expect(await idsFor('admin')).toEqual(everyone())
  })

  it('cannot be widened by the caller filter, and never reads another conversation', async () => {
    await hideAuthor()
    expect(await idsFor('model', { _id: s.authorMsg._id })).toEqual([])
    expect(await idsFor('model', { conversation: s.authorMsgElsewhere.conversation })).toEqual([])
  })
})

describe('getConversationHistory', () => {
  it('passes visible messages through untouched', async () => {
    const all = await Message.find({ conversation: conversationOne._id }).sort({ createdAt: 1 })
    expect(getConversationHistory(all, { count: 10 }).messages).toHaveLength(3)
  })

  it('drops a message flagged hidden even when it was loaded into the array', async () => {
    await hideSingle()
    const all = await Message.find({ conversation: conversationOne._id }).sort({ createdAt: 1 })
    const { messages } = getConversationHistory(all, { count: 10 })
    expect(messages.map((m) => m._id.toString())).not.toContain(s.authorMsg._id.toString())
    // the backstop only knows the flag; reply and author cascades are removed by the populate match
    expect(messages.map((m) => m._id.toString())).toContain(s.otherMsg._id.toString())
  })

  it('drops a reply under a flagged message and, given the hide context, a hidden author, from a loaded list', async () => {
    await hideAuthor()
    const all = await Message.find({ conversation: conversationOne._id }).sort({ createdAt: 1 })
    const ctx = await loadHideContext(conversationOne._id)
    const { messages } = getConversationHistory(all, { count: 10, hideContext: ctx })
    expect(messages.map((m) => m._id.toString())).toEqual([s.otherMsg._id.toString()])

    await Message.updateOne({ _id: s.otherMsg._id }, { hiddenByAdmin: true })
    const reloaded = await Message.find({ conversation: conversationOne._id }).sort({ createdAt: 1 })
    const replyUnderFlagged = await insertMessage(s.author, conversationOne, { parentMessage: s.otherMsg._id })
    // the flag alone, no hide context: the reply cascade still works inside the list
    const kept = getConversationHistory([...reloaded, replyUnderFlagged], { count: 10 }).messages
    expect(kept.map((m) => m._id.toString())).toEqual([s.authorMsg._id.toString(), s.reply._id.toString()])
  })

  it('keeps the channel filter working for what remains', async () => {
    const chat = await insertMessage(s.other, conversationOne, { channels: ['chat'], body: 'chat one' })
    const hidden = await insertMessage(s.other, conversationOne, {
      channels: ['chat'],
      body: 'chat hidden',
      hiddenByAdmin: true
    })
    const { messages } = getConversationHistory([chat, hidden], { count: 10, channels: ['chat'] })
    expect(bodies(messages)).toEqual(['chat one'])
  })
})

describe('getThreadMessages', () => {
  const reply = (author, parent, body, overrides = {}) =>
    insertMessage(author, conversationOne, { parentMessage: parent._id, body, ...overrides })

  it('leaves out a hidden reply when the parent is among the loaded messages', async () => {
    const visibleReply = await reply(s.other, s.otherMsg, 'visible reply')
    await reply(s.other, s.otherMsg, 'hidden reply', { hiddenByAdmin: true })
    const trigger = await reply(s.other, s.otherMsg, 'the new message')

    const thread = await getThreadMessages(
      [s.otherMsg, visibleReply, trigger] as any,
      trigger as any,
      conversationOne._id.toString()
    )

    expect(bodies(thread)).toEqual(bodies([s.otherMsg, visibleReply]))
  })

  it('leaves out a hidden author reply when the parent has to be fetched separately', async () => {
    const visibleReply = await reply(s.other, s.otherMsg, 'visible reply')
    await reply(s.author, s.otherMsg, 'by hidden author')
    await hideAuthor()
    const trigger = await reply(s.other, s.otherMsg, 'the new message')

    // allMessages lacks the parent, which sends getThreadMessages down its fetch-the-parent branch
    const thread = await getThreadMessages([visibleReply] as any, trigger as any, conversationOne._id.toString())

    expect(bodies(thread)).toEqual(bodies([s.otherMsg, visibleReply]))
  })

  it('leaves out replies that cascade from a hidden message', async () => {
    const parent = await insertMessage(s.other, conversationOne, { body: 'hidden parent', hiddenByAdmin: true })
    const sibling = await insertMessage(s.other, conversationOne, { body: 'unrelated' })
    const cascaded = await reply(s.other, parent, 'under hidden')
    const trigger = await reply(s.other, sibling, 'trigger')

    const thread = await getThreadMessages(
      [sibling, cascaded, trigger] as any,
      trigger as any,
      conversationOne._id.toString()
    )

    expect(bodies(thread)).toEqual(['unrelated'])
  })
})

describe('conceptGraph loadSources', () => {
  const sourcesFor = async () => {
    const conversation = await Conversation.findById(conversationOne._id)
    const { texts } = await conceptGraphService.loadSources(conversation, [])
    return texts
  }

  beforeEach(async () => {
    await Message.updateMany({ conversation: conversationOne._id }, { channels: ['chat'] })
  })

  it('includes every visible message', async () => {
    expect(await sourcesFor()).toHaveLength(3)
  })

  it.each([
    ['hidden on its own', hideSingle],
    ['a hidden author', hideAuthor]
  ])('leaves out %s and the reply under it', async (_name, hide) => {
    await hide()
    expect(await sourcesFor()).toEqual([s.otherMsg.body])
  })
})

/* Hiding is scoped to the group chat channel: a hidden author's private assistant channel (or any other
   channel) must keep reaching the model that serves it. */
describe('messages outside the chat channel are never filtered out of model context', () => {
  const inAssistant = (overrides = {}) => insertMessage(s.author, conversationOne, { channels: ['assistant'], ...overrides })

  it('hiddenMessagesMatch leaves a hidden author’s assistant messages, and a flagged one, in', async () => {
    const plain = await inAssistant({ body: 'assistant words' })
    const flagged = await inAssistant({ body: 'flagged elsewhere', hiddenByAdmin: true })
    const replyElsewhere = await insertMessage(s.other, conversationOne, {
      channels: ['assistant'],
      parentMessage: s.authorMsg._id
    })
    await hideAuthor()

    const match = await hiddenMessagesMatch(conversationOne._id, 'model')
    const kept = (await Message.find({ conversation: conversationOne._id, ...match })).map((m) => m._id.toString())

    expect(kept).toEqual(
      expect.arrayContaining([
        plain._id.toString(),
        flagged._id.toString(),
        replyElsewhere._id.toString(),
        s.otherMsg._id.toString()
      ])
    )
    expect(kept).not.toContain(s.authorMsg._id.toString())
    expect(kept).not.toContain(s.reply._id.toString())
  })

  it('getConversationHistory keeps a non-chat message even if it carries the hidden flag', async () => {
    const flagged = await inAssistant({ hiddenByAdmin: true })
    expect(getConversationHistory([flagged], { count: 10 }).messages).toHaveLength(1)
  })

  it('getThreadMessages keeps a hidden author’s assistant-channel replies', async () => {
    await hideAuthor()
    const reply = await insertMessage(s.author, conversationOne, {
      channels: ['assistant'],
      parentMessage: s.otherMsg._id,
      body: 'assistant thread reply'
    })
    const trigger = await insertMessage(s.other, conversationOne, { parentMessage: s.otherMsg._id, body: 'trigger' })

    const thread = await getThreadMessages(
      [s.otherMsg, reply, trigger] as any,
      trigger as any,
      conversationOne._id.toString()
    )

    expect(bodies(thread)).toEqual(bodies([s.otherMsg, reply]))
  })

  it('conceptGraph loadSources only reads chat and transcript, so hiding cannot touch an assistant message either way', async () => {
    await insertMessage(s.author, conversationOne, { channels: ['transcript'], body: 'transcript words' })
    await hideAuthor()
    const conversation = await Conversation.findById(conversationOne._id)
    const { texts } = await conceptGraphService.loadSources(conversation, [])
    expect(texts).toEqual(expect.arrayContaining(['transcript words']))
  })
})

describe('getThreadMessages with a hidden parent that has to be fetched', () => {
  it('does not return a hidden parent', async () => {
    const hiddenParent = await insertMessage(s.other, conversationOne, { body: 'hidden parent', hiddenByAdmin: true })
    const trigger = await insertMessage(s.other, conversationOne, { parentMessage: hiddenParent._id, body: 'trigger' })

    // allMessages lacks the parent, which sends getThreadMessages down its fetch-the-parent branch
    const thread = await getThreadMessages([s.otherMsg] as any, trigger as any, conversationOne._id.toString())

    expect(thread).toEqual([])
  })

  it('still returns a visible parent fetched that way', async () => {
    const trigger = await insertMessage(s.other, conversationOne, { parentMessage: s.otherMsg._id, body: 'trigger' })
    const thread = await getThreadMessages([trigger] as any, trigger as any, conversationOne._id.toString())
    expect(bodies(thread)).toEqual([s.otherMsg.body])
  })
})

describe('vibesAnalyst fetchThread', () => {
  it('leaves out a hidden thread root and everything under it', async () => {
    await hideSingle()
    const trigger = await insertMessage(s.other, conversationOne, { parentMessage: s.authorMsg._id, body: 'trigger' })
    expect(await fetchThread(trigger as any, conversationOne._id.toString())).toEqual([])
  })

  it('returns a visible thread newest first', async () => {
    const later = await insertMessage(s.other, conversationOne, { parentMessage: s.otherMsg._id, body: 'later' })
    const thread = await fetchThread(later as any, conversationOne._id.toString())
    expect(bodies(thread)).toEqual(bodies([s.otherMsg, later]))
  })
})

describe('duplicateConversationMessages', () => {
  const copiesOf = async (target) => Message.find({ conversation: target._id }).lean()

  it('copies every message when nothing is hidden', async () => {
    const target = new mongoose.Types.ObjectId()
    await duplicateConversationMessages(conversationOne._id, target)
    expect(await copiesOf({ _id: target })).toHaveLength(3)
  })

  it.each([
    ['hidden on its own', hideSingle],
    ['a hidden author', hideAuthor]
  ])('does not copy %s, nor the reply under it', async (_name, hide) => {
    await hide()
    const target = new mongoose.Types.ObjectId()
    await duplicateConversationMessages(conversationOne._id, target)
    const copies = await copiesOf({ _id: target })
    expect(copies.map((m: any) => m.body)).toEqual([s.otherMsg.body])
  })

  it('does not carry the hidden flag onto a copy', async () => {
    // a flagged message outside chat is never hidden, so it is copied, but without the moderation flag
    await insertMessage(s.author, conversationOne, { channels: ['assistant'], hiddenByAdmin: true, body: 'elsewhere' })
    const target = new mongoose.Types.ObjectId()
    await duplicateConversationMessages(conversationOne._id, target)
    const copy: any = (await copiesOf({ _id: target })).find((m: any) => m.body === 'elsewhere')
    expect(copy).toBeDefined()
    expect(copy.hiddenByAdmin).toBeFalsy()
  })
})

describe('participant-facing counts', () => {
  it('Conversation.messageCount counts top-level messages without hidden ones', async () => {
    const conversation: any = await Conversation.findById(conversationOne._id)
    // authorMsg + otherMsg are top level; the reply is not
    expect(await conversation.messageCount()).toBe(2)
    await hideSingle()
    expect(await conversation.messageCount()).toBe(1)
  })

  it('messageCount drops a hidden author’s top-level messages too', async () => {
    const conversation: any = await Conversation.findById(conversationOne._id)
    await hideAuthor()
    expect(await conversation.messageCount()).toBe(1)
  })

  it('a topic list counts and dates activity without hidden messages', async () => {
    await Topic.updateOne({ _id: publicTopic._id }, { conversations: [conversationOne._id] })
    const find = async () => (await topicService.allPublicTopics()).find((t: any) => t.id === publicTopic._id.toString())
    const before: any = await find()
    expect(before.messageCount).toBe(2)
    const stamp = (
      id,
      iso // createdAt is immutable through mongoose, so write it natively
    ) => Message.collection.updateOne({ _id: id }, { $set: { createdAt: new Date(iso) } })
    await stamp(s.otherMsg._id, '2020-01-01T00:00:00Z')
    await stamp(s.authorMsg._id, '2021-01-01T00:00:00Z')
    await stamp(s.reply._id, '2019-01-01T00:00:00Z')

    await hideSingle()
    const after: any = await find()

    expect(after.messageCount).toBe(1)
    // the newest remaining message is the older one: hiding authorMsg moves the topic's recency back
    expect(new Date(after.latestMessageCreatedAt).getTime()).toBe(new Date('2020-01-01T00:00:00Z').getTime())
  })
})

describe('history backstop applies the hide context the messages were populated under', () => {
  it('drops a hidden author’s message that appears after the list was populated', async () => {
    await hideAuthor()
    const conversation: any = await Conversation.findById(conversationOne._id)
    await populateMessagesForModel(conversation)
    expect(bodies(conversation.messages)).toEqual([s.otherMsg.body])

    // as createMessage does: the new post is pushed into the in-memory list, unseen by the populate match
    const late = await insertMessage(s.author, conversationOne, { body: 'late post by hidden author' })
    conversation.messages.push(late)

    expect(bodies(getConversationHistory(conversation.messages, { count: 10, channels: ['chat'] }).messages)).toEqual([
      s.otherMsg.body
    ])
  })

  it('an explicit settings.hideContext wins over the one the list was loaded under', async () => {
    const conversation: any = await Conversation.findById(conversationOne._id)
    await populateMessagesForModel(conversation)
    const ctx = await loadHideContext(conversationOne._id)
    ctx.hiddenAuthors.add(s.other._id.toString())

    const history = getConversationHistory(conversation.messages, { count: 10, channels: ['chat'], hideContext: ctx })

    expect(bodies(history.messages)).toEqual([s.authorMsg.body])
  })
})

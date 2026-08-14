import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import { Conversation, Message } from '../../../../src/models/index.js'
import createVibesAnalystTools from '../../../../src/agents/vibesAnalyst/tools.js'

setupIntTest()

/* The analytics service tests cover the computations themselves over plain arrays. This file
   covers what only the tool layer can: that a call is recorded with the filter that produced it,
   that the message set stays scoped to one event, and that nothing identifying reaches the model. */

const ownerId = new mongoose.Types.ObjectId()
const eventStart = new Date('2026-07-01T12:00:00.000Z')

const ownerByName = new Map<string, mongoose.Types.ObjectId>()
function ownerFor(name: string): mongoose.Types.ObjectId {
  if (!ownerByName.has(name)) ownerByName.set(name, new mongoose.Types.ObjectId())
  return ownerByName.get(name)!
}

async function seedEvent() {
  return Conversation.create({
    name: 'Spring Town Hall',
    slug: `hall-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: new mongoose.Types.ObjectId(),
    startTime: eventStart,
    transcript: { status: 'stopped' }
  })
}

async function seedMessage(conversationId: mongoose.Types.ObjectId, sender: string, minute: number, body = 'a message') {
  return Message.create({
    body,
    conversation: conversationId,
    owner: ownerFor(sender),
    pseudonymId: ownerId,
    pseudonym: sender,
    fromAgent: false,
    channels: ['main'],
    createdAt: new Date(eventStart.getTime() + minute * 60 * 1000)
  })
}

/* Pulls one tool out of the set by the name the model calls it by. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolNamed(tools: any[], name: string): any {
  return tools.find((candidate) => candidate.name === name)
}

describe('createVibesAnalystTools', () => {
  it('records each call with the filter that produced its result', async () => {
    const conversation = await seedEvent()
    await seedMessage(conversation._id, 'ana', 1)
    await seedMessage(conversation._id, 'ana', 3)
    await seedMessage(conversation._id, 'bo', 4)
    await seedMessage(conversation._id, 'cy', 40)

    const { tools, computations } = createVibesAnalystTools(conversation)
    const result = JSON.parse(await toolNamed(tools, 'count_messages').invoke({ toMinute: 10 }))

    // The fact-checking pass verifies a cited number against this record, so it has to carry
    // the filter as well as the result: 3 messages in the first 10 minutes is not 3 overall.
    expect(computations).toEqual([{ tool: 'count_messages', args: { toMinute: 10 }, result }])
    expect(result.messageCount).toBe(3)
  })

  it('records every call in the order it ran', async () => {
    const conversation = await seedEvent()
    await seedMessage(conversation._id, 'ana', 1)

    const { tools, computations } = createVibesAnalystTools(conversation)
    await toolNamed(tools, 'count_messages').invoke({ toMinute: 30 })
    await toolNamed(tools, 'measure_message_lengths').invoke({})

    expect(computations.map((computation) => computation.tool)).toEqual(['count_messages', 'measure_message_lengths'])
  })

  it('never reads another event, so the answer stays scoped to the one being asked about', async () => {
    const conversation = await seedEvent()
    const otherEvent = await seedEvent()
    await seedMessage(conversation._id, 'ana', 1)
    await seedMessage(otherEvent._id, 'bo', 1)
    await seedMessage(otherEvent._id, 'cy', 2)

    const { tools } = createVibesAnalystTools(conversation)

    expect(JSON.parse(await toolNamed(tools, 'count_messages').invoke({})).messageCount).toBe(1)
  })

  it('returns no pseudonym and no message text to the model', async () => {
    const conversation = await seedEvent()
    await seedMessage(conversation._id, 'ana', 1, 'a rather longer thought about the point')
    await seedMessage(conversation._id, 'bo', 2, 'yes')

    const { tools } = createVibesAnalystTools(conversation)
    const counted = await toolNamed(tools, 'count_messages').invoke({ minMessages: 1 })
    const measured = await toolNamed(tools, 'measure_message_lengths').invoke({})

    for (const raw of [counted, measured]) {
      expect(raw).not.toMatch(/\b(ana|bo)\b/)
      expect(raw).not.toMatch(/rather longer thought/)
    }
  })
})

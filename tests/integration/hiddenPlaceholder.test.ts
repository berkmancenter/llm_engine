/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals'

/**
 * End to end under the 'placeholder' hidden-display policy, which is off by default ('omit').
 * The policy is a module constant, so it is switched by re-exporting the visibility module with the
 * constant (and the context loader's default) changed. Everything that uses it is imported AFTER the
 * mock is registered, and relative mock paths resolve from tests/setup.ts, hence '../src/...'.
 */
const actual = await import('../../src/utils/messageVisibility.js')
jest.unstable_mockModule('../src/utils/messageVisibility.js', () => ({
  ...actual,
  hiddenDisplay: 'placeholder',
  loadHideContext: (id: any, display: any = 'placeholder') => actual.loadHideContext(id, display)
}))

const { default: request } = await import('supertest')
const { default: setupIntTest } = await import('../utils/setupIntTest.js')
const { default: app } = await import('../../src/app.js')
const { default: websocketGateway } = await import('../../src/websockets/websocketGateway.js')
const { messageHideService, messageService } = await import('../../src/services/index.js')
const { User } = await import('../../src/models/index.js')
const { default: waitFor } = await import('../utils/waitFor.js')
const { seedHideScenario, conversationOne } = await import('../fixtures/messageHide.fixture.js')

setupIntTest()

let s: Awaited<ReturnType<typeof seedHideScenario>>
let broadcastSpy: jest.SpiedFunction<typeof websocketGateway.broadcast>
const conversationId = conversationOne._id.toString()
const adminRoom = `admin:${conversationId}`

const calls = (event: string) => broadcastSpy.mock.calls.filter((c) => c[1] === event)
const toAdmin = (c) => c[4]?.includes(adminRoom)
const toShared = (c) => !c[4]?.length || c[4].includes(conversationId)
const get = (path: string, token: string) =>
  request(app).get(path).query({ channel: 'chat' }).set('Authorization', `Bearer ${token}`).expect(200)

beforeEach(async () => {
  s = await seedHideScenario()
  broadcastSpy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)
})
afterEach(() => {
  jest.restoreAllMocks()
})

describe('placeholder policy', () => {
  it('reports the placeholder display in message:hidden', async () => {
    await messageHideService.hideMessage(s.authorMsg._id, s.admin)
    expect(calls('message:hidden')[0][2].display).toBe('placeholder')
  })

  it('history: participants get body-less stubs, admins get flagged messages, the author gets their own unflagged', async () => {
    await messageHideService.hideMessage(s.authorMsg._id, s.admin)

    const other = (await get(`/v1/messages/${conversationId}`, s.otherToken)).body
    const stub = other.find((m) => m.id === s.authorMsg._id.toString())
    expect(Object.keys(stub).sort()).toEqual(['body', 'createdAt', 'hidden', 'id'])
    expect(stub).toMatchObject({ hidden: true, body: null })
    expect(JSON.stringify(other)).not.toContain(s.authorMsg.body as string)
    expect(other.find((m) => m.id === s.otherMsg._id.toString()).hidden).toBeUndefined()

    const admin = (await get(`/v1/messages/${conversationId}`, s.adminToken)).body.find(
      (m) => m.id === s.authorMsg._id.toString()
    )
    expect(admin).toMatchObject({ hidden: true, body: s.authorMsg.body })

    const own = (await get(`/v1/messages/${conversationId}`, s.authorToken)).body.find(
      (m) => m.id === s.authorMsg._id.toString()
    )
    expect(own.body).toBe(s.authorMsg.body)
    expect(own.hidden).toBeUndefined()
  })

  it('replies: a cascaded reply is a stub that keeps its parent id, and carries no author', async () => {
    await messageHideService.hideMessage(s.authorMsg._id, s.admin)

    const replies = (await get(`/v1/messages/${s.authorMsg._id}/replies`, s.authorToken)).body
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({
      id: s.reply._id.toString(),
      createdAt: expect.anything(),
      parentMessage: s.authorMsg._id.toString(),
      hidden: true,
      body: null
    })
  })

  it('a new message from a hidden author: stub to shared rooms, flagged to admins, full to the author', async () => {
    await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
    broadcastSpy.mockClear()

    const author = (await User.findById(s.author._id))!
    const [created] = await messageService.newMessageHandler(
      { body: 'secret words', conversation: conversationId, channels: [{ name: 'chat' }] },
      author,
      'r1'
    )

    // newMessageHandler does not await the broadcast
    await waitFor(() => expect(calls('message:new')).toHaveLength(3))
    const newCalls = calls('message:new')
    const shared = newCalls.find(toShared)!
    expect(Object.keys(shared[2]).sort()).toEqual(['body', 'createdAt', 'hidden', 'id'])
    expect(JSON.stringify(shared[2])).not.toContain('secret words')

    expect(newCalls.find(toAdmin)![2]).toMatchObject({ id: created._id!.toString(), hidden: true, body: 'secret words' })
    const own = newCalls.find((c) => c[4]?.includes(s.author._id.toString()))!
    expect(own[2]).toMatchObject({ id: created._id!.toString(), body: 'secret words', request: 'r1' })
    expect(own[2].hidden).toBeUndefined()
  })

  it('vote:new on a hidden message sends a stub to shared rooms and the flagged message to admins only', async () => {
    await messageHideService.hideMessage(s.authorMsg._id, s.admin)
    broadcastSpy.mockClear()

    await request(app)
      .post(`/v1/messages/${s.authorMsg._id}/vote`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ status: true, direction: 'up' })
      .expect(200)
    // stub to the shared rooms, flagged to the admin room, and the author's own copy to their user room
    await waitFor(() => expect(calls('vote:new')).toHaveLength(3))

    const votes = calls('vote:new')
    const shared = votes.find(toShared)!
    expect(shared[2]).toMatchObject({ hidden: true, body: null })
    expect(JSON.stringify(shared[2])).not.toContain(s.authorMsg.body as string)
    expect(votes.find(toAdmin)![2]).toMatchObject({ hidden: true, body: s.authorMsg.body })
  })

  it('a participant still cannot vote on a stub', async () => {
    await messageHideService.hideMessage(s.authorMsg._id, s.admin)
    await request(app)
      .post(`/v1/messages/${s.authorMsg._id}/vote`)
      .set('Authorization', `Bearer ${s.otherToken}`)
      .send({ status: true, direction: 'up' })
      .expect(404)
  })
})

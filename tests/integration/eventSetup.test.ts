import { jest } from '@jest/globals'
import httpStatus from 'http-status'
import jwt from 'jsonwebtoken'
import request from 'supertest'

import setupIntTest from '../utils/setupIntTest.js'
import { mintHandoffToken } from '../../src/services/handoffToken.service.js'
import config from '../../src/config/config.js'
import tokenTypes from '../../src/config/tokens.js'
import type { EventSetupPlan } from '../../src/services/eventSetup/planSchema.js'

/* Mock the planner service before importing the app. The LLM call is
   nondeterministic. For plumbing tests we just need a stable response. */
const mockPlan = jest.fn<(input: { description: string }) => Promise<EventSetupPlan>>()

jest.unstable_mockModule('../src/services/eventSetup/planner.service.js', () => ({
  planEventSetup: mockPlan,
  default: { planEventSetup: mockPlan }
}))

jest.mock('agenda')

const { default: app } = await import('../../src/app.js')

jest.setTimeout(30000)
setupIntTest()

const slackContext = {
  slackUserId: 'U123ABC',
  slackTeamId: 'T456DEF',
  slackChannelId: 'C789GHI',
  slackThreadTs: '1700000000.000100'
}

const mockResponse: EventSetupPlan = {
  extracted: {
    eventName: 'AI Ethics Roundtable',
    dateTime: '2026-05-28T19:00:00.000Z',
    timeZone: 'America/New_York',
    zoomLink: 'https://zoom.example/j/123'
  },
  tooVague: false,
  confidence: 'high',
  steps: [
    { key: 'duration', prompt: 'How long is it?', fields: ['duration'] },
    { key: 'speakers', prompt: 'Who is presenting?', fields: ['speakers'] }
  ],
  skippedSections: [{ id: 'res', label: 'Resources', reason: 'No readings mentioned for this event.' }],
  featureDecisions: [
    {
      id: 'transcription',
      label: 'Live transcription',
      enabled: true,
      reason: 'Hybrid panel — remote attendees benefit from a live transcript.',
      byAgent: true,
      byDefault: false
    }
  ]
}

describe('POST /v1/event-setup/plan', () => {
  beforeEach(() => {
    mockPlan.mockReset()
    mockPlan.mockResolvedValue(mockResponse)
  })

  test('returns 401 when no handoff token is provided', async () => {
    const res = await request(app)
      .post('/v1/event-setup/plan')
      .send({ description: 'A casual roundtable on AI ethics next Thursday at 3pm ET.' })

    expect(res.status).toBe(httpStatus.UNAUTHORIZED)
    expect(mockPlan).not.toHaveBeenCalled()
  })

  test('returns 401 when the handoff token is malformed', async () => {
    const res = await request(app)
      .post('/v1/event-setup/plan')
      .set('X-Handoff-Token', 'not-a-real-jwt')
      .send({ description: 'A casual roundtable.' })

    expect(res.status).toBe(httpStatus.UNAUTHORIZED)
    expect(mockPlan).not.toHaveBeenCalled()
  })

  test('returns 401 when the token is signed with the wrong type claim', async () => {
    /* Sign a JWT with the same secret but type=access. A leaked auth token
       must not be replayable as a handoff token. */
    const wrongTypeToken = jwt.sign(
      { ...slackContext, type: tokenTypes.ACCESS, exp: Math.floor(Date.now() / 1000) + 3600 },
      config.jwt.secret
    )

    const res = await request(app)
      .post('/v1/event-setup/plan')
      .set('X-Handoff-Token', wrongTypeToken)
      .send({ description: 'A casual roundtable.' })

    expect(res.status).toBe(httpStatus.UNAUTHORIZED)
    expect(mockPlan).not.toHaveBeenCalled()
  })

  test('returns 400 when description is missing', async () => {
    const token = mintHandoffToken(slackContext)
    const res = await request(app).post('/v1/event-setup/plan').set('X-Handoff-Token', token).send({})

    expect(res.status).toBe(httpStatus.BAD_REQUEST)
    expect(mockPlan).not.toHaveBeenCalled()
  })

  test('returns 400 when description exceeds the length cap', async () => {
    const token = mintHandoffToken(slackContext)
    const tooLong = 'a'.repeat(4001)
    const res = await request(app).post('/v1/event-setup/plan').set('X-Handoff-Token', token).send({ description: tooLong })

    expect(res.status).toBe(httpStatus.BAD_REQUEST)
    expect(mockPlan).not.toHaveBeenCalled()
  })

  test('returns 200 with the planner output when token + body are valid', async () => {
    const token = mintHandoffToken(slackContext)
    const res = await request(app)
      .post('/v1/event-setup/plan')
      .set('X-Handoff-Token', token)
      .send({ description: 'Casual AI ethics roundtable, online via Zoom, next Thursday.' })

    expect(res.status).toBe(httpStatus.OK)
    expect(res.body).toEqual(mockResponse)
    expect(mockPlan).toHaveBeenCalledTimes(1)
    expect(mockPlan).toHaveBeenCalledWith({
      description: 'Casual AI ethics roundtable, online via Zoom, next Thursday.'
    })
  })
})

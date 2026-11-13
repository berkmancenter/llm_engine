import request from 'supertest'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'

setupIntTest()

describe('Auth routes', () => {
  describe('GET /v1/docs', () => {
    // The docs route used to be mounted only when config.env === 'development'; it's now
    // unconditional (see src/routes/v1/index.ts), so this just confirms it's reachable.
    test('is reachable', async () => {
      const res = await request(app).get('/v1/docs')
      expect(res.status).not.toBe(httpStatus.NOT_FOUND)
    })
  })
})

describe('OpenAPI route', () => {
  describe('GET /v1/openapi.json', () => {
    test('should return the OpenAPI spec as JSON', async () => {
      const res = await request(app)
        .get('/v1/openapi.json')
        .expect(httpStatus.OK)
        .expect('Content-Type', /application\/json/)

      expect(res.body).toHaveProperty('openapi')
      expect(res.body).toHaveProperty('info')
      expect(typeof res.body.openapi).toBe('string')
      expect(typeof res.body.info).toBe('object')
    })

    // A spec assembled from missing sources is empty but structurally valid, so the
    // assertions above still pass while every consumer that generates types from this
    // endpoint silently ends up with `never`. Assert it actually describes the API.
    // See src/docs/openapiSpec.ts.
    test('describes the API — paths and component schemas are populated', async () => {
      const res = await request(app).get('/v1/openapi.json').expect(httpStatus.OK)

      expect(Object.keys(res.body.paths ?? {}).length).toBeGreaterThan(0)
      expect(Object.keys(res.body.components?.schemas ?? {}).length).toBeGreaterThan(0)
      expect(res.body.components.schemas).toHaveProperty('Message')
    })

    // Clients generate their types from these, so the Unpacker message bodies must be described
    test('describes the Unpacker request and explanation message bodies', async () => {
      const res = await request(app).get('/v1/openapi.json').expect(httpStatus.OK)
      const { UnpackRequestBody, UnpackExplanation } = res.body.components.schemas

      expect(UnpackRequestBody.properties.type.enum).toEqual(['unpack_request'])
      expect(UnpackRequestBody.required).toEqual(expect.arrayContaining(['type', 'mode', 'text', 'chunkIds']))
      expect(UnpackRequestBody.properties.chunkIds.type).toBe('array')
      expect(UnpackRequestBody.properties.transcriptPasscode.type).toBe('string')
      expect(UnpackExplanation.properties.type.enum).toEqual(['unpack_explanation'])
      expect(UnpackExplanation.required).toEqual(
        expect.arrayContaining(['whatTheyreSaying', 'whyItMatters', 'terms', 'chunkIds', 'passage', 'text'])
      )
    })

    test('describes the passage preview and send endpoints, and a card with no request message', async () => {
      const res = await request(app).get('/v1/openapi.json').expect(httpStatus.OK)
      const { schemas } = res.body.components

      expect(res.body.paths).toHaveProperty(['/unpack/{conversationId}/preview', 'post'])
      expect(res.body.paths).toHaveProperty(['/unpack/{conversationId}/send', 'post'])
      expect(schemas.UnpackSelection.required).toEqual(['startMessageId', 'startOffset', 'endMessageId', 'endOffset'])
      expect(schemas.UnpackPreview.properties.explanation.required).toEqual(
        expect.arrayContaining(['quote', 'whatTheyreSaying', 'headline', 'visual'])
      )
      expect(schemas.UnpackError.properties.reason.enum).toEqual(
        expect.arrayContaining(['selectionTooLong', 'unpackFailed'])
      )
      expect(schemas.UnpackExplanation.properties.mode.enum).toEqual(['passage'])
      expect(schemas.UnpackExplanation.properties).not.toHaveProperty('requestMessage')
    })

    test('describes the catch-up summary and refusal message bodies', async () => {
      const res = await request(app).get('/v1/openapi.json').expect(httpStatus.OK)
      const { CatchUpSummary, CatchUpRefused } = res.body.components.schemas

      expect(CatchUpSummary.properties.type.enum).toEqual(['catch_up_summary'])
      expect(CatchUpSummary.required).toEqual(
        expect.arrayContaining([
          'inShort',
          'whatTheyCovered',
          'comingUp',
          'chunkIds',
          'passage',
          'earlierSpeech',
          'requestMessage',
          'text'
        ])
      )
      expect(CatchUpSummary.properties.comingUp.nullable).toBe(true)
      expect(CatchUpRefused.properties.type.enum).toEqual(['catch_up_refused'])
      expect(CatchUpRefused.required).toEqual(expect.arrayContaining(['requestMessage', 'reason', 'text']))
      expect(CatchUpRefused.properties.reason.enum).toEqual([
        'noTranscript',
        'noPassagesSent',
        'rateLimited',
        'chunkNotInTranscript',
        'passageTooLong',
        'unpackFailed'
      ])
    })
  })
})

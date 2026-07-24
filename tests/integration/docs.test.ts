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
  })
})

import request from 'supertest'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import config from '../../src/config/config.js'

setupIntTest()

describe('Auth routes', () => {
  describe('GET /v1/docs', () => {
    test('should return 404 when running in production', async () => {
      config.env = 'production'
      await request(app).get('/v1/docs').expect(httpStatus.NOT_FOUND)
      config.env = process.env.NODE_ENV
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

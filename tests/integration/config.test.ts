import request from 'supertest'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import config from '../../src/config/config.js'
import agentTypes from '../../src/agents/config.js'
import adapterTypes from '../../src/adapters/config.js'
import conversationTypes from '../../src/conversations/config.js'
import { llmPlatforms, supportedModels } from '../../src/agents/helpers/getModelChat.js'

setupIntTest()

describe('Config routes', () => {
  describe('GET /v1/config', () => {
    test('should return 200 and configuration object', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)
      expect(resp.body).toHaveProperty('maxMessageLength')
      expect(resp.body).toHaveProperty('availableAgents')
      expect(resp.body).toHaveProperty('availablePlatforms')
      expect(resp.body).toHaveProperty('enablePublicChannelCreation')
      expect(resp.body).toHaveProperty('enableAutoDeletion')
      expect(resp.body).toHaveProperty('enableExportOptOut')
      expect(resp.body).toHaveProperty('llmPlatforms')
    })

    test('should return correct maxMessageLength value', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)

      expect(resp.body.maxMessageLength).toBe(config.maxMessageLength)
    })

    test('should return available agents from config', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)

      expect(resp.body.availableAgents).toEqual(agentTypes)
    })

    test('should return available platforms', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)

      expect(resp.body.availablePlatforms).toEqual(adapterTypes)
    })

    test('should return supported models', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)
      expect(resp.body.supportedModels).toEqual(supportedModels)
    })

    test('should return available conversation types', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)
      expect(resp.body.conversationTypes).toEqual(conversationTypes)
    })

    test('should return boolean flags from config', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)

      expect(resp.body.enablePublicChannelCreation).toBe(config.enablePublicChannelCreation)
      expect(resp.body.enableAutoDeletion).toBe(config.enableAutoDeletion)
      expect(resp.body.enableExportOptOut).toBe(config.enableExportOptOut)
    })

    test('should return llm platforms', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)

      expect(resp.body.llmPlatforms).toEqual(llmPlatforms)
    })

    test('should serialize tab, audience, slashCommand, participantDescription, and userControlled on each feature', async () => {
      await insertUsers([registeredUser])
      const resp = await request(app).get(`/v1/config`).send().expect(httpStatus.OK)

      /* Every feature from every conversation type must carry the display-metadata fields.
       * slashCommand and participantDescription are optional, so we only check type when present. */
      for (const ct of resp.body.conversationTypes) {
        for (const feature of ct.features ?? []) {
          expect(['assistant', 'group-chat', 'transcript']).toContain(feature.tab)
          expect(['moderator', 'participant', 'both']).toContain(feature.audience)
          expect(typeof feature.userControlled).toBe('boolean')
          if (feature.slashCommand !== undefined) {
            expect(typeof feature.slashCommand).toBe('string')
          }
          if (feature.participantDescription !== undefined) {
            expect(typeof feature.participantDescription).toBe('string')
          }
        }
      }
    })
  })
})

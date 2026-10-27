import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import logger from '../../../src/config/logger.js'
import JobHandlers from '../../../src/jobs/handlers/index.js'
import organizerConfirmationService from '../../../src/services/eventSetup/organizerConfirmation.service.js'
import { Conversation, OrganizerConfirmation } from '../../../src/models/index.js'
import { insertUsers } from '../../fixtures/user.fixture.js'

setupIntTest()

const newUser = (email: string) => ({
  _id: new mongoose.Types.ObjectId(),
  username: email.split('@')[0],
  email,
  password: 'password1',
  role: 'participant',
  isEmailVerified: false
})

describe('jobs/handlers/organizerConfirmation', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('expireUnconfirmedConversations', () => {
    it('deletes a conversation whose confirmation expired with no click', async () => {
      const [owner] = await insertUsers([newUser('org@example.edu')])
      const conversation = await Conversation.create({
        name: 'Pending Zoom Event',
        owner: owner._id,
        conversationType: 'eventAssistant',
        platforms: ['nextspace', 'zoom'],
        scheduledTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        source: { pendingOrganizerConfirmation: true },
        draft: true
      })
      await organizerConfirmationService.mintConfirmation(conversation)
      await OrganizerConfirmation.updateOne({ conversation: conversation._id }, { expiresAt: new Date(Date.now() - 1000) })

      await JobHandlers.expireUnconfirmedConversations()

      expect(await Conversation.findById(conversation._id)).toBeNull()
    })

    it('logs rather than throws when the sweep itself fails', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockReturnValue(undefined as never)
      jest.spyOn(organizerConfirmationService, 'expireUnconfirmedConversations').mockRejectedValue(new Error('boom'))

      await expect(JobHandlers.expireUnconfirmedConversations()).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalled()
    })
  })
})

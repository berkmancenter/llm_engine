import { jest } from '@jest/globals'
import emailService from '../../../src/services/email.service.js'
import config from '../../../src/config/config.js'

describe('email.service', () => {
  describe('sendSignupInviteEmail', () => {
    let sendMailSpy

    beforeEach(() => {
      sendMailSpy = jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    })

    afterEach(() => {
      sendMailSpy.mockRestore()
    })

    it('sends to the given address with a signup link', async () => {
      await emailService.sendSignupInviteEmail('newcomer@cyber.harvard.edu')

      expect(sendMailSpy).toHaveBeenCalledTimes(1)
      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.to).toBe('newcomer@cyber.harvard.edu')
      expect(msg.from).toBe(config.email.from)
      expect(msg.subject).toEqual(expect.any(String))
      expect(msg.text).toContain(`${config.appHost}/signup`)
      expect(msg.html).toContain(`${config.appHost}/signup`)
    })
  })

  describe('sendEventCreatedEmail', () => {
    let sendMailSpy

    beforeEach(() => {
      sendMailSpy = jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    })

    afterEach(() => {
      sendMailSpy.mockRestore()
    })

    it('sends to the given address with a link to the created event', async () => {
      const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      expect(sendMailSpy).toHaveBeenCalledTimes(1)
      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.to).toBe('organizer@cyber.harvard.edu')
      expect(msg.from).toBe(config.email.from)
      expect(msg.subject).toEqual(expect.any(String))
      const expectedUrl = `${config.appHost}/login?redirectTo=/admin/eventAssistant/view/conv-123`
      expect(msg.text).toContain(expectedUrl)
      expect(msg.html).toContain(expectedUrl)
    })
  })

  describe('sendEventCreationFailedEmail', () => {
    let sendMailSpy

    beforeEach(() => {
      sendMailSpy = jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    })

    afterEach(() => {
      sendMailSpy.mockRestore()
    })

    it('sends to the given address and includes the reference ID when one is given', async () => {
      await emailService.sendEventCreationFailedEmail('organizer@cyber.harvard.edu', 'UID-ABC-123')

      expect(sendMailSpy).toHaveBeenCalledTimes(1)
      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.to).toBe('organizer@cyber.harvard.edu')
      expect(msg.from).toBe(config.email.from)
      expect(msg.subject).toEqual(expect.any(String))
      expect(msg.text).toContain('UID-ABC-123')
      expect(msg.html).toContain('UID-ABC-123')
      expect(msg.text).not.toMatch(/at \w+\.\w+ \(/)
    })

    it('omits the reference line when no reference ID is given', async () => {
      await emailService.sendEventCreationFailedEmail('organizer@cyber.harvard.edu')

      expect(sendMailSpy).toHaveBeenCalledTimes(1)
      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).not.toContain('undefined')
      expect(msg.html).not.toContain('undefined')
    })
  })
})

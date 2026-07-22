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
})

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

    it('reminds the organizer to confirm the event details', async () => {
      const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).toMatch(/confirm/i)
      expect(msg.html).toMatch(/confirm/i)
    })

    it('tells the organizer the link is where to edit details and find moderator and participant links', async () => {
      const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).toMatch(/moderator/i)
      expect(msg.text).toMatch(/participant/i)
      expect(msg.html).toMatch(/moderator/i)
      expect(msg.html).toMatch(/participant/i)
    })

    it('includes only one link', async () => {
      const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.html.match(/href="/g)).toHaveLength(1)
    })

    it('uses an action-needed subject and names what is missing, when required fields are absent', async () => {
      const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

      await emailService.sendEventCreatedEmail('organizer@example.com', conversation, ['a Zoom meeting link', 'a series'])

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.subject).toMatch(/action needed/i)
      expect(msg.subject).not.toBe('Your event is ready')
      expect(msg.text).toContain('a Zoom meeting link')
      expect(msg.text).toContain('a series')
      expect(msg.html).toContain('a Zoom meeting link')
      expect(msg.html).toContain('a series')
    })

    it('still links to where the organizer can add the missing details', async () => {
      const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

      await emailService.sendEventCreatedEmail('organizer@example.com', conversation, ['a Zoom meeting link'])

      const msg = sendMailSpy.mock.calls[0][0]
      const expectedUrl = `${config.appHost}/login?redirectTo=/admin/eventAssistant/view/conv-123`
      expect(msg.text).toContain(expectedUrl)
      expect(msg.html).toContain(expectedUrl)
      expect(msg.html.match(/href="/g)).toHaveLength(1)
    })

    it('uses the ready-to-run subject when nothing is missing', async () => {
      const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

      await emailService.sendEventCreatedEmail('organizer@example.com', conversation, [])

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.subject).toBe('Your event is ready')
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

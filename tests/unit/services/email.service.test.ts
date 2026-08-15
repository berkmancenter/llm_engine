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

    /* An allowlisted sender with no account can reach this email from either the calendar-invite
       path or the plain-email path (see emailSetup.service.ts's resolveOrganizer, shared by both),
       so the wording can't assume a calendar invite prompted it. */
    it('uses wording that fits both an invite and a plain email, not calendar-invite-specific language', async () => {
      await emailService.sendSignupInviteEmail('newcomer@cyber.harvard.edu')

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).not.toMatch(/calendar invite/i)
      expect(msg.text).not.toMatch(/resend the invite/i)
      expect(msg.html).not.toMatch(/calendar invite/i)
      expect(msg.html).not.toMatch(/resend the invite/i)
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

  describe('sendOnDemandEventEmail', () => {
    let sendMailSpy

    const urls = {
      eventPageUrl: 'https://app.example.com/login?redirectTo=/admin/eventAssistant/view/conv-123',
      moderatorUrl: 'https://app.example.com/moderator/?conversationId=conv-123&channel=moderator%2Cabc',
      participantUrl: 'https://app.example.com/assistant/?conversationId=conv-123&channel=chat%2Cxyz'
    }

    beforeEach(() => {
      sendMailSpy = jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    })

    afterEach(() => {
      sendMailSpy.mockRestore()
    })

    it('sends to the given address', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      expect(sendMailSpy).toHaveBeenCalledTimes(1)
      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.to).toBe('organizer@cyber.harvard.edu')
      expect(msg.from).toBe(config.email.from)
    })

    it('uses the instant-join subject and says Berkie is joining now, when no joinAt is given', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.subject).toBe('Berkie is joining your Zoom meeting')
      expect(msg.text).toMatch(/joining.*now/i)
    })

    it('uses the scheduled subject and states the join time, when joinAt is given', async () => {
      const joinAt = new Date('2026-09-01T17:00:00Z')

      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls, { joinAt })

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.subject).toBe('Berkie will join your Zoom meeting')
      expect(msg.text).toContain(joinAt.toISOString())
      expect(msg.html).toContain(joinAt.toISOString())
    })

    it('leads with the moderator link labeled private, and the participant link', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).toContain(urls.moderatorUrl)
      expect(msg.text).toContain(urls.participantUrl)
      expect(msg.text).toMatch(/private/i)
      expect(msg.html).toContain(urls.moderatorUrl)
      expect(msg.html).toContain(urls.participantUrl)
    })

    it('omits the moderator link entirely when the conversation has no moderator passcode', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', { ...urls, moderatorUrl: undefined })

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.html.match(/href="/g)).toHaveLength(2)
    })

    it('includes the event page link last, labeled as where to edit the event', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).toContain(urls.eventPageUrl)
      expect(msg.text).toMatch(/edit/i)
      const [moderatorIndex, participantIndex, eventPageIndex] = [
        msg.text.indexOf(urls.moderatorUrl),
        msg.text.indexOf(urls.participantUrl),
        msg.text.indexOf(urls.eventPageUrl)
      ]
      expect(eventPageIndex).toBeGreaterThan(moderatorIndex)
      expect(eventPageIndex).toBeGreaterThan(participantIndex)
    })
  })

  describe('sendOnDemandEventFailedEmail', () => {
    let sendMailSpy

    beforeEach(() => {
      sendMailSpy = jest.spyOn(emailService.transport, 'sendMail').mockResolvedValue(undefined as never)
    })

    afterEach(() => {
      sendMailSpy.mockRestore()
    })

    it('sends to the given address', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'noZoomLink')

      expect(sendMailSpy).toHaveBeenCalledTimes(1)
      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.to).toBe('organizer@cyber.harvard.edu')
      expect(msg.from).toBe(config.email.from)
    })

    it('tells the sender no Zoom link was found, for reason noZoomLink', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'noZoomLink')

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).toMatch(/zoom link/i)
      expect(msg.text).not.toMatch(/invalid/i)
    })

    it('tells the sender the Zoom link was not valid, for reason invalidZoomLink', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'invalidZoomLink')

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).toMatch(/zoom link/i)
      expect(msg.text).toMatch(/valid/i)
    })

    it('includes no error internals in the body', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'noZoomLink')

      const msg = sendMailSpy.mock.calls[0][0]
      expect(msg.text).not.toMatch(/at \w+\.\w+ \(/)
      expect(msg.html).not.toMatch(/at \w+\.\w+ \(/)
    })
  })
})

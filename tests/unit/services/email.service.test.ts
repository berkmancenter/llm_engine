import { jest } from '@jest/globals'
import postmark from 'postmark'
import emailService from '../../../src/services/email.service.js'
import EmailSendError from '../../../src/utils/EmailSendError.js'
import SuppressedRecipientError from '../../../src/utils/SuppressedRecipientError.js'
import config from '../../../src/config/config.js'
import logger from '../../../src/config/logger.js'

describe('email.service', () => {
  let sendEmailSpy

  const sentMessage = () => sendEmailSpy.mock.calls[0][0]

  beforeEach(() => {
    sendEmailSpy = jest.spyOn(emailService.client, 'sendEmail').mockResolvedValue({ ErrorCode: 0, Message: 'OK' } as never)
  })

  afterEach(() => {
    sendEmailSpy.mockRestore()
  })

  describe('every message', () => {
    /* Tracking is off deliberately, not just unset: link tracking rewrites every URL
       through Postmark's redirector, and several messages carry passcodes or tokens in
       their URLs (password reset, archive topic, moderator links). Nothing consumes the
       tracking data; the per-message Tag covers delivery searchability. */
    it('sends on the transactional stream with link and open tracking off', async () => {
      await emailService.sendEmailAsync('someone@example.com', 'Subject', 'text', '<p>html</p>')

      const msg = sentMessage()
      expect(msg.MessageStream).toBe('outbound')
      expect(msg.TrackOpens).toBe(false)
      expect(msg.TrackLinks).toBe('None')
    })

    it('sends from the configured address with the given subject and bodies', async () => {
      await emailService.sendEmailAsync('someone@example.com', 'Subject', 'text', '<p>html</p>')

      const msg = sentMessage()
      expect(msg.From).toBe(config.email.from)
      expect(msg.To).toBe('someone@example.com')
      expect(msg.Subject).toBe('Subject')
      expect(msg.TextBody).toBe('text')
      expect(msg.HtmlBody).toBe('<p>html</p>')
    })
  })

  describe('suppressed recipients', () => {
    let errorSpy

    beforeEach(() => {
      errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined as never)
    })

    afterEach(() => {
      errorSpy.mockRestore()
    })

    it('throws SuppressedRecipientError and logs, when Postmark reports the address inactive', async () => {
      sendEmailSpy.mockRejectedValue(new postmark.Errors.InactiveRecipientsError('inactive recipient', 406, 422))

      await expect(emailService.sendEmailAsync('bounced@example.com', 'Subject', 'text', '<p>html</p>')).rejects.toThrow(
        SuppressedRecipientError
      )
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('suppression'))
    })

    /* The address must reach callers only through the error's `recipient` field. The log
       line and the error message both end up in app logs (auth.service logs err.message),
       and recipient addresses stay out of those. */
    it('keeps the address out of the log line and the error message', async () => {
      sendEmailSpy.mockRejectedValue(new postmark.Errors.InactiveRecipientsError('inactive recipient', 406, 422))

      await expect(
        emailService.sendEmailAsync('bounced@example.com', 'Subject', 'text', '<p>html</p>', 'password-reset')
      ).rejects.toMatchObject({ message: expect.not.stringContaining('bounced@example.com') })
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('bounced@example.com'))
    })

    it('names the message tag in the log line, so the affected flow is identifiable without the address', async () => {
      sendEmailSpy.mockRejectedValue(new postmark.Errors.InactiveRecipientsError('inactive recipient', 406, 422))

      await expect(
        emailService.sendEmailAsync('bounced@example.com', 'Subject', 'text', '<p>html</p>', 'password-reset')
      ).rejects.toThrow(SuppressedRecipientError)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('password-reset'))
    })

    it('names the suppressed address on the error so callers can surface it', async () => {
      sendEmailSpy.mockRejectedValue(new postmark.Errors.InactiveRecipientsError('inactive recipient', 406, 422))

      await expect(
        emailService.sendEmailAsync('bounced@example.com', 'Subject', 'text', '<p>html</p>')
      ).rejects.toMatchObject({ recipient: 'bounced@example.com' })
    })

    /* Postmark's own error messages can echo the recipient, e.g. a 422 rejecting a
       malformed To field quotes the address. Wrapping keeps that text out of app logs
       and out of err.message, which callers log. */
    it('wraps any other Postmark error in EmailSendError, carrying only codes in the message', async () => {
      const validationError = new postmark.Errors.ApiInputError(
        "Error parsing 'To': Illegal email address 'bounced@example.com'",
        300,
        422
      )
      sendEmailSpy.mockRejectedValue(validationError)

      const send = emailService.sendEmailAsync('bounced@example.com', 'Subject', 'text', '<p>html</p>', 'password-reset')
      await expect(send).rejects.toThrow(EmailSendError)
      await expect(send).rejects.toMatchObject({
        message: expect.not.stringContaining('bounced@example.com'),
        recipient: 'bounced@example.com',
        code: 300,
        statusCode: 422
      })
    })

    /* The address must survive nothing a logger walks. logger.ts expands `cause` into the
       logged string, and Sentry's linkedErrors integration chains on it too, so attaching
       the raw Postmark error would put the address back in the logs by a side door. This
       renders the error the way logger.ts renders it and checks it comes out clean. */
    it('exposes nothing that expands to the address when a logger renders the error', async () => {
      sendEmailSpy.mockRejectedValue(
        new postmark.Errors.ApiInputError("Error parsing 'To': Illegal email address 'bounced@example.com'", 300, 422)
      )

      const thrown = await emailService
        .sendEmailAsync('bounced@example.com', 'Subject', 'text', '<p>html</p>', 'password-reset')
        .catch((error) => error)

      const asLoggerRendersIt = `${thrown.message} \n ${thrown.stack}${thrown.cause ? `\nCaused by: ${thrown.cause}` : ''}`
      expect(asLoggerRendersIt).not.toContain('bounced@example.com')
    })

    it('logs the failure with its codes and tag, never the address or the raw Postmark text', async () => {
      sendEmailSpy.mockRejectedValue(
        new postmark.Errors.ApiInputError("Error parsing 'To': Illegal email address 'bounced@example.com'", 300, 422)
      )

      await expect(
        emailService.sendEmailAsync('bounced@example.com', 'Subject', 'text', '<p>html</p>', 'password-reset')
      ).rejects.toThrow(EmailSendError)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logged = errorSpy.mock.calls[0][0]
      expect(logged).toContain('ApiInputError')
      expect(logged).toContain('300')
      expect(logged).toContain('422')
      expect(logged).toContain('password-reset')
      expect(logged).not.toContain('bounced@example.com')
    })

    it('rethrows a non-Postmark error unchanged', async () => {
      const networkError = new Error('socket hang up')
      sendEmailSpy.mockRejectedValue(networkError)

      await expect(emailService.sendEmailAsync('someone@example.com', 'Subject', 'text', '<p>html</p>')).rejects.toBe(
        networkError
      )
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  describe('sendEmail (callback form)', () => {
    it('invokes the callback with the send result on success', async () => {
      const callback = jest.fn()

      emailService.sendEmail('someone@example.com', 'Subject', 'text', '<p>html</p>', callback)
      await new Promise(process.nextTick)

      expect(callback).toHaveBeenCalledWith(null, { ErrorCode: 0, Message: 'OK' })
    })

    it('invokes the callback with the error on failure', async () => {
      const sendError = new Error('send failed')
      sendEmailSpy.mockRejectedValue(sendError)
      const callback = jest.fn()

      emailService.sendEmail('someone@example.com', 'Subject', 'text', '<p>html</p>', callback)
      await new Promise(process.nextTick)

      expect(callback).toHaveBeenCalledWith(sendError)
    })
  })

  describe('sendPasswordResetEmailAsync', () => {
    it('links to the reset page with the token in the query string', async () => {
      await emailService.sendPasswordResetEmailAsync('user@example.com', 'reset-token-123')

      const msg = sentMessage()
      expect(msg.To).toBe('user@example.com')
      const expectedUrl = `${config.appHost}/reset-password?token=reset-token-123`
      expect(msg.TextBody).toContain(expectedUrl)
      expect(msg.HtmlBody).toContain(expectedUrl)
    })

    it('is tagged password-reset with tracking off, so the token link is never rewritten', async () => {
      await emailService.sendPasswordResetEmailAsync('user@example.com', 'reset-token-123')

      const msg = sentMessage()
      expect(msg.Tag).toBe('password-reset')
      expect(msg.TrackLinks).toBe('None')
      expect(msg.TrackOpens).toBe(false)
    })
  })

  describe('sendPasswordResetEmail', () => {
    it('sends the same reset link as the async form and reports back through the callback', async () => {
      const callback = jest.fn()

      emailService.sendPasswordResetEmail('user@example.com', 'reset-token-123', callback)
      await new Promise(process.nextTick)

      const msg = sentMessage()
      expect(msg.To).toBe('user@example.com')
      expect(msg.Tag).toBe('password-reset')
      expect(msg.TrackLinks).toBe('None')
      expect(msg.TextBody).toContain(`${config.appHost}/reset-password?token=reset-token-123`)
      expect(callback).toHaveBeenCalledWith(null, { ErrorCode: 0, Message: 'OK' })
    })
  })

  describe('sendArchiveTopicEmail', () => {
    const topic = { _id: 'topic-123', name: 'My Channel' }

    it('links to the archive page with the token in the query string', async () => {
      await emailService.sendArchiveTopicEmail('owner@example.com', topic, 'archive-token-456')

      const msg = sentMessage()
      expect(msg.To).toBe('owner@example.com')
      const expectedUrl = `${config.appHost}/archive-topic?topicId=topic-123&token=archive-token-456`
      expect(msg.TextBody).toContain(expectedUrl)
      expect(msg.HtmlBody).toContain(expectedUrl)
    })

    it('is tagged archive-topic with tracking off, so the token link is never rewritten', async () => {
      await emailService.sendArchiveTopicEmail('owner@example.com', topic, 'archive-token-456')

      const msg = sentMessage()
      expect(msg.Tag).toBe('archive-topic')
      expect(msg.TrackLinks).toBe('None')
      expect(msg.TrackOpens).toBe(false)
    })
  })

  describe('sendSignupInviteEmail', () => {
    it('sends to the given address with a signup link', async () => {
      await emailService.sendSignupInviteEmail('newcomer@cyber.harvard.edu')

      expect(sendEmailSpy).toHaveBeenCalledTimes(1)
      const msg = sentMessage()
      expect(msg.To).toBe('newcomer@cyber.harvard.edu')
      expect(msg.From).toBe(config.email.from)
      expect(msg.Subject).toEqual(expect.any(String))
      expect(msg.TextBody).toContain(`${config.appHost}/signup`)
      expect(msg.HtmlBody).toContain(`${config.appHost}/signup`)
    })

    it('is tagged signup-invite', async () => {
      await emailService.sendSignupInviteEmail('newcomer@cyber.harvard.edu')

      expect(sentMessage().Tag).toBe('signup-invite')
    })

    /* An allowlisted sender with no account can reach this email from either the calendar-invite
       path or the plain-email path (see emailSetup.service.ts's resolveOrganizer, shared by both),
       so the wording can't assume a calendar invite prompted it. */
    it('uses wording that fits both an invite and a plain email, not calendar-invite-specific language', async () => {
      await emailService.sendSignupInviteEmail('newcomer@cyber.harvard.edu')

      const msg = sentMessage()
      expect(msg.TextBody).not.toMatch(/calendar invite/i)
      expect(msg.TextBody).not.toMatch(/resend the invite/i)
      expect(msg.HtmlBody).not.toMatch(/calendar invite/i)
      expect(msg.HtmlBody).not.toMatch(/resend the invite/i)
    })
  })

  describe('sendEventCreatedEmail', () => {
    const conversation = { _id: 'conv-123', conversationType: 'eventAssistant' }

    it('sends to the given address with a link to the created event', async () => {
      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      expect(sendEmailSpy).toHaveBeenCalledTimes(1)
      const msg = sentMessage()
      expect(msg.To).toBe('organizer@cyber.harvard.edu')
      expect(msg.From).toBe(config.email.from)
      expect(msg.Subject).toEqual(expect.any(String))
      const expectedUrl = `${config.appHost}/login?redirectTo=/admin/eventAssistant/view/conv-123`
      expect(msg.TextBody).toContain(expectedUrl)
      expect(msg.HtmlBody).toContain(expectedUrl)
    })

    it('is tagged event-created', async () => {
      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      expect(sentMessage().Tag).toBe('event-created')
    })

    it('reminds the organizer to confirm the event details', async () => {
      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      const msg = sentMessage()
      expect(msg.TextBody).toMatch(/confirm/i)
      expect(msg.HtmlBody).toMatch(/confirm/i)
    })

    it('tells the organizer the link is where to edit details and find moderator and participant links', async () => {
      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      const msg = sentMessage()
      expect(msg.TextBody).toMatch(/moderator/i)
      expect(msg.TextBody).toMatch(/participant/i)
      expect(msg.HtmlBody).toMatch(/moderator/i)
      expect(msg.HtmlBody).toMatch(/participant/i)
    })

    it('includes only one link', async () => {
      await emailService.sendEventCreatedEmail('organizer@cyber.harvard.edu', conversation)

      expect(sentMessage().HtmlBody.match(/href="/g)).toHaveLength(1)
    })

    it('uses an action-needed subject and names what is missing, when required fields are absent', async () => {
      await emailService.sendEventCreatedEmail('organizer@example.com', conversation, ['a Zoom meeting link', 'a series'])

      const msg = sentMessage()
      expect(msg.Subject).toMatch(/action needed/i)
      expect(msg.Subject).not.toBe('Your event is ready')
      expect(msg.TextBody).toContain('a Zoom meeting link')
      expect(msg.TextBody).toContain('a series')
      expect(msg.HtmlBody).toContain('a Zoom meeting link')
      expect(msg.HtmlBody).toContain('a series')
    })

    it('still links to where the organizer can add the missing details', async () => {
      await emailService.sendEventCreatedEmail('organizer@example.com', conversation, ['a Zoom meeting link'])

      const msg = sentMessage()
      const expectedUrl = `${config.appHost}/login?redirectTo=/admin/eventAssistant/view/conv-123`
      expect(msg.TextBody).toContain(expectedUrl)
      expect(msg.HtmlBody).toContain(expectedUrl)
      expect(msg.HtmlBody.match(/href="/g)).toHaveLength(1)
    })

    it('uses the ready-to-run subject when nothing is missing', async () => {
      await emailService.sendEventCreatedEmail('organizer@example.com', conversation, [])

      expect(sentMessage().Subject).toBe('Your event is ready')
    })
  })

  describe('sendEventCreationFailedEmail', () => {
    it('sends to the given address and includes the reference ID when one is given', async () => {
      await emailService.sendEventCreationFailedEmail('organizer@cyber.harvard.edu', 'UID-ABC-123')

      expect(sendEmailSpy).toHaveBeenCalledTimes(1)
      const msg = sentMessage()
      expect(msg.To).toBe('organizer@cyber.harvard.edu')
      expect(msg.From).toBe(config.email.from)
      expect(msg.Subject).toEqual(expect.any(String))
      expect(msg.TextBody).toContain('UID-ABC-123')
      expect(msg.HtmlBody).toContain('UID-ABC-123')
      expect(msg.TextBody).not.toMatch(/at \w+\.\w+ \(/)
    })

    it('is tagged event-creation-failed', async () => {
      await emailService.sendEventCreationFailedEmail('organizer@cyber.harvard.edu', 'UID-ABC-123')

      expect(sentMessage().Tag).toBe('event-creation-failed')
    })

    it('omits the reference line when no reference ID is given', async () => {
      await emailService.sendEventCreationFailedEmail('organizer@cyber.harvard.edu')

      expect(sendEmailSpy).toHaveBeenCalledTimes(1)
      const msg = sentMessage()
      expect(msg.TextBody).not.toContain('undefined')
      expect(msg.HtmlBody).not.toContain('undefined')
    })
  })

  describe('sendOnDemandEventEmail', () => {
    const urls = {
      eventPageUrl: 'https://app.example.com/login?redirectTo=/admin/eventAssistant/view/conv-123',
      moderatorUrl: 'https://app.example.com/moderator/?conversationId=conv-123&channel=moderator%2Cabc',
      participantUrl: 'https://app.example.com/assistant/?conversationId=conv-123&channel=chat%2Cxyz'
    }

    it('sends to the given address', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      expect(sendEmailSpy).toHaveBeenCalledTimes(1)
      const msg = sentMessage()
      expect(msg.To).toBe('organizer@cyber.harvard.edu')
      expect(msg.From).toBe(config.email.from)
    })

    it('is tagged on-demand-event with tracking off, so the passcode links are never rewritten', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      const msg = sentMessage()
      expect(msg.Tag).toBe('on-demand-event')
      expect(msg.TrackLinks).toBe('None')
      expect(msg.TrackOpens).toBe(false)
    })

    it('uses the instant-join subject and says Berkie is joining now, when no joinAt is given', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      const msg = sentMessage()
      expect(msg.Subject).toBe('Berkie is joining your Zoom meeting')
      expect(msg.TextBody).toMatch(/joining.*now/i)
    })

    it('uses the scheduled subject and states the join time, when joinAt is given', async () => {
      const joinAt = new Date('2026-09-01T17:00:00Z')

      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls, { joinAt })

      const msg = sentMessage()
      expect(msg.Subject).toBe('Berkie will join your Zoom meeting')
      expect(msg.TextBody).toContain(joinAt.toISOString())
      expect(msg.HtmlBody).toContain(joinAt.toISOString())
    })

    it('leads with the moderator link labeled private, and the participant link', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      const msg = sentMessage()
      expect(msg.TextBody).toContain(urls.moderatorUrl)
      expect(msg.TextBody).toContain(urls.participantUrl)
      expect(msg.TextBody).toMatch(/private/i)
      expect(msg.HtmlBody).toContain(urls.moderatorUrl)
      expect(msg.HtmlBody).toContain(urls.participantUrl)
    })

    it('omits the moderator link entirely when the conversation has no moderator passcode', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', { ...urls, moderatorUrl: undefined })

      expect(sentMessage().HtmlBody.match(/href="/g)).toHaveLength(2)
    })

    it('includes the event page link last, labeled as where to edit the event', async () => {
      await emailService.sendOnDemandEventEmail('organizer@cyber.harvard.edu', urls)

      const msg = sentMessage()
      expect(msg.TextBody).toContain(urls.eventPageUrl)
      expect(msg.TextBody).toMatch(/edit/i)
      const [moderatorIndex, participantIndex, eventPageIndex] = [
        msg.TextBody.indexOf(urls.moderatorUrl),
        msg.TextBody.indexOf(urls.participantUrl),
        msg.TextBody.indexOf(urls.eventPageUrl)
      ]
      expect(eventPageIndex).toBeGreaterThan(moderatorIndex)
      expect(eventPageIndex).toBeGreaterThan(participantIndex)
    })
  })

  describe('sendOnDemandEventFailedEmail', () => {
    it('sends to the given address', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'noZoomLink')

      expect(sendEmailSpy).toHaveBeenCalledTimes(1)
      const msg = sentMessage()
      expect(msg.To).toBe('organizer@cyber.harvard.edu')
      expect(msg.From).toBe(config.email.from)
    })

    it('is tagged on-demand-event-failed', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'noZoomLink')

      expect(sentMessage().Tag).toBe('on-demand-event-failed')
    })

    it('tells the sender no Zoom link was found, for reason noZoomLink', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'noZoomLink')

      const msg = sentMessage()
      expect(msg.TextBody).toMatch(/zoom link/i)
      expect(msg.TextBody).not.toMatch(/invalid/i)
    })

    it('tells the sender the Zoom link was not valid, for reason invalidZoomLink', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'invalidZoomLink')

      const msg = sentMessage()
      expect(msg.TextBody).toMatch(/zoom link/i)
      expect(msg.TextBody).toMatch(/valid/i)
    })

    it('includes no error internals in the body', async () => {
      await emailService.sendOnDemandEventFailedEmail('organizer@cyber.harvard.edu', 'noZoomLink')

      const msg = sentMessage()
      expect(msg.TextBody).not.toMatch(/at \w+\.\w+ \(/)
      expect(msg.HtmlBody).not.toMatch(/at \w+\.\w+ \(/)
    })
  })

  describe('buildMemberInviteEmail', () => {
    const token = 'abc.def.ghi'

    it('links to the invite path with the token in the query string, in both text and html', () => {
      const msg = emailService.buildMemberInviteEmail('Jane Doe', 'Community Room', token)

      const expectedUrl = `${config.appHost}${config.invitePath}?token=${token}`
      expect(msg.subject).toEqual(expect.any(String))
      expect(msg.text).toContain(expectedUrl)
      expect(msg.html).toContain(expectedUrl)
      expect(msg.text).not.toContain(`#token=`)
      expect(msg.html).not.toContain(`#token=`)
    })

    it('greets the person by name and names the room', () => {
      const msg = emailService.buildMemberInviteEmail('Jane Doe', 'Community Room', token)

      expect(msg.text).toContain('Jane Doe')
      expect(msg.html).toContain('Jane Doe')
      expect(msg.text).toContain('Community Room')
      expect(msg.subject).toContain('Community Room')
    })

    it('HTML-escapes names and room names so a CSV value cannot inject markup', () => {
      const msg = emailService.buildMemberInviteEmail('<b>Jane</b> & "Doe"', 'Room <script>', token)

      expect(msg.html).not.toContain('<b>Jane</b>')
      expect(msg.html).not.toContain('<script>')
      expect(msg.html).toContain('&lt;b&gt;Jane&lt;/b&gt;')
      // The plain-text body needs no escaping and keeps the value as-is.
      expect(msg.text).toContain('<b>Jane</b> & "Doe"')
    })

    it('tells the person the link is personal and how long it lasts', () => {
      const msg = emailService.buildMemberInviteEmail('Jane Doe', 'Community Room', token)

      expect(msg.text).toContain(`${config.jwt.inviteExpirationDays} days`)
      expect(msg.text).toMatch(/link is (just )?for you|personal|do not forward|don't forward/i)
    })
  })

  describe('sendMemberInviteBatch', () => {
    it('is blocked until the Postmark API migration lands, and says so', async () => {
      await expect(
        emailService.sendMemberInviteBatch([
          { membershipId: 'm1', to: 'jane.doe@example.com', name: 'Jane Doe', roomName: 'Community Room', token: 'abc' }
        ])
      ).rejects.toMatchObject({ statusCode: 501 })
    })
  })
})

import { jest } from '@jest/globals'

/* The Postmark client falls back to the test token when none is configured, and Postmark
   answers test-token requests with success without delivering anything. These tests run
   the service as production with no token to prove the batch path refuses to send. */
const { default: realConfig } = await import('../../../src/config/config.js')
jest.unstable_mockModule('../src/config/config.js', () => ({
  default: {
    ...realConfig,
    env: 'production',
    email: { ...realConfig.email, postmarkServerToken: undefined }
  }
}))

const { default: emailService } = await import('../../../src/services/email.service.js')

describe('email.service with no Postmark token configured', () => {
  it('sendMemberInviteBatch refuses to send rather than marking members invited', async () => {
    const batchSpy = jest.spyOn(emailService.client, 'sendEmailBatch')

    await expect(
      emailService.sendMemberInviteBatch([
        { membershipId: 'm1', to: 'jane@example.com', name: 'Jane', roomName: 'Room', token: 'tok' }
      ])
    ).rejects.toThrow(/not configured/)

    expect(batchSpy).not.toHaveBeenCalled()
    batchSpy.mockRestore()
  })
})

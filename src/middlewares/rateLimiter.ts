import rateLimit from 'express-rate-limit'

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true
})

/* Guards the member-CSV-import endpoint: it accepts real personal data for ~200 people
   per request, so it stays tight and — unlike authLimiter — is applied in every
   environment, not just production (see members.route.ts). Tests reset this between
   cases with memberImportLimiter.resetAll() rather than relying on a looser max. */
const memberImportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5
})

/* Guards the admin batch-send and resend endpoints in every environment. */
const inviteSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10
})

/* Guards the public invite validate/consume endpoints in every environment. Unlike
   authLimiter this deliberately counts successful requests too: with
   skipSuccessfulRequests a valid token could be replayed rapidly without ever counting
   against the limit. */
const inviteConsumeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20
})

export { authLimiter, memberImportLimiter, inviteSendLimiter, inviteConsumeLimiter }

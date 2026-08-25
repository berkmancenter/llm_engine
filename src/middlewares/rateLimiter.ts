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

export { authLimiter, memberImportLimiter }

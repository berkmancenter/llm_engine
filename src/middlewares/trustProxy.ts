import express from 'express'
import logger from '../config/logger.js'

/* The hop count decides which X-Forwarded-For entry Express treats as the visitor, so it
   must match the deployment exactly (see TRUST_PROXY_HOPS in .env.example). At 0 the setting
   stays false, which keeps express-rate-limit's warning when forwarded headers show up. */
const applyTrustProxy = (expressApp: express.Express, hops: number) => {
  if (hops > 0) {
    expressApp.set('trust proxy', hops)
  }
}

/**
 * Logs once per process when a request carries fewer X-Forwarded-For entries than the
 * configured hops. Real traffic only does that when a proxy was removed or the value was
 * copied to a box with fewer proxies, and a hop count that is too high lets visitors fake
 * their address. Health checks are skipped because they never pass through a proxy.
 */
const warnOnShortForwardedChain = (hops: number): express.RequestHandler => {
  let warned = false
  return (req, res, next) => {
    if (!warned && req.originalUrl !== '/v1/health') {
      const entries = String(req.headers['x-forwarded-for'] ?? '')
        .split(',')
        .filter((entry) => entry.trim()).length
      if (entries < hops) {
        warned = true
        logger.warn(
          `trustProxy: a request arrived with ${entries} X-Forwarded-For entries but TRUST_PROXY_HOPS is ` +
            `${hops}; the setting may be too high for this deployment, which lets visitors fake their address`
        )
      }
    }
    next()
  }
}

export { applyTrustProxy, warnOnShortForwardedChain }

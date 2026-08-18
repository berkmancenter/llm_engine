import express from 'express'
import logger from '../../config/logger.js'
import { isSpecPopulated, loadSpec } from '../../docs/openapiSpec.js'

const router = express.Router()

// Also consumed by docs.route.ts (swagger-ui), which renders this same spec.
export const specs = loadSpec()

if (!isSpecPopulated(specs)) {
  logger.error(
    'OpenAPI spec is empty (no paths and/or no schemas). /v1/openapi.json will serve a spec that describes nothing, ' +
      'which breaks clients that generate types from it. Expected either the spec sources ' +
      '(src/docs/*.yml, src/routes/v1/**/*.ts) or a prebuilt openapi.json under the process working directory ' +
      `(${process.cwd()}). See src/docs/openapiSpec.ts.`
  )
}

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.send(specs)
})

export default router

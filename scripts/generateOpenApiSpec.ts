#!/usr/bin/env node
/**
 * Writes the OpenAPI spec to `openapi.json` at the repository/working-directory root, so it
 * can be served by an image that ships only `dist/` (see src/docs/openapiSpec.ts for the full
 * why). Run from the project root, against a source checkout — the spec is assembled from
 * `src/docs/*.yml` and jsdoc comments in `src/routes/v1/**`.
 *
 *   node dist/scripts/generateOpenApiSpec.js [output-path]
 *
 * Exits non-zero if the assembled spec has no schemas or no paths. That is the failure this
 * script exists to prevent: an empty spec is structurally valid, so every consumer downstream
 * accepts it and then breaks in a way that points nowhere near the real cause.
 */
/* eslint-disable no-console */
import fs from 'fs'
import path from 'path'
import { buildSpecFromSources, isSpecPopulated } from '../src/docs/openapiSpec.js'

const outputPath = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'openapi.json'))

const spec = buildSpecFromSources()
const schemaCount = Object.keys(spec.components?.schemas ?? {}).length
const pathCount = Object.keys(spec.paths ?? {}).length

if (!isSpecPopulated(spec)) {
  console.error(
    `Refusing to write an empty OpenAPI spec: ${schemaCount} schemas, ${pathCount} paths.\n` +
      `Assembled from sources relative to ${process.cwd()} — run this from the project root of a ` +
      `source checkout (src/docs/*.yml and src/routes/v1/**/*.ts must be present).`
  )
  process.exit(1)
}

fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2))
console.log(`Wrote ${outputPath}: ${schemaCount} schemas, ${pathCount} paths.`)

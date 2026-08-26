import fs from 'fs'
import path from 'path'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerDefinition from './swaggerDef.js'

/**
 * Builds the OpenAPI spec this API serves at `/v1/openapi.json` (and renders at `/v1/docs`).
 *
 * swagger-jsdoc assembles the spec from files on disk — `src/docs/components.yml` for the
 * schemas, jsdoc comments in the route sources for the paths — resolved against
 * `process.cwd()`. None of those files survive compilation: `tsc` emits only `.js` into
 * `dist/`, and the runtime container image ships `dist/` without `src/`. Assembling from
 * sources at runtime therefore silently yields an *empty but structurally valid* spec in a
 * container: `{ paths: {}, components: {} }`, no error.
 *
 * That empty spec is worse than a crash, because it breaks consumers far from here. The
 * Nextspace frontend generates its TypeScript types from this endpoint at build time, and
 * `openapi-typescript` renders a schema-less spec as `components.schemas: never` — which
 * turns every generated model into `never` and surfaces as "Property 'body' does not exist
 * on type 'never'" deep inside unrelated components.
 *
 * So the spec is generated once at image build time (`scripts/generateOpenApiSpec.ts`, wired
 * into the Dockerfile's build stage) and shipped as `openapi.json` next to `package.json`.
 * `loadSpec()` prefers the sources whenever they are present — a source checkout, i.e. local
 * dev and tests, always serves what is on disk right now — and falls back to that prebuilt
 * file only where the sources are absent, which is exactly the container case.
 */
const SPEC_SOURCES = ['src/docs/*.yml', 'src/routes/v1/**/*.ts']
const SPEC_SOURCE_PROBE = path.join(process.cwd(), 'src', 'docs', 'components.yml')
const PREBUILT_SPEC_PATH = path.join(process.cwd(), 'openapi.json')

export type OpenApiSpec = {
  paths?: Record<string, unknown>
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}

/** Assemble the spec from the yml/jsdoc sources. Requires a source checkout at `process.cwd()`. */
export const buildSpecFromSources = (): OpenApiSpec =>
  swaggerJsdoc({
    swaggerDefinition,
    apis: SPEC_SOURCES
  }) as OpenApiSpec

/**
 * True when a spec actually describes the API. A spec that parses but carries no schemas or
 * no paths means the sources weren't found — see the note above on why that fails silently.
 */
export const isSpecPopulated = (spec: OpenApiSpec): boolean =>
  Object.keys(spec?.components?.schemas ?? {}).length > 0 && Object.keys(spec?.paths ?? {}).length > 0

export const loadSpec = (): OpenApiSpec => {
  if (fs.existsSync(SPEC_SOURCE_PROBE)) return buildSpecFromSources()
  if (fs.existsSync(PREBUILT_SPEC_PATH)) return JSON.parse(fs.readFileSync(PREBUILT_SPEC_PATH, 'utf8')) as OpenApiSpec
  return buildSpecFromSources()
}

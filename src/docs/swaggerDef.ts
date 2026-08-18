import { createRequire } from 'module'

const require = createRequire(import.meta.url)
// eslint-disable-next-line import/no-dynamic-require
const packageJson = require(`${process.cwd()}/package.json`)

const { version } = packageJson

// Read straight from the environment rather than from config/config.js: this definition is
// also loaded by scripts/generateOpenApiSpec.ts at image build time, where none of config's
// required env vars (MONGODB_URL, JWT_SECRET, ...) exist and its Joi validation would throw.
// This only labels the local dev server in the docs UI, so a plain default is enough.
const port = process.env.PORT ?? 3000

const swaggerDef = {
  openapi: '3.0.0',
  info: {
    title: 'LLM Engine API documentation',
    version,
    license: {
      name: 'MIT',
      url: 'https://github.com/berkmancenter/llm_engine/blob/main/LICENSE'
    }
  },
  servers: [
    {
      url: `http://localhost:${port}/v1`
    }
  ]
}
export default swaggerDef

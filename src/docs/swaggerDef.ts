import { createRequire } from 'module'
import config from '../config/config.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line import/no-dynamic-require
const packageJson = require(`${process.cwd()}/package.json`)

const { version } = packageJson
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
      url: `http://localhost:${config.port}/v1`
    }
  ]
}
export default swaggerDef

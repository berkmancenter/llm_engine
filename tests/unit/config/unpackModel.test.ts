import { envVarsSchema } from '../../../src/config/config.js'

function unpackModelError(model: string) {
  return envVarsSchema.validate({ ...process.env, UNPACK_LLM_MODEL: model }).error
}

describe('UNPACK_LLM_MODEL', () => {
  it.each(['gpt', 'GPT', 'gemini'])('refuses the %s family name, which is not a Bedrock model', (model) => {
    expect(unpackModelError(model)?.message).toContain('UNPACK_LLM_MODEL')
  })

  it.each(['sonnet', 'us.anthropic.claude-sonnet-4-6'])('accepts %s', (model) => {
    expect(unpackModelError(model)).toBeUndefined()
  })
})

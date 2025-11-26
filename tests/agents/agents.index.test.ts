/**
 * @fileoverview Test for src/agents/index.ts to confirm correct agents are exported
 * depending on ENABLE_DEVELOPMENT_AGENTS env var.
 */

const developmentAgentKeys = [
  'civilityPerMessage',
  'civilityPerMessagePerspectiveAPI',
  'radicalEmpathyPerMessage',
  'playfulPerMessage',
  'playfulPeriodic',
  'reflection',
  'delegates',
  'experts',
  'generic'
]

const productionAgentKeys = ['backChannelMetrics', 'backChannelInsights', 'eventAssistant']

function clearAgentsIndexCache() {
  // Clear config and agents index from require cache
  jest.resetModules()
}

describe('src/agents/index.ts exports correct agents', () => {
  afterEach(() => {
    delete process.env.ENABLE_DEVELOPMENT_AGENTS
    clearAgentsIndexCache()
  })

  it('exports only production agents when ENABLE_DEVELOPMENT_AGENTS is false', async () => {
    process.env.ENABLE_DEVELOPMENT_AGENTS = 'false'
    clearAgentsIndexCache()
    const agents = (await import('../../src/agents/index')).default

    // Should have all production agents
    for (const key of productionAgentKeys) {
      expect(agents).toHaveProperty(key)
    }
    // Should NOT have any development agents
    for (const key of developmentAgentKeys) {
      expect(agents).not.toHaveProperty(key)
    }
  })

  it('exports development and production agents when ENABLE_DEVELOPMENT_AGENTS is true', async () => {
    process.env.ENABLE_DEVELOPMENT_AGENTS = 'true'
    clearAgentsIndexCache()
    const agents = (await import('../../src/agents/index')).default

    // Should have all production agents
    for (const key of productionAgentKeys) {
      expect(agents).toHaveProperty(key)
    }
    // Should have all development agents
    for (const key of developmentAgentKeys) {
      expect(agents).toHaveProperty(key)
    }
  })
})

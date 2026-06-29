import agentTypes from '../../../../src/agents/index.js'

describe('vibesAnalyst registry', () => {
  it('is registered in agentTypes with its capabilities loaded', () => {
    expect(agentTypes.vibesAnalyst).toBeDefined()
    expect(agentTypes.vibesAnalyst.capabilities).toBeDefined()
  })
})

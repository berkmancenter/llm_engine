import capabilities from '../../../../src/agents/vibesAnalyst/capabilities.js'

describe('vibesAnalyst capabilities', () => {
  it('reads all public topics so it can react to every public event', () => {
    const result = capabilities()
    expect(result.read).toEqual([{ type: 'allPublicTopics' }])
  })

  it('writes only to its own conversation', () => {
    const result = capabilities()
    expect(result.write).toEqual([{ type: 'ownConversation' }])
  })
})

import buildAppHomeData from '../../../../src/agents/communityAssistant/appHomeContent.js'
import config from '../../../../src/config/config.js'

const allTools = ['event_history', 'bkc_archive_wiki', 'web_search']

function keysOf(features: { key: string }[]): string[] {
  return features.map((feature) => feature.key)
}

describe('buildAppHomeData', () => {
  let archiveApiUrl

  beforeAll(() => {
    archiveApiUrl = config.bkcArchive.apiUrl
    config.bkcArchive.apiUrl = 'https://archive.example.com'
  })

  afterAll(() => {
    config.bkcArchive.apiUrl = archiveApiUrl
  })

  it('names the deployment bot throughout the page', () => {
    const data = buildAppHomeData({ botName: 'Athena', tools: allTools }, { canDirectMessage: true })

    expect(data.headline).toContain('Athena')
    expect(JSON.stringify(data)).not.toContain('{botName}')
  })

  it('lists a feature for each enabled tool, in the order the deployment configured them', () => {
    const data = buildAppHomeData({ botName: 'Athena', tools: ['web_search', 'event_history'] }, {})

    expect(keysOf(data.features)).toEqual(['web_search', 'event_history'])
  })

  it('gives every listed feature a label, a description, and at least one starter question', () => {
    const data = buildAppHomeData({ botName: 'Athena', tools: allTools }, {})

    for (const feature of data.features) {
      expect(feature.label.length).toBeGreaterThan(0)
      expect(feature.description.length).toBeGreaterThan(0)
      expect(feature.starterQuestions.length).toBeGreaterThan(0)
    }
  })

  it('lists no features when the deployment enabled no tools', () => {
    expect(buildAppHomeData({ botName: 'Athena', tools: [] }, {}).features).toEqual([])
  })

  it('drops an unrecognized tool rather than showing its raw name', () => {
    const data = buildAppHomeData({ botName: 'Athena', tools: ['event_history', 'not_a_real_tool'] }, {})

    expect(keysOf(data.features)).toEqual(['event_history'])
    expect(JSON.stringify(data)).not.toContain('not_a_real_tool')
  })

  it('drops a configured tool whose backing service is not set up', () => {
    config.bkcArchive.apiUrl = undefined

    const data = buildAppHomeData({ botName: 'Athena', tools: allTools }, {})

    expect(keysOf(data.features)).not.toContain('bkc_archive_wiki')
    expect(keysOf(data.features)).toEqual(['event_history', 'web_search'])

    config.bkcArchive.apiUrl = 'https://archive.example.com'
  })

  it('describes each notification the deployment turned on', () => {
    const data = buildAppHomeData({ botName: 'Athena', tools: [], notifications: ['event_ended'] }, {})

    expect(data.notices).toHaveLength(1)
    expect(data.notices[0].length).toBeGreaterThan(0)
  })

  it('lists no notices when the deployment turned none on', () => {
    expect(buildAppHomeData({ botName: 'Athena', tools: [] }, {}).notices).toEqual([])
  })

  it('drops an unrecognized notification rather than showing its raw name', () => {
    const data = buildAppHomeData({ botName: 'Athena', tools: [], notifications: ['not_a_real_notice'] }, {})

    expect(data.notices).toEqual([])
  })

  it('links the shared channel when the deployment has one', () => {
    const data = buildAppHomeData({ botName: 'Athena', tools: [] }, { channelId: 'C0123456789' })

    // Slack renders <#C0123456789> as a clickable channel name.
    expect(data.reachLines.join(' ')).toContain('<#C0123456789>')
  })

  it('offers a direct message only when the assistant accepts them', () => {
    const withDMs = buildAppHomeData({ botName: 'Athena', tools: [] }, { canDirectMessage: true })
    const withoutDMs = buildAppHomeData({ botName: 'Athena', tools: [] }, { canDirectMessage: false })

    expect(withDMs.reachLines.join(' ')).toContain('Messages tab')
    expect(withoutDMs.reachLines.join(' ')).not.toContain('Messages tab')
  })

  it('leaves the reach lines empty when there is no channel and no direct messages', () => {
    expect(buildAppHomeData({ botName: 'Athena', tools: [] }, {}).reachLines).toEqual([])
  })

  it('falls back to the configured default when the agent has no bot name', () => {
    const data = buildAppHomeData({ tools: [] }, {})

    expect(data.headline).toContain(config.conversationBotName)
  })
})

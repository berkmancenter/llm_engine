import renderAppHomePage from '../../../../../../src/adapters/slack/blocks/communityAssistant/appHome.js'
import { AppHomeData } from '../../../../../../src/types/index.types.js'

function makeData(overrides: Partial<AppHomeData> = {}): AppHomeData {
  return {
    headline: "Hi, I'm Berkie",
    intro: 'I am an assistant for this community.',
    featuresHeading: 'What I can do',
    features: [
      {
        key: 'event_history',
        label: 'Look up past events',
        description: 'I can find what earlier events covered and when they happened.',
        starterQuestions: ['What events happened recently?', 'What topics have past events covered?']
      },
      {
        key: 'web_search',
        label: 'Search the web',
        description: 'I can check current sources and tell you where the answer came from.',
        starterQuestions: ['What is the latest news on the EU AI Act?']
      }
    ],
    noticesHeading: 'What I post on my own',
    notices: ['When an event wraps up, I post a summary.'],
    reachHeading: 'How to reach me',
    reachLines: ['Say my name in <#C0123456789>.', 'Or message me in the Messages tab.'],
    footer: 'I can be wrong, so check anything that matters.',
    ...overrides
  }
}

function textOf(blocks: unknown[]): string {
  return JSON.stringify(blocks)
}

describe('renderAppHomePage', () => {
  it('leads with the headline as a header block', () => {
    const blocks = renderAppHomePage(makeData())

    expect(blocks[0]).toEqual(
      expect.objectContaining({
        type: 'header',
        text: expect.objectContaining({ text: "Hi, I'm Berkie" })
      })
    )
  })

  it('composes no prose of its own, rendering only the strings it is given', () => {
    const text = textOf(renderAppHomePage(makeData()))

    expect(text).toContain('I am an assistant for this community.')
    expect(text).toContain('What I can do')
    expect(text).toContain('How to reach me')
    expect(text).toContain('I can be wrong, so check anything that matters.')
  })

  it('renders each feature with its label, description, and starter questions', () => {
    const text = textOf(renderAppHomePage(makeData()))

    expect(text).toContain('Look up past events')
    expect(text).toContain('I can find what earlier events covered and when they happened.')
    expect(text).toContain('What events happened recently?')
    expect(text).toContain('What topics have past events covered?')
    expect(text).toContain('What is the latest news on the EU AI Act?')
  })

  it('shows nothing for a feature the deployment left out', () => {
    const data = makeData()
    data.features = data.features.filter((feature) => feature.key !== 'web_search')

    const text = textOf(renderAppHomePage(data))

    expect(text).not.toContain('EU AI Act')
    expect(text).not.toContain('Search the web')
  })

  it('drops the features heading when the deployment has no features enabled', () => {
    expect(textOf(renderAppHomePage(makeData({ features: [] })))).not.toContain('What I can do')
  })

  it('drops the notices heading when the assistant posts nothing on its own', () => {
    const text = textOf(renderAppHomePage(makeData({ notices: [] })))

    expect(text).not.toContain('What I post on my own')
    expect(text).not.toContain('post a summary')
  })

  it('drops the reach heading when there is no way to reach the assistant', () => {
    expect(textOf(renderAppHomePage(makeData({ reachLines: [] })))).not.toContain('How to reach me')
  })

  it('ends with the footer as small print rather than a full section', () => {
    const blocks = renderAppHomePage(makeData())

    expect(blocks[blocks.length - 1]).toEqual(
      expect.objectContaining({
        type: 'context',
        elements: [expect.objectContaining({ text: 'I can be wrong, so check anything that matters.' })]
      })
    )
  })

  it('renders no buttons, since home tab clicks are not routed yet', () => {
    const blocks = renderAppHomePage(makeData())

    expect(blocks.some((block) => block.type === 'actions')).toBe(false)
    expect(textOf(blocks)).not.toContain('"button"')
  })

  it('stays under the 100 block ceiling Slack enforces on a published view', () => {
    const features = Array.from({ length: 200 }, (_unused, index) => ({
      key: `tool_${index}`,
      label: `Feature ${index}`,
      description: `What feature ${index} does.`,
      starterQuestions: [`Question A for ${index}?`]
    }))

    expect(renderAppHomePage(makeData({ features })).length).toBeLessThanOrEqual(100)
  })
})

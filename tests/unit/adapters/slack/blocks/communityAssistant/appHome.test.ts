import type { ActionsBlock, Button as ButtonElement, KnownBlock } from '@slack/types'
import renderAppHomePage from '../../../../../../src/adapters/slack/blocks/communityAssistant/appHome.js'
import { AppHomeData } from '../../../../../../src/types/index.types.js'

function makeData(overrides: Partial<AppHomeData> = {}): AppHomeData {
  return {
    headline: "Hi, I'm Athena",
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
    reachLines: ['Say my name in C0123456789.', 'Or message me in the Messages tab.'],
    questionsAreClickable: false,
    footer: 'I can be wrong, so check anything that matters.',
    ...overrides
  }
}

function buttonsIn(blocks: KnownBlock[]) {
  return blocks
    .filter((block): block is ActionsBlock => block.type === 'actions')
    .flatMap((block) => block.elements as ButtonElement[])
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
        text: expect.objectContaining({ text: "Hi, I'm Athena" })
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

  it('formats the channel ID in reach lines as a Slack mrkdwn channel link', () => {
    const blocks = renderAppHomePage(makeData({ reachLines: ['Find me in C0123456789 to get started.'], channelId: 'C0123456789' }))
    expect(textOf(blocks)).toContain('<#C0123456789>')
    expect(textOf(blocks)).not.toContain(' C0123456789')
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

  it('renders starter questions as plain text when a click has nowhere private to land', () => {
    const blocks = renderAppHomePage(makeData({ questionsAreClickable: false }))

    expect(buttonsIn(blocks)).toHaveLength(0)
    expect(textOf(blocks)).toContain('What events happened recently?')
  })

  it('renders one button per starter question when clicks can be answered privately', () => {
    const buttons = buttonsIn(renderAppHomePage(makeData({ questionsAreClickable: true })))

    expect(buttons).toHaveLength(3)
    expect(buttons.map((button) => button.value)).toEqual([
      'What events happened recently?',
      'What topics have past events covered?',
      'What is the latest news on the EU AI Act?'
    ])
  })

  it('carries the whole question as the button value, so the assistant answers what was asked', () => {
    const longQuestion = `Who spoke about ${'decentralized identity '.repeat(6)}at the workshop?`
    const data = makeData({ questionsAreClickable: true })
    data.features = [{ ...data.features[0], starterQuestions: [longQuestion] }]

    const [button] = buttonsIn(renderAppHomePage(data))

    expect(button.value).toBe(longQuestion)
    // Slack rejects button text over 75 characters, so the label is clipped and the value is not.
    expect(button.text.text.length).toBeLessThanOrEqual(75)
  })

  it('stops repeating a question as text once it is a button', () => {
    const text = textOf(renderAppHomePage(makeData({ questionsAreClickable: true })))

    expect(text).not.toContain('> _What events happened recently?_')
  })

  it('stays under the 100 block ceiling Slack enforces on a published view', () => {
    const features = Array.from({ length: 200 }, (_unused, index) => ({
      key: `tool_${index}`,
      label: `Feature ${index}`,
      description: `What feature ${index} does.`,
      starterQuestions: [`Question A for ${index}?`]
    }))

    expect(renderAppHomePage(makeData({ features })).length).toBeLessThanOrEqual(100)
    // Buttons add an actions block per feature, so the cap has to hold in both modes.
    expect(renderAppHomePage(makeData({ features, questionsAreClickable: true })).length).toBeLessThanOrEqual(100)
  })
})

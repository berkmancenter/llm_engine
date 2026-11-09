import mongoose from 'mongoose'
import setupAgentTest from '../../utils/setupAgentTest.js'
import { getModelChat } from '../../../src/agents/helpers/getModelChat.js'
import { buildPassage, explainPassage } from '../../../src/agents/helpers/unpackPassage.js'
import { summarizeCatchUp } from '../../../src/agents/eventAssistant/unpackHandler.js'

jest.setTimeout(120000)

const testConfig = setupAgentTest('eventAssistant')

const SECOND = 1000

describe('Event Assistant catches a participant up on the last minute', () => {
  async function catchUp(lines: string[], { earlierSpeech = false } = {}) {
    const now = Date.now()
    const chunks = lines.map((body, i) => ({ body, createdAt: new Date(now - (lines.length - i) * 15 * SECOND) }))
    const llm = await getModelChat(testConfig.llmPlatform, testConfig.llmModel, { maxTokens: 1000 })
    return summarizeCatchUp(llm, { topic: 'Building Reliable Distributed Systems', chunks, earlierSpeech })
  }

  it('summarizes in short, lists what they covered, and leaves "Coming up" empty when nothing is announced', async () => {
    const sections = await catchUp([
      'Every team here sets an SLO for each service it runs.',
      'If you burn through your error budget, feature work stops until reliability recovers.',
      'That tradeoff is the heart of how SRE teams negotiate with product managers.'
    ])

    expect(sections.inShort.length).toBeGreaterThan(0)
    expect(sections.inShort.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3)
    expect(sections.whatTheyCovered.length).toBeGreaterThanOrEqual(2)
    expect(sections.whatTheyCovered.length).toBeLessThanOrEqual(5)
    expect(sections.comingUp).toBeNull()
  })

  it('says what is coming up when the speaker announces it', async () => {
    const sections = await catchUp([
      'Every team here sets an SLO for each service it runs.',
      'If you burn through your error budget, feature work stops until reliability recovers.',
      'Next, let me show you the dashboard we use to track error budgets across forty teams.'
    ])

    expect(sections.comingUp).toMatch(/dashboard/i)
  })
})

describe('Event Assistant explains a passage a participant highlighted', () => {
  const chunkAt = (body: string, secondsAgo: number) => ({
    _id: new mongoose.Types.ObjectId(),
    body,
    createdAt: new Date(Date.now() - secondsAgo * SECOND)
  })

  async function explain(chunk, words: string, { before = '', after = '' } = {}) {
    const start = chunk.body.indexOf(words)
    const passage = buildPassage([chunk], {
      startMessageId: chunk._id.toString(),
      startOffset: start,
      endMessageId: chunk._id.toString(),
      endOffset: start + words.length
    })
    const llm = await getModelChat(testConfig.llmPlatform, testConfig.llmModel, { maxTokens: 1000 })
    const sections = await explainPassage(llm, { topic: 'Building Reliable Distributed Systems', passage, before, after })
    return { passage, sections }
  }

  it('explains only the widened passage, names its terms, and writes a headline', async () => {
    const chunk = chunkAt(
      'If you burn through your error budget, feature work stops until reliability recovers. Lunch is at noon.',
      40
    )

    const { passage, sections } = await explain(chunk, 'burn through', {
      before: '[10:41:02 AM] Every team here sets an SLO for each service it runs.',
      after: '[10:42:30 AM] That tradeoff is how SRE teams negotiate with product managers.'
    })

    expect(passage.quote).toBe('If you burn through your error budget, feature work stops until reliability recovers.')
    expect(sections.whatTheyreSaying.length).toBeGreaterThan(0)
    expect(sections.whatTheyreSaying.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3)
    expect(sections.whyItMatters.length).toBeGreaterThan(0)
    expect(`${sections.whatTheyreSaying} ${sections.whyItMatters}`).not.toMatch(/lunch|noon/i)
    expect(sections.terms.length).toBeLessThanOrEqual(3)
    expect(sections.terms.map(({ term }) => term).join(' ')).toMatch(/error budget/i)
    expect(sections.headline.length).toBeGreaterThan(0)
    expect(sections.headline.split(/\s+/).length).toBeLessThanOrEqual(15)
  })

  it('leaves out a visual for a definition', async () => {
    const definition = chunkAt('An SLO is simply the reliability target a team promises for a service.', 20)

    const { sections } = await explain(definition, 'reliability target')

    expect(sections.visual).toBeNull()
  })

  it('gives a drawable visual, with alt text and a caption, for a trend over time', async () => {
    const trend = chunkAt(
      'Our outage minutes fell from 400 in 2021 to 250 in 2022, then 90 in 2023, and just 20 last year.',
      20
    )

    const { sections } = await explain(trend, 'fell from 400')

    expect(sections.visual).not.toBeNull()
    expect(sections.visual!.description.length).toBeGreaterThan(0)
    expect(sections.visual!.altText.length).toBeGreaterThan(0)
    expect(sections.visual!.caption.length).toBeGreaterThan(0)
  })
})

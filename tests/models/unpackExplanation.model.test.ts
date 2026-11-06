import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import UnpackExplanation from '../../src/models/unpackExplanation.model.js'

setupIntTest()

const generating = () => ({
  conversation: new mongoose.Types.ObjectId(),
  passageKey: `${new mongoose.Types.ObjectId()}:0-${new mongoose.Types.ObjectId()}:12`,
  chunkIds: [new mongoose.Types.ObjectId()],
  quote: 'Missing it eats the error budget.',
  status: 'generating',
  generatingSince: new Date()
})

describe('UnpackExplanation model', () => {
  beforeAll(async () => {
    await UnpackExplanation.syncIndexes()
  })

  it('saves a passage that is still being explained, before any AI output exists', async () => {
    const saved = await UnpackExplanation.create(generating())

    expect(saved.status).toBe('generating')
    expect(saved.whatTheyreSaying).toBeUndefined()
  })

  it('keeps one explanation per passage, so two requests at once cannot both call the AI model', async () => {
    const first = generating()
    await UnpackExplanation.create(first)

    await expect(UnpackExplanation.create({ ...generating(), passageKey: first.passageKey })).rejects.toThrow(
      /duplicate key/
    )
  })

  it.each(['conversation', 'passageKey', 'status'])('requires %s', async (field) => {
    const explanation = generating()
    delete explanation[field]

    await expect(UnpackExplanation.create(explanation)).rejects.toThrow(mongoose.Error.ValidationError)
  })

  it('stores a ready explanation with no visual', async () => {
    const saved = await UnpackExplanation.create({
      ...generating(),
      status: 'ready',
      whatTheyreSaying: 'Missing the target uses up the budget for mistakes.',
      whyItMatters: 'It explains why feature work stops.',
      terms: [{ term: 'error budget', text: 'How much failure is allowed.' }],
      headline: "What the speaker meant by 'error budget'",
      visual: null
    })

    expect(saved.terms).toHaveLength(1)
    expect(saved.visual).toBeNull()
  })
})

import mongoose from 'mongoose'
import createResourceSearchTools, { getBackgroundContextForQuestion } from '../../../src/agents/tools/resourceSearch.js'
import rag from '../../../src/agents/helpers/rag.js'
import setupIntTest from '../../utils/setupIntTest.js'

setupIntTest()

describe('resourceSearch tools', () => {
  let ragSpy

  afterEach(() => {
    ragSpy?.mockRestore()
  })

  describe('search_resources', () => {
    test("queries this conversation's own background collection and returns the formatted chunks", async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({
        chunks: 'Source ID: 0\nTitle: Some Paper\nSnippet: Relevant text.',
        retrievedDocs: []
      })

      const [searchResourcesTool] = createResourceSearchTools({ conversationId })
      const result = await searchResourcesTool.invoke({ query: 'flexible work' })

      expect(ragSpy).toHaveBeenCalledWith(`background-${conversationId}`, 'flexible work', expect.any(Function))
      expect(result).toBe('Source ID: 0\nTitle: Some Paper\nSnippet: Relevant text.')
    })

    test('formats a retrieved doc using the citation metadata and page content', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest
        .spyOn(rag, 'getContextChunksForQuestion')
        .mockImplementation(async (_collection, _question, formatFn) => ({
          chunks: formatFn({ metadata: { citation: 'Smith, 2024' }, pageContent: 'Some relevant snippet.' }, 0),
          retrievedDocs: []
        }))

      const [searchResourcesTool] = createResourceSearchTools({ conversationId })
      const result = await searchResourcesTool.invoke({ query: 'anything' })

      expect(result).toBe('Source ID: 0\nTitle: Smith, 2024\nSnippet: Some relevant snippet.')
    })

    test('returns a no-match message when retrieval finds nothing', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({ chunks: '', retrievedDocs: [] })

      const [searchResourcesTool] = createResourceSearchTools({ conversationId })
      const result = await searchResourcesTool.invoke({ query: 'nonsense' })

      expect(result).toBe('No matching background material found.')
    })

    test('degrades gracefully when the collection does not exist yet (no resources uploaded)', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockRejectedValue(new Error('collection not found'))

      const [searchResourcesTool] = createResourceSearchTools({ conversationId })
      const result = await searchResourcesTool.invoke({ query: 'anything' })

      expect(result).toBe('No matching background material found.')
    })

    test('scopes to the given conversation id, not any other conversation', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      const otherConversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({ chunks: 'found it', retrievedDocs: [] })

      const [searchResourcesTool] = createResourceSearchTools({ conversationId })
      await searchResourcesTool.invoke({ query: 'topic' })

      expect(ragSpy).toHaveBeenCalledWith(`background-${conversationId}`, 'topic', expect.any(Function))
      expect(ragSpy).not.toHaveBeenCalledWith(`background-${otherConversationId}`, expect.anything(), expect.anything())
    })
  })

  describe('getBackgroundContextForQuestion', () => {
    test('queries the conversation collection with a relevance-score gate, keyed on the raw question', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({
        chunks: 'Source ID: 0\nTitle: Some Paper\nSnippet: Relevant text.',
        retrievedDocs: []
      })

      const result = await getBackgroundContextForQuestion(conversationId, 'what does the reading say?')

      expect(ragSpy).toHaveBeenCalledWith(
        `background-${conversationId}`,
        'what does the reading say?',
        expect.any(Function),
        undefined,
        5,
        undefined,
        undefined,
        0.5
      )
      expect(result).toBe('Source ID: 0\nTitle: Some Paper\nSnippet: Relevant text.')
    })

    test('returns an empty string when nothing clears the relevance bar', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({ chunks: '', retrievedDocs: [] })

      const result = await getBackgroundContextForQuestion(conversationId, 'unrelated question')

      expect(result).toBe('')
    })

    test('degrades gracefully (empty string, not a thrown error) when the collection does not exist yet', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockRejectedValue(new Error('collection not found'))

      const result = await getBackgroundContextForQuestion(conversationId, 'anything')

      expect(result).toBe('')
    })
  })
})

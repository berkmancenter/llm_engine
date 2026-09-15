import mongoose from 'mongoose'
import createMemberBioTools from '../../../src/agents/tools/memberBios.js'
import rag from '../../../src/agents/helpers/rag.js'
import ConversationMembership from '../../../src/models/conversationMembership.model.js'
import setupIntTest from '../../utils/setupIntTest.js'

setupIntTest()

const seedMember = async (conversationId: string, overrides: Record<string, unknown> = {}) =>
  ConversationMembership.create({
    conversation: conversationId,
    email: overrides.email ?? 'ada@example.com',
    name: overrides.name ?? 'Ada Lovelace',
    bio: overrides.bio ?? 'Mathematician and writer.',
    interests: overrides.interests ?? 'computing, mathematics',
    status: overrides.status ?? 'active',
    externalIds: overrides.externalIds
  })

describe('memberBios tools', () => {
  let ragSpy

  afterEach(() => {
    ragSpy?.mockRestore()
  })

  describe('search_members', () => {
    test('returns a matching member formatted with bio/interests', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      const member = await seedMember(conversationId)

      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({
        chunks: '',
        retrievedDocs: [{ score: 0.1, pageContent: '', metadata: { membershipId: member._id.toString() } }]
      })

      const [searchMembersTool] = createMemberBioTools({ conversationId })
      const result = await searchMembersTool.invoke({ query: 'mathematics' })

      expect(ragSpy).toHaveBeenCalledWith(`member-bio-${conversationId}`, 'mathematics', undefined, undefined, 5)
      expect(result).toContain('Member: Ada Lovelace')
      expect(result).toContain('Bio: Mathematician and writer.')
      expect(result).toContain('Interests: computing, mathematics')
    })

    test('returns member name even when no external id is linked yet', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      const member = await seedMember(conversationId, { name: 'Grace Hopper', email: 'grace@example.com' })

      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({
        chunks: '',
        retrievedDocs: [{ score: 0.1, pageContent: '', metadata: { membershipId: member._id.toString() } }]
      })

      const [searchMembersTool] = createMemberBioTools({ conversationId })
      const result = await searchMembersTool.invoke({ query: 'compilers' })

      expect(result).toContain('Member: Grace Hopper')
    })

    test('returns a no-match message when retrieval finds nothing', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()

      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({ chunks: '', retrievedDocs: [] })

      const [searchMembersTool] = createMemberBioTools({ conversationId })
      const result = await searchMembersTool.invoke({ query: 'nonsense' })

      expect(result).toBe('No matching members found.')
    })

    test('excludes a removed member even if a stale chunk still matches', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      const member = await seedMember(conversationId, { status: 'removed' })

      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({
        chunks: '',
        retrievedDocs: [{ score: 0.1, pageContent: '', metadata: { membershipId: member._id.toString() } }]
      })

      const [searchMembersTool] = createMemberBioTools({ conversationId })
      const result = await searchMembersTool.invoke({ query: 'mathematics' })

      expect(result).toBe('No matching members found.')
    })

    test('does not return a member from a different conversation', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      const otherConversationId = new mongoose.Types.ObjectId().toString()
      const member = await seedMember(otherConversationId)

      ragSpy = jest.spyOn(rag, 'getContextChunksForQuestion').mockResolvedValue({
        chunks: '',
        retrievedDocs: [{ score: 0.1, pageContent: '', metadata: { membershipId: member._id.toString() } }]
      })

      const [searchMembersTool] = createMemberBioTools({ conversationId })
      const result = await searchMembersTool.invoke({ query: 'mathematics' })

      expect(result).toBe('No matching members found.')
    })
  })

  describe('get_member', () => {
    test('finds a member by fuzzy name match', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      await seedMember(conversationId, { name: 'Rebecca Rivera', email: 'becca@example.com' })

      const [, getMemberTool] = createMemberBioTools({ conversationId })
      const result = await getMemberTool.invoke({ name: 'Becca Rivera' })

      expect(result).toContain('Member: Rebecca Rivera')
    })

    test('strips a leading @ before matching', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      await seedMember(conversationId, { name: 'Becca Rivera', email: 'becca@example.com' })

      const [, getMemberTool] = createMemberBioTools({ conversationId })
      const result = await getMemberTool.invoke({ name: '@Becca Rivera' })

      expect(result).toContain('Member: Becca Rivera')
    })

    test('returns a no-match message for an unrelated name', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      await seedMember(conversationId)

      const [, getMemberTool] = createMemberBioTools({ conversationId })
      const result = await getMemberTool.invoke({ name: 'Zzyzx Nonexistent' })

      expect(result).toBe('No matching member found.')
    })

    test('matches a member by first name only', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      await seedMember(conversationId, { name: 'Jonathan Smith', email: 'jonathan@example.com' })

      const [, getMemberTool] = createMemberBioTools({ conversationId })
      const result = await getMemberTool.invoke({ name: 'Jonathan' })

      expect(result).toContain('Member: Jonathan Smith')
    })

    test('does not match a shorter similar first name when searching by longer name', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      await seedMember(conversationId, { name: 'Jon Smith', email: 'jon@example.com' })
      await seedMember(conversationId, { name: 'Jonnie White', email: 'jonnie@example.com' })

      const [, getMemberTool] = createMemberBioTools({ conversationId })
      const result = await getMemberTool.invoke({ name: 'Jonathan' })

      expect(result).toBe('No matching member found.')
    })

    test('does not return a member from a different conversation', async () => {
      const conversationId = new mongoose.Types.ObjectId().toString()
      const otherConversationId = new mongoose.Types.ObjectId().toString()
      await seedMember(otherConversationId)

      const [, getMemberTool] = createMemberBioTools({ conversationId })
      const result = await getMemberTool.invoke({ name: 'Ada Lovelace' })

      expect(result).toBe('No matching member found.')
    })
  })

})

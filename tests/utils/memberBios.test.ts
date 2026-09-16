import memberBios, { memberBioCollectionName } from '../../src/utils/memberBios.js'
import rag from '../../src/agents/helpers/rag.js'

const { indexMemberBios, removeMemberBio, deleteMemberBioCollection } = memberBios

describe('memberBios', () => {
  let ragRemoveSpy
  let ragAddSpy
  let ragDeleteCollectionSpy

  beforeEach(() => {
    ragRemoveSpy = jest.spyOn(rag, 'removeFromVectorStore').mockResolvedValue()
    ragAddSpy = jest.spyOn(rag, 'addTextsToVectorStore').mockResolvedValue()
    ragDeleteCollectionSpy = jest.spyOn(rag, 'deleteCollection').mockResolvedValue()
  })

  afterEach(() => {
    ragRemoveSpy.mockRestore()
    ragAddSpy.mockRestore()
    ragDeleteCollectionSpy.mockRestore()
  })

  describe('memberBioCollectionName', () => {
    it('scopes the collection name to the conversation', () => {
      expect(memberBioCollectionName('conv1')).toBe('member-bio-conv1')
    })
  })

  describe('indexMemberBios', () => {
    it('does nothing for an empty member list', async () => {
      await indexMemberBios('conv1', [])
      expect(ragRemoveSpy).not.toHaveBeenCalled()
      expect(ragAddSpy).not.toHaveBeenCalled()
    })

    it('removes stale entries for all members in one request before adding current content', async () => {
      await indexMemberBios('conv1', [{ id: 'm1', name: 'Ada Lovelace', bio: 'Mathematician.', interests: 'computing' }])

      expect(ragRemoveSpy).toHaveBeenCalledWith('member-bio-conv1', { membershipId: { $in: ['m1'] } })
      expect(ragAddSpy).toHaveBeenCalledWith(
        'member-bio-conv1',
        ['Ada Lovelace is a member of this community. Mathematician. Interests: computing'],
        { metadatas: [{ membershipId: 'm1', name: 'Ada Lovelace' }] }
      )
    })

    it('embeds bio-only and interests-only members correctly', async () => {
      await indexMemberBios('conv1', [
        { id: 'm1', name: 'Bio Only', bio: 'Loves bios.' },
        { id: 'm2', name: 'Interests Only', interests: 'gardening' }
      ])

      expect(ragRemoveSpy).toHaveBeenCalledWith('member-bio-conv1', { membershipId: { $in: ['m1', 'm2'] } })
      expect(ragAddSpy).toHaveBeenCalledWith(
        'member-bio-conv1',
        [
          'Bio Only is a member of this community. Loves bios.',
          'Interests Only is a member of this community. Interests: gardening'
        ],
        {
          metadatas: [
            { membershipId: 'm1', name: 'Bio Only' },
            { membershipId: 'm2', name: 'Interests Only' }
          ]
        }
      )
    })

    it('skips embedding (but still clears stale entries) for a member with neither bio nor interests', async () => {
      await indexMemberBios('conv1', [{ id: 'm1', name: 'Blank Member', bio: '', interests: '   ' }])

      expect(ragRemoveSpy).toHaveBeenCalledWith('member-bio-conv1', { membershipId: { $in: ['m1'] } })
      expect(ragAddSpy).not.toHaveBeenCalled()
    })

    it('logs a warning but still adds when a delete batch fails', async () => {
      ragRemoveSpy.mockRejectedValueOnce(new Error('Chroma is down'))
      await expect(
        indexMemberBios('conv1', [{ id: 'm1', name: 'Ada Lovelace', bio: 'Mathematician.' }])
      ).resolves.not.toThrow()
      expect(ragAddSpy).toHaveBeenCalled()
    })

    it('batches deletes and adds in groups of 100 to avoid Chroma 502s', async () => {
      const members = Array.from({ length: 150 }, (_, i) => ({
        id: `m${i}`,
        name: `Member ${i}`,
        bio: `Bio for member ${i}.`
      }))
      await indexMemberBios('conv1', members)
      expect(ragRemoveSpy).toHaveBeenCalledTimes(2)
      expect(ragAddSpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('removeMemberBio', () => {
    it('removes the member by membershipId filter', async () => {
      await removeMemberBio('conv1', 'm1')
      expect(ragRemoveSpy).toHaveBeenCalledWith('member-bio-conv1', { membershipId: 'm1' })
    })

    it('tolerates a missing collection', async () => {
      ragRemoveSpy.mockRejectedValueOnce(new Error('collection does not exist'))
      await expect(removeMemberBio('conv1', 'm1')).resolves.not.toThrow()
    })
  })

  describe('deleteMemberBioCollection', () => {
    it('deletes the conversation-scoped collection', async () => {
      await deleteMemberBioCollection('conv1')
      expect(ragDeleteCollectionSpy).toHaveBeenCalledWith('member-bio-conv1')
    })
  })
})

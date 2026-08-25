import { roles, roleRights } from '../../../src/config/roles.js'

// Asserted exactly, not sampled, so that widening the role has to fail a test.
const PARTICIPANT_RIGHTS = [
  'createMessage',
  'getConversation',
  'vote',
  'respondPoll',
  'inspectPoll',
  'getPollResponseCounts',
  'getUser',
  'manageAccount'
]

const ADMINISTRATION_RIGHTS = [
  'createConversation',
  'deleteConversation',
  'startConversation',
  'stopConversation',
  'updateConversation',
  'patchConversationAgent',
  'createTopic',
  'deleteTopic',
  'updateTopic',
  'createPoll',
  'createExperiment',
  'runExperiment',
  'getExperiment',
  'getExperimentResults',
  'getConversationReport',
  'deleteTranscript',
  'pauseTranscript',
  'resumeTranscript',
  'getTranscript'
]

const ENUMERATION_RIGHTS = [
  'publicConversations',
  'activeConversations',
  'topicConversations',
  'allTopics',
  'userTopics',
  // Owning and following are both admin-only, so this could only ever return an empty list.
  'userConversations'
]

describe('roles config', () => {
  describe('participant role', () => {
    test('should replace the old user role', () => {
      expect(roles).toContain('participant')
      expect(roles).not.toContain('user')
    })

    test('should grant exactly the rights the event participant flow needs', () => {
      expect([...roleRights.get('participant')!].sort()).toEqual([...PARTICIPANT_RIGHTS].sort())
    })

    test.each(ADMINISTRATION_RIGHTS)('should not grant %s', (right) => {
      expect(roleRights.get('participant')).not.toContain(right)
    })

    test.each(ENUMERATION_RIGHTS)('should not grant %s', (right) => {
      expect(roleRights.get('participant')).not.toContain(right)
    })

    test('should not allow listing or managing users', () => {
      expect(roleRights.get('participant')).not.toContain('getUsers')
      expect(roleRights.get('participant')).not.toContain('manageUsers')
    })
  })

  describe('admin role', () => {
    test('should keep every right it held before participants were narrowed', () => {
      const adminRights = roleRights.get('admin')!
      for (const right of [...PARTICIPANT_RIGHTS, ...ADMINISTRATION_RIGHTS, ...ENUMERATION_RIGHTS]) {
        expect(adminRights).toContain(right)
      }
      expect(adminRights).toContain('getUsers')
      expect(adminRights).toContain('manageUsers')
    })
  })
})

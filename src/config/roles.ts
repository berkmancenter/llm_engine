/* Registration creates participants, so treat this as an allowlist: add a right only when a
   participant-facing client cannot work without it. Rights are global, not per-conversation,
   so `getConversation` opens any conversation id the participant already holds. */
const participantRights = [
  'createMessage',
  'getConversation',
  'vote',
  'respondPoll',
  'inspectPoll',
  'getPollResponseCounts',
  'getUser',
  'manageAccount'
]

const adminOnlyRights = [
  'createConversation',
  'updateConversation',
  'deleteConversation',
  'startConversation',
  'stopConversation',
  'patchConversationAgent',
  'joinConversation',
  'followConversation',
  // Reads conversations you own or follow, both of which need admin rights to do in the first place.
  'userConversations',
  'publicConversations',
  'activeConversations',
  'topicConversations',
  'getConversationReport',
  'exportOwnConversation',
  'createTopic',
  'updateTopic',
  'deleteTopic',
  'allTopics',
  'userTopics',
  'followTopic',
  'getTranscript',
  'deleteTranscript',
  'pauseTranscript',
  'resumeTranscript',
  'createPoll',
  'listPolls',
  'getPollResponses',
  'createExperiment',
  'runExperiment',
  'getExperiment',
  'getExperimentResults',
  'managePseudonym',
  'ping',
  'getUsers',
  'manageUsers'
]

const allRoles = {
  participant: participantRights,
  admin: [...participantRights, ...adminOnlyRights],
  // Generic role for system/bot accounts, scoped to topic operations only
  serviceAccount: ['createTopic', 'allTopics', 'followTopic']
}

const roles = Object.keys(allRoles)
const roleRights = new Map(Object.entries(allRoles))

export { roles, roleRights }

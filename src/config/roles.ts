/* Every account created through registration is a participant, so this list is an
   allowlist built up from what the event flow needs, never a denylist trimmed down.
   Add a right here only when a participant-facing client cannot work without it.

   These are global rights, not per-conversation permissions. `getConversation` lets a
   participant fetch any conversation id they already have; scoping that to the rooms
   they belong to is conversation membership, handled separately. */
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

// Everything else: conversation and topic lifecycle, transcripts, reports, experiments,
// poll authoring, and user management.
const adminOnlyRights = [
  'createConversation',
  'updateConversation',
  'deleteConversation',
  'startConversation',
  'stopConversation',
  'patchConversationAgent',
  'joinConversation',
  'followConversation',
  /* Reads back conversations you own or follow. Both of those need admin rights, so a
     participant holding this would only ever get an empty list. */
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
  // Admins inherit every participant right
  admin: [...participantRights, ...adminOnlyRights],
  // Generic role for system/bot accounts, scoped to topic operations only
  serviceAccount: ['createTopic', 'allTopics', 'followTopic']
}

const roles = Object.keys(allRoles)
const roleRights = new Map(Object.entries(allRoles))

export { roles, roleRights }

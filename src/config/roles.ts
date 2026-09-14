/* Registration creates participants, so treat this as an allowlist: add a right only when a
   participant-facing client cannot work without it. Rights are global, not per-conversation,
   so `getConversation` opens any conversation id the participant already holds. */
const participantRights = [
  'createMessage',
  'getConversation',
  'joinConversation',
  'vote',
  'respondPoll',
  'inspectPoll',
  'getPollResponseCounts',
  'getUser',
  'manageAccount',
  /* Reading an artifact is gated by its container's artifact passcode, not by role — a
     participant may hold a link to one without an account that could be given a right.
     See artifact.service.ts. Creating or revising one needs `manageArtifacts` below. */
  'getArtifact',
  'listArtifacts'
]

const adminOnlyRights = [
  'createConversation',
  'updateConversation',
  'deleteConversation',
  'startConversation',
  'stopConversation',
  'patchConversationAgent',
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
  'manageUsers',
  'manageMembers',
  /* Create an artifact, and append versions to one. Required outright for a topic-scoped
     artifact, since a topic spans other people's conversations; for a conversation-scoped
     one the conversation's or topic's owner qualifies without it. */
  'manageArtifacts'
]

const allRoles = {
  participant: participantRights,
  admin: [...participantRights, ...adminOnlyRights],
  // Generic role for system/bot accounts, scoped to topic operations only
  serviceAccount: ['createTopic', 'allTopics', 'followTopic']
}

const roles = Object.keys(allRoles)
const roleRights = new Map(Object.entries(allRoles))

/* The roles an admin may assign to a person. serviceAccount is left out because it holds no
   right the chat needs, so setting it on a person locks them out of every screen. System
   accounts get it from SYSTEM_USERS at startup instead. */
const assignableRoles = ['participant', 'admin']

export { roles, roleRights, assignableRoles }

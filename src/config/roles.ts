const baseRights = [
  'createMessage',
  'userTopics',
  'createTopic',
  'deleteTopic',
  'updateTopic',
  'createConversation',
  'userConversations',
  'activeConversations',
  'ping',
  'followConversation',
  'followTopic',
  'allTopics',
  'publicConversations',
  'topicConversations',
  'deleteConversation',
  'getConversation',
  'getConversationReport',
  'deleteTranscript',
  'pauseTranscript',
  'resumeTranscript',
  'getTranscript',
  'vote',
  'managePseudonym',
  'manageAccount',
  'getUser',
  'updateConversation',
  'exportOwnConversation',
  'patchConversationAgent',
  'startConversation',
  'stopConversation',
  'joinConversation',
  // poll roles
  'createPoll',
  'respondPoll',
  'listPolls',
  'inspectPoll',
  'getPollResponses',
  'getPollResponseCounts',
  'createExperiment',
  'runExperiment',
  'getExperiment',
  'getExperimentResults'
]
const allRoles = {
  user: baseRights,
  // Admins inherit all user rights
  admin: [...baseRights, 'getUsers', 'manageUsers'],
  // Generic role for system/bot accounts, scoped to topic operations only
  serviceAccount: ['createTopic', 'allTopics', 'followTopic']
}
const roles = Object.keys(allRoles)
const roleRights = new Map(Object.entries(allRoles))

export { roles, roleRights }

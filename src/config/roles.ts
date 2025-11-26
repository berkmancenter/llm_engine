const allRoles = {
  user: [
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
    'getConversation',
    'allTopics',
    'publicConversations',
    'topicConversations',
    'deleteConversation',
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
  ],
  admin: ['getUsers', 'manageUsers']
}
const roles = Object.keys(allRoles)
const roleRights = new Map(Object.entries(allRoles))

export { roles, roleRights }

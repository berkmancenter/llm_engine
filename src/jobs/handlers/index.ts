import agentHandlers from './agent.js'
import conversationHandlers from './conversation.js'
import resourceHandlers from './resource.js'
import topicHandlers from './topic.js'
import transcriptHandlers from './transcript.js'

const JobHandlers = {
  // Agent handlers
  agentResponse: agentHandlers.agentResponse,
  periodicAgent: agentHandlers.periodicAgent,

  // Conversation handlers
  autoStartConversation: conversationHandlers.autoStartConversation,
  autoStopConversation: conversationHandlers.autoStopConversation,

  // Resource handlers
  summarizePdf: resourceHandlers.summarizePdf,

  // Transcript handlers
  batchTranscript: transcriptHandlers.batchTranscript,
  cleanUpTranscripts: transcriptHandlers.cleanUpTranscripts,

  // Topic handlers
  cleanUpTopics: topicHandlers.cleanUpTopics
}

export default JobHandlers

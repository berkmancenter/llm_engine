import agentHandlers from './agent.js'
import topicHandlers from './topic.js'
import transcriptHandlers from './transcript.js'

const JobHandlers = {
  // Agent handlers
  agentResponse: agentHandlers.agentResponse,
  agentIntroduction: agentHandlers.agentIntroduction,
  periodicAgent: agentHandlers.periodicAgent,

  // Transcript handlers
  batchTranscript: transcriptHandlers.batchTranscript,
  cleanUpTranscripts: transcriptHandlers.cleanUpTranscripts,

  // Topic handlers
  cleanUpTopics: topicHandlers.cleanUpTopics
}

export default JobHandlers

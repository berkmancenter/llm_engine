import mongoose from 'mongoose'

import responseFormatSchemas from '../../helpers/responseFormatSchemas.js'
import verify from '../../helpers/verify.js'
import { formatConversationHistory } from '../../helpers/llmInputFormatters.js'
import { getRAGAugmentedResponse } from '../../helpers/llmChain.js'
import logger from '../../../config/logger.js'
import { defaultLLMTemplates, llmTemplateVars, discussionQuestions, displayNames } from './prompts.js'
import addCitations from '../../helpers/addCitations.js'
import saveMessage from '../../helpers/saveMessage.js'
import getConversationHistory from '../../helpers/getConversationHistory.js'

// agentConfig property should be an an object with these properties
// discussionQuestions: String Array // questions the moderator should pose, optional if no questions
// discussionGroups: String Array of Arrays // the subgroupings of experts that should discuss together
// responsesPerQuestion: Number // # of responses for each question
// expertRAGFiles: String Array, // rag document filenames the expert can consult

const MODERATOR_NAME = 'Moderator'

async function getExpertResponse(question, expertName) {
  if (!this.llmTemplateVars[expertName]) throw new Error(`No known expert ${expertName}`)
  const convHistory = formatConversationHistory(
    getConversationHistory(this.conversation.messages, { count: this.agentConfig.convHistorySize })
  )
  const topic = this.conversationName
  const moderatorName = MODERATOR_NAME
  const llm = await this.getLLM()
  return getRAGAugmentedResponse(
    llm,
    this.ragCollectionName,
    this.llmTemplates[expertName],
    { convHistory, topic, question, moderatorName },
    this.agentConfig.expertRAGFiles,
    responseFormatSchemas.citedAnswer
  )
}

export default verify({
  name: 'Expert Discussion Agent',
  description: 'An agent for managing several experts exploring a topic',
  priority: 20,
  maxTokens: 2000,
  defaultTriggers: undefined,
  agentConfig: {
    expertRAGFiles: [
      'reading-1.pdf',
      'reading-2.pdf',
      'reading-3.pdf',
      'reading-4.pdf',
      'reading-5.pdf',
      'reading-6.pdf',
      'reading-7.pdf'
    ],
    discussionQuestions,
    // let each go first once
    discussionGroups: [
      ['skeptic', 'accelerationist'],
      ['accelerationist', 'safetyist'],
      ['safetyist', 'skeptic']
    ],
    responsesPerQuestion: 10,
    convHistorySize: 100
  },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  defaultLLMModelOptions: {
    temperature: 1.2
  },
  ragCollectionName: 'ai-triangle',
  instanceNameFn() {
    return 'Expert Discussion'
  },
  // every delegate needs its own _id
  preValidate() {
    for (const delegate of this.agentConfig?.delegates || []) {
      if (!delegate._id) delegate._id = new mongoose.Types.ObjectId()
    }
  },
  async initialize() {
    return true
  },
  async start() {
    await saveMessage.call(
      this,
      {
        body: `Welcome to our discussion on "${this.conversationName}."`
      },
      this.instanceName,
      false
    )
  },
  async respond() {
    const agentConfig = this.agentConfig || {}
    const responsesPerQuestion = agentConfig.responsesPerQuestion || 2
    const questions = agentConfig.discussionQuestions || []
    const discussionGroups = agentConfig.discussionGroups || []

    for (const [questionNum, question] of questions.entries()) {
      logger.info(
        `Discussion question ${questionNum + 1} of ${discussionQuestions.length} for conversation ${this.conversation._id}`
      )
      // Add temp signal to FE that a discussion phase has started
      await saveMessage.call(this, { body: 'Round Started' })
      await saveMessage.call(this, { body: question }, MODERATOR_NAME)
      logger.debug(`Question ${questionNum}: ${question}`)

      for (const [groupNum, group] of discussionGroups.entries()) {
        logger.info(
          `Discussion group ${groupNum + 1} of ${discussionGroups.length} for question ${questionNum} for conversation ${
            this.conversation._id
          }`
        )
        await saveMessage.call(
          this,
          { body: `Participants ${group.map((e) => displayNames[e]).join(' & ')} please discuss.` },
          MODERATOR_NAME
        )
        for (let responseNum = 0; responseNum < responsesPerQuestion; responseNum++) {
          // cycle through experts
          const expertName = group[responseNum % group.length]

          const expertResponse = await getExpertResponse.call(this, question, expertName)
          const { answer, citations, retrievedDocs } = expertResponse

          const expertAnswer = await addCitations.call(this, answer, citations, retrievedDocs)
          logger.info(`Answer from ${expertName}: ${expertAnswer}`)
          await saveMessage.call(this, { body: expertAnswer }, displayNames[expertName])
        }
      }

      await saveMessage.call(this, { body: 'Round Ended' })
    }

    return []
  },
  async stop() {
    return true
  }
})

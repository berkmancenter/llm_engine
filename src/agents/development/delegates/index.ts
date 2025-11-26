import mongoose from 'mongoose'
import responseFormatSchemas from '../../helpers/responseFormatSchemas.js'
import verify from '../../helpers/verify.js'
import { formatConversationHistory, formatConversationPhases } from '../../helpers/llmInputFormatters.js'
import voteOnConversationPhase from './voteOnConversationPhases.js'
import { getSinglePromptResponse, getRAGAugmentedResponse } from '../../helpers/llmChain.js'
import logger from '../../../config/logger.js'
import websocketGateway from '../../../websockets/websocketGateway.js'
import { defaultLLMTemplates, llmTemplateVars } from './prompts.js'
import addCitations from '../../helpers/addCitations.js'
import saveMessage from '../../helpers/saveMessage.js'
import { IMessage } from '../../../types/index.types.js'
import { Delegate } from './delegates.types.js'
import getConversationHistory from '../../helpers/getConversationHistory.js'

// agentConfig property should be an an object with these properties
// delegates: an array of multiple delegates with these properties
//   personality: String
//   interest: String, // question prompt
//   pseudonym: String // what the human wants the bot to be called
// discussionQuestions: String Array // questions the moderator should pose, optional if no questions
// participantsPerRound: Number // how many participants should contribute to the discussion of each question
// expertRAGFiles: String Array, // rag document filenames the expert can consult
// delegateRAGFiles: String Array // rag document filenames the delegates can consult

// give moderator access to more conversation history

async function getContributionResponse(delegate, question) {
  const convHistory = formatConversationHistory(
    getConversationHistory(this.conversation.messages, { count: this.agentConfig.delegateConvHistorySize })
  )
  const topic = this.conversationName
  const { personality, interest, pseudonym } = delegate
  const moderatorName = this.instanceName
  const llm = await this.getLLM()

  return getRAGAugmentedResponse(
    llm,
    this.ragCollectionName,
    this.llmTemplates.delegate,
    {
      convHistory,
      topic,
      personality,
      interest,
      question,
      pseudonym,
      moderatorName
    },
    this.agentConfig.delegateRAGFiles
  )
}

async function getExpertResponse(question) {
  const convHistory = formatConversationHistory(
    getConversationHistory(this.conversation.messages, { count: this.agentConfig.expertConvHistorySize })
  )
  const topic = this.conversationName
  const llm = await this.getLLM()
  return getRAGAugmentedResponse(
    llm,
    this.ragCollectionName,
    this.llmTemplates.expert,
    { convHistory, topic, question },
    this.agentConfig.expertRAGFiles,
    responseFormatSchemas.citedAnswer
  )
}

async function getModeratorResponse(participantList, roundsLeft) {
  const convHistory = formatConversationHistory(
    getConversationHistory(this.conversation.messages, { count: this.agentConfig.expertConvHistorySize })
  )
  const topic = this.conversationName
  const llm = await this.getLLM()

  return getSinglePromptResponse(llm, this.llmTemplates.moderator, {
    convHistory,
    topic,
    roundsLeft,
    participantList
  })
}

function getParticipantList(availableDelegates) {
  let list = ''
  for (const delegateIndex of availableDelegates) {
    const delegate = this.delegates[delegateIndex]
    list += `${delegate.pseudonym || 'N/A'}\n`
  }

  return list
}

function getRandomDelegate(availableDelegates, usedDelegatesInRound = []) {
  // If no available delegates, pick from any delegate not used in current round
  if (availableDelegates.length === 0) {
    const unusedDelegates = this.delegates.filter(
      (delegate) => !usedDelegatesInRound.some((usedDelegate) => usedDelegate === delegate)
    )
    // If all delegates have been used in this round, pick any random delegate
    if (unusedDelegates.length === 0) {
      return this.delegates[Math.floor(Math.random() * this.delegates.length)]
    }
    return unusedDelegates[Math.floor(Math.random() * unusedDelegates.length)]
  }

  const validIndices = availableDelegates.filter(
    (index) => !usedDelegatesInRound.some((usedDelegate) => usedDelegate === this.delegates[index])
  )
  // If all available delegates have been used in this round, fall back to any unused delegate
  if (validIndices.length === 0) {
    return getRandomDelegate.call(this, [], usedDelegatesInRound)
  }
  const randomIndex = Math.floor(Math.random() * validIndices.length)
  const delegateIndex = validIndices[randomIndex]
  // Remove the chosen delegate index from availableDelegates
  const originalIndex = availableDelegates.indexOf(delegateIndex)
  availableDelegates.splice(originalIndex, 1)
  return this.delegates[delegateIndex]
}

async function getNextParticipant(currentRound, availableDelegates, usedDelegatesInRound = [], useModerator = false) {
  const roundsLeft = this.rounds - currentRound

  let delegate
  if (useModerator) {
    // Filter participant list to exclude used delegates
    const participantList = getParticipantList.call(this, availableDelegates, usedDelegatesInRound)
    const moderatorResponse = await getModeratorResponse.call(this, participantList, roundsLeft)
    delegate = this.delegates.find((d) => d.pseudonym === moderatorResponse)
    if (!delegate) logger.warn(`Moderator did not pick a real delegate: ${moderatorResponse}`)
  }
  if (!delegate) {
    delegate = getRandomDelegate.call(this, availableDelegates, usedDelegatesInRound)
  }

  return delegate
}

async function evaluateConversation(phasedHistory) {
  const questionMessages = phasedHistory.map((phase) => phase.question) || []
  const chunks = formatConversationPhases(phasedHistory)
  const votes: { voter: string; winner: { chunk: number; reason: string } }[] = []
  const llm = await this.getLLM()

  await Promise.all(
    this.delegates.map(async (d) => {
      const winners = await voteOnConversationPhase(llm, this.conversationName, d, this.llmTemplates.voting, chunks)
      votes.push({ voter: d.pseudonym, winner: winners[0] })
    })
  )
  // Expert/Moderator votes
  const expertVotes = await voteOnConversationPhase(
    llm,
    this.conversationName,
    {
      pseudonym: this.instanceName,
      interest: 'N/A',
      personality: 'You are a scholar who is an expert on the topic of this conversation'
    },
    this.llmTemplates.voting,
    chunks,
    3
  )
  for (const expertVote of expertVotes) {
    votes.push({ voter: this.instanceName, winner: expertVote })
  }

  // Sequentially update messages with upvotes
  for (const vote of votes) {
    const winningQuestion = questionMessages[vote.winner.chunk - 1]
    if (winningQuestion) {
      winningQuestion.upVotes.push({ pseudonym: vote.voter, reason: vote.winner.reason })
      await winningQuestion.save()
      websocketGateway.broadcastNewVote(winningQuestion)
    }
  }
}

async function moderatorWrapup() {
  // TODO could ask LLM to summarize, etc instead
  await saveMessage.call(this, { body: 'Thanks for a great discussion folks!' })
}

export default verify({
  name: 'Delegates Expert Discussion Agent',
  description:
    'An agent for managing multiple delegate bots for humans, to participate in a discussion with an expert on their behalf',
  priority: 20,
  maxTokens: 2000,
  defaultTriggers: undefined,
  agentConfig: {
    expertRAGFiles: ['the_line.pdf', 'foucault_in_cyberspace.pdf', 'the_public_domain.pdf'],
    delegateRAGFiles: ['the_line.pdf'],
    delegates: [],
    discussionQuestions: undefined,
    participantsPerRound: 2,
    expertConvHistorySize: 100,
    delegateConvHistorySize: 10
  },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  defaultLLMModelOptions: {
    temperature: 1.0
  },
  ragCollectionName: 'boyle',

  instanceNameFn() {
    return 'Boyle Book Bot'
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
    this.delegates = agentConfig.delegates || []

    const delegatesWithQuestions = this.delegates
      .filter((delegate) => delegate.question)
      .sort((a, b) => a.question.localeCompare(b.question))

    const availableDelegatesForCommentary = [...Array(this.delegates.length).keys()]

    const participantsPerRound = agentConfig.participantsPerRound || []
    this.rounds = delegatesWithQuestions.length

    const phasedHistory: { question: IMessage; conversation: Array<IMessage> }[] = []

    for (let round = 0; round < this.rounds; round++) {
      const roundMessages: Array<IMessage> = []
      logger.info(`Delegate discussion round ${round + 1} of ${this.rounds} for conversation ${this.conversation._id}`)
      // Add temp signal to FE that a discussion phase has started
      await saveMessage.call(this, { body: 'Round Started' })
      const delegate = delegatesWithQuestions[round]
      const discussionQuestion = delegate.question

      // Save delegate question as a message
      const questionMessage = await saveMessage.call(this, { body: `${discussionQuestion}` }, delegate.pseudonym)
      logger.debug(`Question from delegate ${delegate.pseudonym}: ${discussionQuestion}`)

      // Expert responds
      const expertResponse = await getExpertResponse.call(this, discussionQuestion)
      const { answer, questionPosed, citations, retrievedDocs } = expertResponse

      const expertAnswer = await addCitations.call(this, answer, citations, retrievedDocs)
      logger.debug(`Answer from ${this.instanceName}: ${expertAnswer}`)
      const expertAnswerMessage = await saveMessage.call(this, { body: expertAnswer })
      roundMessages.push(expertAnswerMessage)

      const expertQuestionMessage = await saveMessage.call(this, { body: questionPosed })
      logger.debug(`Question from ${this.instanceName}: ${questionPosed}`)
      roundMessages.push(expertQuestionMessage)

      // Now finish off round with unmoderated commentary
      // TODO could ask moderator to pick these participants, intervene in some way, etc

      const usedDelegates: Array<Delegate> = []
      for (let i = 1; i <= participantsPerRound; i++) {
        const delegate2 = await getNextParticipant.call(this, round, availableDelegatesForCommentary, usedDelegates)
        usedDelegates.push(delegate2)
        const response = await getContributionResponse.call(this, delegate2, questionPosed)
        logger.debug(`Contribution from ${delegate2.pseudonym}: ${response}`)
        const contributionMessage = await saveMessage.call(this, { body: response }, delegate2.pseudonym)
        roundMessages.push(contributionMessage)
      }
      // Add temp signal to FE that a discussion phase has ended
      await saveMessage.call(this, { body: 'Round Ended' })
      phasedHistory.push({ question: questionMessage, conversation: roundMessages })
    }

    await moderatorWrapup.call(this)
    await evaluateConversation.call(this, phasedHistory)
    return []
  },
  async stop() {
    return true
  }
})

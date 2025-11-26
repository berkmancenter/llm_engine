import { RunnableSequence } from '@langchain/core/runnables'
import { PromptTemplate } from '@langchain/core/prompts'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import verify from '../helpers/verify.js'
import { formatMessages } from '../helpers/llmInputFormatters.js'
import { getSinglePromptResponse } from '../helpers/llmChain.js'
import Message from '../../models/message.model.js'
import saveMessage from '../helpers/saveMessage.js'

const defaultLLMTemplates = {
  summarization: `You are a facilitator of an online deliberation on the given discussion topic.
You will receive the most recent comments on the topic.
In each line of the most recent comments, I provide you with a participant's handle name, followed by a ":" and then the participants's comment on the given discussion topic.
You will also receive summaries of the conversation that occurred prior to these most recent comments.
Please generate a summary of the deliberation thus far. Do not summarize the comments one at a time.
Instead write a well-written, highly coherent, and all encompassing summary.
In the summary, make sure to include information and quantification on how much agreement versus disagreement there was among participants.
Exclude off-topic comments from your analysis.
Deliberation topic: {topic}
Comments: {convHistory}
Summaries: {summaries}
Answer:`,
  consensus: `Given the following summary of various comments from a deliberation platform, generate one original comment that is likely to get consensus.
I am including your prior consensus proposals. Make sure your original comment is unique from these prior proposals.
Present your comment to the group for discussion along with a more concise summary of the discussion thus far.
Limit your summary and comment to three sentences. Use a conversational tone. Present the summary first. Do not identify the summary and comment with labels.
Summary: {summary}
Prior Consensus Proposals: {proposals}
Answer: `,
  chat: `You are a facilitator of an online deliberation on the given discussion topic.
You will receive the most recent comments on the topic.
In each line of the most recent comments, I provide you with a participant's handle name, followed by a ":" and then the participants's comment on the given discussion topic.
You are the participant known as 'AI'.
You will also receive summaries of the conversation that occurred prior to these most recent comments.
A participant has asked you the given Participant Question, addressing you as '@"Reflection Agent".'
The question starts with participants's username followed by ":" and then the participant's question.
Do your best to answer the question, but only if it broadly concerns the discussion topic, a topic you raised in the conversation history, or guidelines for healthy civil deliberation.
Othwerise, respond with a polite reminder that you can only answer questions about the discussion topic or deliberation procedure.
Be concise and limit your answer to three sentences.
Respond to the participant by their username (all text before the : character), prefaced with the @ symbol.
Deliberation topic: {topic}
Comments: {convHistory}
Summaries: {summaries}
Participant Question: {question}
Answer:`
}

const llmTemplateVars = {
  summarization: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'convHistory', description: 'The recent history of the conversation' },
    { name: 'summaries', description: 'Previous summaries of the conversation' }
  ],
  consensus: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'summary', description: 'The summary of the conversation' },
    { name: 'proposals', description: 'Prior proposals' }
  ],
  chat: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'convHistory', description: 'The recent history of the conversation' },
    { name: 'summaries', description: 'Previous summaries of the conversation' },
    { name: 'question', description: "The participant's question" }
  ]
}

const minMessagesForSummary = 7

export default verify({
  name: 'Reflection Agent',
  description: 'A deliberation facilitator that reflects arguments and builds consensus',
  priority: 20,
  maxTokens: 2000,
  defaultTriggers: { perMessage: {}, periodic: { timerPeriod: 300 } },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  defaultConversationHistorySettings: { count: 10 },
  ragCollectionName: undefined,
  async initialize() {
    return true
  },
  async start() {
    await saveMessage.call(
      this,
      {
        body: `Welcome to the conversation! I am your automated facilitator. You can ask me questions about the discussion topic or tips for healthy discourse by using @"Reflection Agent" in your message. I will also chime in occasionally with my perspective on the discussion and some proposals for reaching consensus.`
      },
      this.instanceName,
      false
    )
  },
  async stop() {
    return true
  },
  async evaluate(userMessage) {
    let action = AgentMessageActions.OK

    if (userMessage?.body.includes(`@"${this.name}"`)) {
      // direct message - always respond
      action = AgentMessageActions.CONTRIBUTE
    } else {
      // find the last summarization (invisible agent message)
      const lastInvisibleIndex = this.conversation.messages.findLastIndex(
        (msg) => !msg.visible && msg.owner._id.equals(this._id)
      )
      // calculate the number of messages received since last summarization
      const countSinceSummary =
        lastInvisibleIndex === -1
          ? this.conversation.messages.filter((msg) => !msg.owner._id.equals(this._id)).length
          : this.conversation.messages.slice(lastInvisibleIndex).filter((msg) => !msg.owner._id.equals(this._id)).length

      if (!userMessage && countSinceSummary > 3) {
        // periodic invocation - there have been at least four new messages
        action = AgentMessageActions.CONTRIBUTE
      } else if (userMessage && countSinceSummary + 1 >= minMessagesForSummary) {
        action = AgentMessageActions.CONTRIBUTE
      }
    }

    return {
      userMessage,
      action,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage?) {
    let llmResponse
    let pause = 0

    const llm = await this.getLLM()

    const summaryMessages = this.conversation.messages.filter((msg) => msg.fromAgent && !msg.visible)
    const summaries = summaryMessages.map((message) => `Summary: ${message.body}`)

    if (userMessage?.body.includes(`@"${this.name}"`)) {
      const msgs = conversationHistory.messages.filter((msg) => msg.visible)
      const convHistory = formatMessages(msgs).join('\n')
      llmResponse = await getSinglePromptResponse(llm, this.llmTemplates.chat, {
        convHistory,
        summaries,
        topic: this.conversation.name,
        question: `${userMessage.pseudonym}: ${userMessage.body}`
      })
    } else {
      pause = 30
      const msgs = conversationHistory.messages.filter((msg) => !msg.fromAgent)
      const convHistory = formatMessages(msgs).join('\n')
      const summarizationPrompt = PromptTemplate.fromTemplate(this.llmTemplates.summarization)
      const summarizationChain = summarizationPrompt.pipe(llm).pipe(new StringOutputParser())
      const consensusPrompt = PromptTemplate.fromTemplate(this.llmTemplates.consensus)

      // Store detailed summaries as invisible agent messages to use for context in future analysis
      const storeSummary = async (summary) => {
        const agentMessage = new Message({
          fromAgent: true,
          visible: false,
          body: summary,
          conversation: this.conversation._id,
          pseudonym: this.name,
          pseudonymId: this.pseudonyms[0]._id,
          owner: this._id
        })

        agentMessage.save()
        this.conversation.messages.push(agentMessage.toObject())

        // TODO this includes prior summarization as well. May need to separate those two to limit tokens
        const proposals = this.conversation.messages.filter((msg) => msg.fromAgent && msg.visible)
        return {
          summary,
          proposals
        }
      }

      const chain = RunnableSequence.from([
        summarizationChain,
        (input) => storeSummary(input),
        consensusPrompt,
        llm,
        new StringOutputParser()
      ])
      llmResponse = await chain.invoke({ topic: this.conversation.name, convHistory, summaries })
    }

    const agentResponse = {
      visible: true,
      message: llmResponse,
      pause
    }

    return [agentResponse]
  }
})

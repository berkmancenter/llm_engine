import type { ApiProvider, ProviderOptions, ProviderResponse, CallApiContextParams } from 'promptfoo'
import mongoose from 'mongoose'
import config from '../../src/config/config.js'
import {
  createEventAssistantConversation,
  createMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript
} from './agentTestHelpers.js'

export default class PromptfooProvider implements ApiProvider {
  protected providerId: string

  public config

  protected agent

  protected user

  protected conversation

  private _initialized = false

  constructor(options: ProviderOptions) {
    this.providerId = options.id || 'typed-provider'
    this.config = options.config || {}
  }

  id(): string {
    return this.providerId
  }

  private async _initialize(): Promise<void> {
    if (this._initialized) {
      return
    }
    await mongoose.connect(config.mongoose.url, config.mongoose.options)
    const startTime = new Date(Date.now() - 15 * 60 * 1000) // The whole event started 15 minutes ago
    this.user = await createUser('Boring Badger')
    const topic = await createPublicTopic()
    this.conversation = await createEventAssistantConversation(
      { name: 'Why your company should consider part-time work' },
      this.user,
      topic,
      startTime,
      process.env.TEST_LLM_PLATFORM,
      process.env.TEST_LLM_MODEL
    )
    await loadPartTimeWorkTranscript(this.conversation, true)
    const [agent] = this.conversation.agents
    this.agent = agent
    agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + 954 * 1000),
      count: 100,
      directMessages: true
    } // simulate running at end of transcript
    await agent.save()
    this._initialized = true
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async callApi(prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    await this._initialize()
    const msg = await createMessage(prompt, this.user, this.conversation)
    let output
    let error
    try {
      const responses = await this.agent.respond(msg)
      output = responses[0].body
    } catch (err) {
      error = err
    }
    return {
      output,
      error
    }
  }
}

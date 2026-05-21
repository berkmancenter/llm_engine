import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { mintHandoffToken } from '../../services/handoffToken.service.js'
import config from '../../config/config.js'

const SETUP_INTENT_PATTERNS = [/\bsetup\b/i, /\bcreate event\b/i, /\bcreate an? event\b/i, /\bnew event\b/i]

export default verify({
  name: 'Event Setup',
  description: 'Collects event details from organizers via Slack and creates a new nextspace event',
  priority: 100,
  maxTokens: 4000,
  defaultTriggers: {
    perMessage: { channels: ['setup'] }
  },
  agentConfig: {
    botName: 'Event Setup Bot'
  },
  llmTemplateVars: {},
  defaultLLMTemplates: {},
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 50, channels: ['setup'] },

  async evaluate(userMessage) {
    const body = userMessage?.body ?? ''
    const hasBotMention = body.toLowerCase().includes(`@${this.agentConfig.botName}`.toLowerCase())
    const hasSetupIntent = SETUP_INTENT_PATTERNS.some((pattern) => pattern.test(body))

    if (hasBotMention || hasSetupIntent) {
      return {
        userMessage,
        action: AgentMessageActions.CONTRIBUTE,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    return {
      userMessage,
      action: AgentMessageActions.OK,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(_conversationHistory: ConversationHistory, userMessage) {
    const setupChannel = this.conversation.channels.find((channel) => channel.name === 'setup')
    /* If the organizer's message is already a reply in an existing thread,
       keep our response in that same thread. Otherwise use the organizer's
       own message as the parent so the Slack adapter starts a new thread
       under it; without this our reply would land in the main channel
       instead of threading under what the user typed. */
    const parentMessageId = userMessage.parentMessage || userMessage._id

    /* The handoff token has to carry enough Slack context that the form
       can post back into the right thread later. The Slack adapter packs
       that context across the userMessage like this:
         user.username  = `${teamId}-${userId}`  (no dashes in either ID)
         channels[0].name = Slack channel ID
         source.id      = timestamp of the originating message (the thread)
       If any of those are missing we are not actually being invoked from
       Slack — most likely a test message routed through this agent by a
       different adapter — and signing a token with empty Slack fields
       would just produce a broken link. In that case we drop the token
       and send the bare URL instead. */
    const username = userMessage.user?.username ?? ''
    const dashIndex = username.indexOf('-')
    const slackChannelId = userMessage.channels?.[0]?.name ?? ''
    const slackThreadTs = userMessage.source?.id ?? ''
    const hasFullSlackContext =
      userMessage.source?.type === 'slack' && dashIndex > 0 && slackChannelId !== '' && slackThreadTs !== ''

    let message: string
    if (hasFullSlackContext) {
      const slackTeamId = username.slice(0, dashIndex)
      const slackUserId = username.slice(dashIndex + 1)
      const token = mintHandoffToken({ slackUserId, slackTeamId, slackChannelId, slackThreadTs })
      /* The token is placed in the URL fragment (after #) rather than the
         query string (after ?) on purpose. Browsers do not send URL
         fragments to servers, so the Nextspace server never sees the
         token in its access logs and the token cannot leak via Referer
         headers on third-party resources the form page might load. The
         frontend reads the token from window.location.hash on the client
         side. */
      const url = `${config.appHost}/events/new#token=${encodeURIComponent(token)}`
      message = `Let's set up your event! Open the form here: ${url}`
    } else {
      /* Reached when Slack context is missing or partial — see the guard
         above. The organizer still gets a working link to the event form,
         they just have to authenticate themselves on the Nextspace side
         instead of arriving pre-identified from Slack. */
      message = `Let's set up your event! Open Nextspace to continue: ${config.appHost}/events/new`
    }

    return [
      {
        visible: true,
        message,
        messageType: 'text',
        channels: setupChannel ? [setupChannel] : [],
        parent: parentMessageId
      }
    ]
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  formatTraceInput(_conversationHistory, userMessage) {
    return userMessage?.body
  },

  formatTraceOutput(responses) {
    return responses[0]?.message
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      conversationHistory,
      channels: userMessage?.channels,
      topic: responses[0]?.topic
    }
  }
})

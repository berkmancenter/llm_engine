import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform, getModelChat } from '../helpers/getModelChat.js'
import { mintSlackHandoffToken } from '../../adapters/slack/handoff.js'
import { checkEventSetupIntent } from './intentCheck.js'
import config from '../../config/config.js'

/*
 * Builds the Slack Block Kit payload for the event setup reply.
 *
 * Exported as a pure function so it can be unit-tested without needing to
 * invoke the full respond() pipeline (which requires a live LLM for the
 * intent check). Called from respond() when full Slack context is available.
 *
 * The url is expected to contain the handoff token in the URL fragment
 * (e.g. /events/new#token=...) — see respond() for why fragment over query
 * string.
 */
export function buildEventSetupBlocks(slackUserId: string, url: string): object[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        /* <@USER_ID> is Slack's mrkdwn syntax for a user mention — Slack
           renders it as the person's display name with a highlight. */
        text: `Hey <@${slackUserId}>! I can help with that in Nextspace. Click the button below and we can get your event set up.`
      }
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: "Let's Go", emoji: false },
          url,
          /* action_id lets the slackInteraction handler route button-click
             events back to this agent if we need to handle them later. */
          action_id: 'open_event_setup_form'
        }
      ]
    }
  ]
}

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

  /* Channel-level filtering happens upstream in AgentEvaluationService
     (only messages on the 'setup' channel reach this agent), so we mark
     every message in that channel as a contribution and defer the actual
     "should the bot respond?" decision to checkEventSetupIntent inside
     respond(). This matches the pattern used by chatbot and
     eventHistorian. */
  async evaluate(userMessage) {
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(
    _conversationHistory: ConversationHistory,
    userMessage,
    /* Optional seam for testing: pass a stub to skip the LLM call.
       Production code omits this argument and gets the real intent check. */
    _checkIntent: (llm: unknown, botName: string, msg: unknown) => Promise<boolean> = checkEventSetupIntent
  ) {
    /* Ask the LLM whether the user's message is actually a request to
       set up an event. If not (casual chatter, off-topic, generic
       greetings), bail out without posting the link. */
    const llm = await getModelChat(config.classificationLLMPlatform, config.classificationLLMModel)
    const isSetupIntent = await _checkIntent(llm, this.agentConfig.botName, userMessage)
    if (!isSetupIntent) return []

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
       and fall back to the bare URL. */
    /* Read Slack identity from source — that's the only field that survives
       DB round-trip. The adapter stores userId/teamId/channelId there so they
       are available here even after the message is persisted and reloaded. */
    const slackUserId = (userMessage.source?.userId as string) ?? ''
    const slackTeamId = (userMessage.source?.teamId as string) ?? ''
    const slackChannelId = (userMessage.source?.channelId as string) ?? ''
    const slackThreadTs = (userMessage.source?.id as string) ?? ''
    const hasFullSlackContext =
      userMessage.source?.type === 'slack' &&
      slackUserId !== '' &&
      slackTeamId !== '' &&
      slackChannelId !== '' &&
      slackThreadTs !== ''

    if (hasFullSlackContext) {
      const token = mintSlackHandoffToken({ slackUserId, slackTeamId, slackChannelId, slackThreadTs })
      /* The token goes in the URL fragment (after #) rather than the query
         string (after ?). Browsers never send fragments to the server, so
         the Nextspace server never sees the token in its access logs and the
         token can't leak via the Referer header. The frontend reads it from
         window.location.hash on the client side. */
      const url = `${config.appHost}/events/new#token=${encodeURIComponent(token)}`
      /* The blocks array is the interactive Block Kit UI (section + button).
         The message field is plain-text fallback for push notifications and
         screen readers; Slack requires it whenever blocks are present.
         We use the base URL without the token here so the token doesn't end
         up in push notifications, the DB transcript, or Slack's message
         history. The token only needs to live in the button URL. */
      return [
        {
          visible: true,
          message: `Let's set up your event! Open Nextspace: ${config.appHost}/events/new`,
          messageType: 'text',
          channels: setupChannel ? [setupChannel] : [],
          parent: parentMessageId,
          blocks: buildEventSetupBlocks(slackUserId, url)
        }
      ]
    }

    /* Reached when Slack context is missing or partial — see the guard above.
       The organizer still gets a link to the event form; they just have to
       authenticate on the Nextspace side instead of arriving pre-identified
       from Slack. No Block Kit blocks here since we're not on Slack. */
    return [
      {
        visible: true,
        message: `Let's set up your event! Open Nextspace to continue: ${config.appHost}/events/new`,
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

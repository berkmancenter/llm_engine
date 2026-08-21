import { supportedModels } from '../agents/helpers/getModelChat.js'
import { ConversationType, Direction } from '../types/index.types.js'
import config from '../config/config.js'

const slackCommunityAssistant: ConversationType = {
  name: 'slackCommunityAssistant',
  label: 'Community Assistant',
  description:
    'An AI assistant specialized in answering questions about past events and their transcripts, accessible via a shared Slack channel',
  platforms: [{ name: 'slack', label: 'Slack' }],
  properties: [
    {
      name: 'slackChannel',
      label: 'Slack Channel ID',
      description: 'The ID of the Slack Channel the chatbot participates in (starts with C- or G-)',
      required: true,
      type: 'string'
    },
    {
      name: 'slackWorkspace',
      label: 'Slack Workspace ID',
      description: 'The Slack workspace (team) ID (starts with T-)',
      required: true,
      type: 'string'
    },
    {
      name: 'slackBotToken',
      label: 'Slack Bot Token',
      description: 'The Bot User OAuth token for the Slack app (starts with xoxb-)',
      required: true,
      type: 'string'
    },
    {
      name: 'slackBotUserId',
      label: 'Slack Bot User ID',
      description: 'The user ID for the bot in Slack (starts with U-), used for routing incoming messages',
      required: false,
      type: 'string'
    },
    {
      name: 'slackSigningSecret',
      label: 'Slack App Signing Secret',
      description: 'The signing secret for the Slack app. Defaults to the system-wide signing secret if not provided.',
      required: false,
      type: 'string'
    },
    {
      name: 'slackAppKey',
      label: 'Slack App Key in Webhook',
      description:
        'The app key for the Slack app, used as last part ofwebhook URL to route incoming messages to the appropriate adapter.',
      required: false,
      type: 'string'
    },
    {
      name: 'botName',
      label: 'Bot Name',
      description: 'The display name for the bot',
      required: false,
      type: 'string',
      default: config.conversationBotName
    },
    {
      name: 'llmModel',
      label: 'Model that your agents will use',
      required: false,
      type: 'enum',
      options: supportedModels,
      validationKeys: ['llmModel', 'llmPlatform']
    },
    {
      name: 'notifications',
      label: 'Notifications',
      description: 'Notification types the assistant will post. Available: event_ended. Defaults to none.',
      required: false,
      type: 'object'
    },
    {
      name: 'tools',
      label: 'Enabled Tools',
      description:
        'Tool names the assistant can use. Available: web_search, event_history, bkc_archive_wiki. Defaults to [web_search].',
      required: false,
      type: 'object'
    },
    {
      name: 'topicIds',
      label: 'Event Series IDs',
      description:
        'IDs of topic series the assistant can search (used when event_history tool is enabled). Leave empty to search all public topics.',
      required: false,
      type: 'object'
    }
  ],
  // internal
  agents: [
    {
      name: 'communityAssistant',
      properties: [
        { $ref: 'llmModel.llmModel' },
        { $ref: 'llmModel.llmPlatform' },
        { $ref: 'botName', as: 'agentConfig.botName' },
        { $ref: 'notifications', as: 'agentConfig.notifications' },
        { $ref: 'tools', as: 'agentConfig.tools' },
        { $ref: 'topicIds', as: 'agentConfig.topicIds' }
      ]
    }
  ],
  channels: [{ name: 'chat' }],
  adapters: {
    slack: {
      type: 'slack',
      config: {
        channel: '{{{properties.slackChannel}}}',
        workspace: '{{{properties.slackWorkspace}}}',
        botToken: '{{{properties.slackBotToken}}}',
        botUserId: '{{{properties.slackBotUserId}}}', // for normalizing incoming messages
        botName: '{{{properties.botName}}}',
        signingSecret: '{{{properties.slackSigningSecret}}}',
        appKey: '{{{properties.slackAppKey}}}'
      },
      chatChannels: [
        {
          name: 'chat',
          direction: Direction.BOTH
        }
      ]
    }
  }
}

export default slackCommunityAssistant

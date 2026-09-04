import { supportedModels } from '../agents/helpers/getModelChat.js'
import { AdapterChannelConfig, ConversationType, Direction } from '../types/index.types.js'
import config from '../config/config.js'

const slackCommunityAssistant: ConversationType = {
  name: 'slackCommunityAssistant',
  label: 'Community Assistant',
  description:
    'A configurable AI assistant that helps community members with questions and discussion, with access to community-specific tools such as event history and archive search, accessible via a shared Slack channel',
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
        'The app key for the Slack app, used as last part of the webhook URL to route incoming messages to the appropriate adapter.',
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
      description: 'Notification types the assistant will post. Available: event_ended. Defaults to event_ended.',
      required: false,
      type: 'object',
      default: ['event_ended']
    },
    {
      name: 'tools',
      label: 'Enabled Tools',
      description:
        'Tool names the assistant can use. Available: web_search, event_history, bkc_archive_wiki. Defaults to all.',
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
    },
    {
      name: 'agentDMs',
      label: 'Enable Agent DMs',
      description:
        'Allow users to DM the community assistant directly. Only one conversation per workspace (or per app key, if set) can have this enabled.',
      required: false,
      type: 'boolean',
      default: false
    },
    {
      name: 'periodicMemberIntros',
      label: 'Periodic Member Introductions',
      description: 'Post periodic group introductions for unintroduced members. Defaults to enabled.',
      required: false,
      type: 'boolean',
      default: true
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
        { $ref: 'topicIds', as: 'agentConfig.topicIds' },
        { $ref: 'periodicMemberIntros', as: 'agentConfig.periodicMemberIntros' }
      ]
    }
  ],
  enableDMs: ['agents'],
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
      ],
      // Handlebars conditional: resolves to the dmChannels array when agentDMs is true,
      // empty string when false. removeEmptyValues strips the empty string so the adapter
      // is created without dmChannels, bypassing the per-workspace uniqueness constraint.
      dmChannels:
        '{{#if properties.agentDMs}}[{"direct":true,"agent":"communityAssistant","direction":"both"}]{{/if}}' as unknown as AdapterChannelConfig[]
    }
  }
}

export default slackCommunityAssistant

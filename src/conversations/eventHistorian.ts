import { supportedModels } from '../agents/helpers/getModelChat.js'
import { ConversationType, Direction } from '../types/index.types.js'
import config from '../config/config.js'

const eventHistorian: ConversationType = {
  name: 'eventHistorian',
  label: 'Event Historian',
  description:
    'An AI assistant specialized in answering questions about past events and their transcripts accessible via a shared Slack channel',
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
      name: 'topicIds',
      label: 'Event Series IDs',
      description:
        'IDs of topic series the assistant can search for past event history. Leave empty to search all public topics.',
      required: false,
      type: 'object'
    }
  ],
  // internal
  agents: [
    {
      name: 'eventHistorian',
      properties: [
        { $ref: 'llmModel.llmModel' },
        { $ref: 'llmModel.llmPlatform' },
        { $ref: 'botName', as: 'agentConfig.botName' },
        { $ref: 'topicIds', as: 'agentConfig.topicIds' }
      ]
    }
  ],
  channels: [{ name: 'historian' }],
  adapters: {
    slack: {
      type: 'slack',
      config: {
        channel: '{{{properties.slackChannel}}}',
        workspace: '{{{properties.slackWorkspace}}}',
        botToken: '{{{properties.slackBotToken}}}',
        botUserId: '{{{properties.slackBotUserId}}}', // for normalizing incoming messages
        botName: '{{{properties.botName}}}'
      },
      chatChannels: [
        {
          name: 'historian',
          direction: Direction.BOTH
        }
      ]
    }
  }
}

export default eventHistorian

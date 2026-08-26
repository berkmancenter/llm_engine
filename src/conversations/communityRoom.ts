import { supportedModels } from '../agents/helpers/getModelChat.js'
import { ConversationType } from '../types/index.types.js'
import config from '../config/config.js'

const communityRoom: ConversationType = {
  name: 'communityRoom',
  label: 'Community Room',
  description:
    'A configurable AI assistant that helps community members with questions and discussion, with access to community-specific tools such as event history and archive search',
  platforms: [{ name: 'nextspace', label: 'Nextspace' }],
  properties: [
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
  enableDMs: ['agents'],
  channels: [{ name: 'chat', passcode: null }]
}

export default communityRoom

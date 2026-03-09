import { supportedModels } from '../agents/helpers/getModelChat.js'
import adapterTypes from '../adapters/config.js'
import { ConversationType, Direction } from '../types/index.types.js'
import config from '../config/config.js'

const eventAssistantPlusProactive: ConversationType = {
  // user-facing
  name: 'eventAssistantPlusProactive',
  label: 'Event Assistant Plus Proactive',
  description: 'A combination of Event Assistant and Back Channel that can proactively intervene in the main chat',
  platforms: adapterTypes,
  properties: [
    {
      name: 'zoomMeetingUrl',
      label: 'Zoom Meeting URL',
      description: 'The zoom meeting link for transcription purposes',
      required: true,
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
      label: 'Model that your agent will use',
      required: false,
      type: 'enum',
      options: supportedModels,
      validationKeys: ['llmModel', 'llmPlatform']
    },
    {
      name: 'minContributionInterval',
      label: 'Minimum number of minutes between proactive contributions to the main chat',
      required: false,
      type: 'number',
      default: 5
    }
  ],
  // internal
  agents: [
    {
      name: 'eventAssistantPlus',
      properties: {
        llmModel: '{{properties.llmModel.llmModel}}',
        llmPlatform: '{{properties.llmModel.llmPlatform}}',
        agentConfig: { botName: '{{properties.botName}}' }
      }
    },
    {
      name: 'backChannelInsights',
      properties: { llmModel: '{{properties.llmModel.llmModel}}', llmPlatform: '{{properties.llmModel.llmPlatform}}' }
    },
    {
      name: 'eventMediatorPlus',
      properties: {
        llmModel: '{{properties.llmModel.llmModel}}',
        llmPlatform: '{{properties.llmModel.llmPlatform}}',
        agentConfig: { minInterval: '{{properties.minContributionInterval}}', personality: 'sarcastic-expert' }
      }
    },
    {
      name: 'engagementAgent',
      properties: {
        llmModel: '{{properties.llmModel.llmModel}}',
        llmPlatform: '{{properties.llmModel.llmPlatform}}',
        agentConfig: { minInterval: '{{properties.minContributionInterval}}', personality: 'sarcastic-expert' }
      }
    }
  ],
  enableDMs: ['agents'],
  channels: [
    { name: 'transcript' },
    { name: 'participant' },
    { name: 'moderator' },
    { name: 'chat' },
    { name: 'image-gen' }
  ],
  adapters: {
    zoom: {
      type: 'zoom',
      config: {
        meetingUrl: '{{{properties.zoomMeetingUrl}}}',
        botName: '{{properties.botName}}'
      },
      dmChannels: [
        {
          direct: true,
          agent: 'eventAssistantPlus',
          direction: Direction.BOTH
        }
      ],

      chatChannels: [
        {
          name: 'moderator',
          direction: Direction.OUTGOING
        },
        {
          name: 'chat',
          direction: Direction.BOTH
        }
      ],
      audioChannels: [
        {
          name: 'transcript',
          direction: Direction.INCOMING
        }
      ]
    },
    default: {
      // Zoom transcription only - assume DMs are coming through web or websocket APIs
      type: 'zoom',
      config: {
        meetingUrl: '{{{properties.zoomMeetingUrl}}}',
        botName: '{{properties.botName}}'
      },
      audioChannels: [
        {
          name: 'transcript',
          direction: Direction.INCOMING
        }
      ]
    }
  }
}
export default eventAssistantPlusProactive

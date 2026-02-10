import { supportedModels } from '../agents/helpers/getModelChat.js'
import { interventionCategories } from '../agents/eventAssistant/interventionCategories.js'
import adapterTypes from '../adapters/config.js'
import { ConversationType, Direction } from '../types/index.types.js'

const eventAssistantPlus: ConversationType = {
  // user-facing
  name: 'eventAssistantPlus',
  label: 'Event Assistant Plus',
  description: 'A combination of Event Assistant and Back Channel',
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
      label: 'Zoom Bot Name',
      description: 'The display name for the bot as it will appear in Zoom',
      required: false,
      type: 'string',
      default: 'Event Assistant Plus'
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
      name: 'interventionCategories',
      label: 'Intervention Categories',
      description: 'Configure which intervention types the mediator can use and their priorities',
      required: false,
      type: 'object',
      schema: interventionCategories,
      itemKey: 'name'
    }
  ],
  // internal
  agents: [
    {
      name: 'eventAssistantPlus',
      properties: { llmModel: '{{properties.llmModel.llmModel}}', llmPlatform: '{{properties.llmModel.llmPlatform}}' }
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
        agentConfig: {
          interventionCategories: {
            collectiveConsciousness: {
              enabled: '{{properties.interventionCategories.collectiveConsciousness.enabled}}',
              weight: '{{properties.interventionCategories.collectiveConsciousness.weight}}'
            },
            engagement: {
              enabled: '{{properties.interventionCategories.engagement.enabled}}',
              weight: '{{properties.interventionCategories.engagement.weight}}'
            },
            facilitation: {
              enabled: '{{properties.interventionCategories.facilitation.enabled}}',
              weight: '{{properties.interventionCategories.facilitation.weight}}'
            }
          },
          mediatorMinInterval: 60000,
          personality: 'sarcastic-expert'
        }
      }
    }
  ],
  enableDMs: ['agents'],
  channels: [{ name: 'transcript' }, { name: 'participant' }, { name: 'moderator' }, { name: 'chat' }],
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
export default eventAssistantPlus

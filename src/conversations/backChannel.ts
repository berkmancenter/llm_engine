import adapterTypes from '../adapters/config.js'
import { supportedModels } from '../agents/helpers/getModelChat.js'
import { ConversationType, Direction } from '../types/index.types.js'

const backChannel: ConversationType = {
  name: 'backChannel',
  label: 'Back Channel',
  description: 'An agent to analyze participant comments and generate insights for the moderator',
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
      default: 'Suggest to Speaker'
    },
    {
      name: 'llmModel',
      label: 'Model that your agent will use',
      required: false,
      type: 'string',
      enum: supportedModels,
      validationKeys: ['llmModel', 'llmPlatform']
    }
  ],
  // internal
  agents: [
    {
      name: 'backChannelMetrics',
      properties: { llmModel: '{{properties.llmModel.llmModel}}', llmPlatform: '{{properties.llmModel.llmPlatform}}' }
    },
    {
      name: 'backChannelInsights',
      properties: { llmModel: '{{properties.llmModel.llmModel}}', llmPlatform: '{{properties.llmModel.llmPlatform}}' }
    }
  ],
  enableDMs: ['agents'],
  channels: [{ name: 'moderator' }, { name: 'participant' }, { name: 'transcript' }],
  adapters: {
    zoom: {
      type: 'zoom',
      config: {
        meetingUrl: '{{{properties.zoomMeetingUrl}}}',
        botName: '{{properties.botName}}'
      },
      dmChannels: [
        {
          name: 'participant',
          direction: Direction.INCOMING
        },
        {
          direct: true,
          agent: 'backChannelInsights',
          direction: Direction.OUTGOING
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
export default backChannel

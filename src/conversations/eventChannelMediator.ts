import { supportedModels } from '../agents/helpers/getModelChat.js'
import adapterTypes from '../adapters/config.js'
import { ConversationType, Direction } from '../types/index.types.js'

const eventChannelMediator: ConversationType = {
  // user-facing
  name: 'eventChannelMediator',
  label: 'Event Channel Mediator',
  description: 'A mediator agent that monitors conversations and makes strategic interventions in shared chat',
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
      default: 'Event Channel Mediator'
    },
    {
      name: 'llmModel',
      label: 'Model that your agent will use',
      required: false,
      type: 'object',
      enum: supportedModels,
      validationKeys: ['llmModel', 'llmPlatform']
    }
  ],
  // internal
  agents: [
    {
      name: 'eventAssistant',
      properties: { llmModel: '{{properties.llmModel.llmModel}}', llmPlatform: '{{properties.llmModel.llmPlatform}}' }
    },
    {
      name: 'eventAssistantChannelMediator',
      properties: { llmModel: '{{properties.llmModel.llmModel}}', llmPlatform: '{{properties.llmModel.llmPlatform}}' }
    }
  ],
  enableDMs: ['agents'],
  channels: [{ name: 'transcript' }, { name: 'chat' }],
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
          agent: 'eventAssistant',
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
export default eventChannelMediator

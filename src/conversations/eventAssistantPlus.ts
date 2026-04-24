import { supportedModels } from '../agents/helpers/getModelChat.js'
import adapterTypes from '../adapters/config.js'
import { ConversationType, Direction } from '../types/index.types.js'
import config from '../config/config.js'

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
      name: 'feedbackFrequency',
      label: 'Feedback Request Frequency',
      description: 'Request feedback every N eligible messages (0 = disabled)',
      required: false,
      type: 'number',
      default: 3
    }
  ],
  features: [
    {
      name: 'collectiveVoice',
      label: 'Collective Voice',
      description:
        'Contributes to the group chat by surfacing what participants are privately thinking, connecting threads across the conversation, and giving the discussion shape and continuity.',
      default: true,
      properties: [
        {
          name: 'minContributionInterval',
          label: 'Minimum Minutes Between Contributions',
          required: false,
          type: 'number',
          default: 10
        }
      ],
      agents: [
        {
          name: 'eventMediatorPlus',
          properties: [
            { $ref: 'llmModel.llmModel' },
            { $ref: 'llmModel.llmPlatform' },
            { $ref: 'collectiveVoice.minContributionInterval', as: 'agentConfig.minInterval' }
          ]
        }
      ]
    },
    {
      name: 'catalyst',
      label: 'Catalyst',
      description:
        'Participates in the group chat as an active voice — jumping into silences, responding to speakers, challenging unexamined claims, and adding witty observations to encourage participation.',
      default: true,
      properties: [
        {
          name: 'minContributionInterval',
          label: 'Minimum Minutes Between Contributions',
          required: false,
          type: 'number',
          default: 10
        }
      ],
      agents: [
        {
          name: 'engagementAgent',
          properties: [
            { $ref: 'llmModel.llmModel' },
            { $ref: 'llmModel.llmPlatform' },
            { $ref: 'catalyst.minContributionInterval', as: 'agentConfig.minInterval' }
          ]
        }
      ]
    }
  ],
  // internal
  agents: [
    {
      name: 'eventAssistantPlus',
      properties: [
        { $ref: 'llmModel.llmModel' },
        { $ref: 'llmModel.llmPlatform' },
        { $ref: 'botName', as: 'agentConfig.botName' }
      ]
    },
    {
      name: 'backChannelInsights',
      properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
    },
    {
      name: 'jargonFilterAgent',
      properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
    },
    {
      name: 'voiceAssistant',
      properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
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
export default eventAssistantPlus

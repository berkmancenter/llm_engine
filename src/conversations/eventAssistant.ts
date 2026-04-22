import { supportedModels } from '../agents/helpers/getModelChat.js'
import adapterTypes from '../adapters/config.js'
import { ConversationType, Direction } from '../types/index.types.js'
import config from '../config/config.js'

const eventAssistant: ConversationType = {
  // user-facing
  name: 'eventAssistant',
  label: 'Event Assistant',
  description: 'An assistant to answer questions about an event',
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
  /*
   * Each entry determines 3 things: the Features section in the event creation form,
   * the Quick Guide panel shown during live events, and slash command
   * autocomplete (for entries where slashCommand is set).
   *
   * tab and audience are required — omitting either is a compile error.
   *
   * tab:                    "assistant", "chat", or "transcript"
   * audience:               "participant", "moderator", or "both"
   * slashCommand:           command text without the slash. Omit for passive features.
   * participantDescription: shown in the Quick Guide. Falls back to description if absent.
   * agents:                 backend agents to start when enabled. Empty for user-triggered features.
   * properties:             sub-properties shown in the event creation form.
   */
  features: [
    {
      name: 'mindmap',
      label: 'Mind Map',
      description: 'Creates a visual mind map of the key topics discussed in the event.',
      participantDescription: 'Generate a visual mind map of the key topics discussed so far.',
      tab: 'assistant',
      audience: 'participant',
      userControlled: true,
      slashCommand: 'mindmap',
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'visual',
      label: 'Visual Response',
      description: 'Generates an image in response to a participant question.',
      participantDescription:
        'Ask for a visual (image) response to a question. Requires "Visuals" to be enabled in your settings.',
      tab: 'assistant',
      audience: 'participant',
      userControlled: true,
      slashCommand: 'visual',
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'jargonFilter',
      label: 'Jargon Filter',
      description: 'Automatically explains jargon and technical terms used by speakers.',
      participantDescription:
        'Automatically explains jargon and technical terms used by speakers. Enable it by turning on "Jargon Clarification" in your event settings.',
      tab: 'assistant',
      audience: 'participant',
      userControlled: true,
      default: true,
      agents: [],
      properties: []
    }
  ],
  // internal
  agents: [
    {
      name: 'eventAssistant',
      properties: [
        { $ref: 'llmModel.llmModel' },
        { $ref: 'llmModel.llmPlatform' },
        { $ref: 'botName', as: 'agentConfig.botName' }
      ]
    }
  ],
  enableDMs: ['agents'],
  channels: [{ name: 'transcript' }, { name: 'chat' }, { name: 'image-gen' }],
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
      chatChannels: [
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
export default eventAssistant

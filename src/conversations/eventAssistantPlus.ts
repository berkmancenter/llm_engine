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
  /*
   * Each entry drives: the Features section in the event creation form,
   * the Quick Guide panel shown during live events, and slash command
   * autocomplete (for entries where slashCommand is set).
   *
   * category is required — omitting it is a compile error.
   *
   * category:     platform area — "assistant", "group-chat", "transcript", or "resources"
   * slashCommand: command text without the slash. Omit for passive features.
   * prerequisite: optional setup instruction shown alongside the description.
   * agents:       backend agents to start when enabled. Empty for user-triggered features.
   * properties:   sub-properties shown in the event creation form.
   */
  features: [
    {
      name: 'collectiveVoice',
      label: 'Collective Voice',
      description:
        'Contributes to the group chat by surfacing what participants are privately thinking, connecting threads across the conversation, and giving the discussion shape and continuity.',
      category: 'group-chat',
      userControlled: false,
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
        'Participates in the group chat as an active voice, jumping into silences, responding to speakers, challenging unexamined claims, and adding witty observations to encourage participation.',
      category: 'group-chat',
      userControlled: false,
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
    },
    {
      name: 'librarian',
      label: 'Reading Recommendations',
      description: 'Periodically recommends relevant reading during the event',
      category: 'resources',
      userControlled: false,
      default: true,
      properties: [
        {
          name: 'recommendationsPerInterval',
          label: 'Number of Reading Recommendations per Interval',
          required: false,
          type: 'number',
          default: 2
        }
      ],
      agents: [
        {
          name: 'librarian',
          properties: [
            { $ref: 'llmModel.llmModel' },
            { $ref: 'llmModel.llmPlatform' },
            { $ref: 'librarian.recommendationsPerInterval', as: 'agentConfig.recommendationsPerInterval' }
          ]
        }
      ]
    },
    {
      name: 'mod',
      label: 'Submit to Moderator',
      description: 'Submit a private question to the moderator.',
      category: 'group-chat',
      userControlled: true,
      slashCommand: 'mod',
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'mindmap',
      label: 'Mind Map',
      description: 'Creates a visual mind map of the key topics discussed in the event.',
      category: 'assistant',
      userControlled: true,
      slashCommand: 'mindmap',
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'visual',
      label: 'Visual Response',
      description: 'Ask for a visual (image) response to a question.',
      prerequisite: 'Requires "Visuals" to be enabled in your settings.',
      category: 'assistant',
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
      prerequisite: 'Enable it by turning on "Jargon Clarification" in your event settings.',
      category: 'assistant',
      userControlled: true,
      default: true,
      agents: [],
      properties: []
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
    { name: 'image-gen' },
    { name: 'resources' }
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

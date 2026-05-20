import { supportedModels } from '../agents/helpers/getModelChat.js'
import adapterTypes from '../adapters/config.js'
import { ConversationType, Direction } from '../types/index.types.js'
import config from '../config/config.js'

export const ZOOM_MEETING_URL_PROPERTY = 'zoomMeetingUrl' as const

const eventAssistant: ConversationType = {
  // user-facing
  name: 'eventAssistant',
  label: 'Event Assistant',
  description: 'An assistant to answer questions about an event',
  platforms: adapterTypes,
  properties: [
    {
      name: ZOOM_MEETING_URL_PROPERTY,
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
   * category is required — omitting it is a compile error.
   *
   * category:     functional area this feature corresponds to, such as "assistant", "group-chat", "transcript", or "resources"
   * slashCommand: command text without the slash. Omit for passive features.
   * prerequisite: optional setup instruction shown alongside the description.
   * agents:       backend agents to start when enabled. Empty for user-triggered features.
   * properties:   sub-properties shown in the event creation form.
   */

  features: [
    {
      name: 'moderatorSupport',
      label: 'Moderator Support',
      description:
        'Enables participants to submit questions to the moderator, surfaces insights from messages, and alerts the moderator when significant themes emerge.',
      default: true,
      category: 'assistant',
      userControlled: false,
      slashCommand: 'mod',
      agents: [
        {
          name: 'backChannelInsights',
          properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
        },
        {
          name: 'moderatorNotifier',
          properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
        }
      ]
    },
    {
      name: 'collectiveVoice',
      label: 'Collective Voice',
      description:
        'Contributes to the group chat by surfacing what participants are privately thinking, connecting threads across the conversation, and giving the discussion shape and continuity.',
      default: true,
      category: 'group-chat',
      userControlled: false,
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
          name: 'eventMediator',
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
      category: 'group-chat',
      userControlled: false,
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
      default: true,
      category: 'assistant',
      userControlled: false,
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
      category: 'assistant',
      userControlled: true,
      slashCommand: 'visual',
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'visualPreference',
      label: 'Visuals',
      description: 'Automatically generates a visual when it would help explain a concept.',
      prerequisite: 'Enable it by turning on "Visuals" in your event settings.',
      category: 'assistant',
      userControlled: true,
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
      name: 'eventAssistant',
      properties: [
        { $ref: 'llmModel.llmModel' },
        { $ref: 'llmModel.llmPlatform' },
        { $ref: 'botName', as: 'agentConfig.botName' },
        { $ref: 'moderatorSupport', as: 'agentConfig.moderatorSupport' }
      ]
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
    // Fully remote: Zoom only — moderator DMs sent via Zoom
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
        },
        {
          name: 'moderator',
          direction: Direction.OUTGOING,
          users: 'moderators'
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
    // Hybrid: Zoom + NextSpace — moderator DMs handled by NextSpace, not Zoom
    'nextspace,zoom': {
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
